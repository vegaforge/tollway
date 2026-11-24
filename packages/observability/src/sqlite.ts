/**
 * Shared loader for the built-in `node:sqlite` module. Each SQLite-backed
 * store calls it inside its factory, never at module load, so an edge runtime
 * that only uses the in-memory implementations can still import the package.
 */

/** The first Node release where `node:sqlite` works without a flag. */
export const SQLITE_MINIMUM_NODE = "22.13.0";

/**
 * Loads `node:sqlite`, or throws an error that names `feature` and the Node
 * version it needs. Older releases either lack `process.getBuiltinModule` or
 * keep the module behind `--experimental-sqlite`.
 */
export function loadSqlite(feature: string): typeof import("node:sqlite") {
  const unavailable = () =>
    new Error(
      `${feature} needs node:sqlite, available without a flag from Node ${SQLITE_MINIMUM_NODE}; this is Node ${process.versions.node}`,
    );
  if (typeof process.getBuiltinModule !== "function") throw unavailable();
  let sqlite: typeof import("node:sqlite") | undefined;
  try {
    sqlite = process.getBuiltinModule("node:sqlite");
  } catch (cause) {
    throw Object.assign(unavailable(), { cause });
  }
  if (!sqlite) throw unavailable();
  return sqlite;
}
