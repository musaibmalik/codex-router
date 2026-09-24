import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { discoveryDisabled } from "./discovery-mode.mjs";
import { MODELS, CHECKED_IN_MODELS, resolveProviderBaseUrl } from "./model-registry.mjs";
import { readProviderSelection } from "./provider-selection.mjs";
import { resolveProviderCredential } from "./provider-credentials.mjs";
import { fetchUntrustedModelCatalog, validateModelCatalogPayload } from "./untrusted-model-discovery.mjs";
import { readUserModels, writeUserModels, userModelEntry, USER_MODELS_PATH } from "./user-models.mjs";
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
  return antigravity ? id.replace(/\((?:none|minimal|low|medium|high|xhigh|auto|\d+)\)$/i, "") : id;
}

function displayName(id) {
  return id.replace(/\(.*\)$/, "").split("-").map((part) => {
    if (part === "gpt") return "GPT";
    if (part === "oss") return "OSS";
    return part.charAt(0).toUpperCase() + part.slice(1);
  }).join(" ");
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
    try { metadata = modelMetadataFromProviderRecord({ ...record, id }); }
    catch { continue; }
    // Codex's conversation picker cannot call embedding/media-only models.
    if (metadata.outputModalities && !metadata.outputModalities.includes("text")) continue;
    if (record.type && !["text", "chat", "model"].includes(record.type)) continue;
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
      ...(metadata.contextWindow ? { contextWindow: metadata.contextWindow, autoCompact: Math.floor(metadata.contextWindow * 0.85) } : {}),
      ...(metadata.inputModalities ? { inputModalities: metadata.inputModalities.filter((mode) => ["text", "image"].includes(mode)) } : {}),
      ...(antigravity ? { usesGoogleToolSchema: true, ...antigravityGeminiMetadata(canonical) } : {}),
    });
    if (!model.inputModalities.length) model.inputModalities = ["text"];
    additions.push(model);
    known.add(canonical); slugs.add(slug); gateways.add(name);
  }
  return additions;
}

export async function syncCustomModels({
  apply = false,
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
    for (const { group, payload } of answers) {
      const unchanged = fresh.find((candidate) => candidate.fingerprint === group.fingerprint);
      if (!unchanged) continue; // Provider disabled, endpoint changed, or key rotated while fetching.
      try { additions.push(...newCustomModels(unchanged, payload, [...all, ...additions])); }
      catch { failed += 1; }
    }
    const result = { changed: false, added: additions.map((model) => ({ slug: model.slug, name: model.displayName })), endpoints: groups.length, failed };
    if (!apply || !additions.length) return result;
    const decided = new Set([...hidden(), ...visible()]);
    await transaction({
      lock: false, files: [USER_MODELS_PATH, MODEL_PICKER_STATE_PATH],
      mutate() {
        writeModels([...users, ...additions]);
        const show = additions.map((model) => model.slug).filter((slug) => !decided.has(slug));
        if (show.length) showModels(show, true);
      },
    });
    return { ...result, changed: true };
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await syncCustomModels({ apply: process.argv.includes("--apply") }))); }
  catch { console.error("Custom model synchronization failed; previous published state was retained or rollback reported an error."); process.exitCode = 1; }
}
