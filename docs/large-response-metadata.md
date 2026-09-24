# Large opening response events

The Responses gateway echoes request instructions and tool definitions in its
opening events. Large Codex tool inventories can make one event larger than
1 MiB; when HTTP splits that event across chunks, the empty-completion guard
cannot classify the event before its original byte limit is reached.

Routed streaming requests now derive their pre-content allowance from the
final provider-bound tools, instructions, text format, tool choice and metadata.
The calculation accommodates three echoed events plus 64 KiB of envelope
space, including ASCII-escaped Unicode. Ordinary requests retain 1 MiB, and
automatic expansion stops at 8 MiB. Conversation history and image input do
not enlarge this allowance. It is a stream-buffer bound, not a total process
memory bound; concurrent large requests can use additional memory.

An explicit CODEX_ROUTER_EMPTY_COMPLETION_PRELUDE_BYTES setting remains fixed
and takes precedence. Native OpenAI and direct Responses routes are unchanged.
The selected budget follows the final request through failover and retry and
also bounds held terminal events. Empty-completion detection, timeout limits,
and the prohibition on retrying after response bytes reach the client remain
in force. Responses exceeding the bounded allowance can still fail.

Regression coverage is in response-prelude-budget.test.mjs and
empty-completion-router.test.mjs, using real HTTP chunk fragmentation and
large echoed tool definitions on both first attempts and retries.

The namespace relay uses the same opening-event allowance. Previously it
disabled namespace restoration after 256 KiB even when the response guard
accepted the larger event. Later tool calls then reached Codex with their
provider-facing names and failed with `unsupported call`. The opening allowance
is separate from the relay's existing 64 MiB terminal-event bound. Native and
direct Responses paths retain their previous defaults.

Coverage includes a CUA tool call following an echoed inventory larger than
1 MiB, and a completed response larger than its opening allowance.
