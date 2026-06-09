import type { IconName } from "@/components/icon";

/**
 * The dashboard's primary navigation. Each entry is a section the
 * observability data feeds, mapped to docs/design.md, "Observability".
 * Add a route under src/app/<href> and a real view when wiring the data.
 */
export type NavItem = {
  label: string;
  href: string;
  icon: IconName;
  /** One line on what this view will show once it is wired. */
  summary: string;
};

export const navItems: NavItem[] = [
  {
    label: "Overview",
    href: "/",
    icon: "overview",
    summary: "Spend, model mix, failures, and open channels at a glance.",
  },
  {
    label: "Agents",
    href: "/agents",
    icon: "agents",
    summary: "Per-agent spend over time and budget usage.",
  },
  {
    label: "Services",
    href: "/services",
    icon: "services",
    summary: "Per-service revenue, model mix, and latency.",
  },
  {
    label: "Channels",
    href: "/channels",
    icon: "channels",
    summary: "Open MPP channels and their remaining budget.",
  },
  {
    label: "Receipts",
    href: "/receipts",
    icon: "receipts",
    summary: "The canonical signed receipt archive, searchable.",
  },
  {
    label: "Anomalies",
    href: "/anomalies",
    icon: "anomalies",
    summary: "Spend spikes and policy stops as they fire.",
  },
  {
    label: "Exports",
    href: "/exports",
    icon: "exports",
    summary: "JSON and CSV exports and outgoing webhooks.",
  },
];
