import assert from "node:assert/strict";
import test from "node:test";

import {
  antigravityGeminiMetadata,
  customModelEffortProblem,
  upstreamModelForEffort,
} from "../src/custom-model-effort.mjs";

function gemini(overrides = {}) {
  return {
    provider: "custom",
    slug: "custom/antigravity-gemini-3-8-flash-high-high",
    upstreamModel: "gemini-3.8-flash-high(high)",
    ...antigravityGeminiMetadata("gemini-3.8-flash-high(high)"),
    ...overrides,
  };
}

test("each picker effort controls both Chat Completions and Responses upstream IDs", () => {
  for (const effort of ["low", "medium", "high"]) {
    const expected = `gemini-3.8-flash-high(${effort})`;
    assert.equal(upstreamModelForEffort(gemini(), { reasoning_effort: effort }), expected);
    assert.equal(upstreamModelForEffort(gemini(), { reasoning: { effort } }), expected);
  }
});

test("default and nullish effort fields fall back without changing input payloads", () => {
  const model = gemini({ defaultEffort: "medium" });
  const payload = { reasoning_effort: null, reasoning: { effort: "low", summary: "auto" } };
  const before = structuredClone(payload);
  assert.equal(upstreamModelForEffort(model), "gemini-3.8-flash-high(medium)");
  assert.equal(upstreamModelForEffort(model, {}), "gemini-3.8-flash-high(medium)");
  assert.equal(upstreamModelForEffort(model, null), "gemini-3.8-flash-high(medium)");
  assert.equal(upstreamModelForEffort(model, payload), "gemini-3.8-flash-high(low)");
  assert.equal(upstreamModelForEffort(model, { reasoning: { effort: null } }), "gemini-3.8-flash-high(medium)");
  assert.deepEqual(payload, before);
  assert.equal(model.upstreamModel, "gemini-3.8-flash-high(high)");
});

test("flat reasoning_effort is authoritative when both request spellings occur", () => {
  assert.equal(upstreamModelForEffort(gemini(), {
    reasoning_effort: "low", reasoning: { effort: "high" },
  }), "gemini-3.8-flash-high(low)");
});

test("unsupported and malformed efforts return status 400, never a silent default", () => {
  for (const effort of ["minimal", "xhigh", "", "LOW", " high ", "__proto__", {}, 1, false]) {
    for (const payload of [{ reasoning_effort: effort }, { reasoning: { effort } }]) {
      assert.throws(() => upstreamModelForEffort(gemini(), payload), {
        status: 400, code: "invalid_reasoning_effort", message: /Unsupported reasoning effort/,
      });
    }
  }
});

test("non-opted models keep arbitrary existing suffixes and unsupported efforts", () => {
  for (const provider of ["custom", "gemini-api", "antigravity-oauth"]) {
    for (const upstreamModel of ["vendor/model(high)", "opaque(route-v2)", "name(special)"]) {
      const model = { provider, upstreamModel };
      assert.equal(customModelEffortProblem(model), undefined);
      assert.equal(upstreamModelForEffort(model, { reasoning_effort: "ultra" }), upstreamModel);
    }
  }
});

test("mapping accepts exact explicit route IDs rather than inferring their suffixes", () => {
  const model = gemini({ upstreamModelsByEffort: {
    low: "vendor/fast@v1", medium: "vendor/balanced:stable", high: "vendor/deep-route",
  } });
  assert.equal(customModelEffortProblem(model), undefined);
  assert.equal(upstreamModelForEffort(model, { reasoning_effort: "medium" }), "vendor/balanced:stable");
});

test("mapping validation refuses non-custom providers, malformed maps, and undeclared levels", () => {
  const cases = [
    { provider: "gemini-api" },
    { upstreamModelsByEffort: null },
    { upstreamModelsByEffort: [] },
    { upstreamModelsByEffort: {} },
    { upstreamModelsByEffort: new Map([["low", "fast"]]) },
    { upstreamModelsByEffort: Object.create({ low: "fast" }) },
    { upstreamModelsByEffort: { ...gemini().upstreamModelsByEffort, xhigh: "deep" } },
    { upstreamModelsByEffort: { low: "fast", high: "deep" } },
    { reasoningLevels: [] },
    { reasoningLevels: [{ effort: "surprise" }] },
    { reasoningLevels: [{ effort: "low" }, { effort: "low" }] },
    { defaultEffort: "ultra" },
  ];
  for (const overrides of cases) {
    const model = gemini(overrides);
    assert.equal(typeof customModelEffortProblem(model), "string");
    assert.throws(() => upstreamModelForEffort(model), { status: 400 });
  }
});

test("mapping validation refuses empty, unsafe, control, and accessor model IDs", () => {
  for (const value of ["", " ", "model\n", "model\u0000", "model\u007f", "model\u0085", "model\u202e", "model name", "<model>", "model;other", "model$(other)", "model`other`", "model?key=secret", 5, null, "a".repeat(513)]) {
    const model = gemini({ upstreamModelsByEffort: { ...gemini().upstreamModelsByEffort, low: value } });
    assert.match(customModelEffortProblem(model), /invalid upstream model ID/);
  }
  const mapping = { ...gemini().upstreamModelsByEffort };
  Object.defineProperty(mapping, "low", { get() { throw new Error("must not execute"); } });
  assert.match(customModelEffortProblem(gemini({ upstreamModelsByEffort: mapping })), /invalid upstream model ID/);
  assert.match(customModelEffortProblem(gemini({ upstreamModelsByEffort: {
    ...gemini().upstreamModelsByEffort, [Symbol("extra")]: "bad",
  } })), /undeclared effort/);
});

test("Flash metadata provides one clean model name and three supported picker levels", () => {
  for (const version of ["3.6", "3.7", "3.8", "3.9", "3.10"]) {
    for (const suffix of ["", "(low)", "(medium)", "(high)"]) {
      const metadata = antigravityGeminiMetadata(`gemini-${version}-flash-high${suffix}`);
      assert.equal(metadata.displayName, `Gemini ${version} Flash`);
      assert.equal(metadata.defaultEffort, "high");
      assert.deepEqual(metadata.reasoningLevels.map(({ effort }) => effort), ["low", "medium", "high"]);
      assert.deepEqual(metadata.upstreamModelsByEffort, {
        low: `gemini-${version}-flash-high(low)`,
        medium: `gemini-${version}-flash-high(medium)`,
        high: `gemini-${version}-flash-high(high)`,
      });
      assert.equal(customModelEffortProblem(gemini(metadata)), undefined);
      assert.equal(Object.hasOwn(metadata, "slug"), false);
    }
  }
});

test("Pro gateway metadata uses documented levels and preserves each base route", () => {
  for (const base of ["gemini-pro-agent", "gemini-3.1-pro-low"]) {
    const metadata = antigravityGeminiMetadata(`${base}(high)`);
    assert.equal(metadata.displayName, "Gemini 3.1 Pro");
    assert.equal(metadata.defaultEffort, base === "gemini-pro-agent" ? "high" : "low");
    for (const effort of ["low", "medium", "high"]) {
      assert.equal(upstreamModelForEffort(gemini(metadata), { reasoning_effort: effort }), `${base}(${effort})`);
    }
  }
});

test("discovered Gemini Flash and Flash Lite have the documented three-choice selector", () => {
  for (const [id, name] of [["gemini-3-flash", "Gemini 3 Flash"], ["gemini-3.1-flash-lite", "Gemini 3.1 Flash Lite"]]) {
    const metadata = antigravityGeminiMetadata(id);
    assert.equal(metadata.displayName, name);
    assert.deepEqual(metadata.reasoningLevels.map((level) => level.effort), ["low", "medium", "high"]);
    assert.equal(metadata.upstreamModelsByEffort.medium, `${id}(medium)`);
  }
});

test("metadata inference is bounded and does not reinterpret unrelated model suffixes", () => {
  for (const id of [undefined, null, {}, "gemini-4.0-flash-high", "gemini-3.8-flash", "gemini-3.8-flash-low", "gemini-3.8-flash-high(unknown)", "vendor/gemini-3.8-flash-high", "gemini-pro-agent(custom)", "claude-sonnet-4-6(high)", "gemini-3.8-flash-high(high)\n"]) {
    assert.equal(antigravityGeminiMetadata(id), undefined);
  }
});
