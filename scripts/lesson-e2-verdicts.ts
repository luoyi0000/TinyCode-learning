// 教学脚本：把 finalVerdict 的四种情况真跑一遍。
// 运行：node scripts/lesson-e2-verdicts.ts

import { applyToolStep, finalVerdict } from "../src/core/loop.ts";
import { initialState, type AgentState, type CheckOutcome, type Observation, type Task } from "../src/core/types.ts";

const task: Task = { id: "lesson", request: "make greeting.txt say hello", workspace: ".", checkCommand: "node check.mjs" };

let n = 0;
function obs(name: string, ok: boolean, data: unknown = null): Observation {
  return { toolCallId: "c" + ++n, name, ok, summary: name + (ok ? " ok" : " FAILED"), data, observedAt: Date.now() };
}

function check(passed: boolean): CheckOutcome {
  return { command: "node check.mjs", passed, output: passed ? "PASS" : "FAIL" };
}

// 助手：模拟一次工具调用后的状态
function step(state: AgentState, name: string, ok: boolean, data: unknown = null): AgentState {
  const decision = { kind: "call_tool" as const, toolCallId: "c" + (n + 1), intent: { name, arguments: { path: "greeting.txt" } } };
  return applyToolStep(state, decision, obs(name, ok, data));
}

function show(label: string, state: AgentState) {
  const v = finalVerdict(state);
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
  console.log("");
  console.log("【" + label + "】");
  console.log("  observations = " + state.observations.length +
              " | filesChanged = " + state.filesChanged.length +
              " | check = " + (state.check === null ? "null（没跑/已作废）" : (state.check.passed ? "passed" : "failed")));
  console.log("  → status = " + v.status + (v.missingMaterial.length ? "   missing = " + JSON.stringify(v.missingMaterial) : ""));
}

// a) 什么都没做，直接回答
show("a · 回答得很好，但一个工具都没调", initialState(task));

// b) 读 → 写 → 自检通过
let s = step(initialState(task), "read_file", true, "old");
s = step(s, "write_file", true);
s = step(s, "run_check", true, check(true));
show("b · 读了、写了、写完自检通过", s);

// c) 写 → 自检通过 → 又写（自检被作废）
let c = step(initialState(task), "write_file", true);
c = step(c, "run_check", true, check(true));
c = step(c, "write_file", true);
show("c · 自检在改之前通过过（陈旧证据）", c);

// d) 自检失败 → 改 → 自检通过
let d = step(initialState(task), "run_check", true, check(false));
d = step(d, "write_file", true);
d = step(d, "run_check", true, check(true));
show("d · 失败过一次，改完再跑通过了", d);

console.log("");
console.log("对照你的答案：a=partial  b=complete  c=partial  d=complete");
