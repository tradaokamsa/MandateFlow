import assert from "node:assert/strict";
import {
  MIXED_OPERATIONS_POLICY,
  MIXED_OPERATIONS_POLICY_SHA256,
  isPackagedPolicyAvailable,
} from "../dist/mandateflow/policy.js";

const expectedHash =
  "4fbe2b6d479175b0ecfda64ae10b6aba458f267cfde0ea7bbc7e89bae9dae4af";

assert.equal(MIXED_OPERATIONS_POLICY.id, "mixed-operations-flow");
assert.equal(MIXED_OPERATIONS_POLICY.version, 1);
assert.equal(MIXED_OPERATIONS_POLICY_SHA256, expectedHash);
assert.equal(
  isPackagedPolicyAvailable("mixed-operations-flow", 1, expectedHash),
  true,
);
assert.equal(Object.isFrozen(MIXED_OPERATIONS_POLICY), true);
assert.equal(Object.isFrozen(MIXED_OPERATIONS_POLICY.rules[0].when), true);

console.log("Compiled MandateFlow policy artifact verified.");
