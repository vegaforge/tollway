// A single stroked-line icon primitive. Pass one or more SVG path strings.
// Keeps the icon set dependency-free and consistent in weight.

export type IconName =
  | "overview"
  | "agents"
  | "services"
  | "channels"
  | "receipts"
  | "anomalies"
  | "exports";

const paths: Record<IconName, string[]> = {
  overview: ["M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"],
  agents: ["M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2", "M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8"],
  services: ["M4 4h16v6H4zM4 14h16v6H4z", "M8 7h.01M8 17h.01"],
  channels: ["M9 15l6-6", "M10 6l1-1a4 4 0 0 1 6 6l-1 1", "M14 18l-1 1a4 4 0 0 1-6-6l1-1"],
  receipts: ["M6 2h9l3 3v17l-3-2-3 2-3-2-3 2V2z", "M9 8h6M9 12h6M9 16h4"],
  anomalies: [
    "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
    "M12 9v4M12 17h.01",
  ],
  exports: ["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "M7 10l5 5 5-5M12 15V3"],
};

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {paths[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
