import policyDocument from "./policies/mixed-operations.v1.json" with { type: "json" };
import { canonicalJson, sha256 } from "./crypto.js";
import { mixedOperationsPolicySchema } from "./schemas.js";
import type { ProvenanceLabel, ToolName } from "./types.js";

export function validatePolicy(value: unknown) {
  return mixedOperationsPolicySchema.parse(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

export const MIXED_OPERATIONS_POLICY = deepFreeze(validatePolicy(policyDocument));
export const MIXED_OPERATIONS_POLICY_SHA256 = sha256(
  canonicalJson(MIXED_OPERATIONS_POLICY),
);

export type ProvenanceDecision =
  | { allowed: true; ruleId: null; safeAlternative: null }
  | {
      allowed: false;
      ruleId: "NO_PAYMENT_REIDENTIFICATION";
      safeAlternative: "payments.aggregate_failures";
    };

export function evaluateProvenance(
  destinationTool: ToolName,
  effectiveLabels: readonly ProvenanceLabel[],
): ProvenanceDecision {
  const rule = MIXED_OPERATIONS_POLICY.rules[0]!;
  if (
    destinationTool === rule.when.destinationTool &&
    effectiveLabels.includes(rule.when.anyAncestorLabel)
  ) {
    return {
      allowed: false,
      ruleId: rule.id,
      safeAlternative: rule.safeAlternative,
    };
  }
  return { allowed: true, ruleId: null, safeAlternative: null };
}

export function isPackagedPolicyAvailable(
  policyId: string,
  policyVersion: number,
  policySha256: string,
): boolean {
  return (
    policyId === MIXED_OPERATIONS_POLICY.id &&
    policyVersion === MIXED_OPERATIONS_POLICY.version &&
    policySha256 === MIXED_OPERATIONS_POLICY_SHA256
  );
}
