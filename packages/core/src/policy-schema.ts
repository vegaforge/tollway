import { z } from "zod";
import { TollwayError } from "./errors.js";
import { policyModes } from "./policy-trace.js";
import { settlementModels } from "./types.js";

/**
 * The policy file format, as a runtime schema. `Policy` is derived from this
 * schema, so the type and the validation cannot drift. See
 * apps/web/src/content/docs/policy.mdx.
 *
 * Policy is data, not code: an operator writes it, the dashboard edits it and
 * the planned policy API serves it. Every object is strict, so a typo such as
 * `budgets.dialy` is an error at startup instead of a rule that silently
 * enforces nothing.
 */

/** The policy format this release writes and understands. */
export const POLICY_VERSION = 1;

/** Where the committed JSON Schema lives, for editors and generated clients. */
export const POLICY_SCHEMA_ID =
  "https://github.com/vegaforge/tollway/blob/dev/packages/core/schema/policy.schema.json";

const integerString = z
  .string()
  .regex(/^[0-9]+$/, "expected an integer string in the asset's smallest unit");
const positiveIntegerString = z
  .string()
  .regex(/^[1-9][0-9]*$/, "expected a positive integer string");

const rationalSchema = z.strictObject({
  numerator: positiveIntegerString,
  denominator: positiveIntegerString,
});

const adaptiveAnomalySchema = z
  .strictObject({
    kind: z.literal("ewma"),
    smoothing: rationalSchema,
    sensitivity: rationalSchema,
    /** Number of completed minute buckets before this rule can block. */
    warmupPeriods: z.number().int().positive(),
    scope: z.enum(["asset", "asset-payee"]).optional(),
    /** Maximum increase allowed when a completed bucket trains the baseline. */
    maxBaselineGrowthPerMinute: integerString.optional(),
  })
  .superRefine((value, ctx) => {
    if (BigInt(value.smoothing.numerator) > BigInt(value.smoothing.denominator)) {
      ctx.addIssue({
        code: "custom",
        path: ["smoothing"],
        message: "smoothing must be no greater than one",
      });
    }
  });

const perModelSchema = z.strictObject({
  enabled: z.boolean().optional(),
  minChannelDeposit: integerString.optional(),
});

/** The versioned policy file. Parse external input with {@link parsePolicy}. */
export const policySchema = z.strictObject({
  policyVersion: z.literal(POLICY_VERSION),
  mode: z.enum(policyModes).optional(),
  budgets: z
    .strictObject({
      daily: integerString.optional(),
      total: integerString.optional(),
    })
    .optional(),
  perService: z
    .record(z.string().min(1), z.strictObject({ cap: integerString.optional() }))
    .optional(),
  perModel: z.partialRecord(z.enum(settlementModels), perModelSchema).optional(),
  rateLimit: z
    .strictObject({
      requestsPerMinute: z.number().int().nonnegative().optional(),
    })
    .optional(),
  anomaly: z
    .strictObject({
      maxSpendPerMinute: integerString.optional(),
      adaptive: adaptiveAnomalySchema.optional(),
    })
    .optional(),
});

/** A policy as the engine consumes it, after migration and validation. */
export type Policy = z.infer<typeof policySchema>;

/**
 * What callers may pass to {@link createPolicyEngine}. The version is
 * optional here so policies written before versioning (the legacy shape)
 * still type-check; `parsePolicy` migrates them to {@link POLICY_VERSION}
 * before validating.
 */
export type PolicyInput = Omit<Policy, "policyVersion"> & { policyVersion?: number };

/** One validation problem, with the path to the field it belongs to. */
export type PolicyIssue = {
  /** Field path, for example `["budgets", "daily"]`; empty for the root. */
  path: string[];
  message: string;
};

/**
 * The result of {@link parsePolicy}. A failure carries every issue, not just
 * the first, because an operator fixing a file wants the whole list.
 */
export type PolicyParseResult =
  | { ok: true; policy: Policy; migratedFrom?: number }
  | { ok: false; issues: PolicyIssue[] };

const LEGACY_POLICY_VERSION = 0;

function zodPath(path: readonly PropertyKey[]): string[] {
  return path.map(String);
}

function pathLabel(path: readonly string[]): string {
  return path.length === 0 ? "(root)" : path.join(".");
}

/** Formats issues one per line, each starting with its field path. */
export function formatPolicyIssues(issues: readonly PolicyIssue[]): string {
  return issues.map((issue) => `${pathLabel(issue.path)}: ${issue.message}`).join("\n");
}

/**
 * Brings an older policy document up to {@link POLICY_VERSION}. Version 0 is
 * the unversioned shape every release before this one accepted: the same
 * rules, with no `policyVersion`. The migration adds the field and lets the
 * schema check the rest.
 */
function migrate(
  input: unknown,
): { value: unknown; migratedFrom?: number } | { issues: PolicyIssue[] } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { value: input };
  const record = input as Record<string, unknown>;
  const version = record.policyVersion;
  if (version === undefined || version === LEGACY_POLICY_VERSION) {
    return { value: { ...record, policyVersion: POLICY_VERSION }, migratedFrom: version ?? 0 };
  }
  if (version === POLICY_VERSION) return { value: record };
  return {
    issues: [
      {
        path: ["policyVersion"],
        message: `unsupported policy version ${String(version)}; supported versions are 0 (legacy) and ${POLICY_VERSION}`,
      },
    ],
  };
}

/**
 * Parses any external value as a policy, migrating supported older versions
 * first. Returns every issue with its path instead of throwing, so a loader
 * or an editor can show the whole list. See {@link PolicyValidationError} for
 * the throwing form {@link createPolicyEngine} uses.
 */
export function parsePolicy(input: unknown): PolicyParseResult {
  const migrated = migrate(input);
  if ("issues" in migrated) return { ok: false, issues: migrated.issues };

  const result = policySchema.safeParse(migrated.value);
  if (!result.success) {
    const issues: PolicyIssue[] = [];
    for (const issue of result.error.issues) {
      // zod reports a strict object's unknown keys once, on the object, with
      // the names in `keys`. An operator needs the field that is wrong, so
      // split those into one issue per key at its own path.
      if (issue.code === "unrecognized_keys") {
        for (const key of issue.keys) {
          issues.push({
            path: [...zodPath(issue.path), key],
            message: "unrecognized key",
          });
        }
        continue;
      }
      issues.push({ path: zodPath(issue.path), message: issue.message });
    }
    return { ok: false, issues };
  }
  return {
    ok: true,
    policy: result.data,
    ...(migrated.migratedFrom === undefined ? {} : { migratedFrom: migrated.migratedFrom }),
  };
}

/**
 * Thrown by {@link createPolicyEngine} when its policy does not match
 * `policySchema`. One error lists every issue, so a bad policy fails at
 * construction instead of on the first payment.
 */
export class PolicyValidationError extends TollwayError {
  readonly issues: readonly PolicyIssue[];

  constructor(issues: readonly PolicyIssue[]) {
    super("invalid-policy", `invalid policy:\n${formatPolicyIssues(issues)}`);
    this.name = "PolicyValidationError";
    this.issues = issues;
  }
}

/**
 * The committed JSON Schema for {@link policySchema}. Regenerate
 * `packages/core/schema/policy.schema.json` from this function; the test
 * fails when the file is stale.
 */
export function policyJsonSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: POLICY_SCHEMA_ID,
    title: "Tollway policy",
    description:
      "A Tollway policy document. Amounts are integer strings in the asset's smallest unit.",
    ...z.toJSONSchema(policySchema, { target: "draft-2020-12" }),
  };
}
