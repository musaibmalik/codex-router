const DEFAULT_BYTES = 1024 * 1024;
const MAX_AUTOMATIC_BYTES = 8 * DEFAULT_BYTES;

// LiteLLM echoes these request fields in response.created, in_progress and
// completed. A single echoed event can exceed the default staging budget,
// especially when Codex publishes a large tool inventory. Size the allowance
// from metadata actually sent, never from conversation history or image data.
// Keep the normal budget, explicit operator overrides, and a finite ceiling.
export function responsePreludeBudget(payload, {
  baseBytes = DEFAULT_BYTES,
  fixed = false,
} = {}) {
  if (fixed || payload?.stream !== true) return baseBytes;
  const echoed = {};
  for (const key of ["tools", "instructions", "text", "tool_choice", "metadata"]) {
    if (payload[key] !== undefined) echoed[key] = payload[key];
  }
  const serialized = JSON.stringify(echoed);
  // Count an ASCII-escaped JSON representation too: Python gateways may emit
  // six-byte unicode escapes where JavaScript emits the original character.
  let bytes = serialized.length;
  for (let i = 0; i < serialized.length; i += 1) {
    if (serialized.charCodeAt(i) > 127) bytes += 5;
  }
  const allowance = 3 * bytes + 64 * 1024;
  return Math.max(baseBytes, Math.min(MAX_AUTOMATIC_BYTES, allowance));
}
