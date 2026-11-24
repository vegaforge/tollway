import { createServer, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import type { Gate } from "./gate.js";
import {
  type HoldResult,
  holdNodeResponse,
  readBodyWithin,
  responseTooLarge,
  settlementTiming,
  twoPhaseAuthorizer,
} from "./two-phase.js";

function stream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("readBodyWithin", () => {
  it("reads a body up to and including the limit", async () => {
    const result = await readBodyWithin(stream(["abc", "def"]), 6);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(new TextDecoder().decode(result.bytes)).toBe("abcdef");
  });

  it("stops and cancels the stream one byte past the limit", async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(encoder.encode("0123456789"));
      },
      cancel() {
        cancelled = true;
      },
    });

    expect(await readBodyWithin(body, 15)).toEqual({ ok: false });
    expect(cancelled).toBe(true);
  });

  it("reads no body as empty", async () => {
    const result = await readBodyWithin(null, 1);

    expect(result).toEqual({ ok: true, bytes: new Uint8Array(0) });
  });
});

describe("settlementTiming and twoPhaseAuthorizer", () => {
  const handWritten: Gate = async () => ({ kind: "rejected", status: 500, reason: "x" });

  it("defaults to settling before the handler", () => {
    expect(settlementTiming(undefined)).toBe("before-handler");
    expect(twoPhaseAuthorizer(handWritten, undefined)).toBeUndefined();
  });

  it("refuses an unknown timing", () => {
    expect(() => settlementTiming({ settlement: "later" as unknown as "after-handler" })).toThrow(
      TypeError,
    );
  });

  it("refuses after-handler for a gate without authorize", () => {
    expect(() => twoPhaseAuthorizer(handWritten, { settlement: "after-handler" })).toThrow(
      /authorize/,
    );
  });

  it("names the limit in the too-large rejection", () => {
    expect(responseTooLarge(64)).toMatchObject({ kind: "rejected", status: 500 });
    expect(responseTooLarge(64).reason).toContain("64 bytes");
  });
});

/**
 * Serves one request with `route` writing to a held response, and `decide`
 * finishing it once the hold resolves.
 */
async function holdOnce(
  maxBytes: number,
  route: (res: ServerResponse) => void,
  decide: (held: ReturnType<typeof holdNodeResponse>, result: HoldResult) => void,
  abort = false,
) {
  let resolveResult: (result: HoldResult) => void = () => {};
  const finished = new Promise<HoldResult>((resolve) => {
    resolveResult = resolve;
  });
  const server = createServer((_req, res) => {
    const held = holdNodeResponse(res, maxBytes);
    route(res);
    void held.done.then((result) => {
      decide(held, result);
      resolveResult(result);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a TCP address");
  const controller = new AbortController();
  const response = fetch(`http://127.0.0.1:${address.port}/`, { signal: controller.signal });
  try {
    if (abort) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      controller.abort();
      await response.catch(() => undefined);
      return { result: await finished, response: undefined };
    }
    const answered = await response;
    return { result: await finished, response: answered, body: await answered.text() };
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

describe("holdNodeResponse", () => {
  it("sends nothing until released, then the route's status, headers and body plus extras", async () => {
    const { result, response, body } = await holdOnce(
      100,
      (res) => {
        res.writeHead(202, [
          ["x-pair", "1"],
          ["content-type", "text/plain"],
        ]);
        res.flushHeaders();
        res.write("hello ");
        res.end(Buffer.from("world"));
      },
      (held) => held.release({ "payment-response": "abc" }),
    );

    expect(result).toBe("ended");
    expect(response?.status).toBe(202);
    expect(response?.headers.get("x-pair")).toBe("1");
    expect(response?.headers.get("payment-response")).toBe("abc");
    expect(body).toBe("hello world");
  });

  it("decodes a chunk written in another encoding", async () => {
    const { body } = await holdOnce(
      100,
      (res) => res.end(Buffer.from("paid").toString("base64"), "base64"),
      (held) => held.release(),
    );

    expect(body).toBe("paid");
  });

  it("reports too-large as soon as the body passes the limit, and drops later writes", async () => {
    const { result, response, body } = await holdOnce(
      8,
      (res) => {
        res.write("0123456789");
        res.write("more");
        res.end("end");
      },
      (held) => held.replace(500, { error: "too big" }),
    );

    expect(result).toBe("too-large");
    expect(response?.status).toBe(500);
    expect(JSON.parse(body ?? "")).toEqual({ error: "too big" });
  });

  it("drops the route's headers when it replaces the response", async () => {
    const { response } = await holdOnce(
      100,
      (res) => {
        res.setHeader("x-secret", "1");
        res.end("{}");
      },
      (held) => held.replace(502, { error: "tx failed" }, { "retry-after": "1" }),
    );

    expect(response?.status).toBe(502);
    expect(response?.headers.get("x-secret")).toBeNull();
    expect(response?.headers.get("retry-after")).toBe("1");
  });

  it("reports closed when the client leaves before the route ends", async () => {
    const { result } = await holdOnce(
      100,
      (res) => res.write("partial"),
      () => {},
      true,
    );

    expect(result).toBe("closed");
  });
});
