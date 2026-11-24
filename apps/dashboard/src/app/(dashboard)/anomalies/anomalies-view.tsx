"use client";

import Link from "next/link";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import {
  ANOMALY_KINDS,
  type AnomalyEvent,
  type AnomalyKind,
  type AnomalySeverity,
  anomalyCounterparties,
  severityOf,
} from "@/data/anomalies";
import { useAnomalies } from "@/data/use-anomalies";
import { anomalyLinks, describeAnomaly, KIND_LABEL } from "@/lib/anomaly-copy";

const PAGE_SIZE = 10;

const SEVERITY_LABEL: Record<AnomalySeverity, string> = { high: "High", medium: "Medium" };

const COUNTERPARTIES = anomalyCounterparties();

/** A filter's value, or "all" for no filter. */
type Choice<T> = T | "all";

const selectClass =
  "rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

/**
 * The anomalies feed: filters, a newest-first list grouped by day, and paging.
 * `agentId` limits the feed to one agent, which the agent detail page links to.
 */
export function AnomaliesView({ agentId = null }: { agentId?: string | null }) {
  const [kind, setKind] = useState<Choice<AnomalyKind>>("all");
  const [severity, setSeverity] = useState<Choice<AnomalySeverity>>("all");
  const [counterparty, setCounterparty] = useState<Choice<string>>("all");
  // The cursor of every page before this one, so "Newer" can step back.
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors.at(-1) ?? null;

  const state = useAnomalies({
    kind: kind === "all" ? undefined : kind,
    severity: severity === "all" ? undefined : severity,
    counterparty: counterparty === "all" ? undefined : counterparty,
    agentId: agentId ?? undefined,
    cursor,
    limit: PAGE_SIZE,
  });

  /** A changed filter starts again from the newest event. */
  function restart() {
    setCursors([null]);
  }

  const nextCursor = state.status === "ready" ? state.page.nextCursor : null;

  return (
    <div className="flex flex-col gap-6">
      {agentId ? (
        <p data-testid="anomalies-agent-filter" className="text-sm">
          Showing events for agent <span className="font-mono">{agentId}</span>.{" "}
          <Link className="underline" href="/anomalies">
            Show all agents
          </Link>
        </p>
      ) : null}

      <Panel
        title="Anomaly events"
        description="Newest first. Filter by kind, severity, or counterparty."
      >
        <div className="mb-6 grid gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1 text-xs text-muted">
            Kind
            <select
              aria-label="Kind"
              className={selectClass}
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as Choice<AnomalyKind>);
                restart();
              }}
            >
              <option value="all">All kinds</option>
              {ANOMALY_KINDS.map((option) => (
                <option key={option} value={option}>
                  {KIND_LABEL[option]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            Severity
            <select
              aria-label="Severity"
              className={selectClass}
              value={severity}
              onChange={(event) => {
                setSeverity(event.target.value as Choice<AnomalySeverity>);
                restart();
              }}
            >
              <option value="all">All severities</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            Counterparty
            <select
              aria-label="Counterparty"
              className={selectClass}
              value={counterparty}
              onChange={(event) => {
                setCounterparty(event.target.value);
                restart();
              }}
            >
              <option value="all">All counterparties</option>
              {COUNTERPARTIES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
        </div>

        {state.status === "loading" ? <FeedSkeleton /> : null}
        {state.status === "error" ? <FeedError message={state.error.message} /> : null}
        {state.status === "ready" ? (
          state.page.events.length === 0 ? (
            <p className="text-sm text-muted">No events match these filters.</p>
          ) : (
            <FeedByDay events={state.page.events} />
          )
        ) : null}

        <nav aria-label="Feed pages" className="mt-6 flex items-center justify-between text-sm">
          <button
            type="button"
            onClick={() => setCursors((stack) => stack.slice(0, -1))}
            disabled={cursors.length <= 1}
            className="rounded-md border border-border px-3 py-1 disabled:opacity-50"
          >
            Newer
          </button>
          <span aria-live="polite" className="text-muted">
            Page {cursors.length}
          </span>
          <button
            type="button"
            onClick={() => {
              if (nextCursor !== null) setCursors((stack) => [...stack, nextCursor]);
            }}
            disabled={nextCursor === null}
            className="rounded-md border border-border px-3 py-1 disabled:opacity-50"
          >
            Older
          </button>
        </nav>
      </Panel>
    </div>
  );
}

/** Groups events by their UTC day, keeping the newest-first order. */
function groupByDay(events: AnomalyEvent[]): [string, AnomalyEvent[]][] {
  const groups = new Map<string, AnomalyEvent[]>();
  for (const event of events) {
    const day = event.at.slice(0, 10);
    const group = groups.get(day) ?? [];
    group.push(event);
    groups.set(day, group);
  }
  return [...groups];
}

function FeedByDay({ events }: { events: AnomalyEvent[] }) {
  return (
    <div className="flex flex-col gap-6">
      {groupByDay(events).map(([day, dayEvents]) => (
        <section key={day} aria-labelledby={`anomalies-day-${day}`}>
          <h3
            id={`anomalies-day-${day}`}
            className="mb-2 text-xs font-medium uppercase tracking-wide text-muted"
          >
            {day} UTC
          </h3>
          <ul className="flex flex-col divide-y divide-border">
            {dayEvents.map((event) => (
              <FeedItem key={event.id} event={event} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function FeedItem({ event }: { event: AnomalyEvent }) {
  const severity = severityOf(event.kind);
  const subject = event.channelId ?? event.payee ?? event.agentId ?? "Unattributed";
  return (
    <li data-testid={`anomaly-${event.id}`} className="flex flex-col gap-2 py-4">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge tone={severity === "high" ? "accent" : "neutral"}>
          {SEVERITY_LABEL[severity]} severity
        </Badge>
        <span className="font-medium">{KIND_LABEL[event.kind]}</span>
        <span className="font-mono text-muted">{subject}</span>
        <time dateTime={event.at} className="ml-auto font-mono text-muted">
          {event.at}
        </time>
      </div>
      <p className="text-sm">{describeAnomaly(event)}</p>
      <ul className="flex flex-wrap gap-3 text-xs">
        {anomalyLinks(event).map((link) => (
          <li key={link.href}>
            <Link className="underline hover:text-foreground" href={link.href}>
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </li>
  );
}

function FeedSkeleton() {
  return (
    <div className="space-y-2" data-testid="anomalies-skeleton">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-16 animate-pulse rounded-md bg-surface-2" />
      ))}
    </div>
  );
}

function FeedError({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-dashed border-border-strong bg-surface-2 px-4 py-6 text-sm text-muted"
    >
      <p className="font-medium text-foreground">Could not load anomalies</p>
      <p className="mt-1">{message}</p>
    </div>
  );
}
