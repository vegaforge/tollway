// @ts-check
/**
 * Every public entry point of every publishable package, in sidebar order.
 * typedoc.json lists the same files; the check in check-api.mjs fails the
 * build if a page for any of these is missing.
 *
 * `module` is the name TypeDoc derives from the entry's path relative to
 * packages/. `slug` is the page under /docs/api.
 */
export const modules = [
  {
    module: "core/src",
    slug: "core",
    importPath: "@vegaforge/tollway-core",
    description: "Domain types, the canonical signed receipt, policy and the model router.",
  },
  {
    module: "server/src",
    slug: "server",
    importPath: "@vegaforge/tollway-server",
    description: "The framework-agnostic payment gate.",
  },
  {
    module: "client/src",
    slug: "client",
    importPath: "@vegaforge/tollway-client",
    description: "The agent-side client that pays 402 challenges.",
  },
  {
    module: "adapter-express/src",
    slug: "adapter-express",
    importPath: "@vegaforge/tollway-adapter-express",
    description: "Express middleware for the payment gate.",
  },
  {
    module: "adapter-fastify/src",
    slug: "adapter-fastify",
    importPath: "@vegaforge/tollway-adapter-fastify",
    description: "Fastify plugin for the payment gate.",
  },
  {
    module: "adapter-next/src",
    slug: "adapter-next",
    importPath: "@vegaforge/tollway-adapter-next",
    description: "Next.js App Router route-handler adapter for the payment gate.",
  },
  {
    module: "adapter-next/src/proxy",
    slug: "adapter-next-proxy",
    importPath: "@vegaforge/tollway-adapter-next/proxy",
    description: "Next.js proxy (middleware) integration for the payment gate.",
  },
  {
    module: "adapter-hono/src",
    slug: "adapter-hono",
    importPath: "@vegaforge/tollway-adapter-hono",
    description: "Hono middleware for the payment gate.",
  },
  {
    module: "channels/src",
    slug: "channels",
    importPath: "@vegaforge/tollway-channels",
    description: "Payment channel management for MPP sessions.",
  },
  {
    module: "reconcile/src",
    slug: "reconcile",
    importPath: "@vegaforge/tollway-reconcile",
    description: "Reconciliation of receipts against the chain.",
  },
  {
    module: "observability/src",
    slug: "observability",
    importPath: "@vegaforge/tollway-observability",
    description: "Metrics, summaries and time series for gate outcomes.",
  },
  {
    module: "theme/src",
    slug: "theme",
    importPath: "@vegaforge/tollway-theme",
    description: "Design tokens shared by the dashboard and the website.",
  },
  {
    module: "theme/src/preset",
    slug: "theme-preset",
    importPath: "@vegaforge/tollway-theme/preset",
    description: "Tailwind preset wiring the theme's semantic roles to its CSS variables.",
  },
];

/**
 * @param {string} name
 */
export function packageForEntry(name) {
  return modules.find((entry) => entry.module === name);
}
