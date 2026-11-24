---
date: 2026-11-24
feature: Service declarations print Zod enums in source order on every build
scope: fix
packages: ["@vegaforge/tollway-core", "@vegaforge/tollway-service"]
scenario-impact: none
---

# Stable enum declarations in the service

The published declarations of `@vegaforge/tollway-service` could list the keys
of a Zod enum, such as the metrics `outcome` values, in a different order on
two builds of the same commit. The types were equal, but the API report is
compared as text, so the CI report check could fail on a pull request that
never touched the service. Nothing a user can observe at runtime changed.

This is the same cause fixed for core in #351. TypeScript prints a union in
the order its checker created the member types, and tsup emits declarations
one source file at a time in an order that varies between runs, so an
inferred `z.ZodEnum<{ ... }>` could print its keys in either order.

Core now exports its `enumSchema` helper, and every enum schema in the
service is built with it. The declared type is
`z.ZodEnum<EnumShape<readonly [...values]>>`, which prints the values from the
tuple in source order whatever order the checker used. Parsed values and
inferred types are unchanged. A test in the service builds its declarations
and fails if an enum is printed from a union again.
