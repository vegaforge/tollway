/**
 * The path to return to after sign-in, taken from the `next` query
 * parameter. Only a same-origin path is accepted; anything else becomes
 * `/`. A prefix check is not enough: browsers read `/\evil.example` as
 * `//evil.example`, a different host, so the value is resolved against a
 * fixed origin and the origin compared.
 */
export function safeNextPath(requested: string | null): string {
  if (!requested?.startsWith("/")) return "/";
  const base = "https://dashboard.invalid";
  let resolved: URL;
  try {
    resolved = new URL(requested, base);
  } catch {
    // Not a URL at all, so not a place to send anyone.
    return "/";
  }
  if (resolved.origin !== base) return "/";
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}
