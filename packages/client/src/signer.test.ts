import { hash, Keypair } from "@stellar/stellar-sdk";
import { TollwayError } from "@vegaforge/tollway-core";
import { isClientStellarSigner } from "@x402/stellar";
import { describe, expect, it, vi } from "vitest";
import { createMppChargeSettler } from "./mpp-charge-settler.js";
import {
  type AgentSigner,
  createKeypairSigner,
  createSmartAccountSigner,
  SignerCapabilityError,
  signerModels,
} from "./signer.js";
import { createX402Settler } from "./x402-settler.js";

const CONTRACT = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const ENTRY = Buffer.from("auth-entry-preimage").toString("base64");

function smartAccount(
  signAuthEntry = vi.fn(async (entry: string) => ({ signedAuthEntry: entry })),
) {
  return createSmartAccountSigner({ contractId: CONTRACT, network: "testnet", signAuthEntry });
}

async function thrown(run: () => unknown): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

describe("createKeypairSigner (#205)", () => {
  it("accepts a secret string or a Keypair and supports every model", () => {
    const agent = Keypair.random();
    for (const signer of [
      createKeypairSigner(agent.secret(), "testnet"),
      createKeypairSigner(agent, "testnet"),
    ]) {
      expect(signer.address).toBe(agent.publicKey());
      expect(signer.network).toBe("testnet");
      expect(signerModels(signer)).toEqual(["x402", "mpp-charge", "mpp-channel"]);
      expect(signer.capabilities.mppCharge?.keypair().publicKey()).toBe(agent.publicKey());
      expect(signer.capabilities.mppChannel?.keypair().publicKey()).toBe(agent.publicKey());
    }
  });

  it("signs x402 auth entries with the agent's key", async () => {
    const agent = Keypair.random();
    const x402 = createKeypairSigner(agent, "testnet").capabilities.x402;
    expect(isClientStellarSigner(x402)).toBe(true);
    const signed = await x402?.signAuthEntry(ENTRY);
    const signature = Buffer.from(signed?.signedAuthEntry ?? "", "base64");
    expect(agent.verify(hash(Buffer.from(ENTRY, "base64")), signature)).toBe(true);
  });

  it("keeps the secret off every serialisable field", () => {
    const agent = Keypair.random();
    const signer = createKeypairSigner(agent.secret(), "testnet");
    const serialised = JSON.stringify(signer);
    expect(serialised).not.toContain(agent.secret());
    // The raw key bytes would show up as a Buffer's JSON form.
    expect(serialised).not.toContain('"type":"Buffer"');
    expect(Object.keys(signer).sort()).toEqual(["address", "capabilities", "network"]);
  });

  it("never echoes a bad secret in the error", async () => {
    const secretLike = `S${"A".repeat(55)}`;
    const error = await thrown(() => createKeypairSigner(secretLike, "testnet"));
    expect(error).toBeInstanceOf(TollwayError);
    expect((error as TollwayError).code).toBe("invalid-signing-key");
    expect((error as Error).message).not.toContain(secretLike);
  });

  it("refuses a public-only keypair, which cannot sign", () => {
    const publicOnly = Keypair.fromPublicKey(Keypair.random().publicKey());
    expect(() => createKeypairSigner(publicOnly, "testnet")).toThrow(/has no secret/);
  });
});

describe("createSmartAccountSigner (#205)", () => {
  it("adapts the caller's signAuthEntry to a ClientStellarSigner for x402 only", async () => {
    const signAuthEntry = vi.fn(async (entry: string) => ({ signedAuthEntry: `signed:${entry}` }));
    const signer = smartAccount(signAuthEntry);

    expect(signer.address).toBe(CONTRACT);
    expect(signerModels(signer)).toEqual(["x402"]);
    expect(isClientStellarSigner(signer.capabilities.x402)).toBe(true);
    expect(signer.capabilities.mppCharge).toBeUndefined();
    expect(signer.capabilities.mppChannel).toBeUndefined();

    await expect(signer.capabilities.x402?.signAuthEntry(ENTRY)).resolves.toEqual({
      signedAuthEntry: `signed:${ENTRY}`,
    });
    expect(signAuthEntry).toHaveBeenCalledWith(ENTRY);
  });

  it("refuses an address that is not a contract", () => {
    expect(() =>
      createSmartAccountSigner({
        contractId: Keypair.random().publicKey(),
        network: "testnet",
        signAuthEntry: async (entry) => ({ signedAuthEntry: entry }),
      }),
    ).toThrow(/not a Stellar contract address/);
  });
});

describe("settlers check the signer's capabilities (#205)", () => {
  it("the x402 settler takes an AgentSigner and pays from its address", () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(createX402Settler({ signer: smartAccount(), network: "testnet", fetch }).payer).toBe(
      CONTRACT,
    );
    const agent = Keypair.random();
    expect(
      createX402Settler({
        signer: createKeypairSigner(agent, "testnet"),
        network: "testnet",
        fetch,
      }).payer,
    ).toBe(agent.publicKey());
    expect(fetch).not.toHaveBeenCalled();
  });

  it("the MPP charge settler refuses a signer without mppCharge before any request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const error = await thrown(() =>
      createMppChargeSettler({ signer: smartAccount(), network: "testnet", fetch }),
    );
    expect(error).toBeInstanceOf(SignerCapabilityError);
    expect((error as SignerCapabilityError).capability).toBe("mppCharge");
    expect((error as Error).message).toContain("no mppCharge capability");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("the x402 settler refuses a signer without x402 before any request", async () => {
    // A signer that only holds an MPP key, as a custom signer might.
    const mppOnly: AgentSigner = {
      address: Keypair.random().publicKey(),
      network: "testnet",
      capabilities: { mppCharge: { keypair: () => Keypair.random() } },
    };
    const fetch = vi.fn<typeof globalThis.fetch>();
    const error = await thrown(() =>
      createX402Settler({ signer: mppOnly, network: "testnet", fetch }),
    );
    expect(error).toBeInstanceOf(SignerCapabilityError);
    expect((error as SignerCapabilityError).capability).toBe("x402");
    expect(signerModels(mppOnly)).toEqual(["mpp-charge"]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("the MPP charge settler pays from a keypair signer's address", () => {
    const agent = Keypair.random();
    const settler = createMppChargeSettler({
      signer: createKeypairSigner(agent, "testnet"),
      network: "testnet",
      fetch: vi.fn<typeof globalThis.fetch>(),
    });
    expect(settler.payer).toBe(agent.publicKey());
  });

  it("refuses a signer on another network", () => {
    const mainnet = createKeypairSigner(Keypair.random(), "mainnet");
    expect(() => createX402Settler({ signer: mainnet, network: "testnet" })).toThrow(
      /configured for testnet, but the signer is on mainnet/,
    );
    expect(() => createMppChargeSettler({ signer: mainnet, network: "testnet" })).toThrow(
      /configured for testnet, but the signer is on mainnet/,
    );
  });
});
