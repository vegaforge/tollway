import { type DetectedEncoding, decodeHeaderText } from "./encoding";
import { explainFields, type FieldRow } from "./explain";
import { type HeaderName, identifyShape, type ShapeId, shapeInfo } from "./shapes";

export type DecodeResult =
  | {
      ok: true;
      header: HeaderName;
      detected: DetectedEncoding;
      shape: ShapeId;
      shapeLabel: string;
      valid: boolean;
      errors: string[];
      /** Remarks that are not errors, such as an encoding that differs from what the producer writes. */
      notes: string[];
      fields: FieldRow[];
      value: unknown;
    }
  | { ok: false; header: HeaderName; errors: string[] };

function encodingNote(shape: ShapeId, detected: DetectedEncoding): string | null {
  const info = shapeInfo[shape];
  if (detected.encoding === "json") {
    return `Pasted as raw JSON. On the wire this shape is ${info.expectedEncoding}-encoded.`;
  }
  if (!detected.certain) {
    return `This value only uses characters base64 and base64url share, so it decodes the same either way. ${info.label} is normally written as ${info.expectedEncoding}.`;
  }
  if (detected.encoding !== info.expectedEncoding) {
    return info.family === "x402"
      ? `This is an x402 shape in base64url. x402 clients decode standard base64 (decodePaymentRequiredHeader and friends in @x402/core/http) and will reject it.`
      : `This is a Tollway shape in standard base64. Tollway's encodeHeader writes base64url, and its decodeHeader accepts only that alphabet.`;
  }
  return null;
}

/**
 * Decodes, identifies and validates one pasted header value. Pure and
 * synchronous: nothing here touches the network.
 */
export function decodeHeaderValue(header: HeaderName, raw: string): DecodeResult {
  const text = decodeHeaderText(raw);
  if (!text.ok) {
    return { ok: false, header, errors: [text.error] };
  }
  const match = identifyShape(header, text.json);
  const note = encodingNote(match.shape, text.detected);
  return {
    ok: true,
    header,
    detected: text.detected,
    shape: match.shape,
    shapeLabel: shapeInfo[match.shape].label,
    valid: match.valid,
    errors: match.errors,
    notes: note === null ? [] : [note],
    fields: explainFields(match.shape, match.value),
    value: match.value,
  };
}
