// Test helper for outbox.test.ts. Opens the outbox file on its own
// connection, takes the write lock with BEGIN IMMEDIATE and reports
// "locked". It then waits until the test sets `signal[0]` to say its write is
// about to start, holds the lock for `holdMs` from that moment, commits and
// exits. Counting the hold from the test's signal, not from "locked", keeps
// the test independent of how long the message takes to arrive.
//
// It runs in a worker thread because node:sqlite is synchronous: a lock held
// on the test's own thread could never be released while that thread waits
// for it.
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

const { filename, holdMs, signal: buffer } = workerData;
const signal = new Int32Array(buffer);
// A test that never starts its write must not hang the run.
const MAX_WAIT_FOR_WRITE_MS = 10_000;

const db = new DatabaseSync(filename);
db.exec("BEGIN IMMEDIATE");
parentPort.postMessage("locked");
// Block this thread, not the test's, until the test is about to write.
Atomics.wait(signal, 0, 0, MAX_WAIT_FOR_WRITE_MS);
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);
db.exec("COMMIT");
db.close();
