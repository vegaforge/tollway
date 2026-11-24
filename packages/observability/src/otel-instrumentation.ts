/**
 * OpenTelemetry traces and metrics around gate verify/settle and client pay.
 * Provides context and span helpers for distributed tracing.
 */

export interface OtelContext {
  /** Trace ID for correlating operations. */
  traceId?: string;
  /** Span ID for this operation. */
  spanId?: string;
  /** Parent span ID if nested. */
  parentSpanId?: string;
}

export interface OtelSpanAttributes {
  "settlement.model"?: string;
  "settlement.amount"?: string;
  "settlement.asset"?: string;
  "settlement.outcome"?: "settled" | "failed" | "skipped";
  "payer.address"?: string;
  "payee.address"?: string;
  "latency.ms"?: number;
  "error.type"?: string;
  "error.message"?: string;
  [key: string]: unknown;
}

/**
 * Creates a span context for OpenTelemetry tracing.
 * Use as wrapper around settlement operations.
 */
export function createOtelSpan(operationName: string, attributes: OtelSpanAttributes = {}) {
  const traceId = `${operationName}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const spanId = Math.random().toString(36).slice(2);

  return {
    traceId,
    spanId,
    attributes,
    startTime: Date.now(),

    /**
     * Records a span event (like an error or milestone).
     */
    addEvent(name: string, eventAttributes: OtelSpanAttributes = {}) {
      return {
        name,
        timestamp: Date.now(),
        attributes: eventAttributes,
      };
    },

    /**
     * Ends the span and returns duration.
     */
    end(): { durationMs: number; traceId: string; spanId: string } {
      return {
        durationMs: Date.now() - this.startTime,
        traceId: this.traceId,
        spanId: this.spanId,
      };
    },
  };
}

/**
 * Wraps a settlement operation with OpenTelemetry tracing.
 */
export async function traceSettlementOperation<T>(
  operationName: string,
  operation: (span: ReturnType<typeof createOtelSpan>) => Promise<T>,
  attributes: OtelSpanAttributes = {},
): Promise<T> {
  const span = createOtelSpan(operationName, attributes);
  try {
    const result = await operation(span);
    return result;
  } catch (error) {
    span.attributes["error.type"] = error instanceof Error ? error.constructor.name : "unknown";
    span.attributes["error.message"] =
      error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    span.end();
  }
}

/**
 * Extracts OpenTelemetry context from HTTP headers (W3C Trace Context standard).
 */
export function extractOtelContextFromHeaders(headers: Record<string, string>): OtelContext {
  const traceParent = headers["traceparent"]; // Format: 00-traceid-spanid-flags
  if (!traceParent) return {};

  const parts = traceParent.split("-");
  if (parts.length !== 4) return {};

  return {
    traceId: parts[1],
    spanId: parts[2],
  };
}

/**
 * Injects OpenTelemetry context into HTTP headers (W3C Trace Context standard).
 */
export function injectOtelContextToHeaders(context: OtelContext): Record<string, string> {
  if (!context.traceId || !context.spanId) return {};

  const flags = "01"; // Traced
  const traceParent = `00-${context.traceId}-${context.spanId}-${flags}`;

  return {
    traceparent: traceParent,
  };
}

/**
 * Records settlement metrics for OpenTelemetry metrics export.
 * These metrics complement the Prometheus exporter.
 */
export interface OtelMetricsCollector {
  /** Record a settlement operation. */
  recordSettlement(attributes: OtelSpanAttributes): void;
  /** Record a failed operation. */
  recordError(operationName: string, error: Error): void;
  /** Get collected metrics in OpenMetrics format. */
  export(): string;
}

export function createOtelMetricsCollector(): OtelMetricsCollector {
  const settlements: OtelSpanAttributes[] = [];
  const errors: Array<{ operation: string; error: string; timestamp: number }> = [];

  return {
    recordSettlement(attributes) {
      settlements.push(attributes);
    },

    recordError(operationName, error) {
      errors.push({
        operation: operationName,
        error: error.message,
        timestamp: Date.now(),
      });
    },

    export(): string {
      const lines: string[] = [];
      const timestamp = Date.now();

      // Export settlement counts
      const byOutcome: Record<string, number> = {};
      for (const s of settlements) {
        const outcome = s["settlement.outcome"] ?? "unknown";
        byOutcome[String(outcome)] = (byOutcome[String(outcome)] ?? 0) + 1;
      }

      for (const [outcome, count] of Object.entries(byOutcome)) {
        lines.push(`# HELP otel_settlements_total Total settlements by outcome`);
        lines.push(`# TYPE otel_settlements_total gauge`);
        lines.push(`otel_settlements_total{outcome="${outcome}"} ${count} ${timestamp}`);
      }

      // Export error counts
      const byErrorType: Record<string, number> = {};
      for (const e of errors) {
        byErrorType[e.operation] = (byErrorType[e.operation] ?? 0) + 1;
      }

      for (const [operation, count] of Object.entries(byErrorType)) {
        lines.push(`# HELP otel_errors_total Errors by operation`);
        lines.push(`# TYPE otel_errors_total gauge`);
        lines.push(`otel_errors_total{operation="${operation}"} ${count} ${timestamp}`);
      }

      return lines.join("\n");
    },
  };
}
