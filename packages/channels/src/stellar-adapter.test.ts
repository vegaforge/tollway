import { Keypair } from "@stellar/stellar-sdk";
import { TollwayError } from "@vegaforge/tollway-core";
import { Credential } from "mppx";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createStellarMppChannelAdapter,
  type StellarMppChannelAdapterOptions,
} from "./stellar-adapter.js";

// @stellar/mpp is stubbed at the module boundary: no test reaches an RPC.
const stub = vi.hoisted(() => ({
  close: vi.fn(),
  getChannelState: vi.fn(),
  channelClient: vi.fn(),
  createCredential: vi.fn(),
}));

vi.mock("@stellar/mpp/channel/server", () => ({
  close: stub.close,
  getChannelState: stub.getChannelState,
}));

vi.mock("@stellar/mpp/channel/client", () => ({
  channel: stub.channelClient,
}));

const CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const OTHER_CONTRACT = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const OPEN_TX = "b".repeat(64);
const CLOSE_TX = "c".repeat(64);
const SEED = "1f".repeat(32);
const FEE_PAYER = Keypair.random();
const RECIPIENT = Keypair.random().publicKey();
const SIGNATURE = "ab".repeat(64);

function options(
  overrides: Partial<StellarMppChannelAdapterOptions> = {},
): StellarMppChannelAdapterOptions {
  return {
    channelContract: CONTRACT,
    openTxHash: OPEN_TX,
    commitmentKey: SEED,
    feePayer: { envelopeSigner: FEE_PAYER.secret() },
    network: "testnet",
    ...overrides,
  };
}

function state(overrides: Record<string, unknown> = {}) {
  return {
    balance: 1_000_000n,
    refundWaitingPeriod: 100,
    token: OTHER_CONTRACT,
    from: Keypair.random().publicKey(),
    to: RECIPIENT,
    closeEffectiveAtLedger: null,
    currentLedger: 10,
    ...overrides,
  };
}

/** What the real client method returns: a serialized mppx credential. */
function credentialFor(amount: string, signature = SIGNATURE): string {
  return Credential.serialize({
    challenge: {
      id: "x",
      realm: "tollway",
      method: "stellar",
      intent: "channel",
      request: { amount, channel: CONTRACT },
    },
    payload: { action: "voucher", amount, signature },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  stub.channelClient.mockReturnValue({ createCredential: stub.createCredential });
});

describe("createStellarMppChannelAdapter configuration", () => {
  it("builds the client signer from the raw commitment seed, pinned to the contract", () => {
    createStellarMppChannelAdapter(options());
    const parameters = stub.channelClient.mock.calls[0]?.[0];
    expect(parameters.allowedChannels).toEqual([CONTRACT]);
    expect(parameters.network).toBe("stellar:testnet");
    expect(parameters.commitmentKey.publicKey()).toBe(
      Keypair.fromRawEd25519Seed(Buffer.from(SEED, "hex")).publicKey(),
    );
  });

  it.each([
    ["a missing contract id", { channelContract: "" }, /channelContract is required/],
    ["a non-contract id", { channelContract: RECIPIENT }, /contract address \(C\.\.\.\)/],
    ["a bad open tx hash", { openTxHash: "nope" }, /openTxHash/],
    [
      "an S... secret as the commitment key",
      { commitmentKey: FEE_PAYER.secret() },
      /raw ed25519 seed of 64 hex characters/,
    ],
    ["a short commitment key", { commitmentKey: "abcd" }, /raw ed25519 seed/],
    [
      "a fee payer that is not a secret",
      { feePayer: { envelopeSigner: RECIPIENT } },
      /feePayer\.envelopeSigner/,
    ],
    [
      "a bad fee bump signer",
      { feePayer: { envelopeSigner: FEE_PAYER.secret(), feeBumpSigner: "x" } },
      /feeBumpSigner/,
    ],
    ["an unknown network", { network: "futurenet" as "testnet" }, /network/],
  ])("fails fast on %s", (_name, overrides, message) => {
    expect(() => createStellarMppChannelAdapter(options(overrides))).toThrow(message);
    expect(stub.channelClient).not.toHaveBeenCalled();
  });

  it("never echoes a secret in a configuration error", () => {
    const secret = FEE_PAYER.secret();
    try {
      createStellarMppChannelAdapter(options({ commitmentKey: secret }));
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});

describe("openChannel", () => {
  const input = {
    counterparty: RECIPIENT,
    asset: OTHER_CONTRACT,
    deposit: "1000000",
    network: "testnet" as const,
  };

  it("checks the deployed contract and reports it with the open tx hash", async () => {
    stub.getChannelState.mockResolvedValue(state());
    const adapter = createStellarMppChannelAdapter(options({ rpcUrl: "https://rpc.example" }));
    await expect(adapter.openChannel(input)).resolves.toEqual({
      channelId: CONTRACT,
      openTxHash: OPEN_TX,
    });
    expect(stub.getChannelState).toHaveBeenCalledWith({
      channel: CONTRACT,
      network: "stellar:testnet",
      rpcUrl: "https://rpc.example",
      simulationTimeoutMs: undefined,
    });
  });

  it.each([
    ["another recipient", state({ to: Keypair.random().publicKey() }), /not the counterparty/],
    ["another token", state({ token: CONTRACT }), /holds token/],
    ["a channel that is closing", state({ closeEffectiveAtLedger: 50 }), /already closing/],
    ["a smaller balance", state({ balance: 999_999n }), /less than the deposit/],
  ])("rejects %s", async (_name, onChain, message) => {
    stub.getChannelState.mockResolvedValue(onChain);
    const adapter = createStellarMppChannelAdapter(options());
    await expect(adapter.openChannel(input)).rejects.toThrow(message);
  });

  it("rejects a deposit that is not an integer string before any RPC call", async () => {
    const adapter = createStellarMppChannelAdapter(options());
    await expect(adapter.openChannel({ ...input, deposit: "1.5" })).rejects.toMatchObject({
      code: "invalid-amount",
    });
    expect(stub.getChannelState).not.toHaveBeenCalled();
  });
});

describe("signCommitment", () => {
  it("signs off chain through @stellar/mpp and returns the signature", async () => {
    stub.createCredential.mockResolvedValue(credentialFor("2500"));
    const adapter = createStellarMppChannelAdapter(options());

    await expect(
      adapter.signCommitment({ channelId: CONTRACT, cumulativeAmount: "2500", network: "testnet" }),
    ).resolves.toEqual({ commitment: SIGNATURE });

    expect(stub.createCredential).toHaveBeenCalledWith({
      challenge: expect.objectContaining({
        method: "stellar",
        intent: "channel",
        request: {
          amount: "2500",
          channel: CONTRACT,
          methodDetails: { network: "stellar:testnet" },
        },
      }),
      context: { cumulativeAmount: "2500", action: "voucher" },
    });
    // Off chain only: nothing is closed or submitted.
    expect(stub.close).not.toHaveBeenCalled();
  });

  it("rejects a commitment for an amount other than the one requested", async () => {
    stub.createCredential.mockResolvedValue(credentialFor("9999"));
    const adapter = createStellarMppChannelAdapter(options());
    await expect(
      adapter.signCommitment({ channelId: CONTRACT, cumulativeAmount: "2500", network: "testnet" }),
    ).rejects.toThrow(/does not match the requested amount/);
  });

  it("refuses a channel the adapter is not bound to", async () => {
    const adapter = createStellarMppChannelAdapter(options());
    await expect(
      adapter.signCommitment({
        channelId: OTHER_CONTRACT,
        cumulativeAmount: "1",
        network: "testnet",
      }),
    ).rejects.toMatchObject({ code: "channel-not-found" });
    expect(stub.createCredential).not.toHaveBeenCalled();
  });

  it("refuses a network the adapter is not configured for", async () => {
    const adapter = createStellarMppChannelAdapter(options());
    await expect(
      adapter.signCommitment({ channelId: CONTRACT, cumulativeAmount: "1", network: "mainnet" }),
    ).rejects.toThrow(TollwayError);
  });

  it("rejects a non-integer cumulative amount", async () => {
    const adapter = createStellarMppChannelAdapter(options());
    await expect(
      adapter.signCommitment({ channelId: CONTRACT, cumulativeAmount: "-1", network: "testnet" }),
    ).rejects.toMatchObject({ code: "invalid-amount" });
  });
});

describe("closeChannel", () => {
  const input = {
    channelId: CONTRACT,
    network: "testnet" as const,
    cumulativeAmount: "600000",
    commitment: SIGNATURE,
    deposit: "1000000",
  };

  it("submits one close with a bigint amount and reports the settlement", async () => {
    stub.close.mockResolvedValue(CLOSE_TX);
    const adapter = createStellarMppChannelAdapter(options());

    await expect(adapter.closeChannel(input)).resolves.toEqual({
      settlementTxHash: CLOSE_TX,
      settledAmount: "600000",
      returnedRemainder: "400000",
    });
    expect(stub.close).toHaveBeenCalledTimes(1);
    const parameters = stub.close.mock.calls[0]?.[0];
    expect(parameters.channel).toBe(CONTRACT);
    expect(parameters.amount).toBe(600_000n);
    expect(Buffer.from(parameters.signature).toString("hex")).toBe(SIGNATURE);
    expect(parameters.feePayer).toEqual({
      envelopeSigner: FEE_PAYER.secret(),
      feeBumpSigner: undefined,
    });
    expect(parameters.network).toBe("stellar:testnet");
  });

  it("refuses to close a channel with no commitments", async () => {
    const adapter = createStellarMppChannelAdapter(options());
    await expect(
      adapter.closeChannel({ ...input, cumulativeAmount: "0", commitment: "" }),
    ).rejects.toThrow(/refund path \(see #38\)/);
    expect(stub.close).not.toHaveBeenCalled();
  });

  it("rejects a malformed commitment", async () => {
    const adapter = createStellarMppChannelAdapter(options());
    await expect(adapter.closeChannel({ ...input, commitment: "zz" })).rejects.toThrow(
      /128-character hex/,
    );
  });

  it("rejects a cumulative amount above the deposit", async () => {
    const adapter = createStellarMppChannelAdapter(options());
    await expect(
      adapter.closeChannel({ ...input, cumulativeAmount: "1000001" }),
    ).rejects.toMatchObject({ code: "commitment-exceeds-deposit" });
  });

  it("lets an SDK failure surface without adding secrets to it", async () => {
    stub.close.mockRejectedValue(new Error("close simulation failed"));
    const adapter = createStellarMppChannelAdapter(options());
    const closing = adapter.closeChannel(input);
    await expect(closing).rejects.toThrow("close simulation failed");
    await closing.catch((error: unknown) => {
      expect(String(error)).not.toContain(FEE_PAYER.secret());
    });
  });
});
