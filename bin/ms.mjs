#!/usr/bin/env node
// ms: the AI's hands and eyes on a scene.
//
//   ms list                         scenes
//   ms new <id> [--format 16:9|9:16|1:1|4:5|web] [--kind ad|film|web] [--title "..."]   scene skeleton + brief.md
//   ms new <id> --template <name> [--fill content.json]   a scene from a saved template, its slots filled
//   ms template list | save <scene> <name> [--about "..."] | slots <scene|template>   reusable pieces (recipes/templates)
//   ms serve [--host H] [--port P]  studio UI with live reload
//   ms lint <scene> [--json]        sample curves + real playback, print issues (writes .ms/report.json)
//   ms sheet <scene> [--frames N]   contact sheet PNG: stills + velocity curves + issues (.ms/sheet.png)
//   ms frame <scene> <t> [--scale]  one still at time t (.ms/frame-<t>.png)
//   ms render <scene> [--fps 60] [--blur 8] [--shutter 180] [--no-audio] [--encoder auto|nvenc|qsv|amf|cpu] [--workers 4]   MP4 from the same timeline, with
//                                   the scene's sound (.ms/<scene>.mp4); GPU encoder first, libx264 as fallback
//   ms audio <scene>                cue sheet + mixed, loudness-normalised wav only (.ms/<scene>.wav)
//   ms vo <scene>                   synthesise the voice-over lines; print each line's span and word timings
//   ms tweens <scene>               the timeline as a table (#index, start, duration, ease, targets, source line)
//   ms edit <scene> <tween> [--dur 0.6] [--ease ms.out] [--at 1.2] [--shift 0.1] [--stagger 0.05] [--id name] [--dry]
//                                   rewrite one tween's call (tween = id, scene.js:12:4 or #index from ms tweens)
//   ms edit <scene> --after 2.0 --shift 0.3      move every tween starting at or after 2.0 s
//   ms import <composition.html|dir> [--id x]   bring a HyperFrames composition in as a scene
//   ms make --resume <id>   continue a stopped run
//   ms make "<prompt>" [--id x] [--format 9:16] [--rounds 2] [--no-render] [--model m] [--agent a] [--critic-agent a]
//                                   brief -> refs -> build -> lint -> critic loop -> sound + render, all headless
//                                   (agent: claude | codex | gemini | opencode; default MOTION.md builder.agent)
//   ms notes <scene> [--all]        pinned notes (open only unless --all)
//   ms reply <scene> <note> "text" [--resolve]
//   ms critic <scene> [--run] [--brief "..."]   packet for a fresh critic (.ms/critic/prompt.md); --run asks the critic agent
//                                   ([--agent a] [--model m] [--effort e])
//   ms critic <scene> --record <answer>          add a critic's answer (text with a ```json block) to the ledger
//   ms review <scene>                            the critic ledger: rounds, scores, open items
//   ms refs "<query>" [--type ref|repo|skill]    search the reference shelf (memory-core library)
//   ms refs <scene> --pull "<query>"             best refs (+ images) into .ms/refs/refs.md for builder and critic
//   ms capture <url> [--clip 6] [--note ""] [--scene s] [--no-push]   screenshot (+ scroll clip) a site to refs/,
//                                                saved back to the library (the inbox)
//   ms study <url|file> [--slug s] [--scene <id>]   a reference to learn from: download (yt-dlp), cuts, motion energy,
//                                                frames -> refs/study/<slug>/sheet.png + study.md; --scene starts a remake
//   ms compare <scene> [--study slug]            the scene's render vs its reference: match score (rhythm, cuts,
//                                                length), side-by-side .ms/compare.mp4 and .ms/compare.png
//   ms beat <song> [--scene id] [--from s] [--length s]   tempo, beats, downbeats, drops of a song; --scene copies it
//                                                to audio/ and writes beats.js (MS.beat / MS.bar / MS.snap)
//   ms playbook ["<words>"]                      every study's learnings -> refs/PLAYBOOK.md; with words, what matches
import fs from "node:fs";
import path from "node:path";
import { startServer, listScenes, readNotes, writeNotes } from "../core/server.mjs";
import { analyze, withScene, outDir } from "../core/session.mjs";
import { sheet } from "../core/sheet.mjs";
import { render } from "../core/render.mjs";
import { plan, mix } from "../core/audio.mjs";
import { newScene } from "../core/scaffold.mjs";
import { listTemplates, saveTemplate, fromTemplate, slotsOf, templatesDir } from "../core/template.mjs";
import { pull, capture, search } from "../core/shelf.mjs";
import { applyEdits } from "../core/edit.mjs";
import { make } from "../core/make.mjs";
import { importComposition } from "../core/importer.mjs";
import { packet, runCritic, parseVerdict, record, readReview } from "../core/critic.mjs";
import { tokensFor } from "../core/tokens.mjs";
import { pick } from "../core/agents.mjs";
import { study, compare } from "../core/study.mjs";
import { beat } from "../core/beat.mjs";
import { playbook, lookup } from "../core/playbook.mjs";

const str = v => typeof v === "string" ? v : undefined; // a bare --flag parses as true

const argv = process.argv.slice(2);
const flags = {};
const args = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const [k, v] = a.slice(2).split("=");
    flags[k] = v ?? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true);
  } else args.push(a);
}
const [cmd, scene, ...rest] = args;
const rel = f => path.relative(process.cwd(), f) || f;
const fmtT = t => t.toFixed(2).padStart(5) + "s";

function printReport(report) {
  const c = { error: 0, warn: 0, info: 0 };
  report.issues.forEach(i => c[i.severity]++);
  console.log(`${report.scene}  score ${report.score}/100  ${c.error} error, ${c.warn} warn, ${c.info} info  ` +
    `(${report.info.duration}s, ${report.tweens.length} tweens, ${report.elements.length} tracked)`);
  if (report.perf) console.log(`playback  p50 ${report.perf.p50}ms  p95 ${report.perf.p95}ms  dropped ${report.perf.droppedPct}%`);
  for (const e of report.errors) console.log(`PAGE ERROR  ${e}`);
  for (const i of report.issues) {
    console.log(`${i.severity.toUpperCase().padEnd(5)} ${fmtT(i.t0)}-${fmtT(i.t1).trim()}  ${i.rule.padEnd(13)} ${i.element}: ${i.message}`);
    console.log(`      fix: ${i.fix}`);
  }
}

function printRound(r, full = true) {
  const sc = Object.entries(r.scores).map(([a, s]) => `${a} ${s}`).join("  ");
  console.log(`round ${r.round}  ${r.verdict}  ${sc}  (${r.by}, ${r.at.slice(0, 16)})`);
  for (const i of r.issues) if (full || i.status === "open")
    console.log(`  [${i.id}] ${i.status.padEnd(5)} ${i.severity.padEnd(7)} ${i.t}s ${i.region}: ${i.problem}
          fix: ${i.fix}`);
  if (full && r.best) console.log(`  keep: ${r.best}`);
}

function printSlots(s) {
  console.log(`  text   ${s.text.map(n => `${n}=${JSON.stringify((s.content.text || {})[n] ?? "")}`).join("  ") || "-"}`);
  console.log(`  images ${s.images}   colors ${s.colors.map(c => `${c}=${s.content.colors[c]}`).join(" ") || "-"}`);
}

async function main() {
  switch (cmd) {
    case "list": {
      for (const s of listScenes()) console.log(`${s.id.padEnd(24)} ${s.title}  (${readNotes(s.id).filter(n => n.status === "open").length} open notes)`);
      break;
    }
    case "new": {
      if (typeof flags.template === "string") {
        const t = fromTemplate(need(scene), flags.template, { fill: typeof flags.fill === "string" ? flags.fill : undefined });
        console.log(`${rel(t.dir)}  from template ${flags.template}`);
        printSlots(t.slots);
        console.log("next: fill content.json (text, images, colors), then brief.md; the motion is already there");
        break;
      }
      const s = newScene(need(scene), { format: typeof flags.format === "string" ? flags.format : undefined, kind: flags.kind, title: flags.title });
      console.log(`${rel(s.dir)}  ${s.width}x${s.height} ${s.kind}  safe area ${s.safe.top}/${s.safe.right}/${s.safe.bottom}/${s.safe.left}`);
      console.log("next: fill brief.md, read MOTION.md, write scene.js");
      break;
    }
    case "template": {
      const sub = scene;
      if (sub === "list" || !sub) {
        const all = listTemplates();
        if (!all.length) console.log(`no templates in ${rel(templatesDir())} (ms template save <scene> <name>)`);
        for (const t of all) console.log(`${t.name.padEnd(24)} ${t.slots.text.length} text, ${t.slots.images} images, ${t.slots.colors.length} colors  from ${t.from || "?"}${t.about ? "  " + t.about : ""}`);
      } else if (sub === "save") {
        const [from, name] = rest;
        const t = saveTemplate(need(from), need(name), { about: typeof flags.about === "string" ? flags.about : undefined });
        console.log(`${rel(t.dir)}  saved from ${from}`);
        printSlots(t.slots);
      } else if (sub === "slots") {
        const id = need(rest[0]);
        const dir = fs.existsSync(path.join(templatesDir(), id)) ? path.join(templatesDir(), id) : path.join("scenes", id);
        printSlots(slotsOf(dir));
      } else throw new Error(`ms template ${sub}: list, save <scene> <name> or slots <name>`);
      break;
    }
    case "serve": {
      const { url } = await startServer({ host: flags.host || "127.0.0.1", port: +(flags.port || 4173), watch: true });
      console.log(`motion studio  ${url}`);
      break;
    }
    case "lint": {
      const { report } = await analyze(need(scene), { fps: +(flags.fps || 60), perf: !flags["no-perf"] });
      flags.json ? console.log(JSON.stringify(report, null, 2)) : printReport(report);
      process.exitCode = report.issues.some(i => i.severity === "error") ? 1 : 0;
      break;
    }
    case "sheet": {
      const { file, report } = await sheet(need(scene), { frames: +(flags.frames || 8), perf: !flags["no-perf"] });
      printReport(report);
      console.log(`sheet  ${rel(file)}`);
      break;
    }
    case "frame": {
      const t = +rest[0];
      if (Number.isNaN(t)) throw new Error("usage: ms frame <scene> <seconds>");
      const file = await withScene(need(scene), async ({ page }) => {
        await page.evaluate(x => MS.seek(x), t);
        const f = path.join(outDir(scene), `frame-${t.toFixed(2)}.png`);
        await page.screenshot({ path: f });
        return f;
      }, { scale: +(flags.scale || 0.5) });
      console.log(rel(file));
      break;
    }
    case "render": {
      let last = -1;
      const r = await render(need(scene), {
        fps: flags.fps && +flags.fps, scale: +(flags.scale || 1), out: flags.out, audio: !flags["no-audio"], encoder: flags.encoder, workers: flags.workers && +flags.workers,
        blur: flags.blur != null ? +flags.blur : undefined, shutter: flags.shutter && +flags.shutter,
        onProgress: (i, n) => { const p = Math.floor(i / n * 10); if (p !== last) { last = p; process.stdout.write(`\rrender ${i}/${n}`); } },
      });
      console.log(`\r${rel(r.file)}  ${r.frames} frames @ ${r.fps}fps  ${r.width}x${r.height}  ${r.encoder} x${r.workers}${r.blur ? `  motion blur ${r.blur.samples} @ ${r.blur.shutter}deg` : ""}`);
      if (r.audio) printAudio(r.audio);
      break;
    }
    case "audio": {
      const p = await withScene(need(scene), async ({ page, info }) => plan(scene, info, await page.evaluate(() => MS.tweens())));
      if (!p) { console.log("no audio in MS.register(tl, { audio: { music, sfx } })"); break; }
      printAudio({ ...(await mix(scene, p)), cues: p.cues, vo: p.vo, warnings: p.warnings });
      break;
    }
    case "vo": {
      const p = await withScene(need(scene), async ({ page, info }) => plan(scene, info, await page.evaluate(() => MS.tweens())));
      if (!p || !p.vo.length) { console.log("no voice-over in MS.register(tl, { audio: { vo: [{ t, text }] } })"); break; }
      for (const v of p.vo) {
        console.log(`${fmtT(v.event)} -> ${fmtT(v.until)}  ${v.provider}:${v.voice}  "${v.text}"`);
        console.log("        " + v.words.map(w => `${w.w}@${w.t.toFixed(2)}`).join(" "));
      }
      for (const w of p.warnings) console.log("  warn  " + w);
      break;
    }
    case "tweens": {
      const tw = await withScene(need(scene), ({ page }) => page.evaluate(() => MS.tweens()));
      tw.forEach((t, i) => console.log(`#${String(i).padEnd(3)}${fmtT(t.start)} +${t.duration.toFixed(2)}s  ${(t.id || "").padEnd(14)} ${t.ease.padEnd(14)} ${t.from ? "from " : ""}${t.props.join(",").padEnd(28)} ${t.targets.join(" ")}${t.repeat ? `  repeat ${t.repeat}` : ""}${t.src ? `  ${t.src}` : ""}`));
      break;
    }
    case "edit": {
      const op = { tween: rest[0], after: flags.after, dur: flags.dur, ease: flags.ease, at: flags.at, shift: flags.shift,
        stagger: flags.stagger, id: flags.id };
      for (const k of Object.keys(op)) if (op[k] === undefined || op[k] === true) delete op[k];
      if (!op.tween && op.after == null) throw new Error("usage: ms edit <scene> <tween> --dur/--ease/--at/--shift/--stagger/--id  (or --after T --shift S)");
      const tw = await withScene(need(scene), ({ page }) => page.evaluate(() => MS.tweens()));
      const changes = applyEdits(scene, tw, [op], { dry: !!flags.dry });
      if (!changes.length) console.log("no change");
      for (const c of changes) console.log(`${c.file}:${c.line}
  - ${c.before.trim()}
  + ${c.after.trim()}`);
      if (flags.dry) console.log("(dry run: nothing written)");
      break;
    }
    case "import": {
      const r = importComposition(need(scene), typeof flags.id === "string" ? flags.id : undefined);
      console.log(`imported  ${r.id}  ${rel(r.dir)}  (HyperFrames: window.__timelines adopted by the runtime)`);
      break;
    }
    case "make": {
      // ms make --resume <id>: continue a stopped run from its make.json
      const resume = typeof flags.resume === "string" ? flags.resume : null;
      const prompt = resume ? null : [scene, ...rest].filter(Boolean).join(" ");
      if (!prompt && !resume) throw new Error('usage: ms make "<what to make>" | ms make --resume <id>');
      const r = await make(prompt, { id: resume || (typeof flags.id === "string" ? flags.id : undefined), resume: !!resume,
        format: typeof flags.format === "string" ? flags.format : undefined, kind: flags.kind,
        rounds: flags.rounds != null ? +flags.rounds : undefined, render: !flags["no-render"],
        model: str(flags.model), agent: str(flags.agent), criticAgent: str(flags["critic-agent"]), onLog: l => console.log(l) });
      console.log(`done  ${r.id}  ${r.verdict}${r.video ? `  ${rel(r.video)}` : ""}`);
      break;
    }
    case "notes": {
      const notes = readNotes(need(scene)).filter(n => flags.all || n.status === "open");
      if (!notes.length) console.log("no open notes");
      for (const n of notes) {
        console.log(`[${n.id}] ${n.status}  at ${n.t.toFixed(2)}s  point ${Math.round(n.x)}%,${Math.round(n.y)}%`);
        console.log(`   ${n.text}`);
        for (const r of n.replies) console.log(`   ${r.by}: ${r.text}`);
      }
      break;
    }
    case "reply": {
      const [nid, text] = rest;
      const notes = readNotes(need(scene));
      const note = notes.find(n => n.id === nid);
      if (!note) throw new Error(`no note ${nid}`);
      if (text) note.replies.push({ by: "ai", text, at: new Date().toISOString() });
      if (flags.resolve) note.status = "resolved";
      writeNotes(scene, notes);
      console.log(`[${nid}] ${note.status}, ${note.replies.length} replies`);
      break;
    }
    case "critic": {
      need(scene);
      if (flags.record) {
        const text = fs.readFileSync(flags.record, "utf8");
        printRound(record(scene, parseVerdict(text), { by: flags.by || "critic", text }));
        break;
      }
      const { promptFile, images } = await packet(scene, { brief: typeof flags.brief === "string" ? flags.brief : undefined });
      console.log(`critic packet  ${rel(promptFile)}`);
      if (!flags.run) { console.log("give it to a fresh critic, then: ms critic " + scene + " --record <answer file>"); break; }
      const j = pick(tokensFor(scene).critic || {}, { agent: str(flags.agent), model: str(flags.model), effort: str(flags.effort) });
      console.log(`critic running (${j.name}, ${j.model || "default"}) ...`);
      const { text, by } = await runCritic(promptFile, { agent: j.name, model: j.model, effort: j.effort, id: scene, images });
      fs.writeFileSync(promptFile.replace(/prompt\.md$/, "answer.md"), text);
      printRound(record(scene, parseVerdict(text), { by, text }));
      break;
    }
    case "refs": {
      if (flags.pull) {
        const r = await pull(need(scene), String(flags.pull), { k: +(flags.k || 5) });
        console.log(`${rel(r.file)}  ${r.refs} refs (${r.images} images), ${r.repos} repos, ${r.skills} skills` +
          (r.noDetail ? "  (server lacks /library/ref: no images)" : ""));
        break;
      }
      const q = [scene, ...rest].filter(Boolean).join(" ");
      if (!q) throw new Error('usage: ms refs "<query>"');
      for (const r of await search(q, { type: typeof flags.type === "string" ? flags.type : undefined, k: +(flags.k || 8) }))
        console.log(`#${String(r.id).padEnd(5)} ${r.type.padEnd(5)} ${r.title}${r.url ? `  ${r.url}` : ""}`);
      break;
    }
    case "capture": {
      const url = scene;
      if (!/^https?:\/\//.test(url || "")) throw new Error("usage: ms capture <https://...> [--clip seconds]");
      const m = await capture(url, { clip: +(flags.clip || 0), note: typeof flags.note === "string" ? flags.note : "",
        scene: typeof flags.scene === "string" ? flags.scene : undefined, push: !flags["no-push"] });
      console.log(`${rel(m.shot)}${m.video ? `  ${rel(m.video)}` : ""}`);
      if (m.library) console.log(m.library.id ? `library  ref #${m.library.id}${m.library.merged ? " (merged)" : ""}, in the library inbox` : `library  ${m.library.error}`);
      break;
    }
    case "study": {
      if (!scene) throw new Error("usage: ms study <url|file> [--slug s] [--scene <id>]");
      const r = await study(scene, { slug: str(flags.slug), scene: str(flags.scene), threshold: flags.threshold && +flags.threshold });
      const d = r.data;
      console.log(`${d.slug}  ${d.duration}s ${d.width}x${d.height} @ ${d.fps}fps  format ${d.format}  ${d.shots.length} shots`);
      d.shots.forEach(([a, b], i) => console.log(`  shot ${String(i + 1).padStart(2)}  ${fmtT(a)} +${(b - a).toFixed(2)}s`));
      console.log(`sheet  ${rel(r.sheet)}
notes  ${rel(r.md)}`);
      if (r.scene) console.log(`remake ${rel(r.scene.dir)}  (ref.json -> ${d.slug}; ms compare ${str(flags.scene)} after a render)`);
      break;
    }
    case "compare": {
      const r = await compare(need(scene), { slug: str(flags.study), video: str(flags.video), threshold: flags.threshold && +flags.threshold });
      console.log(`${scene} vs ${r.study}  match ${r.score}/100  rhythm ${r.rhythm}  cuts ${r.cuts.hits}/${r.cuts.ref.length} (f1 ${r.cuts.f1.toFixed(2)})  length ${r.length}`);
      if (r.cuts.offsets.length) console.log(`  cut offsets (remake - ref): ${r.cuts.offsets.map(o => (o > 0 ? "+" : "") + o.toFixed(2)).join(" ")}`);
      console.log(`  ref cuts   ${r.cuts.ref.map(t => t.toFixed(2)).join(" ")}
  your cuts  ${r.cuts.mine.map(t => t.toFixed(2)).join(" ")}`);
      console.log(`sheet  ${rel(r.sheet)}
video  ${rel(r.video)}`);
      break;
    }
    case "beat": {
      if (!scene) throw new Error("usage: ms beat <song> [--scene id] [--from s] [--length s]");
      const r = await beat(scene, { scene: str(flags.scene), from: flags.from != null ? +flags.from : undefined, length: flags.length && +flags.length });
      console.log(`${r.src}  ${r.bpm} BPM (beat ${r.period}s, bar ${(4 * r.period).toFixed(3)}s)  ${r.duration}s from ${r.from}s`);
      console.log(`  beats ${r.beats.length}  downbeats ${r.downbeats.slice(0, 12).map(t => t.toFixed(2)).join(" ")}${r.downbeats.length > 12 ? " ..." : ""}`);
      console.log(`  bar energy ${r.bars.map(b => " .:-=+*#%@"[Math.min(9, Math.round(b * 9))]).join("")}`);
      console.log(`  drops ${r.drops.map(t => t.toFixed(2)).join(" ") || "none"}${r.song ? `  (whole song: ${r.song.drops.map(t => t.toFixed(2)).join(" ") || "none"})` : ""}`);
      if (r.scene) console.log(`scene  ${rel(r.scene.dir)}/beats.js  (add <script src="beats.js"> before scene.js; audio: { music: ${JSON.stringify(r.scene.music)} })`);
      break;
    }
    case "playbook": {
      if (!scene) {
        const r = await playbook();
        console.log(`${rel(r.file)}  ${r.studies.length} studies, ${r.moves.length} moves (${r.moves.filter(m => !m.built).length} not in core/moves.js yet)`);
        for (const s of r.studies) console.log(`  ${s.slug}  ${s.duration}s ${s.format}  ${s.shots} shots${s.music ? `  ${s.music.bpm} BPM, ${Math.round(100 * s.music.onBeat)}% cuts on beat` : ""}${s.filled ? "" : "  (study.md front matter not filled)"}`);
        break;
      }
      const r = await lookup(args.slice(1).join(" "));
      console.log(`studies  ${r.studies.join(", ") || "none"}`);
      for (const m of r.moves) console.log(`move     ${m.name}${m.built ? "" : " (not in core/moves.js yet)"}  seen in ${m.seen.join(", ")}${m.notes.length ? `  ${m.notes.join("; ")}` : ""}`);
      for (const t of r.techniques) console.log(`trick    ${t.t}  [${t.study}]`);
      for (const t of r.good) console.log(`why      ${t.t}  [${t.study}]`);
      break;
    }
    case "review": {
      const rounds = readReview(need(scene)).rounds;
      if (!rounds.length) console.log("no critic rounds yet");
      for (const r of rounds) printRound(r, false);
      break;
    }
    default:
      console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").filter(l => l.startsWith("//   ")).map(l => l.slice(5)).join("\n"));
  }
}

function printAudio(a) {
  for (const c of a.cues) console.log(`  ${fmtT(c.start)}  ${c.sound.padEnd(10)} for event at ${c.event}s  ${c.gain}dB`);
  for (const v of a.vo || []) console.log(`  ${fmtT(v.event)}  vo ${v.provider}:${v.voice} to ${v.until}s  "${v.text.slice(0, 48)}"`);
  for (const w of a.warnings || []) console.log("  warn  " + w);
  const ok = Math.abs(a.lufs - a.target.lufs) <= 1 && a.truePeak <= a.target.truePeak + 0.1;
  // Sparse cues with no music cannot reach the loudness target without passing the peak ceiling: say so, not "off"
  const peakBound = !ok && a.lufs < a.target.lufs && a.truePeak >= a.target.truePeak - 0.3;
  console.log(`audio  ${rel(a.file)}  ${a.lufs} LUFS, true peak ${a.truePeak} dBTP  (target ${a.target.lufs} / ${a.target.truePeak})` +
    (ok ? "" : peakBound ? "  below target, held by the peak ceiling (sparse cues; music fills it)" : "  OFF TARGET"));
}

function need(id) {
  if (!id) throw new Error(`usage: ms ${cmd} <scene>`);
  return id;
}

main().catch(e => { console.error(String(e.message || e)); process.exit(2); });
