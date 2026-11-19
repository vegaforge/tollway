import { bytesToBase64Url } from "@vegaforge/tollway-core";
import { getServices } from "../../../lib/services";

// The key comes from the runtime environment, so the answer must never be
// prerendered at build time.
export const dynamic = "force-dynamic";

/**
 * Read-only: the public key receipts from this service verify against.
 * Temporary: #167 replaces this route with the well-known key set.
 */
export async function GET(): Promise<Response> {
  const { signer } = await getServices();
  return Response.json(
    {
      keyId: signer.keyId,
      algorithm: signer.algorithm,
      publicKey: bytesToBase64Url(signer.publicKey),
      note: "Temporary endpoint. Tollway issue #167 replaces it with the well-known key set.",
    },
    { headers: { "cache-control": "public, max-age=300" } },
  );
}
