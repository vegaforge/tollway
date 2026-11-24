// Deterministic stub data. Later swapped for @vegaforge/tollway-observability
// without touching the UI (see docs/dashboard-data-contracts.md).

// ADAPT: replace with the real settlement model names from tollway-core.
export type SettlementModel = "per-request" | "channel" | "batch";

export interface PayeeRevenue {
  payeeId: string;
  payeeName: string;
  /** Integer micro-units (1e-6) as a string, to avoid float precision loss. */
  revenueMicros: string;
}

export interface ModelStats {
  model: SettlementModel;
  calls: number;
  avgLatencyMs: number;
}

export interface ServiceSummary {
  serviceId: string;
  serviceName: string;
  payees: PayeeRevenue[];
  models: ModelStats[];
}

export const SERVICES_STUB: ServiceSummary[] = [
  {
    serviceId: "svc-weather",
    serviceName: "Weather API",
    payees: [
      { payeeId: "p-1", payeeName: "Acme Data", revenueMicros: "1250000000" },
      { payeeId: "p-2", payeeName: "Nimbus Labs", revenueMicros: "480500000" },
    ],
    models: [
      { model: "per-request", calls: 9200, avgLatencyMs: 118 },
      { model: "channel", calls: 14100, avgLatencyMs: 41 },
      { model: "batch", calls: 2700, avgLatencyMs: 260 },
    ],
  },
  {
    serviceId: "svc-geocode",
    serviceName: "Geocoding",
    payees: [{ payeeId: "p-3", payeeName: "MapWorks", revenueMicros: "905250000" }],
    models: [
      { model: "per-request", calls: 5100, avgLatencyMs: 96 },
      { model: "channel", calls: 22800, avgLatencyMs: 37 },
    ],
  },
  {
    serviceId: "svc-llm",
    serviceName: "LLM Gateway",
    payees: [
      { payeeId: "p-4", payeeName: "Orbit AI", revenueMicros: "3320000000" },
      { payeeId: "p-5", payeeName: "Lumen Compute", revenueMicros: "1815750000" },
      { payeeId: "p-1", payeeName: "Acme Data", revenueMicros: "74000000" },
    ],
    models: [
      { model: "per-request", calls: 3300, avgLatencyMs: 640 },
      { model: "channel", calls: 8800, avgLatencyMs: 410 },
      { model: "batch", calls: 12400, avgLatencyMs: 1250 },
    ],
  },
  {
    serviceId: "svc-empty",
    serviceName: "Sandbox (no traffic yet)",
    payees: [],
    models: [],
  },
];
