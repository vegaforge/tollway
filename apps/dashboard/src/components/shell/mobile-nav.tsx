"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useId, useRef, useState } from "react";
import { Icon } from "@/components/icon";
import { isActive, navItems } from "./nav";

/**
 * The section menu on small screens, where the sidebar is hidden. A
 * disclosure button that opens the same links as the sidebar; Escape closes
 * it and returns focus to the button.
 */
export function MobileNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);

  return (
    // Escape is handled on the wrapper so it works with focus on the button
    // as well as inside the menu.
    // biome-ignore lint/a11y/noStaticElementInteractions: the wrapper only listens for Escape bubbling from the button and links inside it; it is not itself interactive.
    <div
      className="relative"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          setOpen(false);
          buttonRef.current?.focus();
        }
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label="Open navigation"
        onClick={() => setOpen((value) => !value)}
        className="grid h-[38px] w-[38px] place-items-center rounded-[9px] text-foreground hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          className="h-[18px] w-[18px]"
          aria-hidden="true"
        >
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      </button>
      {open ? (
        <nav
          id={menuId}
          aria-label="Dashboard sections"
          className="absolute left-0 top-11 z-40 flex w-56 flex-col gap-0.5 rounded-lg border border-border bg-surface p-2 shadow-lg"
        >
          {navItems.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                // The menu should not stay open over the page the link opens.
                onClick={() => setOpen(false)}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm ${
                  active ? "bg-surface-2 font-medium text-foreground" : "text-muted"
                } hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary`}
              >
                <Icon name={item.icon} className="h-[18px] w-[18px]" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      ) : null}
    </div>
  );
}
