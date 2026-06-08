"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "@/components/icon";
import { LogoMark } from "@/components/logo";
import { navItems } from "./nav";

function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-surface md:flex">
      <Link href="/" className="flex items-center gap-2.5 border-b border-border px-5 py-4">
        <LogoMark className="h-[30px] w-[23px] text-foreground" />
        <span className="flex flex-col leading-tight">
          <span className="text-[15px] font-semibold">Tollway</span>
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
            Dashboard
          </span>
        </span>
      </Link>

      <nav className="flex flex-1 flex-col gap-0.5 p-3" aria-label="Dashboard sections">
        {navItems.map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                active
                  ? "bg-surface-2 font-medium text-foreground"
                  : "text-muted hover:bg-surface-2 hover:text-foreground"
              }`}
            >
              <Icon
                name={item.icon}
                className={`h-[18px] w-[18px] ${active ? "text-primary" : ""}`}
              />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-border px-5 py-4">
        <p className="font-mono text-[11px] text-muted">Scaffold · pre-release</p>
      </div>
    </aside>
  );
}
