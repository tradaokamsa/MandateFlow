import { createHash, randomBytes } from "node:crypto";

const CAPABILITY_PATTERN = /^mfr1_[A-Za-z0-9_-]{43}$/;
const REFERENCE_PATTERN = /ref1_[A-Za-z0-9_-]{43}/g;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const SYNTHETIC_NAME_PATTERN = /\b(?:Taylor|Morgan) Example\b/gi;

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function fingerprint(domain: string, value: string): string {
  return sha256(`mandateflow:${domain}\0${value}`).slice(0, 12);
}

export function generateCapabilityToken(): string {
  return "mfr1_" + randomBytes(32).toString("base64url");
}

export function isCapabilityToken(value: string): boolean {
  return CAPABILITY_PATTERN.test(value);
}

export function generateReferenceToken(): string {
  return "ref1_" + randomBytes(32).toString("base64url");
}

export function referenceAlias(referenceSha256: string): string {
  return "ref-" + referenceSha256.slice(0, 8);
}

export function redactPersistedText(
  value: string,
  capability: string | null = null,
): string {
  let redacted = value;
  if (capability) {
    redacted = redacted.split(capability).join("[REDACTED_CAPABILITY]");
  }
  return redacted
    .replace(REFERENCE_PATTERN, "[REDACTED_REFERENCE]")
    .replace(SYNTHETIC_NAME_PATTERN, "[REDACTED_IDENTITY]")
    .replace(EMAIL_PATTERN, "[REDACTED_EMAIL]");
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return "[" + value.map((item) => canonicalJson(item)).join(",") + "]";
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    return (
      "{" +
      entries
        .map(([key, item]) => JSON.stringify(key) + ":" + canonicalJson(item))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}
