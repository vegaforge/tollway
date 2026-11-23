// Test helper for outbox.test.ts. Opens the outbox file on its own
// connection, takes the write lock with BEGIN IMMEDIATE, reports "locked",
// holds the lock for `holdMs`, then commits and exits. It runs in a worker
// thread because node:sqlite is synchronous: a lock held on the test's own
// thread could never be released while that thread waits for it.
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

const { filename, holdMs } = workerData;
const db = new DatabaseSync(filename);
db.exec("BEGIN IMMEDIATE");
parentPort.postMessage("locked");
// Block this thread, not the test's, for the hold time.
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);
db.exec("COMMIT");
db.close();
