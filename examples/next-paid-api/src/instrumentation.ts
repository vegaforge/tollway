/**
 * Next.js calls register once per server instance, before it serves a
 * request. The Node.js check is the form Next.js recognises, so the edge
 * bundle never contains the startup code (it uses process.exit).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
