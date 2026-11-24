---
"@vegaforge/tollway-core": patch
"@vegaforge/tollway-service": patch
---

Print every Zod enum schema in the service's published declarations in source order, so they are identical on every build. Core now exports the `enumSchema` helper the service uses to build them.
