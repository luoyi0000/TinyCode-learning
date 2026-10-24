import { useCallback, useEffect, useReducer, useState } from "react";

import type { RunEventMessage } from "../../shared/ipc.ts";
import { initialUiState, reduce } from "./view-model.ts";

interface Form {
  request: string;
  workspace: string;
  check: string;
  endpoint: string;
  modelId: string;
}

const initialForm: Form = {
  request: "Make greeting.txt contain exactly: hello tinycode. Read it, fix it, then run the check.",
  workspace: "",
  check: "node check.mjs",
  endpoint: "http://127.0.0.1:11434/v1",
  modelId: "qwen2.5:7b",
};

export function App() {
  const [state, dispatch] = useReducer(reduce, initialUiState);
  const [form, setForm] = useState<Form>(initialForm);
  const [notice, setNotice] = useState<string | null>(null);

  // One subscription for the lifetime of the app. The preload returns its own
  // unsubscribe, which React uses as effect cleanup -- no listener leak on remount.
  useEffect(() => window.tinycode.onEvent((event: RunEventMessage) => dispatch(event)), []);

  const set = (key: keyof Form) => (event: { target: { value: string } }) => {
    setForm((previous) => ({ ...previous, [key]: event.target.value }));
  };

  const onRun = useCallback(async () => {
    setNotice(null);
    const result = await window.tinycode.run({
      request: form.request,
      workspace: form.workspace,
      checkCommand: form.check,
      endpoint: form.endpoint.trim() || undefined,
      modelId: form.modelId.trim() || undefined,
    });
    if (!result.ok) setNotice(result.message ?? "could not start the run");
  }, [form]);

  const onCancel = useCallback(async () => {
    const cancelled = await window.tinycode.cancel();
    if (!cancelled) setNotice("nothing to cancel");
  }, []);

  const running = state.phase === "running";

  return (
    <div className="shell">
      <header className="head">
        <h1>TinyCode</h1>
        <span className="sub">Core / Runtime 分离 · 证据驱动的完成判定</span>
      </header>

      <section className="form">
        <textarea
          className="request"
          value={form.request}
          onChange={set("request")}
          rows={3}
          spellCheck={false}
        />
        <div className="row">
          <label>
            workspace
            <input
              value={form.workspace}
              onChange={set("workspace")}
              placeholder="空 = 应用沙箱目录（不会碰项目源码）"
            />
          </label>
          <label>
            check
            <input value={form.check} onChange={set("check")} spellCheck={false} />
          </label>
          <label>
            endpoint
            <input value={form.endpoint} onChange={set("endpoint")} spellCheck={false} />
          </label>
          <label>
            model
            <input value={form.modelId} onChange={set("modelId")} spellCheck={false} />
          </label>
        </div>
        <div className="actions">
          <button className="primary" onClick={onRun} disabled={running}>
            {running ? "running…" : "Run"}
          </button>
          <button onClick={onCancel} disabled={!running}>
            Cancel
          </button>
          {notice ? <span className="notice">{notice}</span> : null}
        </div>
      </section>

      <main className="panes">
        <section className="pane">
          <h2>答案（primary）</h2>
          <pre className="body">{state.body || (running ? "…" : "")}</pre>
        </section>
        <section className="pane">
          <h2>轨迹（detail）</h2>
          <ol className="trace">
            {state.trace.map((item, index) => (
              <li key={index} className={"tone-" + item.tone}>
                <span className="seq">{String(item.sequence).padStart(3, "0")}</span>
                {item.text}
              </li>
            ))}
          </ol>
        </section>
      </main>

      <footer className={state.verdict ? "verdict " + (state.verdict.status === "complete" ? "ok" : "warn") : "verdict"}>
        {state.verdict ? (
          <>
            <strong>{state.verdict.status}</strong>
            {state.verdict.missing.length > 0 ? (
              <span className="missing">缺失: {state.verdict.missing.join(", ")}</span>
            ) : null}
          </>
) : (
          <span className="idle">尚未运行</span>
        )}
        <span className="cost">
          tools={state.toolCalls} in={state.tokens.input ?? "n/a"} out={state.tokens.output ?? "n/a"}
        </span>
      </footer>
    </div>
  );
}
