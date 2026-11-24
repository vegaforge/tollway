import {
  Address,
  FeeBumpTransaction,
  hash,
  Keypair,
  Networks,
  StrKey,
  scValToNative,
  Transaction,
  xdr,
} from "@stellar/stellar-sdk";
import type { StellarNetwork } from "@vegaforge/tollway-core";

/**
 * Offline proof that an MPP charge credential's `source` is the account that
 * pays.
 *
 * `@stellar/mpp` already enforces this when it settles: the transfer's `from`
 * must equal the source, and the network requires `from` to authorize the
 * transfer. But the gate reads the payer at verify time, before settlement,
 * and the service policy acts on it then. Without this check a credential
 * that names someone else's account passes verify, takes a reservation in
 * that account's policy windows, and only fails later at settle, so a flood
 * of such credentials can hold another payer's slots and get them refused.
 *
 * The proof is the same one the chain will demand, checked without a network
 * call:
 * - `transaction` (pull mode): the one operation is a `transfer` whose `from`
 *   is the source, and the source signed for it, either as the transaction's
 *   source account (an envelope signature) or through a Soroban address
 *   authorization entry.
 * - `signedHash` (push mode): the source key signed `{challenge.id}:{hash}`,
 *   the binding `@stellar/mpp` checks.
 * - Anything else, including unsigned `hash` credentials, proves nothing and
 *   is refused (`@stellar/mpp` 0.7 refuses them too).
 *
 * Returns null when the source is proven, otherwise the reason it is not.
 */
export function mppSourceProofFailure(
  payload: unknown,
  context: { challengeId: string; payer: string; network: StellarNetwork },
): string | null {
  if (!isRecord(payload)) return "mpp credential payload is not an object";
  switch (payload.type) {
    case "transaction":
      return typeof payload.transaction === "string"
        ? transactionProofFailure(payload.transaction, context)
        : "mpp credential transaction is not a string";
    case "signedHash":
      return typeof payload.hash === "string" && typeof payload.sourceSignature === "string"
        ? signedHashProofFailure(payload.hash, payload.sourceSignature, context)
        : "mpp credential signedHash payload is malformed";
    default:
      return "mpp credential type does not prove its source; use transaction or signedHash";
  }
}

const PASSPHRASE: Record<StellarNetwork, string> = {
  testnet: Networks.TESTNET,
  mainnet: Networks.PUBLIC,
};

const SIGNED_HASH = /^[0-9a-f]{64}$/i;
const SIGNATURE_HEX = /^[0-9a-f]{128}$/i;

function signedHashProofFailure(
  txHash: string,
  signatureHex: string,
  context: { challengeId: string; payer: string },
): string | null {
  if (!SIGNED_HASH.test(txHash) || !SIGNATURE_HEX.test(signatureHex)) {
    return "mpp credential signedHash payload is malformed";
  }
  // Same message @stellar/mpp verifies: the challenge id and the lowercase hash.
  const message = Buffer.from(`${context.challengeId}:${txHash.toLowerCase()}`);
  return Keypair.fromPublicKey(context.payer).verify(message, Buffer.from(signatureHex, "hex"))
    ? null
    : "mpp credential source did not sign this payment";
}

function transactionProofFailure(
  envelopeXdr: string,
  context: { payer: string; network: StellarNetwork },
): string | null {
  const passphrase = PASSPHRASE[context.network];
  let tx: Transaction;
  try {
    const envelope = xdr.TransactionEnvelope.fromXDR(envelopeXdr, "base64");
    tx =
      envelope.switch().name === "envelopeTypeTxFeeBump"
        ? new FeeBumpTransaction(envelope, passphrase).innerTransaction
        : new Transaction(envelope, passphrase);
  } catch {
    return "mpp credential transaction is not a valid Stellar transaction";
  }

  const transfer = transferOf(tx);
  if (typeof transfer === "string") return transfer;
  if (transfer.from !== context.payer) {
    return "mpp credential transfer is not from the credential source";
  }

  if (tx.source === context.payer && hasEnvelopeSignature(tx, context.payer)) {
    return null;
  }
  return transfer.authEntries.some((entry) =>
    isSignedAddressAuthorization(entry, context.payer, passphrase),
  )
    ? null
    : "mpp credential source did not sign this payment";
}

type Transfer = { from: string; authEntries: xdr.SorobanAuthorizationEntry[] };

/** The single SEP-41 transfer the transaction must be, or why it is not. */
function transferOf(tx: Transaction): Transfer | string {
  if (tx.operations.length !== 1 || tx.operations[0]?.type !== "invokeHostFunction") {
    return "mpp credential transaction is not a single contract call";
  }
  const operation = tx.toEnvelope().v1().tx().operations()[0];
  if (!operation) return "mpp credential transaction is not a single contract call";
  const invoke = operation.body().invokeHostFunctionOp();
  const hostFunction = invoke.hostFunction();
  if (hostFunction.switch().name !== "hostFunctionTypeInvokeContract") {
    return "mpp credential transaction is not a single contract call";
  }
  const call = hostFunction.invokeContract();
  const args = call.args();
  const from = args[0];
  if (call.functionName().toString() !== "transfer" || args.length !== 3 || !from) {
    return "mpp credential transaction is not a token transfer";
  }
  try {
    return { from: Address.fromScVal(from).toString(), authEntries: invoke.auth() };
  } catch {
    return "mpp credential transaction is not a token transfer";
  }
}

/** True when the envelope carries a valid signature by `account` over the transaction. */
function hasEnvelopeSignature(tx: Transaction, account: string): boolean {
  const key = Keypair.fromPublicKey(account);
  const hint = key.signatureHint();
  const txHash = tx.hash();
  return tx.signatures.some(
    (decorated) => decorated.hint().equals(hint) && key.verify(txHash, decorated.signature()),
  );
}

/**
 * True when the entry is an address authorization for `account`, signed by
 * `account` over the payload the network checks. Mirrors the check in
 * `@stellar/mpp`'s `verifyAuthEntrySignature`, which is not exported.
 */
function isSignedAddressAuthorization(
  entry: xdr.SorobanAuthorizationEntry,
  account: string,
  passphrase: string,
): boolean {
  const credentials = entry.credentials();
  if (credentials.switch().name !== "sorobanCredentialsAddress") return false;
  const address = credentials.address();
  if (address.address().switch().name !== "scAddressTypeAccount") return false;
  if (Address.fromScAddress(address.address()).toString() !== account) return false;

  const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: hash(Buffer.from(passphrase)),
      nonce: address.nonce(),
      invocation: entry.rootInvocation(),
      signatureExpirationLedger: address.signatureExpirationLedger(),
    }),
  );
  const payload = hash(preimage.toXDR());

  let signatures: unknown;
  try {
    signatures = scValToNative(address.signature());
  } catch {
    return false;
  }
  // An account authorizer is satisfied by one signature, the shape
  // `authorizeEntry` writes: [{ public_key, signature }].
  if (!Array.isArray(signatures) || signatures.length !== 1) return false;
  const [signed] = signatures as unknown[];
  if (!isRecord(signed)) return false;
  const { public_key: publicKey, signature } = signed;
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32) return false;
  if (!(signature instanceof Uint8Array) || signature.length !== 64) return false;
  if (StrKey.encodeEd25519PublicKey(Buffer.from(publicKey)) !== account) return false;
  return Keypair.fromPublicKey(account).verify(payload, Buffer.from(signature));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
