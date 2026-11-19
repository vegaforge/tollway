"use client";

import { settlementModels } from "@vegaforge/tollway-core";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";

import { type DecodeResult, decodeHeaderValue } from "@/lib/playground/decode";
import { type ChallengeInput, type EncodeResult, encodeChallenge } from "@/lib/playground/encode";
import { type HeaderName, headerNames } from "@/lib/playground/shapes";
import { fromShareFragment, type SharedState, toShareFragment } from "@/lib/playground/share";
import { type SignatureSummary, summarizeSignature } from "@/lib/playground/signature";
import { verifyPastedReceipt } from "@/lib/playground/verify";
import { decodeStellarTransfer, type StellarTransfer } from "@/lib/playground/xdr";

/**
 * The 402 playground on /docs/playground. Everything runs in the browser:
 * decoding, validation, receipt verification (WebCrypto) and XDR parsing.
 * Nothing here calls fetch, and the page loads no analytics.
 */

type Tab = "decode" | "encode";
const tabs: readonly Tab[] = ["decode", "encode"];

const inputClass =
  "w-full rounded-md border border-fd-border bg-fd-background p-2 font-mono text-sm focus-visible:outline-2 focus-visible:outline-fd-primary";
const buttonClass =
  "rounded-md border border-fd-border px-4 py-2 text-sm font-medium hover:bg-fd-accent focus-visible:outline-2 focus-visible:outline-fd-primary";
const primaryButtonClass =
  "rounded-md bg-fd-primary px-4 py-2 text-sm font-medium text-fd-primary-foreground focus-visible:outline-2 focus-visible:outline-fd-primary";

const defaultChallenge: ChallengeInput = {
  resource: "https://api.example.com/quote",
  amount: "10000",
  // The testnet USDC contract that @x402/stellar 2.31 lists as USDC_TESTNET_ADDRESS.
  asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  payTo: "",
  network: "testnet",
  models: ["x402"],
};

function writeFragment(fragment: string): void {
  // replaceState changes only the address bar. It makes no request, and the
  // fragment is never sent to a server anyway.
  window.history.replaceState(null, "", fragment);
}

export function PaymentPlayground() {
  const baseId = useId();
  const [tab, setTab] = useState<Tab>("decode");
  const [restored, setRestored] = useState<SharedState | null>(null);
  const [restoreMessage, setRestoreMessage] = useState<string | null>(null);
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ decode: null, encode: null });

  useEffect(() => {
    const result = fromShareFragment(window.location.hash);
    if (result.kind === "restored") {
      setRestored(result.state);
      setTab(result.state.tab);
      setRestoreMessage("Restored the playground from the link.");
    } else if (result.kind === "invalid") {
      setRestoreMessage(result.reason);
    }
  }, []);

  // Arrow keys move between tabs, as the WAI-ARIA tabs pattern expects.
  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const index = tabs.indexOf(tab);
    let next: Tab | undefined;
    if (event.key === "ArrowRight") next = tabs[(index + 1) % tabs.length];
    else if (event.key === "ArrowLeft") next = tabs[(index - 1 + tabs.length) % tabs.length];
    else if (event.key === "Home") next = tabs[0];
    else if (event.key === "End") next = tabs[tabs.length - 1];
    if (next === undefined) return;
    event.preventDefault();
    setTab(next);
    tabRefs.current[next]?.focus();
  }

  return (
    <section
      aria-label="402 playground"
      className="not-prose my-8 rounded-xl border border-fd-border p-5"
    >
      <div
        role="tablist"
        aria-label="Playground mode"
        className="flex gap-2 border-b border-fd-border pb-4"
      >
        {tabs.map((name) => (
          <button
            key={name}
            ref={(element) => {
              tabRefs.current[name] = element;
            }}
            type="button"
            role="tab"
            id={`${baseId}-tab-${name}`}
            aria-selected={tab === name}
            aria-controls={`${baseId}-panel-${name}`}
            tabIndex={tab === name ? 0 : -1}
            onClick={() => setTab(name)}
            onKeyDown={onTabKeyDown}
            className={tab === name ? primaryButtonClass : buttonClass}
          >
            {name === "decode" ? "Decode" : "Encode"}
          </button>
        ))}
      </div>
      {restoreMessage && (
        <p role="status" className="pt-3 text-sm">
          {restoreMessage}
        </p>
      )}
      <div
        role="tabpanel"
        id={`${baseId}-panel-decode`}
        aria-labelledby={`${baseId}-tab-decode`}
        hidden={tab !== "decode"}
      >
        <DecodePanel initial={restored?.tab === "decode" ? restored : null} />
      </div>
      <div
        role="tabpanel"
        id={`${baseId}-panel-encode`}
        aria-labelledby={`${baseId}-tab-encode`}
        hidden={tab !== "encode"}
      >
        <EncodePanel initial={restored?.tab === "encode" ? restored : null} />
      </div>
      <p className="pt-4 text-xs text-fd-muted-foreground">
        Decoding, validation and verification run in this browser. Pasted values are never sent
        anywhere, and this page loads no analytics.
      </p>
    </section>
  );
}

type DecodeState = Extract<SharedState, { tab: "decode" }>;

function DecodePanel({ initial }: { initial: DecodeState | null }) {
  const id = useId();
  const [header, setHeader] = useState<HeaderName>("PAYMENT-REQUIRED");
  const [value, setValue] = useState("");
  const [result, setResult] = useState<DecodeResult | null>(null);
  const [shareMessage, setShareMessage] = useState<string | null>(null);

  useEffect(() => {
    if (initial) {
      setHeader(initial.header);
      setValue(initial.value);
      setResult(decodeHeaderValue(initial.header, initial.value));
    }
  }, [initial]);

  function decode() {
    setResult(decodeHeaderValue(header, value));
    setShareMessage(null);
  }

  function share() {
    const link = toShareFragment({ tab: "decode", header, value });
    if (!link.ok) {
      setShareMessage(link.reason);
      return;
    }
    writeFragment(link.fragment);
    setShareMessage(
      "The address bar now holds a link to this value. Only the part after # changed.",
    );
  }

  const errorsId = `${id}-errors`;
  return (
    <div className="space-y-4 pt-4">
      <div>
        <label className="mb-1 block text-sm font-medium" htmlFor={`${id}-header`}>
          Header
        </label>
        <select
          id={`${id}-header`}
          value={header}
          onChange={(event) => {
            const next = headerNames.find((name) => name === event.target.value);
            if (next) setHeader(next);
          }}
          className={inputClass}
        >
          {headerNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="mb-1 block text-sm font-medium" htmlFor={`${id}-value`}>
          Header value
        </label>
        <textarea
          id={`${id}-value`}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          rows={5}
          spellCheck={false}
          aria-invalid={result !== null && (!result.ok || !result.valid)}
          aria-describedby={result !== null ? errorsId : undefined}
          className={inputClass}
          placeholder="Paste a base64 or base64url header value, or its JSON"
        />
      </div>
      {header === "PAYMENT-SIGNATURE" && (
        <p className="text-sm font-medium">
          A PAYMENT-SIGNATURE is a signed payment. Anyone who has it can try to settle it until it
          expires, so treat it as sensitive, like a password.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={decode} className={primaryButtonClass}>
          Decode header
        </button>
        <button type="button" onClick={share} className={buttonClass}>
          Create share link
        </button>
      </div>
      {shareMessage && (
        <p role="status" className="text-sm">
          {shareMessage}
        </p>
      )}
      {result && <DecodeOutput result={result} errorsId={errorsId} />}
    </div>
  );
}

function DecodeOutput({ result, errorsId }: { result: DecodeResult; errorsId: string }) {
  if (!result.ok) {
    return (
      <div id={errorsId} role="alert" className="rounded-lg border border-red-600 p-4 text-sm">
        <p className="font-medium">Could not decode this value.</p>
        <ul className="list-disc pl-5">
          {result.errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      </div>
    );
  }
  const isReceipt = result.valid && result.shape === "tollway-receipt";
  const isSignature = result.valid && result.shape === "x402-payment-payload";
  return (
    <div className="space-y-4 rounded-lg border border-fd-border p-4">
      <div id={errorsId} role={result.valid ? "status" : "alert"} className="text-sm">
        <p className="font-medium">
          {result.shapeLabel}, {encodingLabel(result)}
        </p>
        <p>{result.valid ? "Validation passed." : "Validation failed:"}</p>
        {result.errors.length > 0 && (
          <ul className="list-disc pl-5">
            {result.errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        )}
      </div>
      {result.notes.map((note) => (
        <p key={note} className="text-sm">
          {note}
        </p>
      ))}
      {isSignature && <SignaturePanel value={result.value} />}
      <FieldTable result={result} />
      {isReceipt && <VerifyPanel receipt={result.value} />}
    </div>
  );
}

function encodingLabel(result: Extract<DecodeResult, { ok: true }>): string {
  const { encoding, certain } = result.detected;
  if (encoding === "json") return "pasted as JSON";
  return certain ? `encoded as ${encoding}` : "valid as both base64 and base64url";
}

function FieldTable({ result }: { result: Extract<DecodeResult, { ok: true }> }) {
  return (
    <table className="w-full text-left text-sm">
      <caption className="pb-2 text-left font-medium">Fields</caption>
      <thead>
        <tr>
          <th scope="col" className="pr-3">
            Field
          </th>
          <th scope="col" className="pr-3">
            Value
          </th>
          <th scope="col">Meaning</th>
        </tr>
      </thead>
      <tbody>
        {result.fields.map((row) => (
          <tr key={row.path} className="border-t border-fd-border align-top">
            <td className="py-1 pr-3 font-mono text-xs">{row.path}</td>
            <td className="max-w-48 break-all py-1 pr-3 font-mono text-xs">{row.value}</td>
            <td className="py-1">{row.explanation}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SignaturePanel({ value }: { value: unknown }) {
  const summary: SignatureSummary | null = summarizeSignature(value);
  const [transfer, setTransfer] = useState<StellarTransfer | null>(null);
  const [xdrError, setXdrError] = useState<string | null>(null);

  useEffect(() => {
    setTransfer(null);
    setXdrError(null);
    if (!summary?.transaction) return;
    let current = true;
    decodeStellarTransfer(summary.transaction, summary.network).then(
      (decoded) => {
        if (current) setTransfer(decoded);
      },
      (error: unknown) => {
        if (current) {
          setXdrError(
            `The transaction could not be decoded: ${error instanceof Error ? error.message : "unknown error"}.`,
          );
        }
      },
    );
    return () => {
      current = false;
    };
  }, [summary?.transaction, summary?.network]);

  if (!summary) return null;
  const payer =
    transfer?.payer ??
    (xdrError ? "unknown" : summary.transaction ? "decoding..." : "not in this payload");
  return (
    <div className="rounded-md border border-fd-border p-3">
      <p className="pb-2 text-sm font-medium">Signed payment summary</p>
      <dl className="grid gap-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-fd-muted-foreground">Network</dt>
          <dd className="break-all">{summary.network}</dd>
        </div>
        <div>
          <dt className="text-xs text-fd-muted-foreground">Payer</dt>
          <dd className="break-all">{payer}</dd>
        </div>
        <div>
          <dt className="text-xs text-fd-muted-foreground">Amount (smallest unit)</dt>
          <dd className="break-all">{summary.amount}</dd>
        </div>
        {transfer && transfer.amount !== null && transfer.amount !== summary.amount && (
          <div className="sm:col-span-3">
            <dt className="text-xs text-fd-muted-foreground">Amount in the signed transfer</dt>
            <dd>{transfer.amount} (differs from the accepted amount)</dd>
          </div>
        )}
      </dl>
      {xdrError && (
        <p role="alert" className="pt-2 text-sm">
          {xdrError}
        </p>
      )}
    </div>
  );
}

function VerifyPanel({ receipt }: { receipt: unknown }) {
  const id = useId();
  const [keys, setKeys] = useState("");
  const [outcome, setOutcome] = useState<{ valid: boolean; message: string } | null>(null);

  const keyId =
    typeof receipt === "object" && receipt !== null && "signature" in receipt
      ? keyIdOf(receipt.signature)
      : "";

  async function verify() {
    const result = await verifyPastedReceipt(receipt, keys, keyId);
    setOutcome(
      result.valid
        ? { valid: true, message: `Signature valid for key ${result.receipt.signature.keyId}.` }
        : { valid: false, message: `Signature not valid: ${result.reason}` },
    );
  }

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium" htmlFor={`${id}-keys`}>
        Public key or key set
      </label>
      <textarea
        id={`${id}-keys`}
        value={keys}
        onChange={(event) => setKeys(event.target.value)}
        rows={3}
        spellCheck={false}
        aria-describedby={`${id}-keys-help`}
        className={inputClass}
      />
      <p id={`${id}-keys-help`} className="text-xs text-fd-muted-foreground">
        A base64url Ed25519 public key, a JWKS document, or the {"{ keyId, publicKey }"} object a
        service publishes.
      </p>
      <button type="button" onClick={() => void verify()} className={buttonClass}>
        Verify receipt
      </button>
      {outcome && (
        <p role={outcome.valid ? "status" : "alert"} className="text-sm">
          {outcome.message}
        </p>
      )}
    </div>
  );
}

function keyIdOf(signature: unknown): string {
  return typeof signature === "object" &&
    signature !== null &&
    "keyId" in signature &&
    typeof signature.keyId === "string"
    ? signature.keyId
    : "";
}

type EncodeState = Extract<SharedState, { tab: "encode" }>;

const textFields: ReadonlyArray<{
  field: "resource" | "amount" | "asset" | "payTo";
  label: string;
  hint: string;
}> = [
  { field: "resource", label: "Resource", hint: "URL or stable identifier of what is sold." },
  {
    field: "amount",
    label: "Amount",
    hint: "Integer string in the asset's smallest unit. USDC has 7 decimals, so 10000 is 0.001 USDC.",
  },
  { field: "asset", label: "Asset", hint: "Asset contract address. The default is testnet USDC." },
  { field: "payTo", label: "Pay to", hint: "Stellar address that receives the payment." },
];

function EncodePanel({ initial }: { initial: EncodeState | null }) {
  const id = useId();
  const [input, setInput] = useState<ChallengeInput>(defaultChallenge);
  const [result, setResult] = useState<EncodeResult | null>(null);
  const [shareMessage, setShareMessage] = useState<string | null>(null);

  useEffect(() => {
    if (initial) {
      const { tab: _tab, ...fields } = initial;
      setInput(fields);
    }
  }, [initial]);

  const errors = result && !result.ok ? result.errors : {};

  function toggleModel(model: string, checked: boolean) {
    setInput((current) => ({
      ...current,
      models: checked
        ? settlementModels.filter((name) => name === model || current.models.includes(name))
        : current.models.filter((name) => name !== model),
    }));
  }

  function share() {
    const link = toShareFragment({ tab: "encode", ...input, models: [...input.models] });
    if (!link.ok) {
      setShareMessage(link.reason);
      return;
    }
    writeFragment(link.fragment);
    setShareMessage(
      "The address bar now holds a link to this form. Only the part after # changed.",
    );
  }

  return (
    <form
      className="space-y-4 pt-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setResult(encodeChallenge(input));
      }}
    >
      {textFields.map(({ field, label, hint }) => {
        const error = errors[field];
        return (
          <div key={field}>
            <label htmlFor={`${id}-${field}`} className="mb-1 block text-sm font-medium">
              {label}
            </label>
            <input
              id={`${id}-${field}`}
              value={input[field]}
              onChange={(event) =>
                setInput((current) => ({ ...current, [field]: event.target.value }))
              }
              aria-invalid={error !== undefined}
              aria-describedby={`${id}-${field}-hint${error ? ` ${id}-${field}-error` : ""}`}
              inputMode={field === "amount" ? "numeric" : undefined}
              spellCheck={false}
              className={inputClass}
            />
            <p id={`${id}-${field}-hint`} className="text-xs text-fd-muted-foreground">
              {hint}
            </p>
            {error && (
              <p id={`${id}-${field}-error`} role="alert" className="text-sm">
                {error}
              </p>
            )}
          </div>
        );
      })}
      <div>
        <label htmlFor={`${id}-network`} className="mb-1 block text-sm font-medium">
          Network
        </label>
        <select
          id={`${id}-network`}
          value={input.network}
          onChange={(event) => setInput((current) => ({ ...current, network: event.target.value }))}
          className={inputClass}
        >
          <option value="testnet">testnet (stellar:testnet)</option>
          <option value="mainnet">mainnet (stellar:pubnet)</option>
        </select>
      </div>
      <fieldset aria-describedby={errors.models ? `${id}-models-error` : undefined}>
        <legend className="mb-1 text-sm font-medium">Settlement models</legend>
        <div className="flex flex-wrap gap-4">
          {settlementModels.map((model) => (
            <label key={model} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={input.models.includes(model)}
                onChange={(event) => toggleModel(model, event.target.checked)}
              />
              {model}
            </label>
          ))}
        </div>
        {errors.models && (
          <p id={`${id}-models-error`} role="alert" className="text-sm">
            {errors.models}
          </p>
        )}
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={primaryButtonClass}>
          Build challenge
        </button>
        <button type="button" onClick={share} className={buttonClass}>
          Create share link
        </button>
      </div>
      {shareMessage && (
        <p role="status" className="text-sm">
          {shareMessage}
        </p>
      )}
      {result?.ok && (
        <div className="space-y-3 rounded-lg border border-fd-border p-4">
          <EncodedOutput
            id={`${id}-x402`}
            label="PAYMENT-REQUIRED, x402 V2 (base64 PaymentRequired)"
            value={result.encoded.x402Base64}
          />
          <EncodedOutput
            id={`${id}-tollway`}
            label="PAYMENT-REQUIRED, Tollway gate today (base64url PaymentOffer)"
            value={result.encoded.tollwayBase64Url}
          />
        </div>
      )}
    </form>
  );
}

function EncodedOutput({ id, label, value }: { id: string; label: string; value: string }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      <textarea id={id} readOnly value={value} rows={3} className={inputClass} />
    </div>
  );
}
