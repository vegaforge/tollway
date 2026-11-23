import { TollwayError } from "@vegaforge/tollway-core";
import { describe, expect, it, vi } from "vitest";
import { createMockFacilitator, type FacilitatorClient } from "./facilitator.js";
import {
  createFacilitatorValidator,
  describeMismatches,
  type FacilitatorCapabilities,
  FacilitatorCheckError,
  type FacilitatorCheckReport,
  type PaywallTarget,
  parseFacilitatorCapabilities,
  validatePaywall,
} from "./facilitator-capabilities.js";

/**
 * Issue #155 coverage:
 * - `/supported` is schema-checked at the boundary, and a malformed body
 *   raises `facilitator-invalid-response` naming the field.
 * - `validatePaywall` rejects EVM-only `exact`, an old `x402Version`, a
 *   `CODE:ISSUER` asset, a bad `payTo` and a paywall `extra` that disagrees
 *   with the kind's, and accepts the `stellar:*` wildcard.
 * - The validator caches `/supported`, defaults to `fail`, throws a typed
 *   error in `fail`, reports through `onWarn` in `warn`, and never turns an
 *   unavailable facilitator into a success.
 */

const STELLAR_USDC_TESTNET_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const STELLAR_DESTINATION = "GCKFBEIYTKP5RDBQMUTAPDCAIVMOLKZYNYKRJHAEWHJDYUGSA3FDQQ3V";
const ROUTE = "GET /quote";

function paywall(overrides: Partial<PaywallTarget> = {}): PaywallTarget {
  return {
    asset: STELLAR_USDC_TESTNET_SAC,
    payTo: STELLAR_DESTINATION,
    network: "testnet",
    models: ["x402"],
    extra: { areFeesSponsored: true },
    ...overrides,
  };
}

function capabilities(overrides: Partial<FacilitatorCapabilities> = {}): FacilitatorCapabilities {
  return {
    kinds: [
      {
        x402Version: 2,
        scheme: "exact",
        network: "stellar:testnet",
        extra: { areFeesSponsored: true },
      },
    ],
    extensions: [],
    signers: {},
    ...overrides,
  };
}

function facilitatorReturning(
  supported: () => Promise<FacilitatorCapabilities>,
): FacilitatorClient & { supported: ReturnType<typeof vi.fn> } {
  return {
    verify: vi.fn(),
    settle: vi.fn(),
    supported: vi.fn(supported),
  };
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(TollwayError);
    expect((error as TollwayError).code).toBe(code);
    return;
  }
  throw new Error(`expected a TollwayError with code ${code}`);
}

describe("parseFacilitatorCapabilities", () => {
  it("round-trips a well-formed response", () => {
    const raw = {
      kinds: [
        {
          x402Version: 2,
          scheme: "exact",
          network: "stellar:testnet",
          extra: { areFeesSponsored: true },
        },
      ],
      extensions: ["offer-receipt"],
      signers: { "stellar:testnet": ["GSIGNER"] },
    };
    expect(parseFacilitatorCapabilities(raw)).toEqual(raw);
  });

  it("rejects a non-object response", () => {
    expectCode(() => parseFacilitatorCapabilities(null), "facilitator-invalid-response");
    expectCode(() => parseFacilitatorCapabilities("nope"), "facilitator-invalid-response");
  });

  it("rejects a response with no `kinds` array", () => {
    expect(() => parseFacilitatorCapabilities({})).toThrow(/kinds/);
  });

  it("names the offending field on malformed kinds", () => {
    expect(() =>
      parseFacilitatorCapabilities({
        kinds: [{ x402Version: "2", scheme: "exact", network: "x" }],
      }),
    ).toThrow(/kinds\.0\.x402Version/);
    expect(() =>
      parseFacilitatorCapabilities({ kinds: [{ x402Version: 2, scheme: "", network: "x" }] }),
    ).toThrow(/kinds\.0\.scheme/);
    expect(() =>
      parseFacilitatorCapabilities({
        kinds: [{ x402Version: 2, scheme: "exact", network: "x", extra: [] }],
      }),
    ).toThrow(/kinds\.0\.extra/);
  });

  it("rejects a fractional x402Version", () => {
    expect(() =>
      parseFacilitatorCapabilities({
        kinds: [{ x402Version: 2.5, scheme: "exact", network: "x" }],
      }),
    ).toThrow(/x402Version/);
  });

  it("treats missing `extensions` and `signers` as empty", () => {
    expect(parseFacilitatorCapabilities({ kinds: [] })).toEqual({
      kinds: [],
      extensions: [],
      signers: {},
    });
  });

  it("rejects malformed entries instead of dropping them", () => {
    expect(() => parseFacilitatorCapabilities({ kinds: [], extensions: "x" })).toThrow(
      /extensions/,
    );
    expect(() => parseFacilitatorCapabilities({ kinds: [], extensions: ["ok", 7] })).toThrow(
      /extensions\.1/,
    );
    expect(() => parseFacilitatorCapabilities({ kinds: [], signers: [] })).toThrow(/signers/);
    expect(() =>
      parseFacilitatorCapabilities({ kinds: [], signers: { "stellar:testnet": ["G", 1] } }),
    ).toThrow(/signers\.stellar:testnet\.1/);
  });
});

describe("validatePaywall", () => {
  it("accepts the testnet CAIP-2 kind", () => {
    expect(validatePaywall(ROUTE, paywall(), capabilities())).toEqual({ status: "valid" });
  });

  it("accepts the stellar:* wildcard", () => {
    const caps = capabilities({
      kinds: [
        {
          x402Version: 2,
          scheme: "exact",
          network: "stellar:*",
          extra: { areFeesSponsored: true },
        },
      ],
    });
    expect(validatePaywall(ROUTE, paywall(), caps)).toEqual({ status: "valid" });
  });

  it("rejects an EVM-only facilitator for a Stellar paywall", () => {
    const caps = capabilities({
      kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }],
    });
    const result = validatePaywall(ROUTE, paywall(), caps);
    expect(result).toMatchObject({
      status: "mismatch",
      mismatches: [{ route: ROUTE, field: "network", expected: "stellar:testnet or stellar:*" }],
    });
  });

  it("rejects an advertised x402Version other than 2", () => {
    const caps = capabilities({
      kinds: [{ x402Version: 1, scheme: "exact", network: "stellar:testnet" }],
    });
    const result = validatePaywall(ROUTE, paywall(), caps);
    expect(result.status).toBe("mismatch");
    expect(result.status === "mismatch" && result.mismatches[0]).toMatchObject({
      field: "x402Version",
      expected: "2",
      advertised: "1",
    });
  });

  it("rejects the CODE:ISSUER asset form", () => {
    const result = validatePaywall(
      ROUTE,
      paywall({ asset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" }),
      capabilities(),
    );
    expect(result).toMatchObject({ status: "mismatch", mismatches: [{ field: "asset" }] });
  });

  it("rejects an invalid payTo", () => {
    const result = validatePaywall(ROUTE, paywall({ payTo: "GNOTANADDRESS" }), capabilities());
    expect(result).toMatchObject({ status: "mismatch", mismatches: [{ field: "payTo" }] });
  });

  it("rejects a paywall whose areFeesSponsored disagrees with the kind", () => {
    const result = validatePaywall(
      ROUTE,
      paywall({ extra: { areFeesSponsored: false } }),
      capabilities(),
    );
    expect(result).toMatchObject({
      status: "mismatch",
      mismatches: [{ field: "extra.areFeesSponsored", expected: "false", advertised: "true" }],
    });
  });

  it("rejects a paywall that omits areFeesSponsored when the kind sets it", () => {
    // The @x402/stellar client refuses to build a payment unless the
    // requirements carry the flag, so an unset value cannot work.
    const result = validatePaywall(ROUTE, paywall({ extra: {} }), capabilities());
    expect(result).toMatchObject({
      status: "mismatch",
      mismatches: [{ field: "extra.areFeesSponsored", expected: "unset", advertised: "true" }],
    });
  });

  it("rejects a paywall that sets areFeesSponsored when the kind does not advertise it", () => {
    const caps = capabilities({
      kinds: [{ x402Version: 2, scheme: "exact", network: "stellar:testnet" }],
    });
    const result = validatePaywall(ROUTE, paywall(), caps);
    expect(result).toMatchObject({
      status: "mismatch",
      mismatches: [{ field: "extra.areFeesSponsored", expected: "true", advertised: "unset" }],
    });
  });

  it("is not applicable to a paywall that does not offer x402", () => {
    // MPP charge settles without a facilitator, so /supported says nothing about it.
    expect(validatePaywall(ROUTE, paywall({ models: ["mpp-charge"] }), capabilities())).toEqual({
      status: "not-applicable",
      reason: "the paywall does not offer x402, the only model a facilitator settles",
    });
  });

  it("checks x402 when models is omitted, since x402 is the default", () => {
    const { models: _omitted, ...rest } = paywall({ payTo: "GNOTANADDRESS" });
    expect(validatePaywall(ROUTE, rest, capabilities()).status).toBe("mismatch");
  });
});

describe("createFacilitatorValidator", () => {
  it("defaults to fail mode and throws a typed error naming every mismatching route", async () => {
    const validator = createFacilitatorValidator(
      facilitatorReturning(async () =>
        capabilities({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }] }),
      ),
    );
    const error = await validator
      .check({ "GET /a": paywall(), "GET /b": paywall() })
      .then(() => undefined)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FacilitatorCheckError);
    const checkError = error as FacilitatorCheckError;
    expect(checkError.code).toBe("facilitator-unsupported");
    expect(checkError.report.status).toBe("mismatch");
    expect(checkError.message).toMatch(/route="GET \/a"/);
    expect(checkError.message).toMatch(/route="GET \/b"/);
  });

  it("in fail mode refuses to start when the facilitator is unavailable", async () => {
    const validator = createFacilitatorValidator(
      facilitatorReturning(async () => {
        throw new TollwayError(
          "payment-failed",
          "facilitator /supported request failed: ECONNREFUSED",
        );
      }),
      { mode: "fail" },
    );
    await expect(validator.check({ [ROUTE]: paywall() })).rejects.toMatchObject({
      code: "facilitator-unavailable",
      report: { status: "unavailable" },
    });
  });

  it("in fail mode resolves with the report when every route is valid", async () => {
    const validator = createFacilitatorValidator(facilitatorReturning(async () => capabilities()));
    const report = await validator.check({ [ROUTE]: paywall() });
    expect(report).toEqual({
      status: "ok",
      routes: { [ROUTE]: { status: "valid" } },
      mismatches: [],
    });
  });

  it("in warn mode reports an unavailable facilitator as unavailable, not valid", async () => {
    const onWarn = vi.fn<(report: FacilitatorCheckReport) => void>();
    const validator = createFacilitatorValidator(
      facilitatorReturning(async () => {
        throw new Error("ECONNREFUSED");
      }),
      { mode: "warn", onWarn },
    );
    const report = await validator.check({ [ROUTE]: paywall() });
    expect(report).toEqual({ status: "unavailable", reason: "ECONNREFUSED" });
    expect(onWarn).toHaveBeenCalledWith(report);
  });

  it("in warn mode reports mismatches through onWarn and resolves", async () => {
    const onWarn = vi.fn<(report: FacilitatorCheckReport) => void>();
    const validator = createFacilitatorValidator(
      facilitatorReturning(async () => capabilities()),
      { mode: "warn", onWarn },
    );
    const report = await validator.check({ [ROUTE]: paywall({ payTo: "GNOTANADDRESS" }) });
    expect(report.status).toBe("mismatch");
    expect(onWarn).toHaveBeenCalledOnce();
    expect(onWarn).toHaveBeenCalledWith(report);
  });

  it("in warn mode does not call onWarn when every route is valid", async () => {
    const onWarn = vi.fn();
    const validator = createFacilitatorValidator(
      facilitatorReturning(async () => capabilities()),
      { mode: "warn", onWarn },
    );
    expect((await validator.check({ [ROUTE]: paywall() })).status).toBe("ok");
    expect(onWarn).not.toHaveBeenCalled();
  });

  it("in off mode skips the check without calling the facilitator", async () => {
    const facilitator = facilitatorReturning(async () => capabilities());
    const validator = createFacilitatorValidator(facilitator, { mode: "off" });
    expect(await validator.check({ [ROUTE]: paywall({ payTo: "bad" }) })).toEqual({
      status: "skipped",
    });
    expect(facilitator.supported).not.toHaveBeenCalled();
  });

  it("caches /supported for the TTL and fetches again afterwards", async () => {
    let now = 0;
    const facilitator = facilitatorReturning(async () => capabilities());
    const validator = createFacilitatorValidator(facilitator, { ttlMs: 1_000, clock: () => now });
    await validator.check({ [ROUTE]: paywall() });
    now = 999;
    await validator.check({ [ROUTE]: paywall() });
    expect(facilitator.supported).toHaveBeenCalledTimes(1);
    now = 1_000;
    await validator.check({ [ROUTE]: paywall() });
    expect(facilitator.supported).toHaveBeenCalledTimes(2);
  });

  it("notices a facilitator deploy that drops a network once the cache is refreshed", async () => {
    let advertised = capabilities();
    const validator = createFacilitatorValidator(
      facilitatorReturning(async () => advertised),
      {
        mode: "warn",
      },
    );
    expect((await validator.check({ [ROUTE]: paywall() })).status).toBe("ok");
    advertised = capabilities({
      kinds: [{ x402Version: 2, scheme: "exact", network: "stellar:pubnet" }],
    });
    expect((await validator.check({ [ROUTE]: paywall() })).status).toBe("ok");
    validator.refresh();
    expect((await validator.check({ [ROUTE]: paywall() })).status).toBe("mismatch");
  });

  it("rejects a TTL that is not a positive finite number", () => {
    const facilitator = facilitatorReturning(async () => capabilities());
    for (const ttlMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createFacilitatorValidator(facilitator, { ttlMs })).toThrow(TypeError);
    }
  });

  it("accepts the demo's live paywall against the mock facilitator", async () => {
    // The mock advertises what OpenZeppelin Channels does, so the mock demo
    // runs the same check the live demo does.
    const validator = createFacilitatorValidator(createMockFacilitator());
    expect((await validator.check({ [ROUTE]: paywall() })).status).toBe("ok");
  });
});

describe("describeMismatches", () => {
  it("lists every mismatch with route, field, expected and advertised", () => {
    expect(
      describeMismatches([
        { route: "GET /a", field: "asset", expected: "C...", advertised: "USDC:G" },
        { route: "GET /b", field: "payTo", expected: "G...", advertised: "bad" },
      ]),
    ).toBe(
      'route="GET /a" field=asset expected=C... advertised=USDC:G; route="GET /b" field=payTo expected=G... advertised=bad',
    );
  });
});
