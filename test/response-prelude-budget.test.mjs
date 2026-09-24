import assert from "node:assert/strict";
import test from "node:test";
import { responsePreludeBudget } from "../src/response-prelude-budget.mjs";

test("ordinary requests and large transcripts retain the default budget", () => {
  assert.equal(responsePreludeBudget({ stream: true, tools: [] }), 1024 * 1024);
  assert.equal(responsePreludeBudget({ stream: true, input: "x".repeat(9000000) }), 1024 * 1024);
});

test("echoed fields get a bounded allowance including ASCII escaped unicode", () => {
  const payload = { stream: true, instructions: "界".repeat(250000) };
  const budget = responsePreludeBudget(payload);
  const escaped = JSON.stringify(payload.instructions).replace(/界/g, "\\u754c");
  assert.ok(budget > 3 * Buffer.byteLength(escaped));
  assert.ok(budget <= 8 * 1024 * 1024);
  assert.equal(responsePreludeBudget({ stream: true, tools: [{ description: "x".repeat(9000000) }] }), 8 * 1024 * 1024);
});

test("explicit limits and non-streaming requests remain unchanged", () => {
  const payload = { stream: true, instructions: "x".repeat(1100000) };
  assert.equal(responsePreludeBudget(payload, { baseBytes: 128, fixed: true }), 128);
  assert.equal(responsePreludeBudget(payload, { baseBytes: 0, fixed: true }), 0);
  assert.equal(responsePreludeBudget({ ...payload, stream: false }), 1024 * 1024);
});
