/**
 * `@vegaforge/tollway-observability/sqlite`: the SQLite metrics store (#217).
 * A separate entry point so the main one never references the store's SQL.
 */
export {
  createSqliteMetricsStore,
  type SqliteMetricsStoreOptions,
} from "./sqlite-metrics-store.js";
