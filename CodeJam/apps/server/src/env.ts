import { existsSync } from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

const codeJamRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export const defaultEnvFile = path.join(codeJamRoot, ".env");

/**
 * Load the repository environment file before application configuration is
 * parsed. Production containers may receive the same values through Compose
 * or another process supervisor, so an injected production environment is
 * accepted when it already contains the Groq key.
 */
export function loadApplicationEnv(envFile = defaultEnvFile): string | null {
  if (existsSync(envFile)) {
    loadEnvFile(envFile);
    return envFile;
  }

  if (process.env.NODE_ENV === "production" && process.env.GROQ_API_KEY?.trim()) {
    return null;
  }

  throw new Error(
    "Missing CodeJam/.env. Copy CodeJam/.env.example to CodeJam/.env and set GROQ_API_KEY to your Groq API key.",
  );
}
