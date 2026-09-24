---
name: codex-computer-use
description: Operate native apps through the current Codex CUA tool. Use when a custom (non-OpenAI) model through Codex Router needs to control an app UI. Prefer dedicated connectors for actions they support.
---

# Codex Computer Use

Check the current callable tool definitions. Use CUA JS, usually flattened as
`mcp__cua_repl__js` on routed models, only when it is actually declared.
Descriptions inherited from a parent or a skill do not establish availability.

Follow the live tool's first-call instructions. For a named app, the entry
point is one call such as:

```js
let app = await cua.getApp("Example App");
```

For an inventory, use `await cua.getState();` by itself. Read the returned
documentation before further interaction. Reuse bindings and obtain updated
accessibility state after actions before choosing what to do next.

Do not import `@oai/sky` or bootstrap `node_repl` for CUA. Use only APIs in the
current tool documentation. Legacy instructions apply only when that legacy
tool is actually declared and its current documentation requires them.

If the tool is absent or returns `unsupported call`, stop and report the exact
blocker. Do not start a side-channel driver or try guessed runtime names.
