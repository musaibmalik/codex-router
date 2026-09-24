import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SOURCE_ROOT, PORTS, loopback } from "./paths.mjs";
import { runOperationProcessTree } from "./process-tree.mjs";
import { customDiscoveryEnabled, CUSTOM_DISCOVERY_INTERVAL_MS } from "./custom-model-discovery.mjs";

export async function scanCustomModels({ signal, run = runOperationProcessTree, now = Date.now } = {}) {
  // A fresh child reads the current registry, selection and endpoint identities.
  // It only publishes; it must never restart its own supervisor mid-transaction.
  const result = await run(process.execPath, [path.join(SOURCE_ROOT, "src", "custom-model-discovery.mjs"), "--apply"], {
    cwd: SOURCE_ROOT, env: process.env, deadline: now() + 12 * 60_000,
    encoding: "utf8", windowsHide: true, signal,
  });
  if (result.status !== 0) throw new Error("Custom model scan failed.");
  return JSON.parse(result.stdout.trim());
}

async function idle() {
  try {
    const response = await fetch(loopback(PORTS.router, "/health"), { signal: AbortSignal.timeout(3_000) });
    const health = await response.json();
    return response.ok && health.service === "codex-router" && health.activity?.activeCount === 0;
  } catch { return false; }
}

export async function waitForCustomModelRefresh({
  scanModels = scanCustomModels, isIdle = idle, enabled = customDiscoveryEnabled,
  isStopping = () => false, wait = delay, signal,
  canReload = () => process.env.MODEL_ROUTER_SUPERVISED === "1",
  log = (message) => console.error(`[codex-router] ${message}`),
} = {}) {
  let pending = false;
  let foregroundNotice = false;
  while (!isStopping() && !signal?.aborted) {
    if (enabled()) {
      if (!pending) {
        try {
          const result = await scanModels({ signal });
          pending = result.changed === true;
          if (result.failed) log(`Custom model discovery: ${result.failed} endpoint(s) unavailable; retained their existing models.`);
        } catch { if (!signal?.aborted) log("Custom model discovery failed; retained the previous catalog."); }
      }
      if (pending && !canReload() && !foregroundNotice) {
        log("New custom models published. Restart this foreground Router process to load their routes.");
        foregroundNotice = true;
      }
      if (pending && !signal?.aborted && canReload() && await isIdle()) {
        log("New custom models published; reloading the supervised routing processes while idle.");
        // start.mjs drains its owned children, then the installed OS supervisor
        // restarts the shared plane. No transaction or lock is held at this point.
        return { label: "Custom model catalog refresh", code: 0, reload: true };
      }
    }
    try { await wait(pending ? 10_000 : CUSTOM_DISCOVERY_INTERVAL_MS, undefined, { signal, ref: false }); }
    catch (error) { if (!signal?.aborted) throw error; }
  }
  return { label: "Custom model monitor stopped", code: 0 };
}
