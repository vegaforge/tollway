---
"@vegaforge/tollway-core": minor
"@vegaforge/tollway-client": minor
---

Make rate-limit counting, windows and scope explicit (#197).

- `rateLimit` accepts `windows`, `count` (`settlements` or `attempts`),
  `scope` (`global` or `per-counterparty`) and `perCounterpartyKeyLimit`.
  `requestsPerMinute` keeps its meaning as shorthand for one 60 second
  window. All of it is validated by `policySchema` at construction.
- `PolicyEngine` gains optional `admit` and `recordAttempt`; `evaluate` and
  `check` never change state. The client counts each payment it sends
  through them.
- The rate-limit trace detail now names the scope, the payee when scoped, and
  what is counted, for example
  `global rate limit exceeded: 1 settled payments in the last 60 seconds, limit 1`.
