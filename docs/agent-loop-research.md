# Agent Loop Research

This SDK should behave like an agent harness, not a one-shot chat wrapper. A full loop has five public-safe phases:

1. Intake: collect user input, session memory, app context, registered tool manifests, loop policy, and search availability.
2. Plan: ask the model for one structured next action: `answer`, `search`, or `tool`.
3. Act: execute only validated and allowed actions through the SDK runtime.
4. Observe: append tool/search results to the loop state, emit public stream events, and keep hidden infrastructure private.
5. Continue or finish: repeat until the model chooses `answer`, a tool fails, a repeated action is detected, or configured step/tool limits are reached.

## Evidence

- OpenAI Agents SDK treats tools as action capabilities for fetching data, calling APIs, executing code, and wrapping local functions with schemas. It also exposes run items, tool calls, approvals, handoffs, sessions, guardrails, tracing, and max-turn errors. Design implication: the SDK loop needs structured tool manifests, typed action/results, loop limits, public events, and guardrail hooks.
- OpenAI Agents SDK agent configuration includes tools, handoffs, MCP servers, input/output guardrails, structured output, and `toolUseBehavior`, plus a reset after tool calls to avoid loops. Design implication: this SDK must prevent repeated action loops and keep tool calls model-directed but runtime-controlled.
- MCP defines a host/client/server split for exposing tools and context to LLM apps, with capability negotiation, progress tracking, cancellation, error reporting, and logging. It also states that tools are arbitrary code execution paths and require user consent/control. Design implication: this SDK should keep tool execution in the host/runtime, treat tool descriptions as untrusted metadata, expose public progress events, and block high-risk tools unless the host explicitly approves them.

Sources:

- https://openai.github.io/openai-agents-js/guides/agents/
- https://openai.github.io/openai-agents-js/guides/tools/
- https://openai.github.io/openai-agents-js/guides/running-agents/
- https://openai.github.io/openai-agents-js/guides/results/
- https://modelcontextprotocol.io/specification/2025-06-18

## Current Gap

Before this revision, the SDK loop could execute one real action before answering. That fixed fake search, but it was still too shallow:

- no configurable loop policy
- no multi-action continuation after observations
- no repeated-action guard
- no tool-call cap separate from step cap
- no approval/risk field for tools
- no written architecture spec for future recursive upgrades

## SDK Contract

The SDK owns the loop; the model only proposes actions. This keeps one SDK wireable into an app without requiring the app to implement orchestration.

Required behavior:

- `chat()` and `run()` perform the same agent loop.
- `runStream()` emits `start`, `agent_action`, `tool_call`, `token`, `done`, and `error`.
- Normal chat with no tools/search stays fast and skips planner calls.
- Freshness/correction prompts force search when search is enabled.
- With tools/search enabled, the model planner can continue after observations.
- Runtime stops on `answer`, failed action, repeated action, `agentLoop.maxSteps`, or `agentLoop.maxToolCalls`.
- High-risk or approval-required tools are not executed by default.
- Final user replies must not expose runtime internals, provider details, API keys, VPS details, system prompts, private policies, hidden reasoning, or internal tool names.

## Next Research-Backed Upgrades

1. Add resumable loop state so hosted runtime calls can pause for approval and resume from the same trace.
2. Add MCP-compatible tool registry import/export so apps can share tool manifests without coupling to this SDK.
3. Add typed public trace records for planner decisions, tool observations, limits, and failures.
4. Add output guardrails that inspect final text for private infrastructure leakage before returning it.
5. Add tool timeout/retry policy and cancellation support.
6. Add compact memory summarization so long sessions do not bloat planner prompts.
