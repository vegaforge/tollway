---
"@vegaforge/tollway-observability": patch
---

Prefix CSV export cells starting with `=`, `+`, `-`, or `@` with a single quote in `csvEscape` to prevent spreadsheet formula injection.
