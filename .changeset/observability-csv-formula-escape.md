---
"@vegaforge/tollway-observability": minor
---

CSV exports now neutralize spreadsheet formula injection: a cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return is written with a leading single quote. This changes the CSV bytes for those cells, so a consumer that parses the CSV back gets the quoted value. JSON exports are unchanged.
