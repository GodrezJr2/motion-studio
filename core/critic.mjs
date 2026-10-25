// The critic loop: the builder never judges its own work. `packet` renders what a fresh critic needs (contact sheet,
// key frames, brief, MOTION.md, lint, the open items of the last round) and writes the prompt; `runCritic` hands it
// to a headless Claude (`claude -p`, Jay's own login) with read-only tools; `record` appends the verdict to the
// ledger in .ms/review.json. The verdict is recomputed from the scores, so nobody can certify a piece by saying so.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { sheet } from "./sheet.mjs";
import { withScene, outDir, sceneDir, stills } from "./session.mjs";
import { tokensFor, motionProse } from "./tokens.mjs";
import { readPulled } from "./shelf.mjs";

const reviewFile = id => path.join(outDir(id), "review.json");
export function readReview(id) {
  try { return JSON.parse(fs.readFileSync(reviewFile(id), "utf8")); } catch { return { rounds: [] }; }
}

// Moments worth a full look: where groups of tweens come to rest, at least 0.5 s apart, plus the last frame
function keyTimes(tweens, duration, max = 6) {
  const ends = [...new Set(tweens.filter(t => t.duration > 0 && t.targets.length).map(t => +(t.start + t.duration).toFixed(2)))].sort((a, b) => a - b);
  const picked = [];
  for (const t of ends) if (t < duration - 0.05 && (!picked.length || t - picked[picked.length - 1] >= 0.5)) picked.push(t);
  while (picked.length > max - 1) picked.splice(Math.floor(picked.length / 2), 1);
  return [...picked, +duration.toFixed(2)];
}

export async function packet(id, { brief } = {}) {
  const dir = path.join(outDir(id), "critic");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const { file: sheetFile, report } = await sheet(id, { frames: 12, perf: false });
  const times = keyTimes(report.tweens, report.info.duration);
  const frames = await withScene(id, async ({ page }) => {
    const shots = await stills(page, times);
    return shots.map((buf, i) => {
      const f = path.join(dir, `frame-${times[i].toFixed(2)}.png`);
      fs.writeFileSync(f, buf);
      return f;
    });
  }, { scale: 1 }); // full size: at half scale the critic misjudges type size and sees downscale aliasing as broken glyphs

  const tokens = tokensFor(id);
  const briefFile = path.join(sceneDir(id), "brief.md");
  brief = brief || (fs.existsSync(briefFile) ? fs.readFileSync(briefFile, "utf8").trim() : "(no brief.md: judge it as a motion piece on its own terms)");
  // Only a render newer than the scene's source, or the critic judges an old cut
  const video = path.join(outDir(id), `${id}.mp4`);
  const srcTime = Math.max(...fs.readdirSync(sceneDir(id)).filter(f => f !== ".ms" && f !== "notes.json")
    .map(f => fs.statSync(path.join(sceneDir(id), f)).mtimeMs));
  const fresh = fs.existsSync(video) && fs.statSync(video).mtimeMs > srcTime;
  const review = readReview(id);
  const open = review.rounds.flatMap(r => r.issues).filter(i => i.status === "open");
  const lintLine = `score ${report.score}/100; ` + (report.issues.length
    ? report.issues.map(i => `${i.severity} ${i.rule} ${i.element} ${i.t0}s: ${i.message}`).join("; ") : "no issues");
  const refs = readPulled(id).trim(); // `ms refs <id> --pull`: the bar the piece is measured against
  const axes = (tokens.critic && tokens.critic.axes) || ["idea", "motion", "type", "layout", "finish"];
  const ship = (tokens.critic && tokens.critic.ship) || 8;

  const prompt = `You are an independent, harsh motion-design critic. You did NOT build this piece; judge only the rendered
pixels you can see, not the intentions in any code. Do not edit files.

Piece: scene "${id}", ${report.info.width}x${report.info.height}, ${report.info.duration}s at ${report.info.fps} fps${report.info.kind ? `, kind ${report.info.kind}` : ""}.

Brief:
${brief}

Look at these with the Read tool (they are images). The frames are 1:1 with the stage, so judge type size and
sharpness from them; the contact sheet stills are thumbnails, judge only timing and rhythm from those:
- Contact sheet (stills across time, velocity/opacity/scale curves, lint issue bands): ${sheetFile}
${frames.map((f, i) => `- Frame at ${times[i]}s: ${f}`).join("\n")}
${fresh ? `- The render is at ${video} (you may extract frames with ffmpeg if you need a moment the stills miss)\n` : ""}
${/^(film|ad)$/.test(report.info.kind || "") ? "This is a film/ad: the beat, hook and ending rules apply in full." : "This is a web piece (it plays on a page, then rests and stays usable): judge its motion, type and layout as web UI; the film rules on hooks, end holds and endings do not apply."}

${refs ? `References that set the bar (look at their images; judge whether the piece reaches that level of detail
and finish, not whether it copies them):
${refs.replace(/^# .*\n+/, "")}

` : ""}Measured by the motion lint (curves, not taste): ${lintLine}

The studio's taste (MOTION.md), which the piece must follow:
${motionProse(id).replace(/^# MOTION\.md\s*/, "")}

Never ship, whatever else is good:
${(tokens.banned || []).map(b => `- ${b}`).join("\n")}
${open.length ? `
The previous critic round left these items. For each, say FIXED, PARTLY or STILL in "verified":
${open.map(i => `- ${i.id}: ${i.problem} (at ${i.t}s, ${i.region})`).join("\n")}
` : ""}
Score each axis 1-10 (${axes.join(", ")}). ${ship} means a professional studio would ship it. Then list the defects,
most severe first, each with the time, the screen region, and a fix concrete enough to implement in a GSAP timeline.
"blocker" is for anything on the never-ship list, invented content, broken frames or unreadable text.

Answer with a short paragraph of judgement, then exactly one fenced json block:
\`\`\`json
{"scores": {${axes.map(a => `"${a}": 0`).join(", ")}},
 "issues": [{"severity": "blocker|major|minor", "t": 0.0, "region": "where on screen", "problem": "...", "fix": "..."}],
 "verified": [{"id": "r1-1", "status": "FIXED|PARTLY|STILL"}],
 "best": "the one thing to keep"}
\`\`\`
`;
  const promptFile = path.join(dir, "prompt.md");
  fs.writeFileSync(promptFile, prompt);
  return { promptFile, sheetFile, frames, report };
}

export function parseVerdict(text) {
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  if (!blocks.length) throw new Error("critic answer has no ```json block");
  return JSON.parse(blocks[blocks.length - 1][1]);
}

// The judge runs on MOTION.md critic.model / critic.effort (cheap and fast by default); --model overrides
export function runCritic(promptFile, { model, effort, id } = {}) {
  const c = (id && tokensFor(id).critic) || {};
  model = model || c.model;
  effort = effort || c.effort;
  const args = ["-p", "--allowedTools", "Read,Bash(ffmpeg:*)", "--output-format", "text"];
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  return new Promise((resolve, reject) => {
    // shell: claude is a .cmd shim on Windows
    const p = spawn("claude", args, { shell: process.platform === "win32", stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", d => { out += d; });
    p.stderr.on("data", d => { err += d; });
    p.on("error", reject);
    p.on("close", code => code === 0 ? resolve(out) : reject(new Error(`claude exited ${code}: ${err.trim() || out.trim()}`)));
    p.stdin.end(fs.readFileSync(promptFile, "utf8"));
  });
}

// Append one critic round. Recomputes the verdict and carries the verification onto earlier issues.
export function record(id, verdict, { by = "critic", text = "" } = {}) {
  const tokens = tokensFor(id);
  const ship = (tokens.critic && tokens.critic.ship) || 8;
  const review = readReview(id);
  const n = review.rounds.length + 1;
  const scores = verdict.scores || {};
  const issues = (verdict.issues || []).map((i, k) => ({ id: `r${n}-${k + 1}`, severity: i.severity || "minor", t: +i.t || 0,
    region: i.region || "", problem: i.problem || "", fix: i.fix || "", status: "open" }));
  for (const v of verdict.verified || []) {
    for (const r of review.rounds) for (const i of r.issues) if (i.id === v.id) i.status = v.status === "FIXED" ? "fixed" : "open";
  }
  const low = Object.entries(scores).filter(([, s]) => s < ship).map(([a]) => a);
  const blockers = issues.filter(i => i.severity === "blocker").length;
  const still = review.rounds.flatMap(r => r.issues).filter(i => i.status === "open" && i.severity !== "minor").length;
  const shipIt = Object.keys(scores).length > 0 && !low.length && !blockers && !still;
  const round = { round: n, at: new Date().toISOString(), by, verdict: shipIt ? "SHIP" : "REVISE", scores, low, blockers,
    issues, best: verdict.best || "", text: text.slice(0, 4000) };
  review.rounds.push(round);
  fs.writeFileSync(reviewFile(id), JSON.stringify(review, null, 2));
  return round;
}
