/**
 * Structured logging for the service. The default writes one JSON object per
 * line to stdout or stderr. Call sites pass only fields they chose: request
 * logs carry the method, path, status, duration and API key name, never a
 * header, a key or a key hash.
 */
export type LogFields = Readonly<Record<string, string | number | boolean | null>>;

export interface ServiceLogger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

function line(level: string, event: string, fields?: LogFields): string {
  return JSON.stringify({ time: new Date().toISOString(), level, event, ...fields });
}

/** Writes JSON lines through `console`, which every runtime provides. */
export function createConsoleLogger(): ServiceLogger {
  return {
    info: (event, fields) => console.log(line("info", event, fields)),
    warn: (event, fields) => console.warn(line("warn", event, fields)),
    error: (event, fields) => console.error(line("error", event, fields)),
  };
}

/** The name and message of an unknown thrown value, for a log line. */
export function describeError(error: unknown): LogFields {
  if (error instanceof Error) return { error: error.name, message: error.message };
  return { error: typeof error };
}
