import { createServer } from "node:http";
import { rpc } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { waitForHealthyRpc } from "./readiness.js";
import { listen } from "./tls-proxy.js";

/**
 * The harness self-test. It needs no Docker and no network, so it runs in
 * every `pnpm test`: a node that never answers must fail with a message that
 * names the URL and the deadline, within that deadline.
 */
describe("waitForHealthyRpc", () => {
  it("fails with a readable message when the node is unreachable within the deadline", async () => {
    // Bind a port and release it, so nothing is listening there.
    const probe = await listen(createServer(), "http");
    await probe.close();
    const server = new rpc.Server(`${probe.url}/rpc`, { allowHttp: true });

    const started = Date.now();
    const waiting = waitForHealthyRpc(server, { label: probe.url, deadlineMs: 1_500 });

    await expect(waiting).rejects.toThrow(
      new RegExp(`local Stellar RPC at ${probe.url} was not healthy within 1500 ms`),
    );
    // The deadline bounds the wait; a little slack covers the last poll.
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("fails fast when the node runs a passphrase the SDKs cannot sign for", async () => {
    const node = await listen(
      createServer((request, response) => {
        let body = "";
        request.on("data", (chunk: Buffer) => {
          body += chunk.toString("utf8");
        });
        request.on("end", () => {
          const { id, method } = JSON.parse(body) as { id: number; method: string };
          const result =
            method === "getHealth"
              ? { status: "healthy", latestLedger: 2, oldestLedger: 1, ledgerRetentionWindow: 1 }
              : { passphrase: "Standalone Network ; February 2017", protocolVersion: "23" };
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
        });
      }),
      "http",
    );
    try {
      const server = new rpc.Server(`${node.url}/rpc`, { allowHttp: true });
      await expect(
        waitForHealthyRpc(server, { label: node.url, deadlineMs: 5_000 }),
      ).rejects.toThrow(/runs "Standalone Network ; February 2017".*NETWORK_PASSPHRASE=/);
    } finally {
      await node.close();
    }
  });
});
