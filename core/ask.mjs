// `ms ask <scene> "<request>"`: hand one request about a scene to the builder agent (the same one `ms make` uses),
// from the studio's Agent tab or the shell. The open notes and the critic's open items ride along, so "fix the notes"
// is a complete request. The agent's session is kept in .ms/agent.json and resumed, so a follow-up ("softer") knows
// what the last turn did. Progress lines (the tools it calls) go to onLog; the answer is returned and logged.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run, pick } from "./agents.mjs";
import { tokensFor } from "./tokens.mjs";
import { outDir, sceneDir } from "./session.mjs";
import { readReview } from "./critic.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = id => path.join(outDir(id), "agent.json");

export function readAgent(id) {
  try { return JSON.parse(fs.readFileSync(file(id), "utf8")); } catch { return { session: null, turns: [] }; }
}
function writeAgent(id, a) {
  fs.mkdirSync(outDir(id), { recursive: true });
  fs.writeFileSync(file(id), JSON.stringify(a, null, 2));
}
function readNotes(id) {
  try { return JSON.parse(fs.readFileSync(path.join(sceneDir(id), "notes.json"), "utf8")); } catch { return []; }
}

// A stroke drawn with a note, in words an agent can act on: where it starts and ends, the box it covers, and
// whether it closes on itself (a circle around something) or runs open (an arrow along a path)
export function drawSummary(draw) {
  if (!draw || draw.length < 2) return "";
  const xs = draw.map(p => p[0]), ys = draw.map(p => p[1]);
  const [a, b] = [draw[0], draw.at(-1)];
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const closed = Math.hypot(a[0] - b[0], a[1] - b[1]) < Math.max(4, span * 0.25);
  const r = v => Math.round(v);
  return closed ? `drawn: a loop around x ${r(Math.min(...xs))}-${r(Math.max(...xs))}%, y ${r(Math.min(...ys))}-${r(Math.max(...ys))}%`
    : `drawn: a line from ${r(a[0])}%,${r(a[1])}% to ${r(b[0])}%,${r(b[1])}% (box x ${r(Math.min(...xs))}-${r(Math.max(...xs))}%, y ${r(Math.min(...ys))}-${r(Math.max(...ys))}%)`;
}

function prompt(id, request, first) {
  const notes = readNotes(id).filter(n => n.status === "open");
  const open = readReview(id).rounds.flatMap(r => r.issues).filter(i => i.status === "open");
  const ctx = [
    notes.length ? "Open notes from the user (time, point as % of the frame):\n" +
      notes.map(n => `- [${n.id}] at ${n.t.toFixed(2)}s, ${Math.round(n.x)}%,${Math.round(n.y)}%${n.draw ? " (" + drawSummary(n.draw) + ")" : ""}: ${n.text}`).join("\n") : "No open notes.",
    open.length ? "Open critic items:\n" + open.map(i => `- [${i.id}] ${i.severity} at ${i.t}s ${i.region}: ${i.problem} (fix: ${i.fix})`).join("\n") : "",
  ].filter(Boolean).join("\n\n");
  const intro = first ? `You are the builder in Motion Studio, working from the studio repo (the working directory). Read AGENTS.md
and MOTION.md before your first edit. The scene is "${id}" (scenes/${id}/: brief.md, scene.js, index.html).
Work the loop: edit, \`node bin/ms.mjs lint ${id} --no-perf\`, \`node bin/ms.mjs sheet ${id}\` and look at the PNG,
\`node bin/ms.mjs frame ${id} <t>\` for a moment. Retime with \`node bin/ms.mjs edit\` where it fits.
Answer each note you addressed with \`node bin/ms.mjs reply ${id} <note-id> "what changed" --resolve\`.
Never git add or commit anything.\n\n` : `Same scene ("${id}"). `;
  return `${intro}The user asks: ${request}

${ctx}

End with one to three plain sentences: what you changed and the lint result.`;
}

export async function ask(id, request, { agent, model, effort, fresh = false, onLog = () => {} } = {}) {
  if (!fs.existsSync(sceneDir(id))) throw new Error(`no scene ${id}`);
  const a = fresh ? { session: null, turns: readAgent(id).turns } : readAgent(id);
  const b = pick(tokensFor(id).builder || {}, { agent, model, effort });
  const turn = { at: new Date().toISOString(), by: `${b.name} ${b.model || "default"}`, request, log: [], text: "", status: "running" };
  a.turns.push(turn);
  writeAgent(id, a);
  onLog(`agent: ${turn.by}${a.session ? " (resumed)" : ""}`);
  try {
    const r = await run(b.name, prompt(id, request, !a.session), { role: "build", model: b.model, effort: b.effort, session: a.session || undefined,
      cwd: ROOT, onEvent: l => { turn.log.push(l); onLog(l); } });
    a.session = r.session || a.session;
    Object.assign(turn, { text: r.text.trim(), status: "done" });
    return turn;
  } catch (e) {
    Object.assign(turn, { text: String(e.message || e), status: "failed" });
    throw e;
  } finally {
    turn.log = turn.log.slice(-200);
    a.turns = a.turns.slice(-30);
    writeAgent(id, a);
  }
}
