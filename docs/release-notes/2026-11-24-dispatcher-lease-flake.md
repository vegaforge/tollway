---
date: 2026-11-24
feature: Two observability tests no longer depend on the wall clock
scope: fix
packages: ["@vegaforge/tollway-observability"]
scenario-impact: none
---

# Deterministic dispatcher and outbox lock tests

No behaviour a user can observe changed. This fixes two tests that failed at
random in CI and on `dev`.

The test "never lets a dispatcher whose lease expired overwrite another's
delivery" froze dispatcher A's clock at a `start` time read before the row
was enqueued. `enqueue` stamps `nextAttemptAt` with the real clock, so when
a millisecond or more passed between the two, the row was not yet due by A's
frozen clock. A claimed nothing, never called `fetch`, and `vi.waitFor` gave
up after one second. Run on its own, or on a loaded CI runner, it failed
every time.

The test now enqueues the row before reading `start`, waits for A's request
through a promise instead of polling, and fakes only `setTimeout`, so A's
real 1000 ms request timeout cannot fire while the test is still arranging
dispatcher B. The assertions are unchanged: A's late failure must still be
refused as a lost lease, with nothing dead-lettered.

The SQLite outbox test "waits for the lock and writes once it is released"
had the same kind of race. Its helper worker took the write lock, posted
"locked", and held the lock for a fixed 200 ms of real time. When the main
thread was slow to receive that message, the lock was already gone by the
time the write ran, which then took about 1 ms instead of at least 150 ms.
The worker now holds the lock until the test signals, through a shared
buffer, that its write is starting, and counts the hold time from there. The
sibling test, which expects "database is locked" after the busy timeout,
uses the same signal.
