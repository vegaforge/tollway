---
date: 2026-11-24
feature: Core declarations print Zod enums in source order on every build
scope: fix
packages: ["@vegaforge/tollway-core"]
scenario-impact: none
---

# Stable enum declarations in core

The CI API report check for `@vegaforge/tollway-core` failed now and then on
pull requests that never touched the package, and passed when the job was
re-run. Two builds of the same commit could publish declarations that listed
the keys of a Zod enum, such as the policy rule ids, in a different order.
The types were equal, but the API report is compared as text, so the check
failed. Nothing a user can observe at runtime changed.

The cause is in how the declarations are built. TypeScript prints a union in
the order its checker created the member types, not in source order. tsup
emits declarations one source file at a time, in the order rollup transforms
them, and that order varies with timing. A literal such as `"anomaly"`, which
several files mention, was created earlier on some builds than on others, and
an inferred `z.ZodEnum<{ ... }>` printed it in a different place. About one
clean build in four reproduced it locally.

Every enum schema in core is now built with an internal `enumSchema` helper
whose declared type is `z.ZodEnum<EnumShape<readonly [...values]>>`. The values
print from the tuple, in source order, whatever order the checker used. The
new exported `EnumShape` type is the shape Zod already used, keyed by the
tuple instead of the union, so parsed values and inferred types are unchanged.
A test builds the declarations and fails if an enum is printed from a union
again.

`scripts/check-api-reports.sh` now also prints a unified diff of the committed
and generated report when the check fails, so a CI failure can be diagnosed
from the log.
