import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  GroqResponsesProxy,
  sanitizeGroqResponsesRequest,
} from "./groq-responses.js";

const proxies: GroqResponsesProxy[] = [];
const upstreamServers: Server[] = [];

afterEach(async () => {
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
  await Promise.all(
    upstreamServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function listen(server: Server): Promise<string> {
  upstreamServers.push(server);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("upstream did not receive a TCP address"));
        return;
      }
      resolve("http://127.0.0.1:" + address.port);
    });
  });
}

describe("Groq Responses compatibility", () => {
  it("removes OpenAI-internal fields, empty reasoning, and non-function tools", () => {
    const request = {
      model: "openai/gpt-oss-20b",
      input: "hello",
      access_programs: [],
      client_metadata: { thread_id: "internal-id" },
      include: ["reasoning.encrypted_content"],
      previous_response_id: "response-id",
      prompt: "internal prompt",
      prompt_cache_key: "cache-key",
      safety_identifier: "safety-id",
      store: false,
      truncation: "disabled",
      reasoning: {},
      tools: [
        { type: "function", name: "exec_command", parameters: {} },
        { type: "namespace", name: "collaboration", tools: [] },
        { type: "web_search" },
      ],
      tool_choice: "auto",
    };

    expect(sanitizeGroqResponsesRequest(request)).toEqual({
      model: "openai/gpt-oss-20b",
      input: "hello",
      tools: [{ type: "function", name: "exec_command", parameters: {} }],
      tool_choice: "auto",
    });
    expect(request.client_metadata).toBeDefined();
  });

  it("removes tools and tool_choice when no function tool remains", () => {
    expect(
      sanitizeGroqResponsesRequest({
        input: "hello",
        tools: [{ type: "namespace", name: "collaboration", tools: [] }],
        tool_choice: "auto",
      }),
    ).toEqual({ input: "hello" });
  });

  it("forwards only the supported request shape and streams the upstream response", async () => {
    let receivedBody = "";
    let receivedAuthorization = "";
    let receivedAccept = "";
    const upstreamUrl = await listen(
      createServer(async (request, response) => {
        for await (const chunk of request) receivedBody += chunk.toString();
        receivedAuthorization = request.headers.authorization ?? "";
        receivedAccept = request.headers.accept ?? "";
        response.writeHead(207, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "retry-after": "42",
          "x-ratelimit-remaining-tokens": "0",
          "x-ratelimit-reset-tokens": "42s",
          "x-request-id": "groq-request-id",
        });
        response.write("data: first\n\n");
        response.end("data: second\n\n");
      }),
    );
    const proxy = new GroqResponsesProxy(upstreamUrl);
    proxies.push(proxy);
    const proxyUrl = await proxy.start();

    const response = await fetch(proxyUrl + "/responses", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-token",
        Accept: "text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: "hello",
        client_metadata: { should: "disappear" },
        reasoning: {},
        tools: [{ type: "function", name: "do_work" }, { type: "web_search" }],
      }),
    });

    expect(proxyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/openai\/v1$/);
    expect(response.status).toBe(207);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("retry-after")).toBe("42");
    expect(response.headers.get("x-ratelimit-remaining-tokens")).toBe("0");
    expect(response.headers.get("x-ratelimit-reset-tokens")).toBe("42s");
    expect(response.headers.get("x-request-id")).toBe("groq-request-id");
    expect(await response.text()).toBe("data: first\n\ndata: second\n\n");
    expect(receivedAuthorization).toBe("Bearer test-token");
    expect(receivedAccept).toBe("text/event-stream");
    expect(JSON.parse(receivedBody)).toEqual({
      input: "hello",
      tools: [{ type: "function", name: "do_work" }],
    });
  });

  it("waits for Groq's retry window before retrying a rate-limited request", async () => {
    let attempts = 0;
    const upstreamUrl = await listen(
      createServer(async (request, response) => {
        for await (const _chunk of request) {
          void _chunk;
        }
        attempts += 1;
        if (attempts === 1) {
          response.writeHead(429, {
            "content-type": "application/json",
            "retry-after": "0.001",
          });
          response.end(JSON.stringify({ error: { code: "rate_limit_exceeded" } }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "completed" }));
      }),
    );
    const proxy = new GroqResponsesProxy(upstreamUrl);
    proxies.push(proxy);
    const proxyUrl = await proxy.start();

    const response = await fetch(proxyUrl + "/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hello" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "completed" });
    expect(attempts).toBe(2);
  });

  it("returns 413 for a request body over 4 MiB", async () => {
    const upstreamUrl = await listen(createServer(() => {
      throw new Error("upstream must not be called");
    }));
    const proxy = new GroqResponsesProxy(upstreamUrl);
    proxies.push(proxy);
    const proxyUrl = await proxy.start();

    const response = await fetch(proxyUrl + "/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "x".repeat(4 * 1024 * 1024) }),
    });

    expect(response.status).toBe(413);
  });

  it("returns 502 when the upstream cannot be reached", async () => {
    const proxy = new GroqResponsesProxy("http://127.0.0.1:1");
    proxies.push(proxy);
    const proxyUrl = await proxy.start();
    const response = await fetch(proxyUrl + "/responses", {
      method: "POST",
      body: JSON.stringify({ input: "hello" }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(502);
  });
});
