// components/site-footer.tsx
import Link from "next/link";
import { LogoMark } from "./logo";

export function SiteFooter() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex max-w-[1320px] flex-wrap items-center justify-between gap-6 px-6 py-[34px]">
        <div className="flex flex-wrap items-center gap-[18px]">
          <Link href="/" aria-label="Tollway home" className="inline-flex items-center gap-[11px]">
            <LogoMark className="h-[34px] w-[26px] text-foreground" />
            <span className="text-[18px] font-semibold tracking-[-0.01em]">Tollway</span>
          </Link>
          <span className="font-mono text-[12.5px] text-muted">Apache-2.0 · vegaforge</span>
        </div>
        <nav className="flex gap-2" aria-label="Footer">
          <Link
            href="/docs"
            className="rounded-[7px] px-3 py-2 text-[14px] text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
          >
            Docs
          </Link>
          <a
            href="https://github.com/vegaforge/tollway"
            className="rounded-[7px] px-3 py-2 text-[14px] text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
          >
            GitHub
          </a>
        </nav>
      </div>
    </footer>
  );
}
