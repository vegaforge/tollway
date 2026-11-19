import { Asset, Keypair, Operation, rpc } from "@stellar/stellar-sdk";
import type { LocalStellarConfig } from "./config.js";
import { deployAssetContract, submitOperations, toClassicAmount } from "./ledger.js";
import { retryUntil, waitForHealthyRpc } from "./readiness.js";
import { startTlsRpcProxy } from "./tls-proxy.js";

/**
 * Everything a test needs on a fresh local network: an RPC client, the
 * HTTPS URL the SDKs use, funded accounts and a test asset with its
 * Stellar Asset Contract.
 */
export type LocalNetwork = {
  /** HTTPS URL of the RPC, for the SDKs under test and the harness. */
  rpcUrl: string;
  server: rpc.Server;
  asset: Asset;
  /** Contract address of the asset's SAC: the `asset` in every offer. */
  assetContract: string;
  /** Holds `payerBalance` of the asset and pays for the happy paths. */
  payer: Keypair;
  /** Receives every payment. Holds a trustline and nothing else at the start. */
  recipient: Keypair;
  /** The test facilitator's signer; pays the settlement fee. */
  facilitator: Keypair;
  /** Has a trustline and a balance of `fundedAmount`, for the underfunded case. */
  shortPayer: Keypair;
  issuer: Keypair;
  close(): Promise<void>;
};

const ASSET_CODE = "TOLL";

export async function setUpLocalNetwork(
  config: LocalStellarConfig,
  amounts: { payerBalance: bigint; shortPayerBalance: bigint },
): Promise<LocalNetwork> {
  const proxy = await startTlsRpcProxy(config);
  try {
    const server = new rpc.Server(proxy.url);
    const deadline = Date.now() + config.readyTimeoutMs;
    const network = await waitForHealthyRpc(server, {
      label: `${config.upstreamRpcUrl} (via ${proxy.url})`,
      deadlineMs: config.readyTimeoutMs,
    });
    if (!network.friendbotUrl) {
      throw new Error(
        `local Stellar RPC at ${config.upstreamRpcUrl} advertises no friendbot; quickstart in ` +
          "local mode runs friendbot when horizon runs, so enable core,horizon,rpc",
      );
    }

    // Fresh keys every run. Nothing is read from the environment and no
    // secret is ever printed.
    const issuer = Keypair.random();
    const payer = Keypair.random();
    const recipient = Keypair.random();
    const facilitator = Keypair.random();
    const shortPayer = Keypair.random();

    // One at a time: friendbot funds from a single root account, and
    // parallel requests can collide on its sequence number.
    for (const account of [issuer, payer, recipient, facilitator, shortPayer]) {
      await retryUntil(`friendbot funding ${account.publicKey()}`, deadline, () =>
        server.fundAddress(account.publicKey()),
      );
    }

    const asset = new Asset(ASSET_CODE, issuer.publicKey());
    const holders = [payer, recipient, shortPayer];
    // One transaction opens every trustline and mints both balances, signed
    // by the issuer and each holder whose operation it carries.
    await submitOperations(
      server,
      issuer,
      [
        ...holders.map((holder) => Operation.changeTrust({ asset, source: holder.publicKey() })),
        Operation.payment({
          destination: payer.publicKey(),
          asset,
          amount: toClassicAmount(amounts.payerBalance),
        }),
        Operation.payment({
          destination: shortPayer.publicKey(),
          asset,
          amount: toClassicAmount(amounts.shortPayerBalance),
        }),
      ],
      holders,
    );
    const assetContract = await deployAssetContract(server, asset, issuer);

    return {
      rpcUrl: proxy.url,
      server,
      asset,
      assetContract,
      payer,
      recipient,
      facilitator,
      shortPayer,
      issuer,
      close: proxy.close,
    };
  } catch (error) {
    await proxy.close();
    throw error;
  }
}
