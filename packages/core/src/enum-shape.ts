import { z } from "zod";

/**
 * The object Zod keeps behind an enum schema: each allowed value keyed by
 * itself, for example `{ testnet: "testnet"; mainnet: "mainnet" }`, built
 * from the tuple of allowed values.
 *
 * It exists so the published declarations come out the same on every build.
 * `z.enum(values)` infers this shape from the union of the values, and
 * TypeScript prints a union in the order the checker happened to create its
 * members. tsup emits declarations one source file at a time, in the order
 * rollup transforms them, and that order changes between runs. A literal
 * such as `"anomaly"` that several files mention is then created at a
 * different moment on different builds, and the inferred enum printed its
 * keys in a different order: the public API report changed between two
 * builds of the same commit.
 *
 * Keyed by the tuple instead, the declaration prints the values as the
 * tuple lists them, which is source order and never moves. A union alias
 * such as `PolicyRuleId` would not help: TypeScript shares one union object
 * per set of members and often prints its members instead of the alias.
 */
export type EnumShape<Values extends readonly string[]> = { [Key in Values[number]]: Key };

/**
 * `z.enum` for a list of string values, with a declared type that prints in
 * source order; see {@link EnumShape}. Every enum schema in this package
 * goes through it, so no public declaration depends on the checker's
 * internal ordering. It is exported so packages that publish their own Zod
 * schemas, such as `@vegaforge/tollway-service`, get the same stable
 * declarations.
 */
export function enumSchema<const Values extends readonly string[]>(
  values: Values,
): z.ZodEnum<EnumShape<Values>> {
  return z.enum(values);
}
