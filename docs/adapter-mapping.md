# Adapter anchoring: Core ports -> Pi Agent SDK

Per the skill's **Adapter anchoring** rule, this note is written **before** the adapter
and from real sources, not memory. Every claim below was read from the installed
package, not recalled.

- Pinned baseline: `@earendil-works/pi-coding-agent@0.84.2` (the skill's baseline).
- Verified installed: `node -p "require('@earendil-works/pi-coding-agent/package.json').version"` -> `0.84.2`
- `npm view` at install time: `latest = 1.4.0`. Deliberately **not** used; `latest`
  invalidates every API claim in the skill.
- Sources read: `dist/core/sdk.d.ts`, `dist/core/extensions/types.d.ts`,
  `node_modules/@earendil-works/pi-ai/dist/{types,models,compat,providers/faux}.d.ts`.

## 1. Dependency declaration (real pitfall #1 from the skill, observed here)

Inside `node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/` the
siblings `pi-ai`, `pi-agent-core`, `pi-client`, `pi-protocol`, `pi-telemetry`, `pi-tui`
are **nested**, not hoisted:

```
$ ls node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works
pi-agent-core  pi-ai  pi-client  pi-protocol  pi-telemetry  pi-tui
```

`pi-ai` is therefore **declared as a direct dependency** in `package.json` rather than
relied upon as a transitive one. This is exactly the "依赖必须声明" failure the skill logs
(Folio V8.1 P0), caught here before it could break a load.

## 2. ModelPort  `decide(state, signal)`

```
pi-ai  dist/compat.d.ts:63-66
  complete<TApi>(model: Model<TApi>, context: Context, options?: ProviderStreamOptions): Promise<AssistantMessage>
  stream<TApi>(...): AssistantMessageEventStream
pi-ai  dist/models.d.ts:139-142  (Models instance, what the adapter actually uses)
  models.complete<TApi>(model, context, options?: ModelsApiStreamOptions<TApi>): Promise<AssistantMessage>
  models.stream<TApi>(model, context, options?): AssistantMessageEventStream
pi-ai  dist/types.d.ts:377-381
  Context = { systemPrompt?: string; messages: Message[]; tools?: Tool[] }
pi-ai  dist/types.d.ts:49-50
  ProviderRequestOptions.signal?: AbortSignal      <- cancellation entry point
```

Mapping, field by field:

| Core | -> | pi-ai |
|---|---|---|
| `AgentState.messages` | -> | `Context.messages: Message[]` |
| `TOOL_SPECS[].name/description` | -> | `Tool.name / Tool.description` |
| `TOOL_SPECS[].parameters` (plain JSON Schema) | -> | `Type.Unsafe(schema)` for `Tool.parameters: TSchema` |
| `signal: AbortSignal` | -> | `options.signal` |
| `AssistantMessage.content[]` `ToolCall` block | -> | `Decision.call_tool { toolCallId, intent }` |
| `AssistantMessage.content[]` `TextContent` blocks | -> | `Decision.respond { content }` |
| `AssistantMessage.usage` | -> | `ModelUsage` -> Runtime `usage_reported` |
| `AssistantMessage.stopReason / errorMessage` | -> | `PortError` -> `RunErrorCode` |

```
pi-ai dist/types.d.ts:277  StopReason = "pending"|"stop"|"length"|"toolUse"|"error"|"aborted"|"deferred"
pi-ai dist/types.d.ts:246  ToolCall  = { type:"toolCall"; id; name; arguments }
pi-ai dist/types.d.ts:255  Usage     = { input; output; cacheRead; cacheWrite; reasoning?; ... }
```

### Error normalization (provider errors never reach the Core raw)

| observed signal | RunErrorCode | retryable |
|---|---|---|
| `402`, "insufficient balance", "quota" | `provider_unavailable` | no |
| `401`/`403`, "unauthor", "invalid api key" | `auth` | no |
| `429`, "rate limit", "too many requests" | `rate_limited` | yes |
| "timeout", ECONNRESET/ENOTFOUND/EAI_AGAIN, `5xx` | `provider_unavailable` | yes |
| anything else with `stopReason: "error"` | `provider_unavailable` | no |

`402 Insufficient Balance` is not hypothetical for this project: the skill's
verification log records it as the real failure of the deepseek path. It is now verified
end-to-end against a mock endpoint (`test/billing-failure.test.ts`), together with the
capability mismatch observed from real ollama.

**Known limitation (measured, not assumed).** The mapping runs on the *message text* the
SDK throws, and the SDK only inlines a response body when it is shaped
`{"error": {"message": ...}}`. A flat `{"message": ...}` body is dropped and surfaces as
`400 status code (no body)`, which then degrades to `provider_unavailable`. Neither
deepseek nor ollama returns that shape, so no body capture was added; a pinned test
(`documented limitation: a flat error body loses its detail...`) records the behaviour
so an SDK upgrade that changes it gets noticed.

## 3. ToolPort  `execute(toolCallId, intent, signal)`

The skill's port table maps `ToolPort.execute` -> `defineTool(...).execute(...)`. That
mapping assumes **the SDK owns the agent loop** (`createAgentSession({ customTools })`,
where `defineTool` registers tools the SDK invokes).

TinyCode inverts that: **the Core owns the loop**, because the whole point of this
project is that Core semantics stay identical across a fake adapter and a real one.
`defineTool`'s `execute(toolCallId, params, signal, onUpdate, ctx)` requires an
`ExtensionContext` that only exists inside an SDK-hosted session; fabricating one would
be exactly the "hidden global state leaking through the Core" the skill forbids.

Therefore, deliberately and visibly:

- `ToolPort` is implemented twice by this project: `createMemoryTools` (fake) and
  `createSandboxToolPort` (real fs + `run_check` subprocess).
- The SDK's role for tools is limited to **schema shape**: `TOOL_SPECS` is converted to
  pi-ai `Tool` so the model sees exactly what `ToolPort` will execute.
- `defineTool` / `createAgentSession` remain available as a future second adapter, not
  written here. Recorded as a limitation, not hidden.

```
pi-ai dist/types.d.ts:371-376  Tool = { name: string; description: string; parameters: TSchema }
pi-coding-agent dist/core/sdk.d.ts:10-56  CreateAgentSessionOptions { tools?, customTools?, noTools? ... }
```

## 4. Streaming

`models.stream()` is the **only** path now: the adapter drains the provider stream and
returns the final message, so there is no second non-streaming branch to drift.

```
pi-ai dist/types.d.ts:390  AssistantMessageEvent =
    { type:"text_start"|"text_delta"|"text_end" ... }
  | { type:"thinking_delta"; contentIndex; delta; partial }
  | { type:"toolcall_start"|"toolcall_delta"|"toolcall_end"; toolCall }
  | { type:"done"; reason; message: AssistantMessage }
  | { type:"error"; reason: "aborted"|"error"; error: AssistantMessage }
pi-ai dist/models.d.ts:139  Models.stream(model, context, options): AssistantMessageEventStream
```

Core semantics are untouched: the Core still calls `decide(state, signal)`. The Runtime
supplies the optional `progress` argument, pushes deltas into a queue, and interleaves
them with the still-pending step -- an async generator cannot yield from a callback, so a
queue plus draining is the mechanism (`src/runtime/delta-queue.ts`).

`text_delta` / `thinking_delta` are marked **transient**: they are published to the live
stream but never appended to the run log. Replay reconstructs state, not a token tape.

## 5. Cancellation

The Runtime owns an `AbortSignal` (caller's signal composed with
`AbortSignal.timeout(budget.timeoutMs)`) and passes it as a **required** argument
through both ports. The adapter forwards it to `options.signal`. Because the skill
warns that "whether the SDK aborts in-flight requests when its signal fires" must be
checked rather than assumed, the adapter *also* races the completion against the signal
so the port contract holds even if a provider transport ignores it. Verified by
`test/pi-adapter.test.ts` with a pre-aborted signal.

## 6. What is verified vs not

| Claim | Evidence |
|---|---|
| SDK imports, 145 exports | `node -e "import('@earendil-works/pi-coding-agent')...` -> exports: 145 |
| `createAgentSession`/`defineTool` export | same smoke test -> `function` |
| Real adapter encode/decode path | tested via `providers/faux` scripted responses (no network, no key) |
| **Live provider round-trip** | **VERIFIED 2026-10-23** against a real ollama endpoint (`--endpoint http://127.0.0.1:11434/v1`), no credentials. See `docs/live-run-notes.md` |
| **Real `usage` reporting** | **VERIFIED** — `in=84 out=256` / `in=73 out=519` from ollama's `openai-completions` layer. The skill's recorded usage gap is provider-specific, not universal |
| Capability-mismatch failures | **VERIFIED** — ollama returns 400 "does not support tools"; now mapped to `model_capability` (non-retryable) instead of `provider_unavailable` |
| **Model-driven tool calling** | **VERIFIED 2026-10-23** — `deepseek/deepseek-v4-flash` autonomously ran read → write → check → answer, `in=1256 out=188`. Pinned as golden transcript `live-cloud-tool-loop` |
| Capability routing by credential | **VERIFIED** — `getAvailable()` returns 0 models with no key and 2 deepseek models once `DEEPSEEK_API_KEY` is set |
| Streaming path | not implemented |

### 6.1 The keyless local provider, and why it is declared in this doc

`resolveLocalModel()` registers a custom provider through the SDK's own
`createProvider`, reusing the builtin `openai-completions` API module:

```
pi-ai dist/providers/groq.js (the pattern this was copied from, not guessed):
  createProvider({ id, name, baseUrl, auth: { apiKey: envApiKeyAuth(...) },
                   models: [...], api: openAICompletionsApi() })

pi-ai dist/auth/types.d.ts:227  ProviderAuth = { apiKey?: ApiKeyAuth; oauth?: OAuthAuth }
pi-ai dist/auth/types.d.ts:6    ModelAuth   = { apiKey?: string; headers?; baseUrl? }
pi-ai dist/api/openai-completions.lazy.d.ts:2  openAICompletionsApi: () => ProviderStreams
```

A local endpoint has no credential, so `resolve()` returns a placeholder
`{ auth: { apiKey: "local" } }`. That is a deliberate lie to the SDK about auth and the
truth to the operator about capabilities -- recorded here so nobody mistakes it for a bug.
