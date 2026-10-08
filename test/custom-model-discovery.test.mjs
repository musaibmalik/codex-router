import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "custom-discovery-test-"));
process.env.CODEX_HOME = path.join(root, "codex");
process.env.MODEL_ROUTER_STATE_DIR = path.join(root, "state");
process.env.CODEX_ROUTER_NO_DISCOVERY = "0";
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const { customEndpointGroups, newCustomModels, syncCustomModels, customCatalogMetadata, reconcileCustomMetadata } = await import("../src/custom-model-discovery.mjs");
const { waitForCustomModelRefresh } = await import("../src/custom-model-monitor.mjs");

const seed = (name = "old", file = "endpoint.key") => ({
  provider: "custom", slug: `custom/${name}`, gatewayModel: name, upstreamModel: name,
  listed: true, endpoint: { baseUrl: "http://127.0.0.1:8317/v1", credential: { file } },
});
const credentialFor = (endpoint) => ({ value: endpoint.credential?.file || "keyless" });
function harness(models = [seed()]) {
  let users = structuredClone(models);
  const effects = { fetches: 0, writes: 0, publishes: 0, shown: [] };
  const options = {
    apply: true, enabled: () => true, selected: () => ["custom"], allowedUrls: () => ["http://127.0.0.1:8317/v1"],
    readModels: () => users, checkedIn: [], registered: structuredClone(models), credentialFor,
    fetchCatalog: async () => { effects.fetches++; return { data: [{ id: "new-chat" }] }; },
    withLock: async (fn) => fn(), assertOwner: () => {},
    transaction: async ({ mutate }) => { await mutate(); effects.publishes++; },
    writeModels: (value) => { users = value; effects.writes++; },
    hidden: () => new Set(["custom/old"]), visible: () => new Set(),
    showModels: (slugs) => effects.shown.push(...slugs),
  };
  return { options, effects, users: () => users };
}

test("deduplicates shared endpoint credentials and separates different credentials", () => {
  const groups = customEndpointGroups([seed("a"), seed("b"), seed("c", "other.key")], ["custom"], credentialFor);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].models.map((m) => m.slug), ["custom/a", "custom/b"]);
  assert.equal(customEndpointGroups([seed()], [], () => { throw Error("must not read"); }).length, 0);
});

test("disabled discovery and unselected custom do not read credentials or fetch", async () => {
  const h = harness(); h.options.credentialFor = () => { throw Error("must not read"); };
  h.options.enabled = () => false;
  assert.equal((await syncCustomModels(h.options)).endpoints, 0);
  h.options.enabled = () => true; h.options.selected = () => [];
  assert.equal((await syncCustomModels(h.options)).endpoints, 0);
  process.env.CODEX_ROUTER_NO_DISCOVERY = "1";
  h.options.selected = () => ["custom"];
  try { assert.equal((await syncCustomModels(h.options)).endpoints, 0); }
  finally { process.env.CODEX_ROUTER_NO_DISCOVERY = "0"; }
  assert.equal(h.effects.fetches, 0);
});

test("publishes new endpoint models once and preserves old hidden decisions", async () => {
  const h = harness();
  const result = await syncCustomModels(h.options);
  assert.equal(result.changed, true); assert.equal(result.added.length, 1);
  assert.equal(h.effects.writes, 1); assert.equal(h.effects.publishes, 1);
  assert.deepEqual(h.effects.shown, [result.added[0].slug]);
  assert.equal(h.users()[0].slug, "custom/old");
  // A subsequent fresh worker imports the now-updated registry.
  h.options.registered = h.users();
  const second = await syncCustomModels(h.options);
  assert.equal(second.changed, false); assert.equal(second.added.length, 0);
  assert.equal(h.effects.writes, 1); assert.equal(h.effects.publishes, 1);
});

test("key rotation or provider disablement during fetch prevents stale publication", async () => {
  for (const mutation of ["key", "selection"]) {
    const h = harness(); let key = "old"; let selected = ["custom"];
    h.options.selected = () => selected; h.options.credentialFor = () => ({ value: key });
    h.options.fetchCatalog = async () => {
      if (mutation === "key") key = "new"; else selected = [];
      return { data: [{ id: "new-chat" }] };
    };
    assert.equal((await syncCustomModels(h.options)).changed, false);
    assert.equal(h.effects.writes, 0);
  }
});

test("one failed endpoint does not block another; malformed records cannot set routing", async () => {
  const h = harness([seed("a"), seed("b", "other.key")]);
  h.options.fetchCatalog = async (_url, { headers, maxRedirects }) => {
    assert.equal(maxRedirects, 0);
    if (headers.Authorization.endsWith("other.key")) throw Error("unavailable");
    return { data: [{ id: "new-chat", endpoint: { baseUrl: "https://attacker.invalid" }, requestProfile: "bad" }] };
  };
  const result = await syncCustomModels(h.options);
  assert.equal(result.failed, 1); assert.equal(result.added.length, 1);
  assert.equal(h.users().at(-1).endpoint.baseUrl, seed().endpoint.baseUrl);
  assert.equal(h.users().at(-1).requestProfile, undefined);
});

test("Antigravity aliases do not duplicate existing models; future Gemini gets clean selector", () => {
  const model = { ...seed("antigravity-gemini-3-8"), upstreamModel: "gemini-3.8-flash-high(high)", usesGoogleToolSchema: true };
  const [group] = customEndpointGroups([model], ["custom"], credentialFor);
  const additions = newCustomModels(group, { data: [
    { id: "gemini-3.8-flash-high" }, { id: "gemini-3.9-flash-high" },
    { id: "gemini-3.9-flash-high(high)" }, { id: "gemini-3.1-flash-image" },
  ] }, [model]);
  assert.equal(additions.length, 1);
  assert.equal(additions[0].displayName, "Gemini 3.9 Flash");
  assert.deepEqual(additions[0].reasoningLevels.map((v) => v.effort), ["low", "medium", "high"]);
  assert.equal(additions[0].upstreamModelsByEffort.low, "gemini-3.9-flash-high(low)");
  assert.equal(additions[0].endpoint.id, undefined);
});

test("concurrent user additions survive the locked merge", async () => {
  const h = harness();
  h.options.withLock = async (fn) => { h.options.writeModels([...h.users(), seed("manual")]); return fn(); };
  await syncCustomModels(h.options);
  assert.ok(h.users().some((m) => m.slug === "custom/manual"));
});

test("monitor publishes once and waits for idle before supervised reload", async () => {
  let scans = 0; let idleReads = 0; const waits = [];
  const result = await waitForCustomModelRefresh({
    enabled: () => true, canReload: () => true, scanModels: async () => { scans++; return { changed: true }; },
    isIdle: async () => ++idleReads > 1,
    wait: async (ms) => waits.push(ms), log: () => {},
  });
  assert.equal(result.reload, true); assert.equal(scans, 1); assert.deepEqual(waits, [10_000]);
});

test("unchanged or failed scans never request a service reload", async () => {
  let scans = 0;
  const result = await waitForCustomModelRefresh({
    enabled: () => true, canReload: () => true, scanModels: async () => { scans++; if (scans === 1) throw Error("offline"); return { changed: false }; },
    isStopping: () => scans >= 2, isIdle: async () => { throw Error("must not reload"); },
    wait: async () => {}, log: () => {},
  });
  assert.equal(result.reload, undefined); assert.equal(scans, 2);
});

test("explicit openai endpoints are discovered; unapproved destinations never read credentials", () => {
  const model = seed(); model.endpoint.protocol = "openai";
  assert.equal(customEndpointGroups([model], ["custom"], credentialFor).length, 1);
  assert.equal(customEndpointGroups([model], ["custom"], () => { throw Error("must not read"); }, []).length, 0);
});

test("monitor shutdown aborts a pending poll immediately", async () => {
  const abort = new AbortController();
  const pending = waitForCustomModelRefresh({ enabled: () => false, signal: abort.signal, log: () => {} });
  abort.abort();
  const result = await pending;
  assert.equal(result.reload, undefined);
});

test("discovery workers receive an absolute deadline and the supervisor cancellation signal", async () => {
  const { scanCustomModels } = await import("../src/custom-model-monitor.mjs");
  const abort = new AbortController();
  let captured;
  await scanCustomModels({ signal: abort.signal, now: () => 1000,
    run: async (_executable, args, options) => {
      assert.ok(args.includes("--apply")); captured = options;
      return { status: 0, stdout: '{"changed":false}' };
    },
  });
  assert.equal(captured.deadline, 721000);
  assert.equal(captured.signal, abort.signal);
});

test("foreground discovery leaves its unsupervised service running", async () => {
  let waits = 0;
  const result = await waitForCustomModelRefresh({
    enabled: () => true, canReload: () => false,
    scanModels: async () => ({ changed: true }),
    isStopping: () => waits > 0, isIdle: async () => { throw Error("must not stop foreground"); },
    wait: async () => { waits++; }, log: () => {},
  });
  assert.equal(result.reload, undefined);
});

test("checked-in custom aliases include endpoint and credential identity", async () => {
  const { modelRouteIdentity } = await import("../src/model-registry.mjs");
  const original = seed();
  const other = seed(); other.endpoint.baseUrl = "http://127.0.0.1:9999/v1";
  assert.notEqual(modelRouteIdentity(original), modelRouteIdentity(other));
  const otherKey = seed("old", "other.key");
  assert.notEqual(modelRouteIdentity(original), modelRouteIdentity(otherKey));
  const normalized = { ...original, endpoint: { ...original.endpoint, id: "custom/alias", kind: "openai-compatible", protocol: "openai" } };
  assert.equal(modelRouteIdentity(original), modelRouteIdentity(normalized));
});

test("Antigravity catalog types, Claude names and maximum effort aliases are handled", () => {
  const model = {...seed("antigravity-seed"), upstreamModel: "claude-opus-5-5-high(max)", usesGoogleToolSchema: true};
  const [group] = customEndpointGroups([model], ["custom"], credentialFor);
  const additions = newCustomModels(group, {data: [
    {id: "claude-opus-5-5-high", type: "antigravity"},
    {id: "claude-sonnet-5-5-high", type: "antigravity"},
    {id: "gemini-3.5-flash-lite", type: "antigravity"},
    {id: "media-only", type: "image"},
  ]}, [model]);
  assert.equal(additions.length, 2);
  assert.equal(additions[0].displayName, "Claude Sonnet 5.5 (High)");
  assert.equal(additions[1].upstreamModelsByEffort.minimal, "gemini-3.5-flash-lite(minimal)");
  const [plain] = customEndpointGroups([seed()], ["custom"], credentialFor);
  assert.equal(newCustomModels(plain, {data: [{id: "chat", type: "antigravity"}]}, [seed()]).length, 0);
});

test("discovery reserves advertised completion and transport overhead, rejecting unusable budgets", () => {
  const sizing = customCatalogMetadata({id: "chat", context_length: 200000, max_completion_tokens: 64000});
  assert.equal(sizing.autoCompact, 131904);
  assert.ok(sizing.contextWindow - sizing.autoCompact >= 64000 + 4096);
  assert.equal(customCatalogMetadata({id: "gpt-oss", context_length: 114000, max_completion_tokens: 32768}).autoCompact, 77136);
  for (const output of [-1, 0, 1.5, "invalid", 200000]) {
    assert.throws(() => customCatalogMetadata({id: "chat", context_length: 200000, max_completion_tokens: output}));
  }
});

test("metadata enrollment is explicit and later user overrides survive automatic reconciliation", () => {
  const model = {...seed(), displayName: "Old", contextWindow: 131072, autoCompact: 110000};
  let [group] = customEndpointGroups([model], ["custom"], credentialFor);
  const payload = {data: [{id: "old", display_name: "Current", context_length: 200000, max_completion_tokens: 64000}]};
  assert.deepEqual(reconcileCustomMetadata(group, payload), []);
  const [enrolled] = reconcileCustomMetadata(group, payload, {enroll: true});
  assert.equal(enrolled.displayName, "Current");
  assert.equal(enrolled.autoCompact, 131904);
  const overridden = {...enrolled, displayName: "My custom name"};
  [group] = customEndpointGroups([overridden], ["custom"], credentialFor);
  const [updated] = reconcileCustomMetadata(group, {data: [{id: "old", display_name: "New provider name", context_length: 250000, max_completion_tokens: 64000}]});
  assert.equal(updated.displayName, "My custom name");
  assert.equal(updated.contextWindow, 250000);
  assert.equal(updated.slug, model.slug);
  assert.equal(updated.endpoint, overridden.endpoint);
  [group] = customEndpointGroups([updated], ["custom"], credentialFor);
  assert.deepEqual(reconcileCustomMetadata(group, {data: [{id: "old", display_name: "New provider name", context_length: 250000, max_completion_tokens: 64000}]}), []);
  assert.deepEqual(reconcileCustomMetadata(group, {data: []}), []);
});

test("metadata-only reconciliation publishes transactionally and preserves visibility decisions", async () => {
  const model = {...seed(), displayName: "Old", contextWindow: 131072, autoCompact: 110000};
  const h = harness([model]);
  h.options.reconcile = true;
  h.options.fetchCatalog = async () => ({data: [{id: "old", display_name: "Current", context_length: 200000, max_completion_tokens: 64000}]});
  const result = await syncCustomModels(h.options);
  assert.equal(result.changed, true);
  assert.equal(result.added.length, 0);
  assert.equal(result.updated.length, 1);
  assert.equal(h.effects.publishes, 1);
  assert.deepEqual(h.effects.shown, []);
  assert.equal(h.users()[0].displayName, "Current");
  h.options.registered = h.users();
  assert.equal((await syncCustomModels(h.options)).changed, false);
  assert.equal(h.effects.publishes, 1);
});

test("a user override to either sizing value preserves the whole context budget", () => {
  const baseline = {contextWindow: 200000, autoCompact: 131904, displayName: "Old"};
  for (const overrides of [{contextWindow: 100000}, {autoCompact: 190000}]) {
    const model = {...seed(), ...baseline, ...overrides, customDiscoveryMetadata: baseline};
    const [group] = customEndpointGroups([model], ["custom"], credentialFor);
    const [next] = reconcileCustomMetadata(group, {data: [{id: "old", display_name: "New", context_length: 150000, max_completion_tokens: 64000}]});
    assert.equal(next.contextWindow, model.contextWindow);
    assert.equal(next.autoCompact, model.autoCompact);
    assert.equal(next.displayName, "New");
  }
});

test("nested and output-only completion metadata retain a safe reservation", () => {
  const nested = customCatalogMetadata({id: "chat", top_provider: {context_length: 200000, max_completion_tokens: "64000"}});
  assert.equal(nested.autoCompact, 131904);
  const fallback = customCatalogMetadata({id: "chat", max_completion_tokens: 64000});
  assert.equal(fallback.contextWindow, 131072);
  assert.equal(fallback.autoCompact, 62976);
});

test("an identical rich AGY catalog does not undo its friendly Gemini name", () => {
  const model = {...seed("antigravity-seed"), usesGoogleToolSchema: true};
  let [group] = customEndpointGroups([model], ["custom"], credentialFor);
  const payload = {data: [{id: "gemini-3.8-flash-high", display_name: "Gemini 3.8 Flash High", context_length: 1048576, max_completion_tokens: 65536}]};
  const [created] = newCustomModels(group, payload, [model]);
  assert.equal(created.displayName, "Gemini 3.8 Flash");
  [group] = customEndpointGroups([created], ["custom"], credentialFor);
  assert.deepEqual(reconcileCustomMetadata(group, payload), []);
});

test("user metadata edits made during a catalog fetch survive the locked merge", async () => {
  const model = {...seed(), displayName: "Old", customDiscoveryMetadata: {displayName: "Old"}};
  const h = harness([model]);
  h.options.fetchCatalog = async () => {
    h.options.writeModels([{...h.users()[0], displayName: "My edit"}]);
    return {data: [{id: "old", display_name: "Provider edit"}]};
  };
  assert.equal((await syncCustomModels(h.options)).changed, false);
  assert.equal(h.users()[0].displayName, "My edit");
});
