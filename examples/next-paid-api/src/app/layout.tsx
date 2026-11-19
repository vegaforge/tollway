import type { ReactNode } from "react";

export const metadata = {
  title: "Tollway: Next.js paid API example",
  description: "App Router routes paywalled with @vegaforge/tollway-adapter-next",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
