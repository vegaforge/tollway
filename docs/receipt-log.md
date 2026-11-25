# Receipt log

A receipt log is an append-only list of signed receipts in which every entry
commits to the one before it by hash. A signed checkpoint records how long the
log was and what its last hash was at a moment in time. With the log and a
checkpoint, anyone can check offline that no receipt the checkpoint covers was
modified, removed or reordered (#171).

Each receipt is already signed on its own, so a single receipt cannot be
forged. The log protects the set: without it, an operator, or an attacker with
database access, could delete an awkward receipt and nothing would show it was
ever there. The [receipt archive](../packages/observability/src/receipt-archive.ts)
is for search; the log is for integrity. A service can feed the same receipts
to both.

## What it guarantees, and what it does not

- Any change to an entry, any gap and any reorder is detected from the log
  alone, at the first entry affected.
- Removing entries from the end (tail truncation) leaves a shorter log that is
  still internally consistent. **Without a checkpoint held outside the log,
  tail truncation cannot be detected.**
- Someone who can rewrite the whole log can also recompute every hash. Only a
  checkpoint signed before the rewrite exposes it.
- A checkpoint is only as strong as the place it is kept. A checkpoint stored
  next to the log, by the same operator, protects against accidents, not
  against that operator. Send checkpoints somewhere the operator cannot edit.

## Entry format

Every line of the log is one entry:

```json
{
  "seq": 0,
  "prevHash": "0000000000000000000000000000000000000000000000000000000000000000",
  "receipt": { "receipt": { "...": "..." }, "signature": { "...": "..." } },
  "appendedAt": "2026-11-24T12:00:00.000Z",
  "entryHash": "3f1c...e9"
}
```

| Field | Meaning |
| ----- | ------- |
| `seq` | Position in the log, starting at 0, with no gaps. |
| `prevHash` | `entryHash` of entry `seq - 1`. Entry 0 uses the fixed genesis hash, 64 zeros (`RECEIPT_LOG_GENESIS_HASH`). |
| `receipt` | The signed receipt, exactly as in [receipt-format.md](receipt-format.md). |
| `appendedAt` | When the log accepted the entry (ISO 8601). |
| `entryHash` | SHA-256, as 64 lowercase hex characters, of the canonical bytes of `{ seq, prevHash, receipt, appendedAt }`. |

Canonical bytes are the RFC 8785 serialisation that receipt signatures use
(`canonicalBytes` in `@vegaforge/tollway-core`, see
[receipt-format.md, "Canonical bytes"](receipt-format.md#canonical-bytes)), so
any language with a JCS library can recompute the hashes.

`append` verifies the receipt's signature before it writes anything, checking a
v2 receipt's expiry against `appendedAt`. Verification does the same, so a
receipt that has expired since it was logged still verifies.

## Checkpoint format

```json
{
  "checkpoint": {
    "type": "tollway-receipt-log-checkpoint",
    "version": 1,
    "logId": "receipts-eu-1",
    "size": 1200,
    "headHash": "9a07...41",
    "issuedAt": "2026-11-24T13:00:00.000Z"
  },
  "signature": { "keyId": "tollway-2026-q4", "algorithm": "Ed25519", "value": "..." }
}
```

`size` is the number of entries covered and `headHash` is the `entryHash` of
entry `size - 1` (the genesis hash for an empty log). The signature covers the
canonical bytes of `checkpoint` and is made with any `ReceiptSigner`, so the
same keys and key sets that verify receipts verify checkpoints. The `type`
field keeps a checkpoint signature from ever being read as a receipt
signature. `logId` names the log so checkpoints of different logs are not
confused; it is not part of the entries.

## Writing a log

```ts
import { createMemoryReceiptLogStore, createReceiptLog } from "@vegaforge/tollway-core";
import { openJsonlReceiptLogStore } from "@vegaforge/tollway-observability";

const store = await openJsonlReceiptLogStore({ path: "/var/lib/tollway/receipts.jsonl" });
// Or, for tests: const store = createMemoryReceiptLogStore();

const log = createReceiptLog({
  store,
  logId: "receipts-eu-1",
  verifier, // checks each receipt before it is written
  signer, // signs checkpoints
  checkpointEvery: 100,
  onCheckpoint: (checkpoint) => publishCheckpoint(checkpoint),
  onCheckpointError: (error, size) => alert(`checkpoint at size ${size} failed`, error),
});

await log.append(signedReceipt);
const head = await log.head(); // { size, headHash }
const page = await log.read(0, 100); // entries 0 to 99
const now = await log.checkpoint(); // sign one on demand
```

Appends in one process are queued, so concurrent calls never fork the chain.
An automatic checkpoint that fails to sign or to deliver goes to
`onCheckpointError`; the entry is already stored, and the next scheduled
checkpoint covers it.

### Stores

- `createMemoryReceiptLogStore()` in `@vegaforge/tollway-core` keeps entries in
  memory, for tests and short-lived processes.
- `openJsonlReceiptLogStore({ path })` in `@vegaforge/tollway-observability`
  writes one canonical JSON line per entry and calls `fsync` after every
  append, so an entry whose `append` resolved survives a crash. Opening a file
  re-checks the whole chain and refuses one that was edited. A crash during a
  write can leave a partial last line: opening that file fails with
  `corrupt-receipt-log` until `repairJsonlReceiptLog(path)` cuts the partial
  line off. `node:fs` is loaded only when the store is opened, so the package
  still imports on edge runtimes, and `@vegaforge/tollway-core` never touches
  the file system. A newly created file's directory entry is not synced; sync
  the directory yourself if that window matters. `read` re-reads the file, so
  it costs time linear in the log's size.

**One writer per log.** The log serialises appends inside one process only.
Two processes appending to the same store would each extend their own head.
Every store refuses an entry that does not extend its current head
(`receipt-log-conflict`); a store shared by several processes has to make that
check an atomic compare-and-set in its backing system (for example a unique
constraint on `seq`). Neither built-in store does that across processes.

## Keeping checkpoints outside the log

Pick a place the operator of the log cannot quietly rewrite, and send every
checkpoint there from `onCheckpoint`:

- Publish them at a public URL, or commit them to a repository other people
  watch.
- Send them to the parties who rely on the log, for example through the signed
  webhooks in `@vegaforge/tollway-observability`
  ([webhook-delivery.md](webhook-delivery.md)), so each counterparty keeps its
  own copy.
- Write them to storage with object lock or another write-once policy.

A verifier then needs only the newest checkpoint it trusts.

## Verifying a log offline

```ts
import { verifyReceiptLog } from "@vegaforge/tollway-core";

const entries = readFileSync("receipts.jsonl", "utf8")
  .split("\n")
  .filter((line) => line.length > 0)
  .map((line) => JSON.parse(line));

const result = await verifyReceiptLog(entries, {
  verifier, // receipt keys, for example createKeySetVerifier(...)
  checkpoint, // a checkpoint obtained from outside the log
  logId: "receipts-eu-1",
});
if (!result.valid) console.error(result.kind, result.seq, result.reason);
```

`verifyReceiptLog` never throws. It reports the first failing `seq` and one of
these kinds:

| Kind | Meaning |
| ---- | ------- |
| `malformed-entry` | The entry does not parse. |
| `gap-or-reorder` | The entry at position `n` does not carry `seq` `n`: an entry was removed or moved. |
| `broken-link` | `prevHash` is not the previous entry's `entryHash`. |
| `modified-entry` | `entryHash` does not match the entry's contents. |
| `receipt-signature` | The receipt's own signature does not verify. |
| `truncated` | The log is shorter than the checkpoint; `seq` is the first missing entry. |
| `checkpoint-mismatch` | The log was rewritten after the checkpoint was signed. |
| `invalid-checkpoint` | The checkpoint's signature or `logId` does not verify (`seq` is null). |

Without `verifier` only the chain is checked: that proves the log is
consistent, not that its receipts came from a trusted key.

## Why a linear chain

An RFC 6962 Merkle tree, as used by Certificate Transparency, would let a
verifier check that one receipt is in the log with O(log n) hashes, and that
one checkpoint extends another without reading the entries in between. A
linear chain needs the whole log for both. Version 1 uses the linear chain
because it is simple to implement and to re-implement in another language, and
because the people who verify a Tollway log (the operator, an auditor, a
counterparty in a dispute) usually hold the whole log anyway. If inclusion
proofs for single receipts become a requirement, a Merkle tree over the same
entries can be added as a new checkpoint version without changing the entry
format.
