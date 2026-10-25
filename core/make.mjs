// `ms make "<prompt>"`: one request to a finished piece, headless. scaffold -> refs -> builder (a coding agent from
// agents.mjs, claude by default: writes the scene, lints and looks at its own sheet) -> critic loop (a different,
// cheap model judges; the builder fixes what is real, resumed in the same session) -> sound + render. Progress goes
// to scenes/<id>/.ms/make.json so the studio's Projects page can show it while it runs.
import fs from "node:fs";
import path from "node:path";
import { run, pick } from "./agents.mjs";
import { newScene } from "./scaffold.mjs";
import { pull } from "./shelf.mjs";
import { packet, runCritic, parseVerdict, record, readReview } from "./critic.mjs";
import { render } from "./render.mjs";
import { analyze, sceneDir, outDir } from "./session.mjs";
import { tokensFor } from "./tokens.mjs";
import { ROOT } from "./server.mjs";

const FORMATS = [
  [/\b(reels?|tiktok|stor(y|ies)|shorts|vertical|9:16|portrait)\b/i, "9:16"],
  [/\b(4:5|feed post|instagram post)\b/i, "4:5"],
  [/\b(square|1:1)\b/i, "1:1"],
  [/\b(landing|hero section|website|web page|web hero)\b/i, "web"],
];
const STOP = new Set("a an the for of to and with in on my our your make bikin buat iklan ad ads video promo please".split(" "));

export function guessFormat(prompt) {
  return (FORMATS.find(([re]) => re.test(prompt)) || [, "16:9"])[1];
}

export function slugFor(prompt) {
  const words = prompt.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter(w => w && !STOP.has(w));
  const base = words.slice(0, 4).join("-").slice(0, 40).replace(/-+$/, "") || "piece";
  let id = base;
  for (let n = 2; fs.existsSync(path.join(ROOT, "scenes", id)); n++) id = `${base}-${n}`;
  return id;
}

export function readMake(id) {
  try { return JSON.parse(fs.readFileSync(path.join(outDir(id), "make.json"), "utf8")); } catch { return null; }
}

function buildPrompt(id, prompt, s, refs) {
  return `You are the builder in Motion Studio. The working directory is the studio repo. Make scene "${id}" from
Jay's request below, as a finished piece a professional studio would ship.

Jay's request: ${prompt}

Read first: AGENTS.md (how the studio and its tools work), MOTION.md (the taste law: eases, limits, banned list),
then scenes/${id}/index.html, scene.js and brief.md: a skeleton at ${s.width}x${s.height}, kind ${s.kind}, with a
.safe box for platform UI.${refs ? ` References that set the bar are in scenes/${id}/.ms/refs/refs.md: Read their
images for the level of detail and finish, do not copy layouts.` : ""}

Do:
1. Fill scenes/${id}/brief.md: kind, audience, feel, the one idea, assets. Use only facts the request gives: never
   invent logos, metrics, prices, testimonials or customer names. Product copy comes from the request.
2. Write index.html and scene.js: one GSAP timeline, data-ms names on what matters, ms.* eases, type and product in
   the safe area, a layout made for this format. Fonts must not swap mid-piece (local or display=block).
3. Sound: audio.sfx cues on the few moments that carry weight, with earshot kit roles (tick, pop, whoosh.short,
   land, click, hit, bell, ...), aligned to tween ids. Not on every move.
4. Check with your own eyes: \`node bin/ms.mjs lint ${id} --no-perf\` until it has no errors and the warnings are
   dealt with, \`node bin/ms.mjs sheet ${id}\` and Read the PNG, \`node bin/ms.mjs frame ${id} <t> --scale 1\` for key
   moments. Fix what looks wrong. Two or three passes, then stop.

Only create or change files inside scenes/${id}/. Do not invoke skills: AGENTS.md and MOTION.md hold all you need. Do not render, do not run the critic. End with three short lines:
the idea, what moves, what you are least sure about.`;
}

function fixPrompt(id, round) {
  const open = readReview(id).rounds.flatMap(r => r.issues).filter(i => i.status === "open" && i.severity !== "minor");
  const minors = round.issues.filter(i => i.severity === "minor");
  return `An independent critic judged scene "${id}" (round ${round.round}): ${round.verdict}. Scores: ${
    Object.entries(round.scores).map(([a, s]) => `${a} ${s}`).join(", ")}.
${round.best ? `Keep: ${round.best}\n` : ""}
Items to address:
${[...open, ...minors].map(i => `- [${i.id}] ${i.severity} at ${i.t}s, ${i.region}: ${i.problem}\n  suggested fix: ${i.fix}`).join("\n")}

Fix what is real. If an item is a misread (it judged web UI as film chrome, or real product UI as decoration), add
one line to brief.md that sets it straight instead. Then lint and look at the sheet again. Same rules: only files
in scenes/${id}/, no render, no critic. End with one line per item: fixed / pushed back / left, and why.`;
}

// width/height/kind of an existing scene, read from its MS.register call (for a resumed run)
function readSize(id) {
  const js = fs.readFileSync(path.join(sceneDir(id), "scene.js"), "utf8");
  const g = k => (js.match(new RegExp(k + "\\s*:\\s*\"?(\\w+)")) || [])[1];
  return { width: +g("width") || 1920, height: +g("height") || 1080, kind: g("kind") || "ad" };
}

// resume: pick a stopped run (session limit, crash) up where make.json says it stopped, without rebuilding
export async function make(prompt, { id, format, kind, rounds, render: doRender = true, model, agent, criticAgent, resume = false, onLog = () => {} } = {}) {
  const prev = resume ? readMake(id) : null;
  if (resume && !prev) throw new Error(`no make run to resume for "${id}"`);
  prompt = prompt || prev.prompt;
  format = format || (prev && prev.format) || guessFormat(prompt);
  id = id || slugFor(prompt);
  const title = prompt.replace(/\s+/g, " ").trim().slice(0, 60);
  const s = prev ? readSize(id) : newScene(id, { format, kind, title });
  const stopped = prev ? prev.stage : null;
  const built0 = !!prev && (prev.built || /^(critic|fix|lint|render|done)/.test(stopped));
  const status = prev ? { ...prev, error: undefined, done: undefined }
    : { prompt, format, stage: "scaffold", started: new Date().toISOString(), log: [], verdict: null };
  const save = () => fs.writeFileSync(path.join(outDir(id), "make.json"), JSON.stringify(status, null, 1));
  const log = line => {
    status.log.push(line);
    status.log = status.log.slice(-60);
    save();
    onLog(`[${status.stage}] ${line}`);
  };
  const stage = name => { status.stage = name; log(name === "done" ? "finished" : `-> ${name}`); };
  log(prev ? `resume from ${stopped}` : `${id}: ${s.width}x${s.height} ${s.kind} (${format})`);

  const b = pick(tokensFor(id).builder || {}, { agent, model });
  // a session id only means something to the agent that made it
  if (status.agent && status.agent !== b.name) status.session = null;
  status.agent = b.name;
  const builder = (input, session) => run(b.name, input, { role: "build", model: b.model, effort: b.effort, session, cwd: ROOT, onEvent: log });
  // fixes continue the builder's session when there is one (it remembers why it built what it built)
  const fix = async (n, round) => {
    stage(`fix ${n}`);
    const fixed = await builder(fixPrompt(id, round), status.session);
    if (fixed.session) status.session = fixed.session;
    log(fixed.text.trim().split("\n").slice(-4).join(" / "));
  };

  try {
    if (!built0) {
      stage("refs");
      let refs = false;
      try {
        const r = await pull(id, prompt, { k: 4 });
        refs = r.refs + r.repos + r.skills > 0;
        log(`${r.refs} refs (${r.images} images), ${r.repos} repos, ${r.skills} skills`);
      } catch (e) { log(`no references: ${e.message}`); }

      stage("build");
      log(`builder: ${b.name} ${b.model || "default"}`);
      const built = await builder(buildPrompt(id, prompt, s, refs));
      Object.assign(status, { built: true, session: built.session });
      log(built.text.trim().split("\n").slice(-3).join(" / "));
    }

    rounds = rounds ?? Math.min(2, (tokensFor(id).critic || {}).rounds || 2);
    let judged = prev ? readReview(id).rounds.length : 0;
    const midFix = /^fix /.test(stopped || "");
    // stopped mid-fix: redo that fix against the last round, then it still gets judged once more
    if (midFix) { await fix(judged, readReview(id).rounds.at(-1)); rounds = Math.max(rounds, judged + 1); }
    if (!/^(lint|render|done)/.test(stopped || "")) for (let n = judged + 1; n <= rounds; n++) {
      stage(`critic ${n}`);
      const { promptFile, images } = await packet(id);
      const { text, by } = await runCritic(promptFile, { id, agent: criticAgent, images });
      fs.writeFileSync(promptFile.replace(/prompt\.md$/, "answer.md"), text);
      const round = record(id, parseVerdict(text), { by: `${by} (make)`, text });
      status.verdict = round.verdict;
      log(`${round.verdict}  ${Object.entries(round.scores).map(([a, v]) => `${a} ${v}`).join(" ")}  ${round.issues.length} items`);
      if (round.verdict === "SHIP" || n === rounds) break;
      await fix(n, round);
    }

    stage("lint");
    const { report } = await analyze(id, { perf: false });
    log(`lint ${report.score}/100, ${report.issues.filter(i => i.severity === "error").length} errors`);

    let video = null;
    if (doRender) {
      stage("render");
      const r = await render(id, { audio: true });
      video = r.file;
      log(`${path.basename(r.file)} ${r.frames} frames${r.audio ? `, sound ${r.audio.lufs} LUFS` : ""}`);
    }
    stage("done");
    status.done = new Date().toISOString();
    save();
    return { id, verdict: status.verdict || "unjudged", video, dir: sceneDir(id) };
  } catch (e) {
    status.error = String(e.message || e);
    log("failed: " + status.error);
    throw e;
  }
}
