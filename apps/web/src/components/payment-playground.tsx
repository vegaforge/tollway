"use client";

import { useMemo, useState } from "react";
import {
  decodeHeaderValue,
  decodeStellarTransactionXdr,
  encodeChallenge,
  getPaymentSignatureSummary,
  getPaymentTransactionXdr,
  isSignedReceipt,
  verifyReceiptWithPublicKey,
  type DecodedHeader,
  type HeaderName,
} from "@/lib/playground";

const HEADER_NAMES: HeaderName[] = [
  "PAYMENT-REQUIRED",
  "PAYMENT-SIGNATURE",
  "PAYMENT-RESPONSE",
  "TOLLWAY-RECEIPT",
];

export function PaymentPlayground() {
  const [tab, setTab] = useState<"decode" | "encode">("decode");
  const [header, setHeader] = useState<HeaderName>("PAYMENT-REQUIRED");
  const [headerValue, setHeaderValue] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [decoded, setDecoded] = useState<DecodedHeader | null>(null);
  const [verification, setVerification] = useState<string | null>(null);
  const [xdrSummary, setXdrSummary] = useState<string | null>(null);
  const [xdrError, setXdrError] = useState<string | null>(null);
  const [encodeFields, setEncodeFields] = useState({
    resource: "https://api.example.com/quote",
    amount: "10000",
    asset: "USDC",
    payTo: "",
    network: "stellar:testnet",
    models: "x402",
  });
  const [encoded, setEncoded] = useState<{ x402Base64: string; tollwayBase64Url: string } | null>(null);
  const [encodeError, setEncodeError] = useState<string | null>(null);

  const signatureSummary = useMemo(
    () => decoded?.header === "PAYMENT-SIGNATURE" && decoded.valid
      ? getPaymentSignatureSummary(decoded.value)
      : [],
    [decoded],
  );
  const transactionXdr = decoded?.header === "PAYMENT-SIGNATURE" && decoded.valid
    ? getPaymentTransactionXdr(decoded.value)
    : null;

  async function decodeTransaction() {
    if (!transactionXdr) return;
    try {
      const details = await decodeStellarTransactionXdr(transactionXdr.xdr, transactionXdr.network);
      setXdrSummary(JSON.stringify(details, null, 2));
      setXdrError(null);
    } catch (error) {
      setXdrSummary(null);
      setXdrError(error instanceof Error ? error.message : "Unable to decode Stellar transaction XDR.");
    }
  }

  function decode() {
    const result = decodeHeaderValue(header, headerValue);
    setDecoded(result);
    setVerification(null);
    setXdrSummary(null);
    setXdrError(null);
  }

  async function verify() {
    if (!decoded || !isSignedReceipt(decoded.value)) {
      setVerification("Decode a valid TOLLWAY-RECEIPT first.");
      return;
    }
    try {
      const result = await verifyReceiptWithPublicKey(decoded.value, publicKey);
      setVerification(result.valid ? "Valid signature for key " + result.receipt.signature.keyId + "." : result.reason);
    } catch (error) {
      setVerification(error instanceof Error ? error.message : "Receipt verification failed.");
    }
  }

  function updateField(field: keyof typeof encodeFields, value: string) {
    setEncodeFields((current) => ({ ...current, [field]: value }));
  }

  function encode() {
    try {
      setEncoded(encodeChallenge(encodeFields));
      setEncodeError(null);
    } catch (error) {
      setEncoded(null);
      setEncodeError(error instanceof Error ? error.message : "Unable to encode challenge.");
    }
  }

  return (
    <section className="my-8 rounded-xl border p-5">
      <div className="flex gap-2 border-b pb-4">
        <button type="button" aria-pressed={tab === "decode"} onClick={() => setTab("decode")} className="rounded-md border px-4 py-2">
          Decode
        </button>
        <button type="button" aria-pressed={tab === "encode"} onClick={() => setTab("encode")} className="rounded-md border px-4 py-2">
          Encode
        </button>
      </div>

      {tab === "decode" ? (
        <div className="space-y-4 pt-4">
          <div>
            <label className="mb-1 block text-sm font-medium" htmlFor="playground-header">Header type</label>
            <select id="playground-header" value={header} onChange={(event) => setHeader(event.target.value as HeaderName)} className="w-full rounded-md border bg-transparent p-2">
              {HEADER_NAMES.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium" htmlFor="playground-header-value">Header value</label>
            <textarea id="playground-header-value" value={headerValue} onChange={(event) => setHeaderValue(event.target.value)} rows={5} className="w-full rounded-md border bg-transparent p-3 font-mono text-sm" placeholder="Paste the header value here" />
          </div>
          <button type="button" onClick={decode} className="rounded-md bg-primary px-4 py-2 text-primary-foreground">Decode header</button>

          {decoded && (
            <div aria-live="polite" className="space-y-3 rounded-lg border p-4">
              <p className="font-medium">{decoded.shape} · {decoded.encoding}</p>
              <p className={decoded.valid ? "text-green-700" : "text-red-700"}>{decoded.valid ? "Validation passed" : "Validation failed"}</p>
              {decoded.errors.length > 0 && <ul className="list-disc pl-5 text-sm text-red-700">{decoded.errors.map((error) => <li key={error}>{error}</li>)}</ul>}
              {signatureSummary.length > 0 && (
                <dl className="grid gap-2 sm:grid-cols-3">
                  {signatureSummary.map((item) => <div key={item.label}><dt className="text-xs opacity-70">{item.label}</dt><dd className="break-all text-sm">{item.value}</dd></div>)}
                </dl>
              )}
              {transactionXdr && (
                <div className="space-y-2">
                  <button type="button" onClick={() => void decodeTransaction()} className="rounded-md border px-4 py-2">Decode Stellar transaction XDR</button>
                  {xdrError && <p role="alert" className="text-sm text-red-700">{xdrError}</p>}
                  {xdrSummary && <pre className="overflow-auto rounded-md bg-muted p-3 text-xs">{xdrSummary}</pre>}
                </div>
              )}
              <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(decoded.value, null, 2)}</pre>
              {decoded.header === "TOLLWAY-RECEIPT" && decoded.valid && (
                <div className="space-y-2">
                  <label className="block text-sm font-medium" htmlFor="playground-public-key">Public key or JWKS JSON</label>
                  <textarea id="playground-public-key" value={publicKey} onChange={(event) => setPublicKey(event.target.value)} rows={3} className="w-full rounded-md border bg-transparent p-3 font-mono text-sm" placeholder="Base64url public key or JSON key set" />
                  <button type="button" onClick={() => void verify()} className="rounded-md border px-4 py-2">Verify receipt</button>
                  {verification && <p aria-live="polite" className="text-sm">{verification}</p>}
                </div>
              )}
            </div>
          )}
          <p className="text-xs opacity-75">Decoding and verification run entirely in this browser. Pasted values are not sent to a server. Treat PAYMENT-SIGNATURE values as sensitive.</p>
        </div>
      ) : (
        <div className="space-y-4 pt-4">
          {([
            ["resource", "Resource URL"],
            ["amount", "Amount (integer string, smallest unit)"],
            ["asset", "Asset identifier"],
            ["payTo", "Pay-to address"],
            ["network", "Network (CAIP-2, e.g. stellar:testnet)"],
            ["models", "Models (comma-separated)"],
          ] as const).map(([field, label]) => (
            <div key={field}>
              <label htmlFor={"playground-" + field} className="mb-1 block text-sm font-medium">{label}</label>
              <input id={"playground-" + field} value={encodeFields[field]} onChange={(event) => updateField(field, event.target.value)} className="w-full rounded-md border bg-transparent p-2" />
            </div>
          ))}
          <button type="button" onClick={encode} className="rounded-md bg-primary px-4 py-2 text-primary-foreground">Build challenge</button>
          {encodeError && <p role="alert" className="text-sm text-red-700">{encodeError}</p>}
          {encoded && (
            <div className="space-y-3 rounded-lg border p-4">
              <div>
                <p className="mb-1 text-sm font-semibold">x402 base64 header</p>
                <textarea readOnly value={encoded.x402Base64} rows={3} className="w-full rounded-md border bg-transparent p-2 font-mono text-xs" />
              </div>
              <div>
                <p className="mb-1 text-sm font-semibold">Tollway base64url header</p>
                <textarea readOnly value={encoded.tollwayBase64Url} rows={3} className="w-full rounded-md border bg-transparent p-2 font-mono text-xs" />
              </div>
            </div>
          )}
          <p className="text-xs opacity-75">The amount is validated as a non-negative integer string. No request is made when building a challenge.</p>
        </div>
      )}
    </section>
  );
}
