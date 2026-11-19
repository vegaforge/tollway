import { honoPaywall } from "@vegaforge/tollway-adapter-hono";
import { createMockFacilitator, createPaywall } from "@vegaforge/tollway-server";
import { Hono } from "hono";
import { MockReceiptSigner } from "./mock-signer.js";

if ((process.env.MOCK_MODE ?? "true") !== "true")
  throw new Error("Bring a signer and facilitator before disabling mock mode.");
const signer = new MockReceiptSigner();
const network = process.env.TOLLWAY_NETWORK ?? "testnet";
if (network !== "testnet" && network !== "mainnet")
  throw new Error("TOLLWAY_NETWORK must be testnet or mainnet");
const gate = createPaywall(
  {
    amount: "10000",
    asset:
      process.env.TOLLWAY_ASSET ?? "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    payTo: process.env.TOLLWAY_PAY_TO ?? "GSERVICEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    network,
  },
  { signer, facilitator: createMockFacilitator() },
);
export const app = new Hono();
app.get("/api/paid", honoPaywall(gate), (context) =>
  context.json({ message: "Paid route reached" }),
);

export { signer };
