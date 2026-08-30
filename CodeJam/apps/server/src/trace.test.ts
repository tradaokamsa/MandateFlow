import { describe, expect, it } from "vitest";
import { redactRuntimeText, redactTraceText, TRACE_EVIDENCE_MAX_LENGTH } from "./trace.js";

describe("secret redaction", () => {
  it("redacts Groq keys and bearer credentials", () => {
    expect(redactTraceText("GROQ_API_KEY=abc123")).toBe("GROQ_API_KEY=[REDACTED]");
    expect(redactTraceText("Authorization: Bearer eyJ.secret.value")).toBe(
      "Authorization: Bearer [REDACTED]",
    );
    expect(redactRuntimeText("raw-groq-key", "raw-groq-key")).toBe("[REDACTED]");
  });

  it("bounds diagnostic evidence", () => {
    const redacted = redactTraceText("x".repeat(TRACE_EVIDENCE_MAX_LENGTH + 10));
    expect(redacted).toBe("x".repeat(TRACE_EVIDENCE_MAX_LENGTH) + "… [truncated]");
  });
});
