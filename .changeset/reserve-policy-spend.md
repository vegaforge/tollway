---
"@vegaforge/tollway-core": minor
"@vegaforge/tollway-client": patch
---

`PolicyEngine` gains `reserve`, `commit` and `release`. A payment's spend is held against every budget and window from the moment it is admitted until it is committed or released, so payments in flight at the same time cannot all pass the same budget. Holds lapse after a time to live, and `onReservationExpired` reports each one. `pay()` reserves before it calls the settler, commits once the settler returns, and releases only when the failure proves nothing settled.
