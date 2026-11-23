import { readFile } from "node:fs/promises";
import { TollwayError } from "./errors.js";
import { formatPolicyIssues, type Policy, type PolicyIssue, parsePolicy } from "./policy-schema.js";

/**
 * Reads and validates a policy file from disk.
 *
 * This module is exported as `@vegaforge/tollway-core/policy-loader`, a
 * separate subpath, so the main entry point stays free of `node:fs` and the
 * package keeps working on edge runtimes.
 */

/** Why a policy file could not be loaded. */
export type PolicyLoadErrorKind = "read" | "json" | "validation";

/**
 * Thrown when a policy file cannot be read, is not JSON, or does not match
 * `policySchema`. `issues` carries every validation problem, with paths.
 */
export class PolicyLoadError extends TollwayError {
  readonly kind: PolicyLoadErrorKind;
  readonly filePath: string;
  readonly issues: readonly PolicyIssue[];

  constructor(
    kind: PolicyLoadErrorKind,
    filePath: string,
    message: string,
    issues: readonly PolicyIssue[] = [],
  ) {
    super("invalid-policy", message);
    this.name = "PolicyLoadError";
    this.kind = kind;
    this.filePath = filePath;
    this.issues = issues;
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Loads a policy document from a JSON file, migrating older versions and
 * validating the result. Throws {@link PolicyLoadError}; a validation failure
 * names the field and every rule it broke.
 */
export async function loadPolicyFile(filePath: string): Promise<Policy> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    throw new PolicyLoadError(
      "read",
      filePath,
      `cannot read policy file ${filePath}: ${reason(error)}`,
    );
  }

  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new PolicyLoadError("json", filePath, `${filePath} is not valid JSON: ${reason(error)}`);
  }

  const parsed = parsePolicy(document);
  if (!parsed.ok) {
    throw new PolicyLoadError(
      "validation",
      filePath,
      `invalid policy in ${filePath}:\n${formatPolicyIssues(parsed.issues)}`,
      parsed.issues,
    );
  }
  return parsed.policy;
}
