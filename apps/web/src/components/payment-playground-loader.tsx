"use client";

import dynamic from "next/dynamic";

/**
 * Every docs page shares one MDX component map, so a direct import would
 * put the playground, @x402/core and zod in the first load of every page.
 * Loading it on demand keeps them on /docs/playground only. It renders on
 * the client alone because it reads the URL fragment, which the server
 * never sees.
 */
const LazyPaymentPlayground = dynamic(
  () => import("./payment-playground").then((module) => module.PaymentPlayground),
  {
    ssr: false,
    loading: () => <p className="my-8 text-sm">Loading the playground...</p>,
  },
);

export function PaymentPlayground() {
  return <LazyPaymentPlayground />;
}
