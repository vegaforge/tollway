import Link from "next/link";
import { SessionBadge, type SessionSummary } from "@/components/auth/session-badge";
import { LogoMark } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { Badge } from "@/components/ui/badge";
import { MobileNav } from "./mobile-nav";

export function Topbar({ session }: { session: SessionSummary }) {
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-border bg-background/85 px-5 backdrop-blur-md">
      {/* The mark doubles as the mobile brand, since the sidebar is hidden there. */}
      <div className="flex items-center gap-1 md:hidden">
        <MobileNav />
        <Link href="/" className="flex items-center gap-2">
          <LogoMark className="h-[26px] w-[20px] text-foreground" />
          <span className="text-sm font-semibold">Tollway</span>
        </Link>
      </div>

      <div className="hidden md:block">
        <Badge tone="neutral">Observability</Badge>
      </div>

      <div className="flex items-center gap-2">
        <a
          href="https://github.com/vegaforge/tollway"
          className="hidden rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-foreground sm:inline-block"
        >
          GitHub
        </a>
        <ThemeToggle />
        <SessionBadge session={session} />
      </div>
    </header>
  );
}
