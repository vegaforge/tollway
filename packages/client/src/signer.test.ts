import { Keypair } from "@stellar/stellar-sdk";
import { TollwayError } from "@vegaforge/tollway-core";
import { describe, expect, it, vi } from "vitest";
import { createMppChargeSettler } from "./mpp-charge-settler.js";
import {
  assertKeypairSigner,
  createKeypairSigner,
  createSmartAccountSigner,
  isKeypairSigner,
} from "./signer.js";
import { createX402Settler } from "./x402-settler.js";

const VALID_CONTRACT = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

describe("AgentSigner (#205)", () => {
  it("creates a keypair signer from a secretKey or Keypair", () => {
    const kp = Keypair.random();
    const fromSecret = createKeypairSigner({ secretKey: kp.secret(), network: "testnet" });
    const fromKeypair = createKeypairSigner({ keypair: kp, network: "testnet" });

    expect(fromSecret.kind).toBe("keypair");
    expect(fromSecret.address).toBe(kp.publicKey());
    expect(fromSecret.network).toBe("testnet");
    expect(fromSecret.x402.address).toBe(kp.publicKey());
    expect(isKeypairSigner(fromSecret)).toBe(true);

    expect(fromKeypair.address).toBe(kp.publicKey());
    expect(assertKeypairSigner(fromKeypair, "mpp-charge")).toBe(fromKeypair);
  });

  it("rejects invalid secret keys or ambiguous options", () => {
    const kp = Keypair.random();
    expect(() =>
      createKeypairSigner({ secretKey: kp.secret(), keypair: kp, network: "testnet" } as never),
    ).toThrow(TypeError);
    expect(() => createKeypairSigner({ secretKey: "NOT_A_SECRET", network: "testnet" })).toThrow(
      TollwayError,
    );
  });

  it("creates a smart-account signer for C... contract accounts", async () => {
    const signAuthEntry = vi.fn(async (entry: string) => ({
      signedAuthEntry: `signed:${entry}`,
    }));
    const signer = createSmartAccountSigner({
      address: VALID_CONTRACT,
      network: "testnet",
      signAuthEntry,
    });

    expect(signer.kind).toBe("smart-account");
    expect(signer.address).toBe(VALID_CONTRACT);
    expect(signer.x402.address).toBe(VALID_CONTRACT);
    expect(isKeypairSigner(signer)).toBe(false);

    const signed = await signer.x402.signAuthEntry("payload");
    expect(signed).toEqual({ signedAuthEntry: "signed:payload" });
    expect(signAuthEntry).toHaveBeenCalledWith("payload");
  });

  it("rejects non-contract addresses for smart-account signers", () => {
    const kp = Keypair.random();
    expect(() =>
      createSmartAccountSigner({
        address: kp.publicKey(),
        network: "testnet",
        signAuthEntry: async (e) => ({ signedAuthEntry: e }),
      }),
    ).toThrow(TollwayError);
  });

  it("wires smart-account signer into x402 settler and rejects it in MPP charge settler", () => {
    const smart = createSmartAccountSigner({
      address: VALID_CONTRACT,
      network: "testnet",
      signAuthEntry: async (e) => ({ signedAuthEntry: e }),
    });

    const x402Settler = createX402Settler({ signer: smart, network: "testnet" });
    expect(x402Settler.payer).toBe(VALID_CONTRACT);

    expect(() => createMppChargeSettler({ signer: smart, network: "testnet" })).toThrow(
      /requires a keypair signer/,
    );
  });

  it("rejects network mismatches between signer and settler", () => {
    const kp = createKeypairSigner({ keypair: Keypair.random(), network: "mainnet" });
    expect(() => createX402Settler({ signer: kp, network: "testnet" })).toThrow(
      /configured for testnet/,
    );
    expect(() => createMppChargeSettler({ signer: kp, network: "testnet" })).toThrow(
      /configured for testnet/,
    );
  });
});
