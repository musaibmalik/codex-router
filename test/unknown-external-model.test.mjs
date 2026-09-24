import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { openPort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CALLER_KEY = "test-router-caller-capability-with-sufficient-length";
const INTERNAL_KEY = "test-internal-service-key-with-sufficient-length";
const CUSTOM_MODEL = "custom/antigravity-isolation-test";
const GATEWAY_MODEL = "antigravity-isolation-test";

function writeJson(file, data) {
  writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
}

async function backend(cleanups) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const decoded = request.headers["content-encoding"] === "zstd"
      ? zstdDecompressSync(raw)
      : raw;
    requests.push({
      path: request.url,
      headers: request.headers,
      body: JSON.parse(decoded.toString("utf8")),
    });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      id: "resp-isolation-test",
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "isolation-test-ok" }],
      }],
    }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanups.push(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return { port: server.address().port, requests };
}

async function fixture(t) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "unknown-external-model-"));
  const cleanups = [() => rmSync(scratch, { recursive: true, force: true })];
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
  });
  const stateDir = path.join(scratch, "state");
  const codexHome = path.join(scratch, "codex-home");
  mkdirSync(stateDir);
  mkdirSync(codexHome);
  // A usable fake session exercises the dangerous fallback without reading
  // any real account state. Every destination below is a loopback mock.
  writeJson(path.join(codexHome, "auth.json"), {
    tokens: { access_token: "fake-local-chatgpt-session", account_id: "fake-local-account" },
  });
  writeJson(path.join(stateDir, "enabled-providers.json"), { version: 1, providers: ["custom"] });
  const native = await backend(cleanups);
  const gateway = await backend(cleanups);
  writeJson(path.join(stateDir, "user-models.json"), {
    version: 1,
    models: [{
      slug: CUSTOM_MODEL,
      gatewayModel: GATEWAY_MODEL,
      upstreamModel: "antigravity-test",
      provider: "custom",
      listed: true,
      displayName: "Antigravity isolation test",
      description: "Loopback routing fixture.",
      priority: 500,
      defaultEffort: "high",
      reasoningLevels: [{ effort: "high", description: "High" }],
      contextWindow: 131072,
      autoCompact: 110000,
      inputModalities: ["text"],
      compHash: "antigravity-isolation-test-v1",
      endpoint: {
        baseUrl: `http://127.0.0.1:${gateway.port}/v1`,
        credential: { file: "isolation-test.api-key", environment: ["ISOLATION_TEST_API_KEY"] },
      },
    }],
  });
  const port = await openPort();
  const child = spawn(process.execPath, [path.join(root, "src", "router.mjs")], {
    cwd: root,
    // Do not inherit credential, state, or endpoint overrides from the host.
    env: {
      PATH: process.env.PATH,
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      CODEX_HOME: codexHome,
      CODEX_BIN: path.join(scratch, "nonexistent-codex"),
      MODEL_ROUTER_STATE_DIR: stateDir,
      CODEX_ROUTER_PORT: String(port),
      CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
      CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
      CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.port}/backend-api/codex`,
      CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
      CODEX_ROUTER_QUIET: "1",
      ISOLATION_TEST_API_KEY: "fake-custom-provider-key",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  cleanups.push(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  });
  child.stderr.setEncoding("utf8");
  let logs = "";
  child.stderr.on("data", (chunk) => { logs += chunk; });
  const deadline = Date.now() + 5_000;
  while (!logs.includes("[codex-router] listening")) {
    assert.equal(child.exitCode, null, `Router exited: ${logs}`);
    assert.ok(Date.now() < deadline, `Router did not start: ${logs}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const send = (model, { endpoint = "/responses", authorization = `Bearer ${CALLER_KEY}` } = {}) =>
    fetch(`${callerBaseUrl(port, CALLER_KEY)}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authorization,
        "chatgpt-account-id": "fake-caller-account",
      },
      body: JSON.stringify({
        model,
        stream: false,
        input: [{ role: "user", content: [{ type: "input_text", text: "isolation test" }] }],
        reasoning: { effort: "high" },
      }),
    });
  return { stateDir, native, gateway, send };
}

test("unknown external models stay local before native fallback, aliases, or redirect", async (t) => {
  const { stateDir, native, gateway, send } = await fixture(t);
  const unknown = ["custom/antigravity-stale-test", "grok-oauth/unknown-test-model"];
  for (const mode of ["default", "alias", "redirect"]) {
    if (mode === "alias") {
      writeJson(path.join(stateDir, "native-aliases.json"), {
        version: 1,
        aliases: Object.fromEntries(unknown.map((slug) => [slug, CUSTOM_MODEL])),
      });
    }
    if (mode === "redirect") {
      rmSync(path.join(stateDir, "native-aliases.json"));
      writeJson(path.join(stateDir, "native-redirect.json"), { version: 1, model: CUSTOM_MODEL });
    }
    for (const model of unknown) {
      for (const endpoint of ["/responses", "/responses/compact"]) {
        const response = await send(model, { endpoint });
        const payload = await response.json();
        assert.equal(response.status, 404, `${mode}: ${model} at ${endpoint}`);
        assert.equal(payload.error.type, "model_not_found");
        assert.equal(payload.error.model, model);
        assert.equal(native.requests.length, 0, "an external typo must never reach ChatGPT");
        assert.equal(gateway.requests.length, 0, "an external typo must never be redirected");
      }
    }
  }
});

test("registered custom AGY model reaches only its gateway", async (t) => {
  const { native, gateway, send } = await fixture(t);
  const response = await send(CUSTOM_MODEL, { authorization: "Bearer fake-caller-session" });
  assert.equal(response.status, 200, await response.text());
  assert.equal(native.requests.length, 0);
  assert.equal(gateway.requests.length, 1);
  assert.equal(gateway.requests[0].body.model, GATEWAY_MODEL);
  assert.equal(gateway.requests[0].headers.authorization, `Bearer ${INTERNAL_KEY}`);
});

test("native and future model IDs preserve their native path and caller credentials", async (t) => {
  const { native, gateway, send } = await fixture(t);
  for (const [model, upstream] of [
    ["gpt-5.6-sol", "gpt-5.6-sol"],
    ["gpt-future-not-in-catalog", "gpt-future-not-in-catalog"],
    ["gpt-5.6-sol-1m", "gpt-5.6-sol"],
    ["openai/gpt-future-not-in-catalog", "openai/gpt-future-not-in-catalog"],
  ]) {
    const response = await send(model, { authorization: "Bearer fake-caller-session" });
    assert.equal(response.status, 200, await response.text());
    const seen = native.requests.at(-1);
    assert.equal(seen.body.model, upstream);
    assert.deepEqual(seen.body.reasoning, { effort: "high" });
    assert.equal(seen.headers.authorization, "Bearer fake-caller-session");
    assert.equal(seen.headers["chatgpt-account-id"], "fake-caller-account");
    assert.equal(gateway.requests.length, 0);
  }
  assert.equal(native.requests.length, 4);
});
