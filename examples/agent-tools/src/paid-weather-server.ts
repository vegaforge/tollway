/**
 * A paid MCP tool in mock mode, speaking the x402 MCP transport the way a
 * Tollway gate does (#206): an unpaid call gets `isError: true` with the
 * `PaymentRequired` challenge, and a paid call gets the tool result with the
 * signed Tollway receipt in `_meta["tollway/receipt"]`.
 *
 * Nothing is settled on chain. The mock accepts any payment that accepts
 * exactly the offered terms, as the repository's mock facilitator does, and
 * signs a receipt for it.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  TOLLWAY_MCP_RECEIPT_META_KEY,
  X402_MCP_PAYMENT_META_KEY,
  X402_MCP_PAYMENT_RESPONSE_META_KEY,
} from "@vegaforge/tollway-client/mcp";
import { buildReceipt, type Ed25519Signer, signReceipt } from "@vegaforge/tollway-core";
import type { PaymentRequired } from "@x402/core/types";
import { z } from "zod";

/** Testnet USDC's Stellar Asset Contract. */
export const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
/** 0.0005 USDC, in USDC's smallest unit (7 decimals). */
export const FORECAST_PRICE = "5000";
export const FORECAST_RESOURCE = "mcp://tool/forecast";

const acceptedPaymentSchema = z.object({
  accepted: z.object({
    scheme: z.literal("exact"),
    network: z.literal("stellar:testnet"),
    amount: z.string(),
    asset: z.string(),
    payTo: z.string(),
  }),
});

export type PaidWeatherServerOptions = {
  /** The service's receipt signing key. */
  signer: Ed25519Signer;
  /** The Stellar address the forecast is paid to. */
  payTo: string;
  /** The agent address the receipts name as payer. */
  payer: string;
};

export function createPaidWeatherServer(options: PaidWeatherServerOptions): McpServer {
  const server = new McpServer({ name: "paid-weather", version: "1.0.0" });
  const challenge: PaymentRequired = {
    x402Version: 2,
    resource: { url: FORECAST_RESOURCE, description: "A three-day forecast" },
    accepts: [
      {
        scheme: "exact",
        network: "stellar:testnet",
        amount: FORECAST_PRICE,
        asset: USDC,
        payTo: options.payTo,
        maxTimeoutSeconds: 60,
        extra: {},
      },
    ],
  };
  let settled = 0;

  server.registerTool(
    "forecast",
    { description: "A three-day forecast for a city", inputSchema: { city: z.string() } },
    async ({ city }, extra) => {
      const payment = acceptedPaymentSchema.safeParse(extra._meta?.[X402_MCP_PAYMENT_META_KEY]);
      const offered = challenge.accepts[0];
      const paysTheOffer =
        payment.success &&
        offered !== undefined &&
        payment.data.accepted.amount === offered.amount &&
        payment.data.accepted.asset === offered.asset &&
        payment.data.accepted.payTo === offered.payTo;
      if (!paysTheOffer) {
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify(challenge) }],
          structuredContent: challenge,
        };
      }

      settled += 1;
      const txHash = settled.toString(16).padStart(64, "0");
      const receipt = await signReceipt(
        buildReceipt({
          model: "x402",
          network: "testnet",
          payer: options.payer,
          payee: options.payTo,
          amount: FORECAST_PRICE,
          asset: USDC,
          resource: FORECAST_RESOURCE,
          settlement: { kind: "transaction", txHash },
        }),
        options.signer,
      );
      return {
        content: [{ type: "text", text: `${city}: sunny, 31C; cloudy, 29C; rain, 26C` }],
        _meta: {
          [X402_MCP_PAYMENT_RESPONSE_META_KEY]: { success: true, transaction: txHash },
          [TOLLWAY_MCP_RECEIPT_META_KEY]: receipt,
        },
      };
    },
  );
  return server;
}
