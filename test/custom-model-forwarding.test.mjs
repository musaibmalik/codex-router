import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { antigravityGeminiMetadata } from "../src/custom-model-effort.mjs";
import { openPort } from "./port-pool.mjs";

test("installed forwarder sends all three selector choices to their exact upstream model IDs", async (t) => {
  const requests = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }));
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const temporary = mkdtempSync(path.join(os.tmpdir(), "custom-effort-wire-"));
  const state = path.join(temporary, "state"); mkdirSync(state);
  const model = {
    provider: "custom", slug: "custom/gemini-selector-test", gatewayModel: "gemini-selector-test",
    upstreamModel: "gemini-3.8-flash-high(high)", listed: true, priority: 100,
    description: "Selector wire test", contextWindow: 131072, autoCompact: 110000,
    compHash: "selector-test-v1", inputModalities: ["text"],
    endpoint: { baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, keyless: true },
    ...antigravityGeminiMetadata("gemini-3.8-flash-high"),
  };
  const modelFile = path.join(state, "user-models.json");
  writeFileSync(modelFile, JSON.stringify({ version: 1, models: [model] }), { mode: 0o600 });
  writeFileSync(path.join(state, "enabled-providers.json"), JSON.stringify({ version: 1, providers: ["custom"] }), { mode: 0o600 });
  const port = await openPort();
  const internalKey = "isolated-selector-wire-test-key-long-enough";
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const child = spawn(process.execPath, [path.join(sourceRoot, "src/api-forwarder.mjs")], {
    cwd: sourceRoot,
    env: { ...process.env, CODEX_HOME: path.join(temporary, "codex"), MODEL_ROUTER_STATE_DIR: state,
      MODEL_ROUTER_USER_MODELS: modelFile, CODEX_ROUTER_API_PORT: String(port), CODEX_ROUTER_INTERNAL_KEY: internalKey,
      MODEL_ROUTER_API_PORT: String(port), CODEX_ROUTER_NO_DISCOVERY: "0", CODEX_ROUTER_SHOW_ALL_MODELS: "1" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = ""; child.stderr.on("data", (data) => { stderr += data; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
    upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve));
    rmSync(temporary, { recursive: true, force: true });
  });
  const headers = { Authorization: `Bearer ${internalKey}`, "Content-Type": "application/json" };
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw Error(stderr);
    try { if ((await fetch(`http://127.0.0.1:${port}/health`, { headers })).ok) { ready = true; break; } } catch {}
    await delay(50);
  }
  assert.equal(ready, true, stderr);
  for (const effort of ["low", "medium", "high"]) {
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST", headers,
      body: JSON.stringify({ model: model.gatewayModel, reasoning_effort: effort,
        messages: [{ role: "user", content: "test" }] }),
    });
    assert.equal(response.status, 200, await response.text());
    assert.equal(requests.at(-1).model, `gemini-3.8-flash-high(${effort})`);
  }
  const before = requests.length;
  const rejected = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST", headers, body: JSON.stringify({ model: model.gatewayModel, reasoning_effort: "ultra", messages: [] }),
  });
  assert.equal(rejected.status, 400); assert.equal(requests.length, before);
});
