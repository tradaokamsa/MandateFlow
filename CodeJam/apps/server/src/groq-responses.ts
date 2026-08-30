import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";

export const GROQ_RESPONSES_PROXY_PORT = 34567;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

const unsupportedRequestFields = [
  "access_programs",
  "client_metadata",
  "include",
  "previous_response_id",
  "prompt",
  "prompt_cache_key",
  "safety_identifier",
  "store",
  "truncation",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Remove Responses fields that Codex sends but Groq does not accept. */
export function sanitizeGroqResponsesRequest(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("Groq Responses request must be a JSON object");
  }

  const request = { ...value };
  for (const field of unsupportedRequestFields) delete request[field];

  if (isRecord(request.reasoning) && Object.keys(request.reasoning).length === 0) {
    delete request.reasoning;
  }

  if (Array.isArray(request.tools)) {
    const tools = request.tools.filter(
      (tool): tool is Record<string, unknown> => isRecord(tool) && tool.type === "function",
    );
    if (tools.length > 0) {
      request.tools = tools;
    } else {
      delete request.tools;
      delete request.tool_choice;
    }
  }

  return request;
}

class RequestTooLargeError extends Error {}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body: Record<string, unknown>,
): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<string> {
  const contentLength = Number(request.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    request.resume();
    throw new RequestTooLargeError("request too large");
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_REQUEST_BYTES) {
      request.resume();
      throw new RequestTooLargeError("request too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function requestPath(request: IncomingMessage): string {
  try {
    return new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  } catch {
    return "";
  }
}

export class GroqResponsesProxy {
  private server: ReturnType<typeof createServer> | null = null;
  private address: string | null = null;

  constructor(private readonly upstreamBaseUrl: string) {}

  async start(): Promise<string> {
    if (this.address) return this.address;

    const upstream = this.upstreamBaseUrl.replace(/\/+$/, "") + "/responses";
    const server = createServer(async (request, response) => {
      if (request.method !== "POST" || !requestPath(request).endsWith("/responses")) {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      try {
        const body = sanitizeGroqResponsesRequest(JSON.parse(await readBody(request)));
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (request.headers.authorization) {
          headers.authorization = request.headers.authorization;
        }
        if (request.headers.accept) headers.accept = request.headers.accept;

        const upstreamResponse = await fetch(upstream, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        response.statusCode = upstreamResponse.status;
        const contentType = upstreamResponse.headers.get("content-type");
        if (contentType) response.setHeader("content-type", contentType);
        const cacheControl = upstreamResponse.headers.get("cache-control");
        if (cacheControl) response.setHeader("cache-control", cacheControl);
        if (!upstreamResponse.body) {
          response.end();
          return;
        }
        Readable.fromWeb(upstreamResponse.body as ReadableStream<Uint8Array>).pipe(response);
      } catch (error) {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        const tooLarge = error instanceof RequestTooLargeError;
        writeJson(response, tooLarge ? 413 : 502, {
          error: tooLarge ? "request too large" : "Groq Responses proxy request failed",
        });
      }
    });
    this.server = server;

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
    } catch (error) {
      await this.close();
      throw error;
    }

    const address = server.address();
    if (!address || typeof address === "string") {
      await this.close();
      throw new Error("Groq Responses proxy did not receive a TCP address");
    }
    this.address = "http://127.0.0.1:" + address.port + "/openai/v1";
    return this.address;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.address = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
