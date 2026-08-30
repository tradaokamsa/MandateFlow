import { describe, expect, it } from "vitest";
import {
  fingerprint,
  generateCapabilityToken,
  generateReferenceToken,
  redactPersistedText,
  sha256,
} from "./crypto.js";

describe("MandateFlow cryptography and redaction", () => {
  it("generates opaque 256-bit capability and reference handles", () => {
    const capability = generateCapabilityToken();
    const reference = generateReferenceToken();

    expect(capability).toMatch(/^mfr1_[A-Za-z0-9_-]{43}$/);
    expect(reference).toMatch(/^ref1_[A-Za-z0-9_-]{43}$/);
    expect(sha256(capability)).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint("capability", capability)).toHaveLength(12);
    expect(fingerprint("runtime", capability)).not.toBe(
      fingerprint("capability", capability),
    );
  });

  it("scrubs exact capabilities, opaque references and synthetic identities", () => {
    const capability = generateCapabilityToken();
    const reference = generateReferenceToken();
    const persisted = redactPersistedText(
      `token=${capability} ref=${reference} Taylor Example <taylor.support@example.test>`,
      capability,
    );

    expect(persisted).not.toContain(capability);
    expect(persisted).not.toContain(reference);
    expect(persisted).not.toContain("Taylor Example");
    expect(persisted).not.toContain("taylor.support@example.test");
    expect(persisted).toContain("[REDACTED_CAPABILITY]");
    expect(persisted).toContain("[REDACTED_REFERENCE]");
  });

  it("scrubs known synthetic display names regardless of casing", () => {
    const persisted = redactPersistedText(
      "TAYLOR EXAMPLE and morgan example are synthetic identities",
    );

    expect(persisted.toLowerCase()).not.toContain("taylor example");
    expect(persisted.toLowerCase()).not.toContain("morgan example");
    expect(persisted).toBe(
      "[REDACTED_IDENTITY] and [REDACTED_IDENTITY] are synthetic identities",
    );
  });
});
