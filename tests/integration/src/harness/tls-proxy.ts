import { readFile } from "node:fs/promises";
import type { createServer, IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";

/**
 * An HTTPS front for the quickstart RPC.
 *
 * quickstart serves Stellar RPC over plain HTTP. `@stellar/stellar-sdk`'s
 * `rpc.Server` refuses an `http:` URL unless the caller passes
 * `allowHttp: true`, and two of the SDKs under test never pass it:
 * `@x402/stellar` 2.31.0's client builds its transfer with
 * `contract.AssembledTransaction.build({ rpcUrl })`, and `@stellar/mpp` 0.7.1
 * calls `new rpc.Server(rpcUrl)`. Rather than patch either package, the suite
 * terminates TLS here with a per-run certificate that the test process trusts
 * through `NODE_EXTRA_CA_CERTS`, and forwards every request unchanged.
 */
export type TlsRpcProxy = {
  /** `https://127.0.0.1:<port>`; every path is forwarded to the upstream RPC URL. */
  url: string;
  close(): Promise<void>;
};

export async function startTlsRpcProxy(options: {
  upstreamRpcUrl: string;
  tlsCertPath: string;
  tlsKeyPath: string;
}): Promise<TlsRpcProxy> {
  const [cert, key] = await Promise.all([
    readFile(options.tlsCertPath),
    readFile(options.tlsKeyPath),
  ]);
  const server = createHttpsServer({ cert, key }, (request, response) => {
    forward(options.upstreamRpcUrl, request, response).catch((error: unknown) => {
      // The client sees a 502 with the cause, so a broken upstream reads as
      // such in the failing test instead of as a TLS or parse error.
      if (!response.headersSent) {
        response.writeHead(502, { "content-type": "text/plain" });
      }
      response.end(`upstream RPC request failed: ${errorMessage(error)}`);
    });
  });
  return listen(server, "https");
}

async function forward(
  upstreamRpcUrl: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readBody(request);
  const contentType = request.headers["content-type"];
  const upstream = await fetch(upstreamRpcUrl, {
    method: request.method ?? "POST",
    headers: contentType ? { "content-type": contentType } : {},
    body: body.length > 0 ? new Uint8Array(body) : undefined,
  });
  const payload = Buffer.from(await upstream.arrayBuffer());
  response.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "application/json",
  });
  response.end(payload);
}

export async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks);
}

/**
 * Listens on a random loopback port. The URL uses the IP, not `localhost`,
 * so a runner that resolves `localhost` to `::1` first still connects.
 */
export async function listen(
  server: ReturnType<typeof createServer> | ReturnType<typeof createHttpsServer>,
  scheme: "http" | "https",
): Promise<{ url: string; close(): Promise<void> }> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `${scheme}://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
