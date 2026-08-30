import http from "node:http";

const maxRequestBytes = 4 * 1024 * 1024;
const port = Number(process.env.GROQ_RESPONSES_PROXY_PORT || 34567);
const upstream =
  (process.env.GROQ_UPSTREAM_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/+$/, "") +
  "/responses";
const unsupportedRequestFields = new Set([
  "access_programs",
  "client_metadata",
  "include",
  "previous_response_id",
  "prompt",
  "prompt_cache_key",
  "safety_identifier",
  "store",
  "truncation",
]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitize(value) {
  if (!isRecord(value)) throw new Error("Groq Responses request must be a JSON object");
  const request = { ...value };
  for (const field of unsupportedRequestFields) delete request[field];
  if (isRecord(request.reasoning) && Object.keys(request.reasoning).length === 0) {
    delete request.reasoning;
  }
  if (Array.isArray(request.tools)) {
    request.tools = request.tools.filter((tool) => isRecord(tool) && tool.type === "function");
    if (request.tools.length === 0) {
      delete request.tools;
      delete request.tool_choice;
    }
  }
  return request;
}

function requestPath(request) {
  try {
    return new URL(request.url || "/", "http://127.0.0.1").pathname;
  } catch {
    return "";
  }
}

function json(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const contentLength = Number(request.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > maxRequestBytes) {
    request.resume();
    throw new Error("request too large");
  }

  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    totalBytes += chunk.byteLength;
    if (totalBytes > maxRequestBytes) {
      request.resume();
      throw new Error("request too large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const server = http.createServer(async (request, response) => {
  if (request.method !== "POST" || !requestPath(request).endsWith("/responses")) {
    json(response, 404, { error: "Not found" });
    return;
  }

  try {
    const body = sanitize(JSON.parse(await readBody(request)));
    const headers = { "content-type": "application/json" };
    if (request.headers.authorization) headers.authorization = request.headers.authorization;
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
    for await (const chunk of upstreamResponse.body) response.write(chunk);
    response.end();
  } catch (error) {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    json(response, message === "request too large" ? 413 : 502, {
      error: message === "request too large" ? message : "Groq Responses proxy request failed",
    });
  }
});

server.on("error", () => process.exitCode = 1);
server.listen(port, "127.0.0.1");
