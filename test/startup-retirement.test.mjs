import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { attemptAntigravityProbePromotionAfterReadiness } from "../src/antigravity-probe-activation.mjs";
import { clearStartupTimeouts, startupTimeoutMs } from "../src/startup-timeout.mjs";

// Importing start.mjs launches the whole service. Execute its actual post-health
// boundary with isolated process/child/publisher dependencies instead, retaining
// the real activation controller and timeout cleanup. No provider request or
// credential is needed to reproduce losing the remaining bootstrap allowance.
const source = readFileSync(new URL("../src/start.mjs", import.meta.url), "utf8");
const begin = source.indexOf("  const frontend = FRONTEND;");
const end = source.indexOf("  const cursorEdge =", begin);
assert.ok(begin >= 0 && end > begin, "startup readiness boundary must be present");
const boundary = source.slice(begin, end);
assert.ok(boundary.includes('import("./native-catalog-drift.mjs")'));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const completeStartup = new AsyncFunction("context", `
  const { FRONTEND, SOURCE_ROOT, run, process, waitForHealth, loopback, PORTS,
    STARTUP_CHILD_HEALTH_TIMEOUT_MS, clearStartupTimeouts,
    attemptAntigravityProbePromotionAfterReadiness, antigravityStartup,
    children, console, path, loadPublisher } = context;
  ${boundary.replace('import("./native-catalog-drift.mjs")', "loadPublisher()")}
`);

const PRIVATE_TIMEOUT = "CODEX_ROUTER_WINDOWS_PRIVATE_SYNC_TIMEOUT_MS";
const GENERATION = "55555555-5555-4555-8555-555555555555";
const SESSION_GENERATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function scenario({ pending = true, promotion = true, failure } = {}) {
  const env = { [PRIVATE_TIMEOUT]: "900000", KEEP_SETTING: "unchanged" };
  const events = [];
  const errors = [];
  const child = { exitCode: null, signalCode: null };
  const context = {
    FRONTEND: { script: "router.mjs", service: "codex-router", label: "Codex router" },
    SOURCE_ROOT: "/unused-startup-fixture",
    run: () => child,
    process: { env, execPath: process.execPath },
    waitForHealth: async () => { events.push("frontend healthy"); },
    loopback: () => "http://127.0.0.1/unused-health",
    PORTS: { router: 1 },
    STARTUP_CHILD_HEALTH_TIMEOUT_MS: 30_000,
    clearStartupTimeouts: (environment) => {
      events.push("startup retired");
      return clearStartupTimeouts(environment);
    },
    attemptAntigravityProbePromotionAfterReadiness: (options) =>
      attemptAntigravityProbePromotionAfterReadiness({
        ...options,
        promote: async (generation, sessionGeneration) => {
          assert.equal(generation, GENERATION);
          assert.equal(sessionGeneration, SESSION_GENERATION);
          events.push("activation started");
          const budget = startupTimeoutMs(PRIVATE_TIMEOUT, 15_000, env);
          // Model a 20 s cold ACL helper: it fits the opted-in startup allowance,
          // but exceeds the 15 s runtime default. Do not actually sleep or spawn.
          assert.ok(budget >= 20_000, `pending startup save lost its allowance: ${budget}ms`);
          await Promise.resolve();
          if (failure) throw failure;
          events.push(promotion ? "activation persisted" : "activation superseded");
          return promotion;
        },
      }),
    antigravityStartup: pending ? {
      pendingActivationGeneration: GENERATION,
      pendingSessionGeneration: SESSION_GENERATION,
    } : {},
    children: [child],
    console: { error: (message) => { errors.push(message); } },
    path,
    loadPublisher: async () => {
      events.push("publisher loaded");
      const assertRuntime = () => {
        assert.deepEqual(env, { KEEP_SETTING: "unchanged" });
        assert.equal(startupTimeoutMs(PRIVATE_TIMEOUT, 15_000, env), 15_000);
      };
      return {
        watchNativeCatalog: () => {
          assertRuntime();
          events.push("watcher started");
        },
        republishOnNativeDrift: async () => {
          assertRuntime();
          events.push("catalog published");
        },
      };
    },
  };
  return { env, events, errors, complete: () => completeStartup(context) };
}

async function settlePublishers() {
  await Promise.resolve();
  await Promise.resolve();
}

test("pending activation retains its startup ACL allowance until persistence finishes", async () => {
  const fixture = scenario();
  await fixture.complete();
  await settlePublishers();
  assert.deepEqual(fixture.events, [
    "frontend healthy", "activation started", "activation persisted",
    "startup retired", "publisher loaded", "watcher started", "catalog published",
  ]);
  assert.deepEqual(fixture.errors, []);
  assert.deepEqual(fixture.env, { KEEP_SETTING: "unchanged" });
});

test("superseded activation still retires startup settings before background publication", async () => {
  const fixture = scenario({ promotion: false });
  await fixture.complete();
  await settlePublishers();
  assert.deepEqual(fixture.events, [
    "frontend healthy", "activation started", "activation superseded",
    "startup retired", "publisher loaded", "watcher started", "catalog published",
  ]);
  assert.equal(fixture.errors.length, 1);
  assert.match(fixture.errors[0], /route remains disabled/);
});

test("a fatal activation failure cannot start background publishers", async () => {
  const failure = new Error("planned activation persistence failure");
  const fixture = scenario({ failure });
  await assert.rejects(fixture.complete(), (error) => error === failure);
  await settlePublishers();
  assert.deepEqual(fixture.events, ["frontend healthy", "activation started"]);
  assert.deepEqual(fixture.errors, []);
});

test("startup without pending activation retires settings before publication", async () => {
  const fixture = scenario({ pending: false });
  await fixture.complete();
  await settlePublishers();
  assert.deepEqual(fixture.events, [
    "frontend healthy", "startup retired", "publisher loaded", "watcher started", "catalog published",
  ]);
  assert.deepEqual(fixture.errors, []);
});
