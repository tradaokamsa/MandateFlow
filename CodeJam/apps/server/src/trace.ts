/** Keep diagnostic evidence small before it reaches logs or persisted state. */
export const TRACE_EVIDENCE_MAX_LENGTH = 1_000;

const secretName =
  "(?:GROQ_API_KEY|ARK_API_KEY|OPENAI_API_KEY|API_KEY|AUTHORIZATION|BEARER|TOKEN|SECRET|PASSWORD)";

function redactSecretPatterns(value: string): string {
  return value
    .replace(/(authorization\s*:\s*bearer\s+)([^\s,;"}]+)/gi, "$1[REDACTED]")
    .replace(/(\bbearer\s+)([^\s,;"}]+)/gi, "$1[REDACTED]")
    .replace(
      new RegExp(`(\\b${secretName}\\b\\s*[=:]\\s*)((?!Bearer\\b)[^\\s,;"}]+)`, "gi"),
      "$1[REDACTED]",
    )
    .replace(
      new RegExp(`(\\\"${secretName}\\\"\\s*:\\s*\\\")(?:[^\\\"]*)(\\\")`, "gi"),
      "$1[REDACTED]$2",
    );
}

/** Redact known credential patterns and any exact configured secret value. */
export function redactRuntimeText(value: string, ...secrets: string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redactSecretPatterns(redacted);
}

/** Redacts and bounds diagnostic text before it is persisted or displayed. */
export function redactTraceText(value: string): string {
  const redacted = redactSecretPatterns(value);
  return redacted.length <= TRACE_EVIDENCE_MAX_LENGTH
    ? redacted
    : redacted.slice(0, TRACE_EVIDENCE_MAX_LENGTH) + "… [truncated]";
}
