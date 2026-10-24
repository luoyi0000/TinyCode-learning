# TinyCode

一个**小**的编码 Agent：给它一句话需求，它在工作区里读文件、改文件、跑自检命令，然后**带着证据**回答你；做不到时它报告 `partial`，而不是假装成功。

Core 与 Runtime 分离，Pi Agent SDK 只活在端口后面。方法论来自 `pi-coding-agent-skill`（第一性原理：真实任务 → 最小循环 → Core/Runtime 分离 → SDK 只做适配器）。

## 1. 真实任务（一切的起点）

> 给定一个小型源码树和一句自然语言需求，用户想要一份**已落盘、自带证据**的代码改动；
> 材料不足或自检失败时，Agent 必须诚实报 `partial`，而不是假装成功。

## 2. 最小循环

```
Task → Context → 模型决策 → 工具动作 → Observation → 状态更新 → Result | 下一轮
```

工具面刻意只有 4 个：`list_files` / `read_file` / `write_file` / `run_check`。

## 3. 分层

| 层 | 拥有 | 硬约束 |
|---|---|---|
| **Core** (`src/core`) | Task / State / Decision / ToolIntent / Observation / Result / RunErrorCode / 工具白名单 | **绝不 import SDK**；纯函数，不碰 IO，不改传入的 state |
| **Runtime** (`src/runtime`) | Session / Run / 有序 AgentEvent / AbortSignal 预算 / 重试 / JSONL 事件日志 / 回放 | 换适配器不改 Core 语义 |
| **Adapters** (`src/adapters`) | `fake.ts`（内存、确定性）、`pi.ts`（真实 SDK + 真实文件系统） | **唯一** import SDK 的地方 |
| **Product** (`src/cli.ts`) | 事件流 → 可读 trace | 不泄露原始 SDK 回调 |

## 4. 快速开始

```bash
npm install
npm run check     # tsc --noEmit，零错误
npm test          # 68 个测试，全绿（含 1 份真机 golden transcript 回放）
npm run demo      # 离线：5 个确定性场景（含上下文压缩）+ 回放恢复
npm run serve     # SSE 端点（需要模型：--endpoint 或 provider 凭证）
```

要求 **Node >= 24**：本项目用 Node 原生执行 `.ts`（无构建步骤），而 24 是唯一实测过的版本。
CI 也只跑 24 —— 声称两个版本却只测一个，是空头承诺。

真实模型的路径。**零凭证的本地端点已验证**（见第 7 节与 `docs/live-run-notes.md`）：

```bash
# 本地 / 无凭证：任何 OpenAI 兼容端点（ollama、llama.cpp、vLLM、LM Studio）
node src/cli.ts run --request "make greeting.txt say hello" \
     --workspace ./sandbox --check "npm test" \
     --endpoint http://127.0.0.1:11434/v1 --model deepseek-r1:7b --timeout 240000

# 云端：需要 provider 凭证或一次 pi 登录
node src/cli.ts run --request "..." --workspace ./sandbox [--model provider/modelId]

node src/cli.ts replay <runId>     # 从事件日志重建一次 run

# SSE 端点：和 CLI 共用同一份事件协议，浏览器可直接消费
node src/cli.ts serve --port 8787 --workspace ./sandbox --check "node check.mjs" \
     --endpoint http://127.0.0.1:11434/v1 --model qwen2.5:7b
curl -N "http://127.0.0.1:8787/run?request=..."
```

模型不支持 tool calling 时加 `--tools none`：这是一条**文字模式**通道，用来隔离
"传输/解码/usage"与"工具调用"两件事——本项目的 usage 就是这样第一次被真机验证的。

## 4.1 工程状态

| 项 | 状态 |
|---|---|
| 版本控制 | git 仓库；首次提交 49 files / 7 878 insertions，提交信息含完整设计理由 |
| 许可证 | MIT（见 `LICENSE`）—— 这是**默认选择**，如需专利授权条款请改 Apache-2.0 |
| CI | `.github/workflows/ci.yml`：`npm ci` → typecheck → 57 tests → demo |
| npm scripts | `test` / `check` / `demo` / `replay` / `serve` / `record` |
| 仓库范围 | 只含本项目；与本项目无关的第三方技能包已在 `.gitignore` 排除 |

> 注：仓库级 git 身份是占位值（`TinyCode <tinycode@localhost.invalid>`），
> 因为你机器上没有配置全局身份。首次推送前请改成你自己的。

## 4.2 桌面应用（Electron）

同一套 Core/Runtime，包在 Electron 里：**Runtime 跑在主进程**（Pi SDK 是 Node 包），
renderer 只接收通过 IPC 推来的产品级事件。Core/Runtime/adapters **一行未改** —— 这是端口架构的回报。

```
src/main/index.ts              BrowserWindow + 安全配置 + CSP
src/main/ipc/run-handlers.ts   托管 Runtime，把事件推给 renderer
src/preload/index.ts           contextBridge，只暴露具名 channel
src/renderer/src/App.tsx       打字机正文 / 工具轨迹 / 成本 / 终态
src/renderer/src/view-model.ts 纯 reducer：事件 → 可见状态
src/shared/ipc.ts              IPC 契约（三端共享）
```

```bash
npm run dev:desktop     # 开发模式（HMR）
npm run build:desktop   # 产出 out/
```

### 三个被迫的格式决定（每一条都有实测理由，不是偏好）

| 决定 | 理由 |
|---|---|
| main 必须是 **CJS**（`index.cjs`） | 实测：Electron 33 / Node 20.18.3 下，ESM main 连 `import { app } from "electron"` 都会崩 |
| preload 必须是 **CJS**（`index.cjs`） | `sandbox: true` 的 preload 不能是 ESM |
| `pi-ai` 在适配器里**只做类型 import** | 它是纯 ESM 包，CJS 的 `require()` 会 `ERR_PACKAGE_PATH_NOT_EXPORTED`；运行时访问全部走动态 `import()` |

### 一个环境坑（值得记）

如果 shell 里有 `ELECTRON_RUN_AS_NODE=1`，Electron 会以**纯 Node 模式**启动：
`process.type` 是 `undefined`、`require("electron")` 返回 exe 路径字符串而非 API。
启动前请先 `unset ELECTRON_RUN_AS_NODE`，否则会得到一堆看不懂的互操作报错。

### ⚠️ 启动**未**在本环境验证

构建通过、三端类型检查通过、11 个新测试通过 —— 但**我没有成功把窗口拉起来**：

```
直接启动             exit -2147483645 (0x80000003 STATUS_BREAKPOINT)
--no-sandbox --disable-gpu  exit -1073741819 (0xC0000005 STATUS_ACCESS_VIOLATION)
```

两次都是 OS 级崩溃，发生在**我的应用代码执行之前**，也无任何 stdout/stderr ——
这是我的执行环境不允许 Chromium 多进程模型的限制，不是代码错误的证据。
**请在你自己桌面的终端里跑 `npm run dev:desktop` 验证。**

已静态验证的部分（`test/desktop-security.test.ts`，5 个测试）：
安全三默认齐全、禁止导航/开窗、CSP 存在、preload 不暴露裸 `ipcRenderer`、
所有 IPC 走具名 channel、preload 不碰 node 内置模块、renderer 不碰 SDK 与文件系统。
## 5. 退出准则 → 真实命令

每一条都对应一个真跑过的测试；跑不过就不算完成。

| # | 退出准则 | 对应证据 |
|---|---|---|
| 1 | 两个 Session 不共享消息、状态、观察 | `two sessions share no messages, state or observations` |
| 2 | 每次 Run 有序生命周期 + 终态 | `a run has an ordered lifecycle, monotonic sequence and a terminal event` |
| 3 | 工具失败可见且不污染无关状态 | `a failing tool is visible and never corrupts unrelated state` |
| 4 | 取消停止后续工作、落盘、in-flight 调用拒绝 | `cancellation stops the run, persists it, and never fakes completion` + `cancellation rejects in-flight model work when the signal fires` |
| 5 | 重启恢复持久状态；回放精确重建 AgentState | `event-log replay reconstructs the state the Core actually reached` + `a log truncated by a crash...` + `golden replay: *` |
| 6 | Runtime 只发产品级事件，不泄漏 SDK 事件 | `the SDK is imported in exactly one file: the Pi adapter` |
| 7 | 模型/工具/重试/时间预算可预测地终止 | `a retryable provider error is retried...` / `a non-retryable error is never retried...` / `the tool-call budget...` / `the iteration budget...` / `the timeout budget...` |
| 8 | 真适配器与假适配器产出同一套 Core 语义 | `fake and real adapters produce the same Core semantics (golden equivalence)` |
| 9 | `run_completed` 区分 complete / partial（带 missingMaterial），且 **complete 需要证据** | `an unknown tool cannot succeed...` + `a failed check makes the run partial...` + `answering without a single observation is partial, not complete` + demo 场景 2 |
| 10 | `usage_reported` 回答每次 run 的成本问题 | `a run has an ordered lifecycle...`（断言每次 run 都有 usage_reported）+ `real adapter decodes a text stop into respond and reports usage` |
| 11 | 密钥不出现在事件、trace、日志里 | `our code never reads credentials: the SDK auth store owns them` |

`npm test` 是唯一的验收入口：68 pass / 0 fail。

对照 skill 全部 13 个参考文件的逐条审计见 `docs/skill-audit.md`：
24 条有约束力的要求 —— 合规 15、已修偏离 1、有意偏离 2（附实测依据）、不适用 6（附架构理由）。

## 6. 文件地图

```
src/core/types.ts        domain 类型 + 端口契约（零 SDK）
src/core/policy.ts       工具白名单、JSON Schema、结果截断
src/core/context.ts      token 估算 + 确定性压缩（无模型调用，可回放复现）
src/core/loop.ts         step()；applyToolStep() 是 loop 与 replay 共用的唯一状态转移
src/runtime/events.ts    产品级事件 tagged union + 单调 sequence
src/runtime/budget.ts    调用方 signal 与 timeout 的组合，区分 user / timeout
src/runtime/run.ts       Runtime：单次 run 的事件流、预算、重试、取消、终止
src/runtime/runlog.ts    append-only JSONL + replayAgentState + terminalStatus
src/adapters/fake.ts     确定性 fake model / fake tools
src/adapters/pi.ts       真 Pi 适配器（模型传输 + 沙箱文件工具）
src/cli.ts               demo / replay / run
docs/adapter-mapping.md  skill 要求的适配器映射文档（先写文档再写代码）
docs/skill-audit.md       13 个参考文件的逐条合规审计（含 2 处有意偏离的依据）
docs/live-run-notes.md    真机验证记录，事实 1-15，格式对齐 skill 的 verification-log
transcripts/             golden 事件日志 + manifest
```

## 7. 诚实的缺口（没有验证的事，不写成已验证）

1. **真机端到端已闭合。** 两条真实链路都跑过：

   | 链路 | 凭证 | 验证到的东西 |
   |---|---|---|
   | 本地 ollama（`deepseek-r1:7b`） | 无 | 真实 HTTP 往返、真实 usage（`in=84/out=256`）、类型化失败 |
   | 云端（`deepseek/deepseek-v4-flash`） | API key | **模型自主调用工具**：读 → 改 → 自检 → 带证据回答，`in=1256/out=188` |

   第二条第 `0297f57f` 次 run 已采纳为**真机 golden transcript**，
   由 `test/transcripts.test.ts` 的 `golden replay: live-cloud-tool-loop` 每次校验。
   完整事实见 `docs/live-run-notes.md`。
2. **本地 7B 模型能用但不可靠。** `qwen2.5:7b` 会写错内容、跳过自检、把工具调用写成正文。
   产品现在能接住它（判 `partial` + `check:required_after_change`），但它不能当作任务正确性的证据。
   详见 `docs/live-run-notes.md` 的事实 9/10。可靠的本地闭环需要更大的模型。
3. **流式已实现并真机验证。** 适配器统一走 `models.stream()`（一条代码路径，不是两条），
   Runtime 用 delta 队列在 `core.step` 仍挂起时就把 token 吐出去。真机时间戳证明 token 是
   分散到达的（每 ~40ms 一个），而不是攒完再 flush —— 后者同样「有」delta 事件，所以测试
   断言的是**顺序**（delta 下标 < decision_made），不是存在性。
   `text_delta`/`thinking_delta` 是**瞬态事件**：只进实时流，不进 run log（状态重建不需要它们，
   而把每个 token 写进审计日志会把它变成转录垃圾）。
   现状：`node src/cli.ts serve --port 8787 ...` 提供 SSE 端点，与 CLI 共用同一份事件协议。
4. **上下文压缩只在离线验证过。** 4 个测试 + demo 场景 4 覆盖了「省略、边界消息、回放复现、
   压不下去就失败」，其中回放有一条**真交叉校验**（回放重算的估算值必须等于运行时记录值）。
   但**没有用真实模型跑出「撑爆再压缩」的一轮** —— 需要一个足够长、足够大的任务。
   压缩刻意不用模型生成摘要，因为那会让回放非确定。
3. **没有用 `defineTool` / `createAgentSession`。** 那是「SDK 拥有 agent 循环」的用法，
   而本项目的全部价值在于 **Core 拥有循环**、fake 与 real 语义一致。
   理由与取舍写在 `docs/adapter-mapping.md` §3，不是遗漏。
4. **`ask_human` 需要注入 `humanInput`。** 没注入时 run 以 `partial` + `missingMaterial: ["human_input:..."]` 结束。
   这是有意的诚实终止，而不是无声挂起。
5. **一个 runtime 实例同一时刻只跑一个 run**（共用单一事件 sink）。并发需要各自实例。
   会直接抛错，不会悄悄交叉污染。
6. **真实 provider 下 token 数可能是 `undefined`。** skill 的验证日志记录了 deepseek 路径 `agent_end` 不带 usage。
   此时 `usage_reported` 如实留空，不编造 0。
7. **崩溃恢复是回放，不是续跑。** 中途崩溃留下的日志会被 `replay` 判为非终态并如实报告；
   目前没有「接着跑完这次 run」的能力。

## 8. 版本基线

- `@earendil-works/pi-coding-agent@0.84.2`：**钉死**。安装时 npm `latest` 是 `1.4.0`，
  按 skill 的版本协议刻意不用 —— 装 `latest` 会立刻让 skill 里所有 API 描述失效。
- `@earendil-works/pi-ai@0.84.2`：**显式声明**为直接依赖。
  它实际被嵌套在 `pi-coding-agent/node_modules/@earendil-works/` 下（已实测），
  不声明就踩 skill 记录的「依赖必须声明」坑。

## 9. 关于 `pi-coding-agent-skill` 的目录

`pi-coding-agent-skill/` 与本项目同级、只读，是方法论与其参考层（`references/`）。
本项目的映射文档 `docs/adapter-mapping.md` 按它的 Adapter anchoring 要求在写适配器**之前**完成，
每条 API 声明都标注了真实出处（`dist/*.d.ts` 行号），没有一个字来自记忆。
