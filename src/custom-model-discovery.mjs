import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { discoveryDisabled } from "./discovery-mode.mjs";
import { MODELS, CHECKED_IN_MODELS, resolveProviderBaseUrl } from "./model-registry.mjs";
import { readProviderSelection } from "./provider-selection.mjs";
import { resolveProviderCredential } from "./provider-credentials.mjs";
import { fetchUntrustedModelCatalog, validateModelCatalogPayload } from "./untrusted-model-discovery.mjs";
import { readUserModels, writeUserModels, userModelEntry, USER_MODELS_PATH, DEFAULT_CONTEXT_WINDOW } from "./user-models.mjs";
import { modelMetadataFromProviderRecord } from "./model-capabilities.mjs";
import { MODEL_PICKER_STATE_PATH, readHiddenModels, readVisibleModels, setModelsVisible } from "./model-picker-state.mjs";
import { withModelOverlayLock } from "./model-overlay-lock.mjs";
import { transactModelOverlayMutation } from "./model-overlay-publication.mjs";
import { assertStateOwnership } from "./state-owner.mjs";
import { STATE_DIR } from "./paths.mjs";
import { antigravityGeminiMetadata } from "./custom-model-effort.mjs";

export const CUSTOM_DISCOVERY_PATH = path.join(STATE_DIR, "custom-model-discovery.json");
export const CUSTOM_DISCOVERY_INTERVAL_MS = 5 * 60_000;

export function customDiscoveryAllowedUrls() {
  try {
    const config = JSON.parse(readFileSync(CUSTOM_DISCOVERY_PATH, "utf8"));
    return Array.isArray(config.allowedBaseUrls) ? config.allowedBaseUrls : [];
  } catch { return []; }
}

export function customDiscoveryEnabled() {
  if (discoveryDisabled() || !existsSync(CUSTOM_DISCOVERY_PATH)) return false;
  try {
    const config = JSON.parse(readFileSync(CUSTOM_DISCOVERY_PATH, "utf8"));
    return config.version === 1 && config.enabled === true;
  } catch { return false; }
}

const digest = (value) => createHash("sha256").update(value).digest("hex");
const safe = (value) => String(value).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
const plainEndpoint = ({ id, kind, ...endpoint }) => endpoint;

// Keep endpoints with different credentials separate even when their URLs match.
// The fingerprint containing the credential stays in memory and is never persisted.
export function customEndpointGroups(models, selected, credentialFor = resolveProviderCredential, allowedUrls) {
  if (!selected.includes("custom")) return [];
  const groups = new Map();
  for (const model of models) {
    if (model.provider !== "custom" || !model.endpoint) continue;
    const endpoint = plainEndpoint(model.endpoint);
    const { baseUrl } = resolveProviderBaseUrl(endpoint);
    if (allowedUrls && !allowedUrls.includes(baseUrl)) continue;
    // Anonymous custom routes are authorized per slug; that grant cannot be
    // inherited by a newly discovered slug. Explicit credentials/keyless
    // loopback endpoints retain their existing destination boundary.
    if (endpoint.authMode === "anonymous") continue;
    if (endpoint.protocol && !["openai", "openai-responses"].includes(endpoint.protocol)) continue;
    const resolved = { ...endpoint, id: model.slug, kind: "openai-compatible" };
    const credential = credentialFor(resolved);
    if (!credential) continue;
    const identity = JSON.stringify({ ...endpoint, baseUrl });
    const fingerprint = digest(identity + "\0" + credential.value);
    if (!groups.has(fingerprint)) groups.set(fingerprint, {
      fingerprint, endpointId: digest(identity).slice(0, 12), endpoint, baseUrl,
      credential, models: [],
    });
    groups.get(fingerprint).models.push(model);
  }
  return [...groups.values()];
}

function antigravityGroup(group) {
  return group.models.some((model) => model.slug.startsWith("custom/antigravity-") && model.usesGoogleToolSchema === true);
}

function canonicalId(id, antigravity) {
  return antigravity ? id.replace(/\((?:none|minimal|low|medium|high|xhigh|max|ultra|auto|\d+)\)$/i, "") : id;
}

function displayName(id) {
  const claude = /^claude-(opus|sonnet)-(\d+)-(\d+)-high$/.exec(id);
  if (claude) return `Claude ${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2]}.${claude[3]} (High)`;
  return id.replace(/\(.*\)$/, "").split("-").map((part) => {
    if (part === "gpt") return "GPT";
    if (part === "oss") return "OSS";
    return part.charAt(0).toUpperCase() + part.slice(1);
  }).join(" ");
}

// Provider metadata is untrusted. An advertised completion must fit alongside
// the input; reserve space for transport/tool overhead as well as output.
export function customCatalogMetadata(record, { antigravity = false } = {}) {
  const metadata = modelMetadataFromProviderRecord(record);
  const fields = {};
  if (metadata.displayName) fields.displayName = metadata.displayName;
  const gemini = antigravity ? antigravityGeminiMetadata(metadata.upstreamId) : undefined;
  if (gemini) fields.displayName = gemini.displayName;
  const raw = record.max_completion_tokens ?? record.max_output_tokens ??
    record.top_provider?.max_completion_tokens ?? record.top_provider?.max_output_tokens;
  if (metadata.contextWindow || raw !== undefined) {
    const context = metadata.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    const output = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw;
    if (output !== undefined && (!Number.isSafeInteger(output) || output < 1 || output + 4096 >= context)) {
      throw new Error("Catalog completion limit leaves no safe input budget.");
    }
    fields.contextWindow = context;
    fields.autoCompact = Math.min(Math.floor(context * 0.85),
      output === undefined ? context : context - output - 4096);
  }
  return fields;
}

export function reconcileCustomMetadata(group, payload, { enroll = false } = {}) {
  validateModelCatalogPayload(payload);
  const records = Array.isArray(payload) ? payload : payload.data ?? payload.models;
  const antigravity = antigravityGroup(group);
  const catalog = new Map(records.map(record => [canonicalId(String(record.id ?? record.model ?? record.upstreamId ?? record.slug ?? ""), antigravity), record]));
  const updates = [];
  for (const model of group.models) {
    const record = catalog.get(canonicalId(model.upstreamModel, antigravity));
    if (!record || (!enroll && !model.customDiscoveryMetadata)) continue;
    let fields;
    try { fields = customCatalogMetadata(record, { antigravity }); } catch { continue; }
    const previous = model.customDiscoveryMetadata || {};
    const next = { ...model };
    const owned = { ...previous };
    const sizingOverridden = ["contextWindow", "autoCompact"].some(key =>
      Object.hasOwn(previous, key) && model[key] !== previous[key]);
    for (const [key, value] of Object.entries(fields)) {
      // Context and compaction form one budget. Never apply half of an update
      // against a user-owned sizing value from the other half.
      if (sizingOverridden && ["contextWindow", "autoCompact"].includes(key)) continue;
      // Enrolling a legacy entry is explicit. Once enrolled, a user edit wins.
      if (!Object.hasOwn(previous, key) ? !enroll : model[key] !== previous[key]) continue;
      next[key] = value;
      owned[key] = value;
    }
    if (!Object.keys(owned).length) continue;
    next.customDiscoveryMetadata = owned;
    if (JSON.stringify(next) !== JSON.stringify(model)) updates.push(next);
  }
  return updates;
}

export function newCustomModels(group, payload, allModels) {
  validateModelCatalogPayload(payload);
  const records = Array.isArray(payload) ? payload : payload.data ?? payload.models;
  const antigravity = antigravityGroup(group);
  const known = new Set(group.models.flatMap((model) => [model.upstreamModel, ...Object.values(model.upstreamModelsByEffort || {})])
    .map((id) => canonicalId(id, antigravity)));
  const slugs = new Set(allModels.map((model) => model.slug));
  const gateways = new Set(allModels.map((model) => model.gatewayModel));
  const additions = [];
  for (const record of records) {
    const id = String(record.id ?? record.model ?? record.upstreamId ?? record.slug ?? "").trim();
    if (!id || id.length > 240 || /[\x00-\x1f\x7f]/.test(id)) continue;
    const canonical = canonicalId(id, antigravity);
    if (known.has(canonical)) continue;
    let metadata;
    try { metadata = modelMetadataFromProviderRecord({ ...record, id }); customCatalogMetadata({ ...record, id }, { antigravity }); }
    catch { continue; }
    // Codex's conversation picker cannot call embedding/media-only models.
    if (metadata.outputModalities && !metadata.outputModalities.includes("text")) continue;
    if (record.type && !["text", "chat", "model"].includes(record.type) &&
        !(antigravity && record.type === "antigravity")) continue;
    if (/(?:^|[-_/])(?:embedding|embed|image|tts|whisper)(?:[-_/]|$)/i.test(id)) continue;
    const name = `${antigravity ? "antigravity" : "endpoint"}-${group.endpointId}-${safe(canonical)}-${digest(id).slice(0, 6)}`;
    const slug = `custom/${name}`;
    if (slugs.has(slug) || gateways.has(name)) continue;
    const model = userModelEntry({ providerId: "custom", upstreamId: canonical, priority: 1900 + additions.length });
    Object.assign(model, {
      slug, gatewayModel: name, compHash: `${name}-discovered-v1`,
      displayName: metadata.displayName || displayName(canonical),
      description: "Automatically discovered from a configured custom endpoint.",
      endpoint: group.endpoint,
      ...customCatalogMetadata({ ...record, id }, { antigravity }),
      ...(metadata.inputModalities ? { inputModalities: metadata.inputModalities.filter((mode) => ["text", "image"].includes(mode)) } : {}),
      ...(antigravity ? { usesGoogleToolSchema: true, ...antigravityGeminiMetadata(canonical) } : {}),
    });
    const owned = customCatalogMetadata({ ...record, id }, { antigravity });
    if (Object.keys(owned).length) model.customDiscoveryMetadata = Object.fromEntries(
      Object.keys(owned).map(key => [key, model[key]]));
    if (!model.inputModalities.length) model.inputModalities = ["text"];
    additions.push(model);
    known.add(canonical); slugs.add(slug); gateways.add(name);
  }
  return additions;
}

export async function syncCustomModels({
  apply = false,
  reconcile = false,
  enabled = customDiscoveryEnabled,
  selected = readProviderSelection,
  allowedUrls = customDiscoveryAllowedUrls,
  readModels = readUserModels,
  checkedIn = CHECKED_IN_MODELS,
  registered = MODELS,
  credentialFor = resolveProviderCredential,
  fetchCatalog = fetchUntrustedModelCatalog,
  withLock = withModelOverlayLock,
  transaction = transactModelOverlayMutation,
  writeModels = writeUserModels,
  hidden = readHiddenModels,
  visible = readVisibleModels,
  showModels = setModelsVisible,
  assertOwner = assertStateOwnership,
} = {}) {
  // This must precede every credential reader, including keyless endpoints.
  if (discoveryDisabled() || !enabled()) return { changed: false, added: [], endpoints: 0, failed: 0 };
  if (apply) assertOwner("synchronize custom model catalogs");
  const validSlugs = new Set(registered.map((model) => model.slug));
  const current = () => [...checkedIn, ...readModels()].filter((model) => validSlugs.has(model.slug));
  const groups = customEndpointGroups(current(), selected(), credentialFor, allowedUrls());
  const answers = [];
  let failed = 0;
  // Endpoint reads are independent; bounded batches avoid a large overlay
  // opening thousands of simultaneous connections.
  for (let offset = 0; offset < groups.length; offset += 4) {
    const batch = await Promise.allSettled(groups.slice(offset, offset + 4).map(async (group) => {
      const headers = group.endpoint.keyless ? {} : { Authorization: `Bearer ${group.credential.value}` };
      const payload = await fetchCatalog(`${group.baseUrl}/models`, { headers, allowPrivate: true, timeoutMs: 15_000, maxRedirects: 0 });
      return { group, payload };
    }));
    for (const answer of batch) {
      if (answer.status === "fulfilled") answers.push(answer.value);
      else failed += 1; // Never put provider response bodies or credentials in logs.
    }
  }
  return withLock(async () => {
    if (discoveryDisabled() || !enabled()) return { changed: false, added: [], endpoints: groups.length, failed };
    const users = readModels();
    const all = [...checkedIn, ...users];
    const fresh = customEndpointGroups(current(), selected(), credentialFor, allowedUrls());
    const additions = [];
    const updates = new Map();
    for (const { group, payload } of answers) {
      const unchanged = fresh.find((candidate) => candidate.fingerprint === group.fingerprint);
      if (!unchanged) continue; // Provider disabled, endpoint changed, or key rotated while fetching.
      try {
        additions.push(...newCustomModels(unchanged, payload, [...all, ...additions]));
        for (const model of reconcileCustomMetadata(unchanged, payload, { enroll: reconcile })) {
          if (users.some(user => user.slug === model.slug)) updates.set(model.slug, model);
        }
      }
      catch { failed += 1; }
    }
    const result = { changed: false, added: additions.map((model) => ({ slug: model.slug, name: model.displayName })), endpoints: groups.length, failed };
    result.updated = [...updates.values()].map(model => ({slug: model.slug, name: model.displayName}));
    if (!apply || (!additions.length && !updates.size)) return result;
    const decided = new Set([...hidden(), ...visible()]);
    await transaction({
      lock: false, files: [USER_MODELS_PATH, MODEL_PICKER_STATE_PATH],
      mutate() {
        writeModels([...users.map(model => updates.get(model.slug) || model), ...additions]);
        const show = additions.map((model) => model.slug).filter((slug) => !decided.has(slug));
        if (show.length) showModels(show, true);
      },
    });
    return { ...result, changed: true };
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await syncCustomModels({ apply: process.argv.includes("--apply"), reconcile: process.argv.includes("--reconcile") }))); }
  catch { console.error("Custom model synchronization failed; previous published state was retained or rollback reported an error."); process.exitCode = 1; }
}
