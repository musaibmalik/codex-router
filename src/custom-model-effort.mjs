const RECOGNIZED_EFFORTS = new Set([
  "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
]);
const GEMINI_EFFORTS = ["low", "medium", "high"];

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// Values go into a JSON model field, never a URL or shell command. Keep common
// namespaced/versioned model IDs and CLIProxyAPI's documented (effort) suffix,
// but refuse whitespace, controls, and characters used to inject other syntax.
function safeUpstreamModel(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    /^[A-Za-z0-9][A-Za-z0-9._:/@()+~=-]*$/.test(value);
}

// Matches model-registry's validation contract: a problem string or undefined.
// Requiring a complete map prevents a picker from advertising an unroutable
// effort. Omission means no opt-in, so existing custom endpoints are unchanged.
export function customModelEffortProblem(model) {
  if (model?.upstreamModelsByEffort === undefined) return undefined;
  const prefix = `model ${model.slug || "(unnamed)"}`;
  if (model.provider !== "custom") {
    return `${prefix} may use upstreamModelsByEffort only with provider custom`;
  }
  const mapping = model.upstreamModelsByEffort;
  if (!isPlainObject(mapping) || Reflect.ownKeys(mapping).length === 0) {
    return `${prefix} requires a nonempty upstreamModelsByEffort object`;
  }
  const levels = model.reasoningLevels;
  if (!Array.isArray(levels) || levels.length === 0 ||
      levels.some((level) => !RECOGNIZED_EFFORTS.has(level?.effort))) {
    return `${prefix} requires declared reasoningLevels for upstreamModelsByEffort`;
  }
  const efforts = new Set(levels.map((level) => level.effort));
  if (efforts.size !== levels.length || !efforts.has(model.defaultEffort)) {
    return `${prefix} has invalid reasoningLevels or defaultEffort for upstreamModelsByEffort`;
  }
  for (const effort of Reflect.ownKeys(mapping)) {
    if (typeof effort !== "string" || !efforts.has(effort)) {
      return `${prefix} has an undeclared effort in upstreamModelsByEffort`;
    }
    const descriptor = Object.getOwnPropertyDescriptor(mapping, effort);
    if (!descriptor || !Object.hasOwn(descriptor, "value") ||
        !safeUpstreamModel(descriptor.value)) {
      return `${prefix} has an invalid upstream model ID in upstreamModelsByEffort`;
    }
  }
  if ([...efforts].some((effort) => !Object.hasOwn(mapping, effort))) {
    return `${prefix} requires upstreamModelsByEffort to cover every declared effort`;
  }
  return undefined;
}

function effortError(message) {
  const error = new Error(message);
  error.status = 400;
  error.code = "invalid_reasoning_effort";
  return error;
}

export function upstreamModelForEffort(model, payload = {}) {
  if (model?.upstreamModelsByEffort === undefined) return model?.upstreamModel;
  const problem = customModelEffortProblem(model);
  if (problem) throw effortError(problem);
  const effort = payload?.reasoning_effort ?? payload?.reasoning?.effort ?? model.defaultEffort;
  if (typeof effort !== "string" || !Object.hasOwn(model.upstreamModelsByEffort, effort)) {
    throw effortError(`Unsupported reasoning effort for ${model.slug || "custom model"}; supported efforts: ${Object.keys(model.upstreamModelsByEffort).join(", ")}`);
  }
  return model.upstreamModelsByEffort[effort];
}

// This metadata is specific to Antigravity models served through CLIProxyAPI.
// The gateway strips the reasoning suffix before routing and applies the effort:
// https://help.router-for.me/configuration/thinking
// Its registry documents low/medium/high for Flash 3.6/3.7/3.8 and both
// Pro IDs. Flash 3/3.6 and Flash Lite 3.1/3.5 also document minimal.
// Do not apply this suffix convention to arbitrary custom endpoints.
// https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/registry/models/models.json
export function antigravityGeminiMetadata(upstreamId) {
  if (typeof upstreamId !== "string") return undefined;
  const match = /^(gemini-(3\.\d+)-flash-high|gemini-3-flash|gemini-3\.(?:1|5)-flash-lite|gemini-pro-agent|gemini-3\.1-pro-low)(?:\((minimal|low|medium|high)\))?$/.exec(upstreamId);
  if (!match) return undefined;
  const base = match[1];
  const flashVersion = match[2];
  const efforts = ["gemini-3-flash", "gemini-3.6-flash-high", "gemini-3.1-flash-lite", "gemini-3.5-flash-lite"].includes(base)
    ? ["minimal", ...GEMINI_EFFORTS] : GEMINI_EFFORTS;
  return {
    displayName: flashVersion ? `Gemini ${flashVersion} Flash`
      : base === "gemini-3-flash" ? "Gemini 3 Flash"
      : /^gemini-3\.(1|5)-flash-lite$/.test(base) ? `Gemini ${base.split("-")[1]} Flash Lite` : "Gemini 3.1 Pro",
    reasoningLevels: efforts.map((effort) => ({
      effort,
      description: `${effort[0].toUpperCase()}${effort.slice(1)} reasoning effort`,
    })),
    defaultEffort: !flashVersion && base === "gemini-3.1-pro-low" ? "low" : "high",
    upstreamModelsByEffort: Object.fromEntries(
      efforts.map((effort) => [effort, `${base}(${effort})`]),
    ),
  };
}
