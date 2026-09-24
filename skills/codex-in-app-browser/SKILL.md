---
name: codex-in-app-browser
description: Operate browser tabs through the current Codex browser tool. Use when a custom (non-OpenAI) model through Codex Router needs to open, read, fill, click, or test pages in the Codex in-app browser.
---

# Codex In-App Browser

Check the current callable tool definitions. The current browser entry point
is CUA JS, usually flattened as `mcp__cua_repl__js` on routed models. A skill
or inherited parent message does not prove the tool is available to a child.

Use the entry point specified by the live tool instructions. For an initial
browser inventory, the first call contains only:

```js
await cua.getState();
```

Read the returned documentation before proceeding. For a known URL and an
explicit request for the in-app browser, its entry point is:

```js
let tab = await cua.createBrowserTab("iab", url, { visible: true });
```

For a child agent, use `{ visible: false }`: the CUA service rejects visible
in-app tabs in subagent threads. The child can still control its hidden tab
independently.

Follow the user's browser choice and the live entry-point precedence for tab
mentions and other browsers. Use only the APIs documented by the current tool.
After actions, read the updated accessibility state before choosing the next
action, and verify entered values and final outcomes from the returned state.

Do not bootstrap `node_repl`, import a browser client, or start a side-channel
driver for CUA. Legacy runtime instructions apply only when that legacy tool
is actually declared and its current documentation requires them.

If the tool is absent or returns `unsupported call`, stop and report the exact
blocker. Do not guess tool names or investigate alternative runtimes. A parent
executing a child's proposed browser actions is assisted operation, not
independent child browser control.
