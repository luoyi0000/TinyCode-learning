# 合规审计（Skill Compliance Audit）

> 范围：`pi-coding-agent-skill` 的 `SKILL.md` + 全部 13 个参考文件。
> 方法：逐条提取**对本项目有约束力**的要求，对照实现，给出判定与证据。
> 判定四类：**合规** / **已修偏离** / **有意偏离（附依据）** / **不适用（架构差异，说明理由）**。

审计时状态：47 个测试全绿，typecheck 零错误，两条真机链路已验证。

---

## 1. 本次审计发现的唯一必改项（已修）

**要求**（`scenario-confirm-gate.md` 第 4 步 + 验证第 3 条）：

> 没有 humanInput channel 时，`ask_human` **必须失败**，绝不能静默放行。
> …… 无 `humanInput` 注入时，run 以 `run_failed(runtime_error)` 终止而不是执行。

**修复前**：`run_completed(partial)` + `missingMaterial: ["human_input:…"]`。

**为什么这是错的**：未接人通道是**运维错误**，不是「降级的结果」——根本没有任何结果。
用 `partial` 报告会让调用方以为「agent 答了但材料不足」，于是去读内容，而不是去查配置。

**修复后**：抛 `PortError("runtime_error")` → `run_failed`。
测试 `ask_human without a human channel fails loudly instead of proceeding` 同时断言：
问题进了 trace（`human_input_requested`）、**没有任何 `tool_started`**（确认前绝不执行）、终态是 `run_failed`。

---

## 2. 有意保留的偏离（附实测依据）

### 2.1 事件落库用 `await`，不是 fire-and-forget

**要求**（`scenario-event-logging.md`）：`void appendEvent(...)`，慢 I/O 不该堵主循环。

**本项目的选择**：`await log.appendEvent(event)`。

**理由**：

1. skill 警告的根因是「SDK 的 `pi.on` handler 被派发方 await」——**本项目没有这条链路**，
   Runtime 自己拥有循环，不存在「被外部 await 的 handler」。
2. `await` 保证**磁盘顺序 == sequence 顺序**。朴素 `void` 会让并发写交错，破坏审计顺序。
3. 本项目承诺「崩溃后可从日志精确恢复」，`await` 使已发出的事件必然已落盘。

**实测依据**（`scripts/measure-log-latency.ts`，500 次追加）：

```
mean=0.343ms  p50=0.273ms  p95=0.729ms  max=1.749ms
每步约 6 个事件  =>  约 2.06ms/步
对照：云端一步约 1000ms；本地 7B 一步 3000-70000ms
```

落库占单步耗时 **0.2%**。这不是「我觉得没事」，是量过。

**什么会推翻它**：事件率上升到落库耗时可与单步耗时相比，或需要多消费者并发写同一日志。
届时改为「内存队列 + 终态前 flush」。

### 2.2 一个 run 一个日志文件，而不是一个 session 一个

**要求**（SKILL「Storage contracts」）：one file/table per session keeps concurrent sessions isolated。

**本项目的选择**：`.tinycode/events/<runId>.jsonl`，粒度**更细**。

**理由**：一个 session 可有多个 run；会话级文件会让单 run 回放需要先过滤。
run 级文件让回放天然幂等、并发 run 零干扰。隔离性更强，代价是文件数更多。

---

## 3. 比 skill 基线更严的地方

### 3.1 完全没有 bash 工具

**要求**（`sdk-doc-tools.md`）：垂直 Agent 的默认姿势是 `noTools: "builtin"`，
因为多用户场景下 `bash` 是安全口子。

**本项目**：工具面只有 `list_files` / `read_file` / `write_file` / `run_check`。
**没有 bash**；且 `run_check` 执行的是 **Task 里固定的命令**，不是模型选定的命令 ——
模型无法借 `run_check` 执行任意 shell。这是**结构性**保证，不靠 prompt 约束。

### 3.2 判定规则比 skill 最低要求更严

skill 只要求 `run_completed` 区分 complete/partial。本项目额外要求：

1. 至少一条 observation（否则 `evidence:no observation recorded`）
2. 改过文件时必须有**最后一次写入之后**的通过检查（否则 `check:required_after_change`）
3. 写入会作废先前的 check

三条都是真机发现逼出来的（`docs/live-run-notes.md` 事实 4 / 9）。

---

## 4. 不适用（架构差异，说明理由）

| 要求 | 出处 | 为什么不适用 |
|---|---|---|
| 别把 `agent_end` 当终态，用 `agent_settled` | sdk-doc-events | 不使用 `createAgentSession`，没有 SDK 内部 retry/compaction 队列；适配器 `done` 是单次请求终点，`willRetry` 概念不存在 |
| `subscribe` listener 禁止阻塞 I/O | sdk-doc-events | 不使用 `session.subscribe`；事件由 Runtime 在生成器里产出 |
| `SessionManager.inMemory()` 用于多用户 | sdk-doc-session-runtime | 不使用 SDK 会话持久化，自实现 `RunLog` |
| `AgentSession.abort()` 对应 `run_cancelled` | sdk-doc-session-runtime | 不使用会话；等价能力是 Runtime 自有 `AbortSignal` 组合（区分 user/timeout） |
| `defineTool` + `prepareArguments` 双通道校验 | sdk-doc-tools | Core 拥有循环，工具不经 SDK 注册（理由见 `docs/adapter-mapping.md` §3）。等价保障：`ToolPort` 在 execute 内校验并抛 `invalid_tool`，非 schema 级预校验 |
| 工具返回 `Array<TextContent \| ImageContent>` | scenario-custom-tool | 那是 SDK 工具形状；本项目端口返回 `Observation`，映射只在适配器边界发生 |
| 工具拦截 / 隐私包装 | scenario-tool-intercept | 不使用 SDK 工具系统；等价能力已在 `instrumented` ToolPort 里实现（白名单、事件采集、异常留痕） |
| ~~`maxInputTokens` 与上下文压缩~~ | SKILL「Budgets」 | **已实现**（见 §6.1）：硬上限 → `budget_input_tokens`；压缩为确定性省略，无模型调用 |

---

## 5. Security defaults 逐条

| 要求 | 实现 | 判定 |
|---|---|---|
| 显式 allowlist，未知工具在 `execute` 拒绝 | `isAllowedTool` 在 instrumented ToolPort 拒绝，并产出可审计事件 | 合规（有回归测试） |
| 密钥不进 state / event / trace | 守卫测试：全项目禁止 `process.env` 与 secret 字面量；凭证由 SDK auth 层解析 | 合规 |
| 工具结果不可信：截断 | `truncate()` + `MAX_OBSERVATION_CHARS=1500`，落进 message 前再截一次 | 合规 |
| 路径不能逃出工作区 | `safeResolve()` 唯一入口，`..` 直接抛 `invalid_tool` | 合规（有测试） |

## 6. 审计与持久化逐条

| 要求 | 实现 | 判定 |
|---|---|---|
| append-only 是唯一真源，快照只能是缓存 | `RunLog` 只有 `appendEvent`，无更新方法 | 合规 |
| `sequence` 每 run 单调、回放幂等 | `createPublisher` 递增；`stage/publish` 分离保证发射序==序号序 | 合规（有测试） |
| 回放按序重建 state | `replayAgentState` 复用 `applyToolStep`，构造上不可能漂移 | 合规 |
| `tool_completed` 带 result/error/durationMs | 是 | 合规 |
| `observation_added` 带 name/observation | 是 | 合规 |
| `decision_made` 全量记录决策 | 是 | 合规 |
| usage 可能缺失，不要假装有 | `undefined` 而非 0，`usageSeen` 标志控制 | 合规（真机两路验证） |
| 崩溃可恢复 | 截断日志测试：非终态如实报告，durable 进度不丢 | 合规 |

---

## 6.1 上下文预算与压缩（本轮新增）

`RunBudget.maxInputTokens?` 是**硬上限**：Runtime 在每次请求前检查估算值，超了即
`run_failed { code: "budget_input_tokens" }`（`RunErrorCode` 的扩展项，理由同 `model_capability`）。

压缩策略是**确定性省略**，刻意不调用模型：

| 决定 | 理由 |
|---|---|
| 不用「模型生成摘要」式压缩 | 会让回放非确定（摘要不可复现），且在一次 run 中途多出费用与失败点 |
| 保留首条用户消息（任务本身） | 任务不可协商 |
| 保留最近 N 条 | 局部性：刚读过的内容最可能被用到 |
| 不许把 tool 结果与其调用拆开 | 否则模型会看到无主的 toolResult |
| 被丢弃的内容换成一条**具名**边界消息 | 模型知道「我忘了什么」，可以重读而不是臆造 |
| 已存在的边界消息保留 | 否则反复压缩会 churn，破坏幂等与回放一致性 |

**回放复现**：`compact_boundary` 事件持久化 `elided` / `keepRecentMessages` / `estimatedTokens`，
`replayAgentState` 用同一函数重放。有一条**真交叉校验**的测试：回放到该事件时重算的估算值
必须等于运行时记录的 `estimatedTokens`。

token 估算用 4 字符/token 的启发式，**只用于预算决策，从不用于计费**。

## 7. 结论

- 13 个参考文件中，有约束力的条目共 **24 条**：合规 15、已修偏离 1、有意偏离 2、不适用 6。
- 唯一必改项（`ask_human` 无通道必须失败）**已修复并有测试**。
- 两处有意偏离都写了**依据与推翻条件**；落库那条附实测数据（0.2%）。
- 审计**没有**发现第二类问题：不存在「漏读了某条硬要求」的情况。
  这值得记一笔 —— 审计的价值一半在「找到了什么」，一半在「确认了没漏」。

## 8. 审计之后仍未闭合的

| 项 | 状态 |
|---|---|
| compaction 的**真机**验证 | 未做。离线有 4 个测试 + demo 场景 4 覆盖，但未用真实模型跑出「撑爆再压缩」的一轮 |
