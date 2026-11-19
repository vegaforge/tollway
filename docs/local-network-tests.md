# Integration tests on a local Stellar network

The suite in `tests/integration` pays real Soroban transactions through the
Tollway gate on a disposable Stellar network started from the
[`stellar/quickstart`](https://github.com/stellar/quickstart) Docker image.
Every other test uses the mock facilitator or skips; this one is the only
place a pull request moves funds on chain.

It covers:

- x402 end to end: an Express route gated by `createPaywall` and
  `expressPaywall`, paid by `@x402/stellar`'s client scheme, settled by a
  test-only facilitator (`x402Facilitator` with the `@x402/stellar` exact
  scheme) that `createHttpFacilitator` calls over HTTP. The test checks the
  receipt signature, `getTransaction` status `SUCCESS`, the recipient's
  balance moving by exactly the offer amount, and one `transfer` event.
- The same `PAYMENT-SIGNATURE` sent twice, in sequence and concurrently: one
  `/settle`, one on-chain transfer, a replayed receipt for the second request.
- On-chain rejections: a payer whose balance is spent after signing, and a
  payment signed for the wrong amount. Both end `rejected` with no balance
  change.
- MPP charge (#100) end to end through the same harness.
- MPP channel (#101) is listed as a todo: it needs the one-way-channel
  contract deployed on the local network.

The facilitator under `tests/integration/src/harness/facilitator.ts` is a test
fixture. It is never exported; Tollway calls a facilitator, it never is one
(see [design.md](design.md), "What Tollway is not").

## How the local network is made acceptable to the SDKs

Two things stand between a quickstart node and the SDKs, and neither is
solved by patching a package.

**The network passphrase.** `@x402/stellar` (2.31.0) and `@stellar/mpp`
(0.7.1) only know `stellar:testnet` and `stellar:pubnet`, and sign with the
matching passphrase. quickstart's local mode uses
`Standalone Network ; February 2017` by default, but its start script keeps a
`NETWORK_PASSPHRASE` it is given:

```bash
local)
  if [ -z "$NETWORK_PASSPHRASE" ]; then
    export NETWORK_PASSPHRASE="Standalone Network ; February 2017"
  fi
```

The option came in with stellar/quickstart#688 ("Allow setting custom network
passphrase in local mode") and is documented in the image's
`.do/deploy.template.yaml` ("NETWORK_PASSPHRASE sets a network passphrase to
uniquely identify the network"). The suite starts the node with the testnet
passphrase, `Test SDF Network ; September 2015`, and talks to it as
`stellar:testnet`. The harness checks the passphrase through `getNetwork` and
fails with a clear message if it differs.

The local network is still its own ledger: its accounts, keys and assets do
not exist on the public testnet. A transaction signed for it would be valid
on testnet only if the same source account existed there with the same
sequence number, and every account here is a fresh `Keypair.random()`.

**Plain HTTP.** quickstart serves RPC at `http://localhost:8000/rpc`.
`@stellar/stellar-sdk`'s `rpc.Server` refuses an `http:` URL unless the caller
passes `allowHttp: true`. The `@x402/stellar` client (through
`contract.AssembledTransaction.build`) and `@stellar/mpp` never pass it, so
the harness runs an HTTPS proxy in front of the RPC with a throwaway
certificate that Node trusts through `NODE_EXTRA_CA_CERTS`.

## Running it locally

You need Docker, OpenSSL and the repository installed (`pnpm install`).

1. Start a local network with the testnet passphrase:

   ```bash
   docker run --rm -d --name tollway-stellar -p 8000:8000 \
     -e NETWORK_PASSPHRASE="Test SDF Network ; September 2015" \
     stellar/quickstart --local --enable core,horizon,rpc
   ```

   Horizon must run: in local mode, friendbot only runs with it.

2. Create a certificate for the proxy (once; it is valid for a day):

   ```bash
   mkdir -p .local-rpc-tls
   openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
     -keyout .local-rpc-tls/key.pem -out .local-rpc-tls/cert.pem \
     -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
   ```

   Keep the directory out of Git, or put it outside the repository.

3. Build the packages the suite imports, then run it:

   ```bash
   pnpm --filter "@vegaforge/tollway-integration-tests^..." build
   TOLLWAY_LOCAL_STELLAR=true \
   TOLLWAY_LOCAL_STELLAR_TLS_CERT="$PWD/.local-rpc-tls/cert.pem" \
   TOLLWAY_LOCAL_STELLAR_TLS_KEY="$PWD/.local-rpc-tls/key.pem" \
   NODE_EXTRA_CA_CERTS="$PWD/.local-rpc-tls/cert.pem" \
     pnpm --filter @vegaforge/tollway-integration-tests test
   ```

4. Stop the node: `docker stop tollway-stellar`.

Settings:

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `TOLLWAY_LOCAL_STELLAR` | unset | `true` runs the suite; anything else skips it |
| `TOLLWAY_LOCAL_STELLAR_RPC_URL` | `http://localhost:8000/rpc` | The node's RPC |
| `TOLLWAY_LOCAL_STELLAR_TLS_CERT`, `TOLLWAY_LOCAL_STELLAR_TLS_KEY` | none | Certificate and key the proxy serves |
| `TOLLWAY_LOCAL_STELLAR_READY_TIMEOUT_MS` | `180000` | Deadline for the node to report healthy and fund accounts |

No keys are read from the environment. Every account is generated per run.

Without `TOLLWAY_LOCAL_STELLAR=true`, `pnpm test` skips the suite and still
runs the harness self-test, which checks that an unreachable node fails with
a readable message within its deadline.

## In CI

`.github/workflows/integration.yml` runs the suite on every push and pull
request, with quickstart as a service container pinned by digest. Service
containers take no arguments, so `--local` and `--enable` are passed as the
`NETWORK` and `ENABLE` variables the image's start script reads. The job is
not in the `quality` aggregate yet; it joins once its runtime and flakiness
have been reviewed.

The `@x402/stellar` client and facilitator also ask the public testnet
Horizon for the average ledger close time, and fall back to 5 seconds when
it cannot be reached. That only sizes the payment's validity window.
