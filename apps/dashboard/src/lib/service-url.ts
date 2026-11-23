/**
 * Builds URLs for the tollway-service HTTP API. The service base URL is
 * read from `SERVICE_URL` (server-only); it is never sent to the browser.
 *
 * Default: http://localhost:3200 for local development.
 */

/**
 * Returns true when the minimum required service credentials are present.
 * Both `SERVICE_URL` and `SERVICE_API_KEY` must be set; `SERVICE_URL` alone
 * is not enough because every request to the service needs the API key.
 */
export function isServiceConfigured(): boolean {
  return Boolean(process.env.SERVICE_URL) && Boolean(process.env.SERVICE_API_KEY);
}

export function serviceBaseUrl(): string {
  return (process.env.SERVICE_URL ?? "http://localhost:3200").replace(/\/$/, "");
}

/** Full URL for the SSE events stream, with an optional type filter. */
export function serviceStreamUrl(types?: string | null): string {
  const base = `${serviceBaseUrl()}/v1/events/stream`;
  if (types && types.trim().length > 0) {
    return `${base}?types=${encodeURIComponent(types)}`;
  }
  return base;
}
