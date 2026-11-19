import { base64UrlToBytes, bytesToBase64Url, utf8Bytes } from "@vegaforge/tollway-core";
import { z } from "zod";

import { MAX_HEADER_LENGTH } from "./encoding";
import { headerNames } from "./shapes";

/**
 * Shareable playground state lives only in the URL fragment (`#...`).
 * Browsers never send the fragment to the server, so a shared link carries
 * the pasted value to whoever opens it without it passing through the site.
 * A link is only written when the user asks for one.
 */
const FRAGMENT_KEY = "playground=";

const sharedStateSchema = z.discriminatedUnion("tab", [
  z.strictObject({
    tab: z.literal("decode"),
    header: z.enum(headerNames),
    value: z.string().max(MAX_HEADER_LENGTH),
  }),
  z.strictObject({
    tab: z.literal("encode"),
    resource: z.string().max(2048),
    amount: z.string().max(64),
    asset: z.string().max(256),
    payTo: z.string().max(256),
    network: z.string().max(32),
    models: z.array(z.string().max(32)).max(8),
  }),
]);

export type SharedState = z.infer<typeof sharedStateSchema>;

export type ShareLink = { ok: true; fragment: string } | { ok: false; reason: string };

/**
 * Builds the fragment for a share link. A signed payment is refused: it is a
 * spendable authorization until it expires, and a link gets copied around.
 */
export function toShareFragment(state: SharedState): ShareLink {
  if (state.tab === "decode" && state.header === "PAYMENT-SIGNATURE") {
    return {
      ok: false,
      reason:
        "PAYMENT-SIGNATURE values are signed payments, so they cannot be put in a share link.",
    };
  }
  const parsed = sharedStateSchema.safeParse(state);
  if (!parsed.success) {
    return { ok: false, reason: "This value is too large to share in a link." };
  }
  return {
    ok: true,
    fragment: `#${FRAGMENT_KEY}${bytesToBase64Url(utf8Bytes(JSON.stringify(parsed.data)))}`,
  };
}

export type RestoredState =
  | { kind: "none" }
  | { kind: "invalid"; reason: string }
  | { kind: "restored"; state: SharedState };

const UNREADABLE: RestoredState = {
  kind: "invalid",
  reason: "The link's playground state could not be read, so the playground starts empty.",
};

/**
 * Reads state back from `location.hash`. A fragment that is not the
 * playground's is ignored; one that is but does not parse is reported.
 */
export function fromShareFragment(hash: string): RestoredState {
  const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!fragment.startsWith(FRAGMENT_KEY)) {
    return { kind: "none" };
  }
  let json: unknown;
  try {
    const bytes = base64UrlToBytes(fragment.slice(FRAGMENT_KEY.length));
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    // A truncated or hand-edited link. The caller tells the user instead of
    // guessing at what was meant.
    return UNREADABLE;
  }
  const parsed = sharedStateSchema.safeParse(json);
  if (!parsed.success) {
    return UNREADABLE;
  }
  if (parsed.data.tab === "decode" && parsed.data.header === "PAYMENT-SIGNATURE") {
    return { kind: "invalid", reason: "Share links never carry a PAYMENT-SIGNATURE value." };
  }
  return { kind: "restored", state: parsed.data };
}
