import type { Commitment } from "@vegaforge/tollway-channels";
import { describe, expect, it } from "vitest";

import {
  commitmentSteps,
  drawdownBasisPoints,
  fetchChannelDetail,
  scaleBasisPoints,
} from "./channel-detail";

function commitment(sequence: number, cumulativeAmount: string): Commitment {
  return { channelId: "ch-test", sequence, cumulativeAmount, commitment: "sig" };
}

describe("commitmentSteps", () => {
  it("measures the first step from zero and each later step from the one before", () => {
    const steps = commitmentSteps([commitment(0, "100"), commitment(1, "250")]);

    expect(steps.map((step) => step.deltaAmount)).toEqual(["100", "150"]);
    expect(steps.every((step) => step.issues.length === 0)).toBe(true);
  });

  it("flags a sequence gap", () => {
    const steps = commitmentSteps([commitment(0, "10"), commitment(2, "20")]);

    expect(steps[1]?.issues).toEqual(["sequence-gap"]);
  });

  it("flags a first commitment that does not start at sequence 0", () => {
    expect(commitmentSteps([commitment(1, "5")])[0]?.issues).toEqual(["sequence-gap"]);
  });

  it("flags a step whose cumulative amount falls, with a negative delta", () => {
    const steps = commitmentSteps([commitment(0, "100"), commitment(1, "90")]);

    expect(steps[1]).toMatchObject({ deltaAmount: "-10", issues: ["non-monotonic"] });
  });

  it("subtracts amounts above Number.MAX_SAFE_INTEGER exactly", () => {
    // MAX_SAFE_INTEGER is 9007199254740991. Both amounts are above it, and
    // Number arithmetic could not tell them apart.
    const steps = commitmentSteps([
      commitment(0, "9007199254740993"),
      commitment(1, "9007199254740995"),
    ]);

    expect(steps[1]?.deltaAmount).toBe("2");
  });
});

describe("scaleBasisPoints", () => {
  it("places an amount on the chart without float error above MAX_SAFE_INTEGER", () => {
    // 2^54 is well above the safe range. Half of it is 5000 basis points.
    const top = 18014398509481984n;

    expect(scaleBasisPoints(top / 2n, top)).toBe(5000);
    expect(scaleBasisPoints(top, top)).toBe(10000);
  });

  it("returns zero for a non-positive top instead of dividing by it", () => {
    expect(scaleBasisPoints(5n, 0n)).toBe(0);
  });
});

describe("drawdownBasisPoints", () => {
  it("returns committed over deposit in basis points", () => {
    expect(drawdownBasisPoints("1250000000", "5000000000")).toBe(2500n);
  });

  it("returns null for a zero deposit rather than a made-up percentage", () => {
    expect(drawdownBasisPoints("0", "0")).toBeNull();
  });
});

describe("fetchChannelDetail", () => {
  it("resolves null for a channel the source does not track", async () => {
    expect(await fetchChannelDetail("ch-missing")).toBeNull();
  });

  it("ends each stream on the channel's sequence and committed total", async () => {
    for (const id of ["ch-stripe-01", "ch-anthropic-02", "ch-openai-03", "ch-long-stream-05"]) {
      const detail = await fetchChannelDetail(id);
      const last = detail?.commitments.at(-1);

      expect(last?.sequence, id).toBe(detail?.channel.sequence);
      expect(last?.cumulativeAmount, id).toBe(detail?.channel.committed);
    }
  });

  it("keeps every stub stream strictly rising in cumulative amount", async () => {
    for (const id of ["ch-anthropic-02", "ch-long-stream-05", "ch-drift-06"]) {
      const detail = await fetchChannelDetail(id);
      const amounts = (detail?.commitments ?? []).map((c) => BigInt(c.cumulativeAmount));

      for (let i = 1; i < amounts.length; i += 1) {
        expect(amounts[i], `${id} step ${i}`).toBeGreaterThan(amounts[i - 1] ?? 0n);
      }
    }
  });

  it("includes a stream of hundreds of commitments", async () => {
    const detail = await fetchChannelDetail("ch-long-stream-05");

    expect(detail?.commitments.length).toBeGreaterThanOrEqual(200);
  });

  it("includes a closed channel that reconciled ok and a closed channel with drift", async () => {
    const clean = await fetchChannelDetail("ch-long-stream-05");
    const drifted = await fetchChannelDetail("ch-drift-06");

    expect(clean?.channel.status).toBe("closed");
    expect(clean?.reconciliation.status).toBe("ok");
    expect(drifted?.channel.status).toBe("closed");
    expect(drifted?.reconciliation.status).toBe("drift");
  });

  it("shows a sequence gap in the drifted stream", async () => {
    const drifted = await fetchChannelDetail("ch-drift-06");
    const issues = commitmentSteps(drifted?.commitments ?? []).flatMap((step) => step.issues);

    expect(issues).toContain("sequence-gap");
  });

  it("says a channel that was never reconciled was never reconciled", async () => {
    const detail = await fetchChannelDetail("ch-openai-03");

    expect(detail?.reconciliation).toEqual({ status: "never-reconciled" });
  });

  it("lists only the receipts that settle through this channel", async () => {
    const detail = await fetchChannelDetail("ch-openai-03");

    expect(detail?.receipts.map((row) => row.receipt.id)).toEqual(["rcpt-channel-openai-01"]);
  });
});
