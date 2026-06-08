// components/site-header.tsx
import Link from "next/link";
import { LogoMark } from "./logo";
import { ThemeToggle } from "./theme-toggle";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-50 border-b border-border bg-background/85 backdrop-blur-md backdrop-saturate-150">
      <div className="mx-auto flex h-16 max-w-[1200px] items-center justify-between px-6">
        <Link href="/" aria-label="Tollway home" className="inline-flex items-center gap-[11px]">
          <LogoMark className="h-[34px] w-[26px] text-foreground" />
          <span className="text-[18px] font-semibold tracking-[-0.01em]">Tollway</span>
        </Link>

        <nav className="flex items-center gap-[6px]" aria-label="Primary">
          <Link
            href="/docs"
            className="rounded-[7px] px-3 py-2 text-[14px] text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
          >
            Docs
          </Link>
          <a
            href="https://github.com/vegaforge/tollway"
            className="hidden rounded-[7px] px-3 py-2 text-[14px] text-muted transition-colors hover:bg-surface-2 hover:text-foreground sm:inline-block"
          >
            GitHub
          </a>
          <ThemeToggle />
        </nav>
      </div>
    </header>
  );
}
