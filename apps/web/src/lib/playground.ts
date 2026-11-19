import {
  base64UrlToBytes,
  bytesToBase64Url,
  Ed25519Verifier,
  signedReceiptSchema,
  utf8Bytes,
  verifyReceipt,
  type SignedReceipt,
} from "@vegaforge/tollway-core";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
} from "@x402/core/http";
import { parsePaymentPayload, parsePaymentRequired } from "@x402/core/schemas";

export const MAX_HEADER_LENGTH = 64 * 1024;

export type HeaderName =
  | "PAYMENT-REQUIRED"
  | "PAYMENT-SIGNATURE"
  | "PAYMENT-RESPONSE"
  | "TOLLWAY-RECEIPT";

export type DecodedHeader = {
  header: HeaderName;
  encoding: "JSON" | "base64" | "base64url";
  shape: string;
  value: unknown;
  valid: boolean;
  errors: string[];
};

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

function decodeStandardBase64(text: string): unknown {
  const binary = atob(text);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return parseJson(new TextDecoder().decode(bytes));
}

function decodeBase64Url(text: string): unknown {
  return parseJson(new TextDecoder().decode(base64UrlToBytes(text)));
}

function describeValidation(header: HeaderName, value: unknown): {
  shape: string;
  valid: boolean;
  errors: string[];
} {
  if (header === "TOLLWAY-RECEIPT") {
    const parsed = signedReceiptSchema.safeParse(value);
    return parsed.success
      ? { shape: "Tollway signed receipt", valid: true, errors: [] }
      : {
          shape: "Unknown receipt shape",
          valid: false,
          errors: parsed.error.issues.map((issue) => String(issue.path.join(".") || "(root)") + ": " + issue.message),
        };
  }

  if (header === "PAYMENT-REQUIRED") {
    const parsed = parsePaymentRequired(value);
    if (parsed.success) {
      return { shape: "x402 PaymentRequired v" + parsed.data.x402Version, valid: true, errors: [] };
    }
    if (isRecord(value) && (Array.isArray(value.accepts) || Array.isArray(value.requirements))) {
      return { shape: "Tollway payment challenge", valid: true, errors: [] };
    }
    return {
      shape: "Unknown payment challenge shape",
      valid: false,
      errors: parsed.error.issues.map((issue) => String(issue.path.join(".") || "(root)") + ": " + issue.message),
    };
  }

  if (header === "PAYMENT-SIGNATURE") {
    const parsed = parsePaymentPayload(value);
    return parsed.success
      ? { shape: "x402 PaymentPayload v" + parsed.data.x402Version, valid: true, errors: [] }
      : {
          shape: "Unknown payment payload shape",
          valid: false,
          errors: parsed.error.issues.map((issue) => String(issue.path.join(".") || "(root)") + ": " + issue.message),
        };
  }

  if (header === "PAYMENT-RESPONSE") {
    if (isRecord(value) && typeof value.success === "boolean") {
      return { shape: "x402 SettleResponse", valid: true, errors: [] };
    }
    return {
      shape: "Unknown settlement response shape",
      valid: false,
      errors: ["Expected an object with a boolean success field."],
    };
  }

  return { shape: "Unknown", valid: false, errors: ["Unsupported header."] };
}

export function decodeHeaderValue(header: HeaderName, rawValue: string): DecodedHeader {
  const value = rawValue.trim();
  if (!value) {
    return { header, encoding: "JSON", shape: "Empty input", value: null, valid: false, errors: ["Paste a header value first."] };
  }
  if (value.length > MAX_HEADER_LENGTH) {
    return {
      header,
      encoding: "JSON",
      shape: "Input too large",
      value: null,
      valid: false,
      errors: ["Header values are limited to " + MAX_HEADER_LENGTH.toLocaleString() + " characters."],
    };
  }

  const attempts: Array<{ encoding: DecodedHeader["encoding"]; decode: () => unknown }> = [];
  if (value.startsWith("{") || value.startsWith("[")) {
    attempts.push({ encoding: "JSON", decode: () => parseJson(value) });
  } else {
    if (header === "PAYMENT-REQUIRED") {
      attempts.push({ encoding: "base64", decode: () => decodePaymentRequiredHeader(value) });
    } else if (header === "PAYMENT-SIGNATURE") {
      attempts.push({ encoding: "base64", decode: () => decodePaymentSignatureHeader(value) });
    } else if (header === "PAYMENT-RESPONSE") {
      attempts.push({ encoding: "base64", decode: () => decodePaymentResponseHeader(value) });
    } else {
      attempts.push({ encoding: "base64", decode: () => decodeStandardBase64(value) });
    }
    attempts.push({ encoding: "base64url", decode: () => decodeBase64Url(value) });
  }

  const errors: string[] = [];
  for (const attempt of attempts) {
    try {
      const decoded = attempt.decode();
      const validation = describeValidation(header, decoded);
      if (validation.valid || errors.length === 0) {
        return {
          header,
          encoding: attempt.encoding,
          shape: validation.shape,
          value: decoded,
          valid: validation.valid,
          errors: validation.errors,
        };
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Unable to decode this value.");
    }
  }

  return {
    header,
    encoding: "JSON",
    shape: "Invalid input",
    value: null,
    valid: false,
    errors: errors.length > 0 ? errors : ["The value could not be decoded or validated."],
  };
}

export function getPaymentSignatureSummary(value: unknown): Array<{ label: string; value: string }> {
  if (!isRecord(value)) return [];
  const accepted = isRecord(value.accepted) ? value.accepted : {};
  const payload = isRecord(value.payload) ? value.payload : {};
  const authorization = isRecord(payload.authorization) ? payload.authorization : payload;
  const fields: Array<[string, unknown]> = [
    ["Network", accepted.network ?? value.network],
    ["Payer", authorization.source ?? authorization.payer ?? authorization.from ?? payload.source],
    ["Amount", accepted.amount ?? accepted.maxAmountRequired ?? authorization.amount ?? payload.amount],
  ];
  return fields
    .filter((entry): entry is [string, string | number] => typeof entry[1] === "string" || typeof entry[1] === "number")
    .map(([label, fieldValue]) => ({ label, value: String(fieldValue) }));
}

export type ChallengeInput = {
  resource: string;
  amount: string;
  asset: string;
  payTo: string;
  network: string;
  models: string;
};

export function encodeChallenge(input: ChallengeInput): { x402Base64: string; tollwayBase64Url: string } {
  if (!/^[0-9]+$/.test(input.amount)) {
    throw new Error("Amount must be an integer string in the asset's smallest unit.");
  }
  if (!input.resource.trim() || !input.asset.trim() || !input.payTo.trim() || !input.network.trim()) {
    throw new Error("Resource, asset, payTo and network are required.");
  }

  const challenge = {
    x402Version: 2,
    resource: {
      url: input.resource.trim(),
      description: "Tollway paid API resource",
      mimeType: "application/json",
    },
    accepts: [{
      scheme: "exact",
      network: input.network.trim(),
      amount: input.amount,
      asset: input.asset.trim(),
      payTo: input.payTo.trim(),
      maxTimeoutSeconds: 300,
      extra: {
        models: input.models.split(",").map((model) => model.trim()).filter(Boolean),
      },
    }],
  };
  const parsed = parsePaymentRequired(challenge);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) => issue.message).join("; "));
  }

  return {
    x402Base64: encodePaymentRequiredHeader(parsed.data),
    tollwayBase64Url: bytesToBase64Url(utf8Bytes(JSON.stringify(parsed.data))),
  };
}

function receiptPublicKeys(receipt: SignedReceipt, rawKey: string): Record<string, string> {
  const value = rawKey.trim();
  if (!value) throw new Error("Paste a public key or key-set JSON.");

  if (!value.startsWith("{")) {
    return { [receipt.signature.keyId]: value };
  }

  const parsed: unknown = parseJson(value);
  if (!isRecord(parsed)) throw new Error("The key-set must be a JSON object.");
  if (Array.isArray(parsed.keys)) {
    const keys: Record<string, string> = {};
    for (const candidate of parsed.keys) {
      if (isRecord(candidate) && candidate.kty === "OKP" && candidate.crv === "Ed25519"
        && typeof candidate.kid === "string" && typeof candidate.x === "string") {
        keys[candidate.kid] = candidate.x;
      }
    }
    if (Object.keys(keys).length === 0) throw new Error("No Ed25519 public keys with kid and x were found.");
    return keys;
  }
  if (typeof parsed.keyId === "string" && typeof parsed.publicKey === "string") {
    return { [parsed.keyId]: parsed.publicKey };
  }
  const values = Object.fromEntries(
    Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  if (Object.keys(values).length === 0) throw new Error("The JSON must contain keys with base64url public-key values.");
  return values;
}

export async function verifyReceiptWithPublicKey(
  candidate: unknown,
  publicKeyOrSet: string,
): Promise<{ valid: true; receipt: SignedReceipt } | { valid: false; reason: string }> {
  const parsed = signedReceiptSchema.safeParse(candidate);
  if (!parsed.success) {
    return { valid: false, reason: parsed.error.issues.map((issue) => issue.message).join("; ") };
  }
  const verifier = new Ed25519Verifier(receiptPublicKeys(parsed.data, publicKeyOrSet));
  return verifyReceipt(parsed.data, verifier);
}

/** Decode transaction XDR only when the user explicitly expands the detail. */
export async function decodeStellarTransactionXdr(
  xdr: string,
  network: string,
): Promise<{ source: string; sequence: string; fee: string }> {
  const stellar = await import("@stellar/stellar-base");
  const passphrase = network === "stellar:testnet" || network === "testnet"
    ? stellar.Networks.TESTNET
    : stellar.Networks.PUBLIC;
  const transaction = stellar.TransactionBuilder.fromXDR(xdr, passphrase);
  return {
    source: transaction.source,
    sequence: transaction.sequence,
    fee: transaction.fee,
  };
}

/** Used to ensure receipt decoding does not accidentally trigger network access. */
export function isSignedReceipt(value: unknown): value is SignedReceipt {
  return signedReceiptSchema.safeParse(value).success;
}
