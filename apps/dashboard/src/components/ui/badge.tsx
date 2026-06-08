import type { ReactNode } from "react";

type Tone = "neutral" | "primary" | "accent";

const tones: Record<Tone, string> = {
  neutral: "border-border bg-surface-2 text-muted",
  primary: "border-transparent bg-primary text-primary-foreground",
  accent: "border-transparent bg-accent text-accent-foreground",
};

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: Tone }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}
