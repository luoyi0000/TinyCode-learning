# 真机验证笔记（Live Run Notes）

> 本文件只记录**真跑出来的事实**，格式对齐 skill 的 `references/verification-log.md`：
> `日期 | 环境/版本 | 验证方式 | 结果`。禁止把推测写进来。

---

## 2026-10-23 | 首次真机网络往返 | 本地 ollama

**环境**

| 项 | 值 |
|---|---|
| 端点 | `http://127.0.0.1:11434/v1`（ollama 的 OpenAI 兼容层） |
| ollama | client 0.18.2，`ollama serve` 后台运行 |
| 模型 | `deepseek-r1:7b`（7.6B，Q4_K_M，family=qwen2 的蒸馏版） |
| SDK | `@earendil-works/pi-coding-agent@0.84.2` / `pi-ai@0.84.2` |
| 适配器 api | `openai-completions`，经 `createProvider` 注册为 `local-openai-compatible` |
| 凭证 | **无**（`resolve()` 返回占位 key） |

**命令**

```bash
node src/cli.ts run --request "..." --workspace ./sandbox --check "node --version" \
     --endpoint http://127.0.0.1:11434/v1 --model deepseek-r1:7b --timeout 240000
```

### 事实 1：真实 HTTP 往返通了

请求真的发出去了、ollama 真的回了、适配器真的解了、Runtime 真的按事件顺序吐了出来。
**这条路径在本次之前完全未验证**（README 旧缺口 #1 的主体）。

### 事实 2：能力不匹配被错误分类（已修复）

带 tools 请求 deepseek-r1 时，ollama 回：

```
400: {"message":"registry.ollama.ai/library/deepseek-r1:7b does not support tools",
      "type":"invalid_request_error"}
```

修复前：被兜底归到 `provider_unavailable` —— **语义错误**，重试永远不会成功。
修复后：`mapProviderError` 显式识别能力类错误，归到新增的 `model_capability`（`retryable=false`）。

> skill 的 `RunErrorCode` 最小集合里没有这个码（它只说 "at minimum"），因此这是**有依据的扩展**，
> 理由是：能力缺失与 provider 故障对用户是两种截然不同的处置——前者换模型，后者等/重试。

### 事实 3：usage 在 ollama 路径上是**有**的

| 运行 | input | output | 耗时 |
|---|---|---|---|
| 第 1 次（text-only） | 84 | 256 | 64 471 ms |
| 第 2 次（text-only） | 73 | 519 | 31 941 ms |

`usage_reported` 拿到的是**真实 token 数**，不是 `undefined`。

这修正了 skill 验证日志里那条缺口的一个隐含误读：**`usage` 缺失是 provider 特定的，不是普遍现象**。
deepseek 官方 API 的 `agent_end` 不带 usage；ollama 的 openai-completions 层带。
本项目的行为不变：拿到就报，拿不到就留 `undefined`，**不编 0**。

### 事实 4：无证据的 run 曾经自称完成（已修复）

`--tools none` 时有工具面为空，模型只能凭先验回答。它答了「greeting.txt 里大概是问候语」——
**它从未读过这个文件**——而旧规则下 `missingMaterial` 为空，于是报 `complete`。

这是 skill「never claims unsupported success」的直接违反。
新规则（`loop.ts` 的 `finalVerdict`）：**`complete` 要求至少有一条 observation**；
否则 `partial` + `missingMaterial: ["evidence:no observation recorded"]`。

修复后同一条命令的输出：

```
[003] decision_made   respond "Greetings! ..."
[004] usage_reported  tools=0 in=73 out=519 31941ms
[005] run_completed   partial missing=["evidence:no observation recorded"]
（退出码 4）
```

### 事实 5：本地 7B 模型的延迟远超默认预算

单次决策 32–64 秒（CPU 推理）。Runtime 默认 `timeoutMs: 60_000`，**对本地模型太紧**。
所以 CLI 现在有 `--timeout`。这是运维事实，不是代码缺陷。

---

---

## 2026-10-23 | 首次真机完整闭环（云端） | 模型自主调用工具

**环境**：`deepseek/deepseek-v4-flash`（SDK 内置 provider 目录），凭证经环境变量由 SDK auth 层解析。

**命令**

```bash
DEEPSEEK_API_KEY=... node src/cli.ts run \
  --request "Make greeting.txt contain exactly: hello tinycode. Read it first, then fix it, then run the check." \
  --workspace ./sandbox --check "node check.mjs" \
  --model deepseek/deepseek-v4-flash --timeout 180000
```

**结果：模型自主完成 读 → 改 → 自检 → 带证据回答**

```
[003] decision_made      call read_file  {"path":"greeting.txt"}
[008] decision_made      call write_file {"path":"greeting.txt","content":"hello tinycode\n"}
[013] decision_made      call run_check  {}
[016] observation_added  run_check ok: check passed: PASS greeting.txt = "hello tinycode"
[018] decision_made      respond "Done. - Read greeting.txt: it contained 'old content...' - Replaced it"
[019] usage_reported     tools=3 in=1256 out=188 3947ms
[020] run_completed      complete
```

### 事实 6：工具调用闭环通了（这是此前唯一的 release 缺口）

- 模型**自主**选择工具、按正确顺序（先读后写、写完自检），没有任何硬编码引导
- 真实文件被改动：`hello tinycode\n`
- 真实子进程执行了 `node check.mjs`，退出码 0
- `run_completed: complete` **且合法**——3 条 observation 构成证据（新证据规则生效）
- 真实 usage：`in=1256 out=188`，3947 ms

该 run 已被采纳为**第一份真机 golden transcript**（`transcripts/events/0297f57f-*.jsonl`，
manifest label `live-cloud-tool-loop`），并由 `test/transcripts.test.ts` 每次回放校验。

### 事实 7：模型写入带尾换行，检查脚本的 `.trim()` 救了这一局

模型写的是 `"hello tinycode\n"`（15 字符），检查脚本用 `.trim()` 比较才通过。
这不是运气：**自检脚本必须规范化，否则会因空白差异产生假失败**。

### 事实 8（过程教训，不是产品缺陷）

验收时我在项目根目录跑 `node sandbox/check.mjs`，得到 `FAIL greeting.txt is missing`——
因为脚本按 **cwd** 找文件，而产品的 `run_check` 是以 **workspace** 为 cwd 执行的。
产品侧输出 `[016] check passed` 是对的；错的是我那条验收命令。
记录在此以免下次误判成 bug。


---

## 2026-10-23 | 本地工具调用（零凭证） | 一次真实的「小模型不可靠」

**环境**：`qwen2.5:7b`（4.7 GB，支持 tool calling），ollama，`--endpoint http://127.0.0.1:11434/v1`，无任何凭证。

**结果：工具调用机制通了，但模型把任务做错了，而产品没能接住**

```
[003] call read_file   {"path":"greeting.txt"}
[006] observation_added read_file ok: old content, must be replaced
[008] call write_file  {"content":"hello tinycode.","path":"greeting.txt"}   <- 多了一个句号
[013] respond          " Ronaldo ... {\"name\": \"run_check\"} ..."            <- 工具调用被写成了纯文本
[015] run_completed    complete                                                 <- 却报成功
```

最终文件 `hello tinycode.`，`node check.mjs` 退出码 1 —— **任务失败了，run 却说成功，进程退出码 0**。

### 事实 9：这暴露了 finalVerdict 的真实缺陷（已修复）

旧规则只要求「至少一条 observation」。这次有两条（read、write），于是判 `complete`。
**但写入成功只证明 I/O 通了，不证明任务完成了。**

新规则（`src/core/loop.ts`）：

1. `complete` 要求至少一条 observation（上一轮加的）
2. **改过文件时，必须有「最后一次写入之后」的通过检查**，否则 `partial` +
   `missingMaterial: ["check:required_after_change"]`
3. **写入会作废先前的检查**（`check = null`）：在最后一次写入之前跑的 check
   对当前文件内容一无所知

对应两个回归测试：`a write with no following check is partial, not complete (live finding)` /
`a check that ran before the last write does not count as evidence`。

### 事实 10：skill 记录的「prompt 敏感」真实存在，表现形式是「工具调用写成正文」

模型没走原生 `tool_calls` 字段，而是把 JSON 混在正文里输出。
适配器如实把它解码成 `Decision.respond` —— **适配器没错，错的是「这就够了」的判断**。
修复方向不是去正文里猜 JSON（脆且危险），而是**要求证据**：没跑 check 就不许说完成。

### 结论：本地 7B 能用但不可靠

| 模型 | 工具调用 | 结果 |
|---|---|---|
| `deepseek/deepseek-v4-flash`（云端） | 读→改→自检，内容正确 | `complete`，check 通过 |
| `qwen2.5:7b`（本地，零凭证） | 读了、写了，但内容错、跳过自检 | `partial`（修复后），check 失败 |

零凭证本地链路适合**验证管道**（传输/解码/usage/预算/取消），
不适合当作**任务正确性**的证据。这个区分现在有真机数据支撑。

---

## 2026-10-23 | 402 与能力错误的端到端验证 | 本地 mock + 真 ollama

此前这两个错误码只有**正则单测**，从未被真实 HTTP 响应触发过。本轮补上。

### 事实 11：402 计费失败被正确类型化，且不重试

mock 端点返回 OpenAI 形状的 `{error:{message:"Insufficient Balance"}}` + HTTP 402：

```
SDK 抛出 message: 402: {"message":"Insufficient Balance","type":"invalid_request_error","code":"402"}
适配器映射: provider_unavailable, retryable=false
Runtime:      run_failed, 只发出 1 次模型请求（未重试），usage_reported 仍发出，日志落盘 failed
```

### 事实 12：能力错误在真 ollama 上映射正确

```
--model deepseek-r1:7b（不支持 tools）
[004] run_failed  model_capability: 400: {"message":"...does not support tools",
                  "type":"invalid_request_error","param":null,"code":null}
```

**这是实测，不是推理** —— 我一开始的推测是「真 ollama 也可能丢 body」，实测推翻了它。

### 事实 13（SDK 行为，已知局限）：扁平错误体会被丢弃

对照实验（同一 mock 端点，只改响应体形状）：

| 响应体形状 | SDK 抛出的 message | 映射结果 |
|---|---|---|
| `{error:{message:...}}`（OpenAI 形状） | `400: {...完整 body...}` | 正确 |
| `{message, type}`（扁平形状） | `400 status code (no body)` | 退化为 `provider_unavailable` |

**根因**：SDK 只在 body 能被 `error.message` 解包时才把它拼进错误消息。
**影响**：适配器只能看到消息文本，因此扁平体的能力错误无法被识别。
**处置**：deepseek 与 ollama 都不返回该形状，故**不改架构**（不为一个不存在的情况加 body 捕获复杂度）。
该退化行为已用一个 pinned 测试记录（`documented limitation: a flat error body loses its detail...`），
这样将来 SDK 若修好，测试会失败并提醒我们更新认知 —— 而不是悄悄变好却没人知道。

---

## 2026-10-23 | 流式验证 | 真机 token 到达时间戳

### 事实 14：流式是真的分散到达，不是攒完再吐

给 CLI 的每个 stdout chunk 打时间戳（`qwen2.5:7b`，本地，`--tools none`）：

```
+340ms   [001] run_started
+346ms   [002] model_requested
+5349ms  "Streaming"        <- 第一个 token
+5394ms  " allows"
+5437ms  " real"
  ... 每 ~40ms 一个 token，共 54 个 chunk ...
+7334ms  " "
+7335ms  [052] decision_made   <- 决策在所有 token 之后
```

**判据**：如果流式是假的（deltas 攒完再 flush），54 个 token 会全部挤在 `+7335ms` 那一瞬间。
实际是分散在 2 秒里陆续到达，而 `decision_made` 落在最后 —— 这才是真流式。

这条行为由 `test/streaming.test.ts` 钉住：断言第一个 `text_delta` 的**下标小于** `decision_made`。
只断言「存在 delta 事件」是不够的 —— 批量 flush 同样会「有」delta。

### 事实 15：SSE 端点用同一份事件协议跑通

```bash
node src/cli.ts serve --port 8791 --workspace ./sandbox --check "node check.mjs" \
     --endpoint http://127.0.0.1:11434/v1 --model qwen2.5:7b
curl -N "http://127.0.0.1:8791/run?request=..."
```

抓到的帧（节选）：

```
{"type":"tool_use_start","displayLevel":"detail","payload":{"toolName":"write_file",...}}
{"type":"text_delta","displayLevel":"primary","payload":{"delta":" successfully"}}
{"type":"end","displayLevel":"terminal","payload":{"status":"complete","missingMaterial":[]}}
```

同一条任务、同一个 qwen2.5:7b，这一次**做对了**（文件是 `hello tinycode`，无尾标点，check 通过）——
因为 prompt 里明确写了「no trailing punctuation. Run the check after writing.」。
**这印证了事实 9/10：小模型的方差来自 prompt 具体度，不是能力缺失。**

---

## 仍未被真机验证的部分

| 缺口 | 原因 | 怎么闭合 |
|---|---|---|
| ~~402 余额不足的类型化失败~~ | **已闭合**（事实 11，mock 端点端到端验证） | — |
| ~~流式 `text_delta`~~ | **已闭合**（事实 14/15，真机时间戳 + SSE 端到端） | — |
| 多轮长任务的上下文压缩 | 本次任务只有 4 轮 | 需要一个需要 compaction 的长任务 |

**`--tools none` 文字通道**（事实 3）依然保留：它用于隔离「传输/解码/usage」与「工具调用」，
在没有 tool-capable 模型的环境里仍是唯一的 usage 验证手段。
