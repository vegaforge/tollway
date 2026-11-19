import { withPaywall } from "@vegaforge/tollway-adapter-next";
import { createMockFacilitator, createPaywall } from "@vegaforge/tollway-server";
import { MockReceiptSigner } from "../../../src/mock-signer.js";

if ((process.env.MOCK_MODE ?? "true") !== "true")
  throw new Error("Bring a signer and facilitator before disabling mock mode.");
export const signer = new MockReceiptSigner();
const network = process.env.TOLLWAY_NETWORK ?? "testnet";
if (network !== "testnet" && network !== "mainnet")
  throw new Error("TOLLWAY_NETWORK must be testnet or mainnet");
const gatePromise = Promise.resolve(
  createPaywall(
    {
      amount: "10000",
      asset:
        process.env.TOLLWAY_ASSET ??
        "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      payTo:
        process.env.TOLLWAY_PAY_TO ?? "GSERVICEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      network,
    },
    { signer, facilitator: createMockFacilitator() },
  ),
);

export async function GET(request: Request): Promise<Response> {
  return withPaywall(await gatePromise, async (_request, { receipt }) =>
    Response.json({ message: "Paid route reached", receiptId: receipt.receipt.id }),
  )(request);
}
