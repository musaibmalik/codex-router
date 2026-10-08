# Custom model discovery and effort selectors

Custom models may share a provider container while using different endpoints. Optional automatic discovery reads each explicitly approved endpoint independently, using that endpoint's existing credential. It only requests `/models`; it never generates a response to probe a model.

Enable discovery in the Router state directory's `custom-model-discovery.json`:

```json
{
  "version": 1,
  "enabled": true,
  "allowedBaseUrls": ["http://127.0.0.1:8317/v1"]
}
```

Approve each actual destination separately. Addresses outside this list are rejected before credential resolution. Disabling the custom provider or discovery kill-switch prevents these requests. Anonymous models have individual destination authorization and are not expanded by this feature. Redirects are refused.

An installed background Router checks after startup and every five minutes. New conversation models are added to protected `user-models.json` and shown in the picker. Hidden-model choices and old task IDs are preserved. Existing catalog-owned names and context/compaction limits are reconciled when tracked metadata changes; subsequent user overrides win. Legacy entries can be explicitly enrolled with `--reconcile`. Missing models are retained for existing chats; reconciliation does not implicitly hide them. Image-generation, audio-generation and embedding-only entries do not belong in the conversation picker. Discovery failures retain the previous catalog. New models without capability metadata use conservative defaults; discovery does not certify tool compatibility.

The model-overlay transaction republishes gateway routes and all installed clients together. After successful publication, the supervised service waits for an idle Router and reloads its processes. A foreground Router stays running and reports that it needs a restart. Codex itself loads the picker catalog at application startup: fully quit and reopen Codex to see new names or models.

Run a one-off preview or synchronization from the managed checkout:

```sh
node src/custom-model-discovery.mjs
node src/custom-model-discovery.mjs --apply
node src/custom-model-discovery.mjs --reconcile --apply
```

Both honor the enable flag and destination list. The `--reconcile` option explicitly enrolls legacy entries’ advertised names and sizing; preview it without `--apply` first. Output-aware sizing reserves the advertised completion limit plus 4096 tokens for transport/tool overhead. Repeating an unchanged scan does not write models, publish the catalog or reload the service.

For a custom gateway that encodes reasoning in model IDs, `upstreamModelsByEffort` maps the picker choice to the exact upstream ID. Every declared effort must have an entry. Other models keep their original routing behavior. Gemini through CLIProxyAPI uses its documented `(low)`, `(medium)` and `(high)` suffixes, with clean display names such as `Gemini 3.8 Flash`. Gemini 3 Flash, 3.6 Flash, and 3.1/3.5 Flash Lite additionally expose their documented `minimal` level. Claude 5.5 names preserve their dotted version. Catalog aliases with `(max)` and `(ultra)` are deduplicated along with the other reasoning suffixes. Legacy slugs remain valid; duplicate single-effort rows can be hidden.

References: [CLIProxyAPI thinking suffixes](https://help.router-for.me/configuration/thinking) and [official model metadata](https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/registry/models/models.json).

AGY custom routes omit tool declarations when `tool_choice` explicitly prohibits tools, accepting both `"none"` and `{ "type": "none" }`. Other choices and other custom endpoints keep their existing behavior.
