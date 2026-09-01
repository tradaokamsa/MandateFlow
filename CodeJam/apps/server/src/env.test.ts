import { expect, it } from "vitest";
import { loadApplicationEnv } from "./env.js";

it("fails clearly when the local environment file is missing", () => {
  expect(() => loadApplicationEnv("/tmp/mandateflow-env-file-that-does-not-exist"))
    .toThrow("Missing CodeJam/.env");
});
