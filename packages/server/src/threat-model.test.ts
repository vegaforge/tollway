import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ed25519Signer } from "@vegaforge/tollway-core";
import { describe, expect, it } from "vitest";
import { createInMemorySettlementCache } from "./cache.js";
import { createMockFacilitator } from "./facilitator.js";
import { createPaywall, type PaywallConfig } from "./gate.js";
import { decodeHeader, encodePaymentSignatureHeader, PAYMENT_SIGNATURE_HEADER } from "./headers.js";

/** This file's directory, so the paths below do not depend on the working directory. */
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The repository root, found by walking up to `pnpm-workspace.yaml`. Paths
 * relative to the working directory break when the package runs from a
 * copy, as Stryker's mutation sandbox does (issue #247).
 */
function repositoryRoot(): string {
  let dir = HERE;
  while (!existsSync(join(dir, "pnpm-workspace.yaml"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("pnpm-workspace.yaml not found above this test");
    dir = parent;
  }
  return dir;
}

const config = {
  amount: "10000",
  asset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  payTo: "GSERVICEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  network: "testnet",
} satisfies PaywallConfig;

describe("TM-01 settled payment replay", () => {
  it("returns the prior receipt without settling again", async () => {
    const signer = await Ed25519Signer.generate();
    const inner = createMockFacilitator();
    let settlements = 0;
    const facilitator = {
      ...inner,
      async settle(input: Parameters<typeof inner.settle>[0]) {
        settlements++;
        return inner.settle(input);
      },
    };
    const gate = createPaywall(config, {
      signer,
      facilitator,
      cache: createInMemorySettlementCache(),
    });
    const request = {
      method: "GET",
      url: "/resource",
      headers: {
        [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader({
          x402Version: 2,
          accepted: {
            scheme: "exact",
            network: "stellar:testnet",
            asset: config.asset,
            amount: config.amount,
            payTo: config.payTo,
            maxTimeoutSeconds: 60,
            extra: {},
          },
          payload: { transaction: "one-payment" },
        }),
      },
    };
    const first = await gate(request);
    const replay = await gate(request);
    expect(first.kind).toBe("settled");
    expect(replay.kind).toBe("settled");
    expect(settlements).toBe(1);
  });
});

describe("TM-07 malformed payment header", () => {
  it("rejects malformed and oversized base64url JSON", () => {
    expect(() => decodeHeader("%%%not-json%%%")).toThrow();
    expect(() => decodeHeader("A".repeat(1_000_000))).toThrow();
  });
});

describe("threat model cross-check", () => {
  it("requires a matching test suite for every defended row", () => {
    const root = repositoryRoot();
    const model = readFileSync(join(root, "docs/threat-model.md"), "utf8");
    const suites = [
      readFileSync(join(HERE, "gate.test.ts"), "utf8"),
      readFileSync(join(HERE, "threat-model.test.ts"), "utf8"),
      readFileSync(join(root, "packages/core/src/receipt/receipt.test.ts"), "utf8"),
    ].join("\n");
    const defended = [...model.matchAll(/^\| (TM-\d+) \|.*\| defended \|$/gm)].map(
      (match) => match[1],
    );
    expect(defended.length).toBeGreaterThan(0);
    for (const id of defended)
      expect(suites, `${id} needs a matching test suite`).toContain(`describe("${id}`);
  });
});
