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
  "https://raw.githubusercontent.com/vegaforge/tollway/dev/packages/core/schema/policy.schema.json";

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

/**
 * A rolling window cap. `windowSeconds` is a whole number of seconds, at
 * least 1: the trace carries it as an integer, and the accumulator needs a
 * bucket of at least a millisecond. `z.number().int()` also limits it to
 * safe integers.
 */
const windowCapSchema = z.strictObject({
  windowSeconds: z
    .number()
    .int()
    .min(1)
    .meta({ description: "Length of the sliding window, in whole seconds (at least 1)." }),
  cap: integerString.meta({ description: "Most spend allowed inside any one window." }),
});

/**
 * The caps a `perService` or `perResource` entry can set. Both share this
 * shape so the two stay in step.
 */
const capFields = {
  /** Lifetime ceiling: it never resets. */
  cap: integerString.meta({ description: "Lifetime ceiling. It never resets." }).optional(),
  /** Ceiling per UTC day, reset at the same instant as `budgets.daily`. */
  dailyCap: integerString
    .meta({ description: "Ceiling per UTC day, reset at the same instant as budgets.daily." })
    .optional(),
  /**
   * Sliding-window ceiling, for example 5 USDC per hour. Accounting is
   * approximate to one accumulator bucket; see `RollingSum`.
   */
  window: windowCapSchema
    .meta({
      description:
        "Sliding-window ceiling, for example 5 USDC per hour. May over-count by one accumulator bucket, never under-count.",
    })
    .optional(),
};

const perServiceEntrySchema = z.strictObject(capFields);

const perResourceEntrySchema = z.strictObject({
  ...capFields,
  /**
   * `exact` (the default) matches the resource string as the receipt
   * carries it, query string included. `prefix` matches every resource that
   * starts with the key, character by character. No regex or glob.
   */
  match: z
    .enum(["exact", "prefix"])
    .meta({
      description:
        "exact (the default) matches the resource string, query string included. prefix matches every resource starting with the key, character by character.",
    })
    .optional(),
});

const adaptiveAnomalySchema = z
  .strictObject({
    kind: z.literal("ewma"),
    /** Weight of the newest minute in the baseline, at most one. */
    smoothing: rationalSchema.meta({
      description: "Weight of the newest minute in the baseline, a rational no greater than one.",
    }),
    /** How many deviations above the baseline a minute may reach. */
    sensitivity: rationalSchema.meta({
      description: "How many deviations above the baseline a minute's spend may reach.",
    }),
    /** Number of completed minute buckets before this rule can block. */
    warmupPeriods: z
      .number()
      .int()
      .positive()
      .meta({ description: "Completed minute buckets before this rule can block." }),
    /** Whether one baseline covers an asset, or each asset and payee pair. */
    scope: z
      .enum(["asset", "asset-payee"])
      .meta({ description: "One baseline per asset (the default), or per asset and payee." })
      .optional(),
    /** Maximum increase allowed when a completed bucket trains the baseline. */
    maxBaselineGrowthPerMinute: integerString
      .meta({
        description: "Largest increase allowed when a completed bucket trains the baseline.",
      })
      .optional(),
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

/** One sliding window of the rate limit. */
const rateLimitWindowSchema = z.strictObject({
  windowSeconds: z
    .number()
    .int()
    .min(1)
    .meta({ description: "Length of the sliding window, in whole seconds (at least 1)." }),
  limit: z
    .number()
    .int()
    .nonnegative()
    .meta({ description: "Most counted events allowed inside any one window." }),
});

/**
 * The rate limit (issue #197). `requestsPerMinute` is the original form and
 * stays as shorthand for one 60 second window; `windows` sets one or more
 * windows that all apply. Setting both is refused, because it is unclear
 * which the operator meant.
 */
const rateLimitSchema = z
  .strictObject({
    /** Shorthand for `windows: [{ windowSeconds: 60, limit }]`. */
    requestsPerMinute: z
      .number()
      .int()
      .nonnegative()
      .meta({
        description:
          "Most counted events in any sliding minute. Shorthand for one 60 second window; do not combine with windows.",
      })
      .optional(),
    /** Every window applies: a payment passes only if it fits in all of them. */
    windows: z
      .array(rateLimitWindowSchema)
      .min(1)
      .meta({
        description:
          "One or more sliding windows, all applied together, for example 60 per minute and 1000 per hour.",
      })
      .optional(),
    /**
     * `settlements` (the default) counts payments recorded after they
     * settle. `attempts` counts every payment the client sends, when it
     * sends it, including ones that then fail.
     */
    count: z
      .enum(["settlements", "attempts"])
      .meta({
        description:
          "settlements (the default) counts settled payments. attempts counts every payment the client sends, including failed ones.",
      })
      .optional(),
    /** `global` (the default) shares one count; `per-counterparty` keeps one per payee. */
    scope: z
      .enum(["global", "per-counterparty"])
      .meta({
        description:
          "global (the default) shares one count across every payee. per-counterparty keeps a count per payee address.",
      })
      .optional(),
    /**
     * Most counterparties tracked at once under `per-counterparty` scope.
     * Idle ones are dropped first; when every tracked one is active, a new
     * counterparty is refused until one goes idle.
     */
    perCounterpartyKeyLimit: z
      .number()
      .int()
      .min(1)
      .meta({
        description:
          "Most payees tracked at once under per-counterparty scope (default 1024). When all are active, a new payee is refused until one goes idle.",
      })
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.requestsPerMinute !== undefined && value.windows !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["windows"],
        message: "set either requestsPerMinute or windows, not both",
      });
    }
  });

const perModelSchema = z.strictObject({
  /** Allows or refuses this settlement model outright. */
  enabled: z.boolean().meta({ description: "Allows or refuses this settlement model." }).optional(),
  /** Channel mode only makes sense above a minimum deposit. */
  minChannelDeposit: integerString
    .meta({ description: "Smallest channel deposit allowed. Channel mode only." })
    .optional(),
});

/**
 * The versioned policy file. Parse external input with {@link parsePolicy}.
 * All amounts are integer strings in the asset's smallest unit, the same as
 * receipts.
 */
export const policySchema = z.strictObject({
  /**
   * The JSON Schema an editor should validate this file against. Allowed so a
   * policy file can name {@link POLICY_SCHEMA_ID}; the engine ignores it.
   */
  $schema: z
    .string()
    .meta({ description: "The JSON Schema an editor validates this file against. Ignored." })
    .optional(),
  /** The format version. Unversioned documents are migrated by {@link parsePolicy}. */
  policyVersion: z
    .literal(POLICY_VERSION)
    .meta({ description: "The policy format version. Unversioned documents are version 0." }),
  /**
   * `enforce` (the default) blocks a payment when a rule fails. `dry-run`
   * allows it and only marks the would-be block in the trace. Spend is
   * recorded the same way in both modes, so budgets stay real.
   */
  mode: z
    .enum(policyModes)
    .meta({
      description:
        "enforce (the default) blocks a payment when a rule fails. dry-run allows it and marks the would-be block in the trace.",
    })
    .optional(),
  budgets: z
    .strictObject({
      /** Spend ceiling per UTC day. */
      daily: integerString.meta({ description: "Spend ceiling per UTC day." }).optional(),
      /** Lifetime ceiling for this policy. */
      total: integerString.meta({ description: "Lifetime ceiling for this policy." }).optional(),
    })
    .optional(),
  /** Caps per counterparty service, keyed by the payee address or service id. */
  perService: z
    .record(z.string().min(1), perServiceEntrySchema)
    .meta({ description: "Caps per counterparty service, keyed by payee address or service id." })
    .optional(),
  /**
   * Caps per resource, keyed by the resource string or a prefix of it. Every
   * entry that matches a resource applies and is charged, so a narrower
   * entry can tighten a broader one but never lift it.
   */
  perResource: z
    .record(z.string().min(1), perResourceEntrySchema)
    .meta({
      description:
        "Caps per resource. Every matching entry applies and is charged, so a narrower entry can tighten a broader one but never lift it.",
    })
    .optional(),
  /** Rules per settlement model. */
  perModel: z
    .partialRecord(z.enum(settlementModels), perModelSchema)
    .meta({ description: "Rules per settlement model." })
    .optional(),
  rateLimit: rateLimitSchema
    .meta({
      description:
        "Agent-side rate limit: what is counted, over which sliding windows, and per which scope.",
    })
    .optional(),
  anomaly: z
    .strictObject({
      /** Trips the anomaly stop when spend in any minute exceeds this. */
      maxSpendPerMinute: integerString
        .meta({ description: "Trips the anomaly stop when spend in any minute exceeds this." })
        .optional(),
      /** An explainable EWMA detector over committed per-minute spend. */
      adaptive: adaptiveAnomalySchema
        .meta({ description: "An explainable EWMA detector over committed per-minute spend." })
        .optional(),
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
