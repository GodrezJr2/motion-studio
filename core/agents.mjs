// Headless coding agents the studio can hand work to: the builder of `ms make` and the critic. Each adapter turns one
// request (prompt on stdin, a role, model/effort, a session to resume, images to attach) into that CLI's flags and
// reads its event stream back into { text, session }, with tool calls reported as progress lines.
// Pick one with MOTION.md `builder.agent` / `critic.agent`, `--agent` / `--critic-agent`, or MS_AGENT.
import { spawn } from "node:child_process";
import path from "node:path";

// what the builder may do: edit files, run the studio's own CLI. The critic only reads.
const BUILD_TOOLS = "Read,Write,Edit,Glob,Grep,Bash(node bin/ms.mjs:*)";
const CRITIC_TOOLS = "Read,Bash(ffmpeg:*)";

const short = f => path.basename(String(f || ""));
const cmd = c => "$ " + String(c || "").replace(/^node bin\/ms\.mjs /, "ms ").slice(0, 90);

export const AGENTS = {
  claude: {
    bin: "claude",
    args: ({ role, model, effort, session }) => ["-p", "--output-format", "stream-json", "--verbose",
      "--allowedTools", role === "critic" ? CRITIC_TOOLS : BUILD_TOOLS,
      ...(role === "critic" ? [] : ["--permission-mode", "acceptEdits"]),
      ...(model ? ["--model", model] : []), ...(effort ? ["--effort", effort] : []),
      ...(session ? ["--resume", session] : [])],
    event(ev, r, onEvent) {
      if (ev.session_id) r.session = ev.session_id;
      if (ev.type === "result") r.text = ev.result || r.text;
      if (ev.type === "assistant") for (const c of ev.message?.content || []) {
        if (c.type !== "tool_use") continue;
        const i = c.input || {};
        onEvent(c.name === "Bash" ? cmd(i.command) : c.name === "Read" ? "look " + short(i.file_path)
          : /^(Write|Edit)$/.test(c.name) ? "edit " + short(i.file_path) : c.name);
      }
    },
  },
  // OpenAI Codex CLI: `codex exec`, prompt from stdin ("-"), JSONL events; a critic runs in a read-only sandbox
  codex: {
    bin: "codex",
    args: ({ role, model, effort, session, images }) => ["exec", ...(session ? ["resume", session] : []),
      "--json", "--skip-git-repo-check",
      ...(role === "critic" ? ["--sandbox", "read-only"] : ["--full-auto"]),
      ...(model ? ["-m", model] : []), ...(effort ? ["-c", `model_reasoning_effort=${effort}`] : []),
      ...images.flatMap(f => ["-i", f]), "-"],
    event(ev, r, onEvent) {
      if (ev.type === "thread.started") r.session = ev.thread_id;
      const it = ev.item || {};
      if (ev.type === "item.completed" && it.type === "agent_message") r.text = it.text || r.text;
      if (ev.type === "item.started" && it.type === "command_execution") onEvent(cmd(it.command));
      if (ev.type === "item.completed" && it.type === "file_change") onEvent("edit " + (it.changes || []).map(c => short(c.path)).join(", "));
      if (ev.type === "error" || ev.type === "turn.failed") r.error = ev.message || ev.error?.message;
    },
  },
  // Google Gemini CLI: prompt from stdin, one JSON object at the end (no tool stream in this mode)
  gemini: {
    bin: "gemini",
    args: ({ role, model, session }) => ["-p", "", "--output-format", "json",
      "--approval-mode", role === "critic" ? "default" : "yolo",
      ...(model ? ["-m", model] : []), ...(session ? ["--resume", session] : [])],
    json: true,
    event(ev, r) {
      r.text = ev.response || r.text;
      if (ev.session_id) r.session = ev.session_id;
      if (ev.error) r.error = ev.error.message || String(ev.error);
    },
  },
  // OpenCode: `opencode run`, prompt from stdin, JSONL events; images go in as attached files
  opencode: {
    bin: "opencode",
    args: ({ model, session, images }) => ["run", "--format", "json", "--auto",
      ...(model ? ["-m", model] : []), ...(session ? ["-s", session] : []), ...images.flatMap(f => ["-f", f])],
    event(ev, r, onEvent) {
      if (ev.sessionID) r.session = ev.sessionID;
      const p = ev.part || {};
      if (ev.type === "text" && p.text) r.text += p.text;
      if (ev.type === "step_start") r.text = ""; // keep the last step's answer, not the narration before tool calls
      if (ev.type === "tool_use") {
        const i = p.state?.input || {};
        onEvent(p.tool === "bash" ? cmd(i.command) : /^(edit|write)$/.test(p.tool) ? "edit " + short(i.filePath) : p.tool === "read" ? "look " + short(i.filePath) : p.tool);
      }
      if (ev.type === "error") r.error = ev.error?.message || "error";
    },
  },
};

export const agentNames = Object.keys(AGENTS);

// model/effort in MOTION.md belong to the agent named there: "opus" means nothing to codex, so another agent runs on
// its own default unless --model says otherwise
export function pick(cfg = {}, { agent, model, effort } = {}, fallback = "claude") {
  const name = agent || process.env.MS_AGENT || cfg.agent || fallback;
  if (!AGENTS[name]) throw new Error(`unknown agent "${name}" (one of: ${agentNames.join(", ")})`);
  const own = (cfg.agent || fallback) === name;
  return { name, model: model || (own ? cfg.model : undefined), effort: effort || (own ? cfg.effort : undefined) };
}

// run(agent, prompt, { role, model, effort, session, images, cwd, onEvent }) -> { text, session }
export function run(name, prompt, { role = "build", model, effort, session, images = [], cwd, onEvent = () => {} } = {}) {
  const a = AGENTS[name];
  if (!a) throw new Error(`unknown agent "${name}"`);
  const win = process.platform === "win32";
  // shell on Windows (most of these are .cmd shims): quote every arg, they hold spaces, commas and parens
  const argv = a.args({ role, model, effort, session, images }).map(x => win ? `"${String(x).replace(/"/g, '\\"')}"` : x);
  return new Promise((resolve, reject) => {
    const p = spawn(a.bin, argv, { cwd, shell: win, stdio: ["pipe", "pipe", "pipe"] });
    const r = { text: "", session: session || null, error: null };
    let buf = "", all = "", err = "";
    const line = l => {
      l = l.trim();
      if (!l) return;
      try { a.event(JSON.parse(l), r, onEvent); } catch { /* not an event line */ }
    };
    p.stdout.on("data", d => {
      all += d;
      if (a.json) return;
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    p.stderr.on("data", d => { err += d; });
    p.on("error", e => reject(e.code === "ENOENT" ? new Error(`${a.bin} is not installed or not on PATH`) : e));
    p.on("close", code => {
      if (a.json) line(all.slice(all.indexOf("{")));
      else line(buf);
      if (code === 0 && r.text && !r.error) return resolve({ text: r.text, session: r.session });
      reject(new Error(`${a.bin} exited ${code}: ${(r.error || err || all).trim().slice(0, 400)}`));
    });
    p.stdin.end(prompt);
  });
}
