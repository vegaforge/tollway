import type { ShapeId } from "./shapes";

/**
 * Plain-language notes for each field, keyed by path with array indexes
 * written as `[]`. The wording follows the TSDoc in
 * `packages/core/src/types.ts`, `packages/core/src/receipt/schema.ts` and the
 * x402 V2 types in `@x402/core/types`.
 */
const requirementFields: Record<string, string> = {
  scheme: 'Payment scheme. Stellar uses "exact": pay exactly the amount.',
  network: "CAIP-2 network id: stellar:testnet or stellar:pubnet.",
  amount: "Price as an integer string in the asset's smallest unit. Stellar USDC has 7 decimals.",
  asset: "Asset contract address the payment is made in.",
  payTo: "Stellar address the payment settles to. Tollway never holds the funds.",
  maxTimeoutSeconds: "How long the signed payment stays valid, in seconds.",
  extra: "Scheme-specific details, opaque to the client.",
};

function prefixed(prefix: string, fields: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(fields).map(([path, note]) => [`${prefix}.${path}`, note]),
  );
}

const resourceFields: Record<string, string> = {
  resource: "What is being paid for.",
  "resource.url": "URL of the paid resource.",
  "resource.description": "Human-readable description of the resource.",
  "resource.mimeType": "Media type the resource responds with.",
};

const explanations: Record<ShapeId, Record<string, string>> = {
  "x402-payment-required": {
    x402Version: "x402 protocol version. V2 uses the PAYMENT-* header names.",
    error: "Why the previous payment attempt failed, if there was one.",
    ...resourceFields,
    accepts: "Payment options the service accepts. The client picks one.",
    ...prefixed("accepts[]", requirementFields),
    extensions: "Optional x402 extensions the service supports.",
  },
  "x402-payment-payload": {
    x402Version: "x402 protocol version the payment was built for.",
    ...resourceFields,
    accepted: "The payment option from the challenge this payment answers.",
    ...prefixed("accepted", requirementFields),
    payload: "Scheme-specific signed payment. Treat it as sensitive.",
    "payload.transaction":
      "Base64 Stellar transaction envelope carrying the signed Soroban authorization.",
    extensions: "Optional x402 extension data.",
  },
  "x402-settle-response": {
    success: "Whether the facilitator settled the payment.",
    errorReason: "Machine-readable reason settlement failed.",
    errorMessage: "Human-readable reason settlement failed.",
    payer: "Address that paid.",
    transaction: "Hash of the settlement transaction on chain.",
    network: "CAIP-2 network the payment settled on.",
    amount: "Amount actually settled, as an integer string, when it can differ from the offer.",
    extensions: "Optional x402 extension data.",
    extra: "Facilitator-specific details.",
  },
  "tollway-offer": {
    resource: "URL or stable identifier of the thing being sold.",
    amount: "Price as an integer string in the asset's smallest unit.",
    asset: 'Asset identifier, for example "USDC:GA5Z...".',
    payTo: "Stellar address the payment settles to. Tollway never sits in between.",
    network: "Tollway network name: testnet or mainnet.",
    models: "Settlement models the service accepts, in its order of preference.",
    "models[]": "One settlement model: x402, mpp-charge or mpp-channel.",
    mppSessionSupported: "Routing hint: the service can open an MPP session.",
    facilitatorUrl: "Base URL of the facilitator the service settles through.",
  },
  "tollway-receipt": {
    receipt: "The receipt body. The signature covers exactly these fields.",
    "receipt.version": "Receipt format version.",
    "receipt.id": "Unique per receipt, so a replayed receipt can be detected.",
    "receipt.payer": "Who paid.",
    "receipt.payee": "Who was paid.",
    "receipt.amount": "Amount paid, as an integer string in the asset's smallest unit.",
    "receipt.asset": "Asset the payment was made in.",
    "receipt.resource": "URL or stable identifier of what was paid for.",
    "receipt.model": "Settlement model used: x402, mpp-charge or mpp-channel.",
    "receipt.settlement": "Where the payment is anchored on chain.",
    "receipt.settlement.kind":
      "transaction for x402 and MPP charge, channel-commitment for channels.",
    "receipt.settlement.txHash": "Stellar transaction hash of the settlement.",
    "receipt.settlement.channelId": "Payment channel the commitment belongs to.",
    "receipt.settlement.sequence": "Position in the channel's commitment stream.",
    "receipt.network": "Tollway network name: testnet or mainnet.",
    "receipt.issuedAt": "When the receipt was issued, ISO 8601 in UTC.",
    signature: "Signature over the canonical bytes of the receipt body.",
    "signature.keyId": "Identifies the signing key, so keys can rotate.",
    "signature.algorithm": "Signature algorithm, Ed25519 by default.",
    "signature.value": "The signature, base64url.",
  },
};

export type FieldRow = {
  path: string;
  value: string;
  explanation: string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function display(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * Flattens a decoded value into one row per leaf field, each with its note.
 * A field the shape does not define gets a note that says so, which is how a
 * typo in a hand-built header shows up.
 */
export function explainFields(shape: ShapeId, value: unknown): FieldRow[] {
  const notes = explanations[shape];
  const rows: FieldRow[] = [];

  function noteFor(path: string): string {
    const generic = path.replace(/\[\d+\]/g, "[]");
    return notes[generic] ?? "Not a field of this shape.";
  }

  function walk(path: string, node: unknown): void {
    if (isPlainObject(node) && Object.keys(node).length > 0) {
      for (const [key, child] of Object.entries(node)) {
        walk(path === "" ? key : `${path}.${key}`, child);
      }
      return;
    }
    if (Array.isArray(node) && node.length > 0 && node.some(isPlainObject)) {
      node.forEach((child, index) => {
        walk(`${path}[${index}]`, child);
      });
      return;
    }
    rows.push({
      path: path === "" ? "(root)" : path,
      value: display(node),
      explanation: noteFor(path),
    });
  }

  walk("", value);
  return rows;
}
