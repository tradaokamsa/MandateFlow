import { describe, expect, it } from "vitest";
import {
  MIXED_OPERATIONS_POLICY,
  MIXED_OPERATIONS_POLICY_SHA256,
  evaluateProvenance,
  validatePolicy,
} from "./policy.js";

describe("mixed operations policy", () => {
  it("loads a strict canonical v1 policy with a stable hash", () => {
    expect(MIXED_OPERATIONS_POLICY).toMatchObject({
      id: "mixed-operations-flow",
      version: 1,
      purposeId: "MIXED_OPERATIONS_BRIEF",
    });
    expect(MIXED_OPERATIONS_POLICY_SHA256).toBe(
      "4fbe2b6d479175b0ecfda64ae10b6aba458f267cfde0ea7bbc7e89bae9dae4af",
    );
    expect(() =>
      validatePolicy({ ...MIXED_OPERATIONS_POLICY, unexpected: true }),
    ).toThrow();
  });

  it("denies only Payment-derived CRM reidentification", () => {
    expect(
      evaluateProvenance("crm.resolve_customer", [
        "PAYMENT_AGGREGATE_ONLY",
        "CASE_DERIVED",
      ]),
    ).toMatchObject({
      allowed: false,
      ruleId: "NO_PAYMENT_REIDENTIFICATION",
      safeAlternative: "payments.aggregate_failures",
    });
    expect(
      evaluateProvenance("crm.resolve_customer", [
        "SUPPORT_FOLLOWUP_ALLOWED",
        "CASE_DERIVED",
      ]),
    ).toMatchObject({ allowed: true });
  });

  it("cannot mutate shipped policy semantics after its hash is pinned", () => {
    const rule = MIXED_OPERATIONS_POLICY.rules[0]! as unknown as {
      when: { anyAncestorLabel: string };
    };
    const original = rule.when.anyAncestorLabel;
    let mutationThrew = false;
    try {
      rule.when.anyAncestorLabel = "SUPPORT_FOLLOWUP_ALLOWED";
    } catch {
      mutationThrew = true;
    } finally {
      if (!mutationThrew) rule.when.anyAncestorLabel = original;
    }

    expect(mutationThrew).toBe(true);
    expect(Object.isFrozen(MIXED_OPERATIONS_POLICY.rules[0]?.when)).toBe(true);
    expect(
      evaluateProvenance("crm.resolve_customer", ["PAYMENT_AGGREGATE_ONLY"]),
    ).toMatchObject({ allowed: false });
  });
});
