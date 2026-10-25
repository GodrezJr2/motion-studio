// Static + API server for the studio. The CLI starts it on a free port to open scenes; `ms serve` runs it for people.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { tokensScript } from "./tokens.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SCENES = path.join(ROOT, "scenes");

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp",
  ".woff2": "font/woff2", ".mp4": "video/mp4", ".map": "application/json", ".mp3": "audio/mpeg", ".wav": "audio/wav",
  ".m4a": "audio/mp4", ".md": "text/markdown; charset=utf-8",
};

// URL prefix -> folder on disk
const MOUNTS = [
  ["/core/", path.join(ROOT, "core")],
  ["/studio/", path.join(ROOT, "studio")],
  ["/scenes/", SCENES],
  ["/sounds/", path.join(ROOT, "sounds")],
  ["/vendor/gsap/", path.join(ROOT, "node_modules", "gsap", "dist")],
];

export function listScenes() {
  if (!fs.existsSync(SCENES)) return [];
  return fs.readdirSync(SCENES, { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(path.join(SCENES, d.name, "index.html")))
    .map(d => {
      const html = fs.readFileSync(path.join(SCENES, d.name, "index.html"), "utf8");
      const title = (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || d.name;
      return { id: d.name, title, mtime: fs.statSync(path.join(SCENES, d.name)).mtimeMs };
    });
}

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };

// The project list for the studio's home: what each scene is and where it stands, all from files already on disk
function projects() {
  return listScenes().map(s => {
    const ms = path.join(SCENES, s.id, ".ms");
    const meta = readJson(path.join(ms, "poster.json")) || {};
    const report = readJson(path.join(ms, "report.json"));
    const review = readJson(path.join(ms, "review.json"));
    const rounds = review && review.rounds ? review.rounds : [];
    const mp4 = path.join(ms, `${s.id}.mp4`);
    return {
      ...s, edited: sourceTime(s.id),
      width: meta.width, height: meta.height, duration: meta.duration, kind: meta.kind, fps: meta.fps,
      poster: meta.at ? `/scenes/${s.id}/.ms/poster.png?v=${Math.round(meta.at)}` : null,
      posterFresh: !!meta.at && meta.at > sourceTime(s.id),
      notes: readNotes(s.id).filter(n => n.status !== "resolved").length,
      lint: report ? report.score : null,
      critic: rounds.length ? { round: rounds.length, verdict: rounds[rounds.length - 1].verdict } : null,
      make: makeState(ms),
      render: fs.existsSync(mp4) ? `/scenes/${s.id}/.ms/${s.id}.mp4?v=${Math.round(fs.statSync(mp4).mtimeMs)}` : null,
    };
  }).sort((a, b) => b.edited - a.edited);
}

// `ms make` progress for the card: running, failed or done (the last lines of its log)
const making = new Map(); // id -> child process started by POST /api/make
function makeState(ms) {
  const m = readJson(path.join(ms, "make.json"));
  if (!m) return null;
  const id = path.basename(path.dirname(ms));
  const running = !m.done && !m.error && (making.has(id) || Date.now() - fs.statSync(path.join(ms, "make.json")).mtimeMs < 15 * 60e3);
  return { stage: m.stage, running, error: m.error || null, done: !!m.done, last: m.log.slice(-3), prompt: m.prompt, format: m.format };
}

// A still of the scene for its project card, taken near the end where the piece is composed. One browser at a time.
let posterQueue = Promise.resolve();
function poster(id) {
  const run = posterQueue.then(async () => {
    const { withScene } = await import("./session.mjs");
    const meta = await withScene(id, async ({ page, info }) => {
      await page.evaluate(t => MS.seek(t), info.duration * 0.85);
      await page.screenshot({ type: "png", path: path.join(SCENES, id, ".ms", "poster.png") });
      return { width: info.width, height: info.height, fps: info.fps, duration: info.duration, kind: info.kind || null, at: Date.now() };
    }, { scale: 0.5 });
    fs.writeFileSync(path.join(SCENES, id, ".ms", "poster.json"), JSON.stringify(meta));
    return meta;
  });
  posterQueue = run.catch(() => {});
  return run;
}

// Copy a scene's source and assets (not its notes, renders or reports) under a new id
function duplicate(from, to) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(to)) throw new Error(`scene id "${to}": use lowercase letters, digits and dashes`);
  const dst = path.join(SCENES, to);
  if (fs.existsSync(dst)) throw new Error(`scene "${to}" already exists`);
  fs.cpSync(path.join(SCENES, from), dst, { recursive: true, filter: src => !/[\\/](\.ms|notes\.json)$/.test(src) });
  const html = path.join(dst, "index.html");
  fs.writeFileSync(html, fs.readFileSync(html, "utf8").replace(/<title>([^<]*)<\/title>/i, (_, t) => `<title>${t} (copy)</title>`));
}

const notesFile = id => path.join(SCENES, id, "notes.json");
export function readNotes(id) {
  try { return JSON.parse(fs.readFileSync(notesFile(id), "utf8")); } catch { return []; }
}
export function writeNotes(id, notes) {
  fs.writeFileSync(notesFile(id), JSON.stringify(notes, null, 2) + "\n");
}

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function body(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
  });
}

const validId = id => /^[a-z0-9][a-z0-9-_]*$/i.test(id) && fs.existsSync(path.join(SCENES, id, "index.html"));

// What the studio may upload into a scene folder: media only, never code
const UPLOADS = new Set([".mp3", ".wav", ".m4a", ".ogg", ".png", ".jpg", ".jpeg", ".webp", ".svg", ".gif", ".mp4", ".webm", ".woff2", ".ttf", ".otf"]);

const sourceTime = id => Math.max(...fs.readdirSync(path.join(SCENES, id)).filter(f => f !== ".ms" && f !== "notes.json")
  .map(f => fs.statSync(path.join(SCENES, id, f)).mtimeMs));

// The scene's mixed sound for studio playback: the same plan + mix as the render, rebuilt only when the scene changed
const building = new Map();
async function sceneAudio(id) {
  const meta = path.join(SCENES, id, ".ms", "audio.json");
  if (fs.existsSync(meta) && fs.statSync(meta).mtimeMs > sourceTime(id)) return JSON.parse(fs.readFileSync(meta, "utf8"));
  if (!building.has(id)) building.set(id, (async () => {
    const { withScene } = await import("./session.mjs");
    const { plan, mix } = await import("./audio.mjs");
    const p = await withScene(id, async ({ page, info }) => plan(id, info, await page.evaluate(() => MS.tweens())));
    const r = p ? await mix(id, p) : null;
    const out = r ? { src: `/scenes/${id}/.ms/${id}.wav?v=${Date.now()}`, lufs: r.lufs, truePeak: r.truePeak,
      cues: p.cues.map(c => ({ sound: c.sound, from: c.from, event: c.event, start: c.start })), music: !!p.music } : { src: null, cues: [] };
    fs.writeFileSync(meta, JSON.stringify(out));
    return out;
  })().finally(() => building.delete(id)));
  return building.get(id);
}

// Everything in a scene folder, grouped the way an editor thinks about it
function sceneFiles(id) {
  const root = path.join(SCENES, id), files = [];
  const add = (rel, group) => {
    const st = fs.statSync(path.join(root, rel));
    files.push({ name: rel.replace(/\\/g, "/"), url: `/scenes/${id}/${rel.replace(/\\/g, "/")}`, size: st.size, mtime: st.mtimeMs, group });
  };
  const walk = (rel, group, depth) => {
    for (const d of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = path.join(rel, d.name);
      if (d.isDirectory()) { if (depth < 2) walk(r, group, depth + 1); }
      else add(r, group);
    }
  };
  for (const d of fs.readdirSync(root, { withFileTypes: true })) {
    if (d.name === ".ms" || d.name === "notes.json") continue;
    if (d.isDirectory()) walk(d.name, "assets", 1);
    else add(d.name, /\.(html|js|css|md|json)$/i.test(d.name) ? "source" : "assets");
  }
  const ms = path.join(root, ".ms");
  if (fs.existsSync(ms)) {
    for (const d of fs.readdirSync(ms, { withFileTypes: true })) {
      if (d.isFile() && /\.(mp4|wav|png|json)$/i.test(d.name) && !/(\.video\.mp4|\.premix\.wav|^audio\.json|^sample\.json|^poster\.(png|json))$/.test(d.name)) add(path.join(".ms", d.name), "output");
    }
    if (fs.existsSync(path.join(ms, "refs"))) for (const f of fs.readdirSync(path.join(ms, "refs"))) add(path.join(".ms", "refs", f), "refs");
  }
  return files;
}

const rendering = new Set();
const clients = new Set();
const broadcast = ev => { for (const c of clients) c.write(`data: ${JSON.stringify(ev)}\n\n`); };

export function startServer({ port = 0, host = "127.0.0.1", watch = false } = {}) {

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const p = decodeURIComponent(url.pathname);
    try {
      if (p === "/" || p === "/index.html") return send(res, 200, fs.readFileSync(path.join(ROOT, "studio", "index.html")), TYPES[".html"]);
      if (p === "/favicon.ico") { res.writeHead(204); return res.end(); }
      if (p === "/api/scenes" && req.method === "GET") return send(res, 200, listScenes());
      if (p === "/api/projects") return send(res, 200, projects());
      if (p === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write("retry: 1000\n\n");
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      let m = p.match(/^\/api\/scenes\/([^/]+)\/notes(?:\/([^/]+))?$/);
      if (m) {
        const [, id, nid] = m;
        if (!validId(id)) return send(res, 404, { error: "no such scene" });
        const notes = readNotes(id);
        if (req.method === "GET") return send(res, 200, notes);
        const b = await body(req);
        if (!nid) {
          const note = { id: Date.now().toString(36), t: +(+b.t).toFixed(3), x: b.x, y: b.y, text: String(b.text || "").slice(0, 2000),
            status: "open", created: new Date().toISOString(), replies: [] };
          notes.push(note);
          writeNotes(id, notes);
          return send(res, 201, note);
        }
        const note = notes.find(n => n.id === nid);
        if (!note) return send(res, 404, { error: "no such note" });
        if (b.status) note.status = b.status === "resolved" ? "resolved" : "open";
        if (b.reply) note.replies.push({ by: b.by || "jay", text: String(b.reply).slice(0, 2000), at: new Date().toISOString() });
        if (req.method === "DELETE") notes.splice(notes.indexOf(note), 1);
        writeNotes(id, notes);
        return send(res, 200, note);
      }
      m = p.match(/^\/api\/scenes\/([^/]+)\/lint$/);
      if (m && req.method === "POST") {
        if (!validId(m[1])) return send(res, 404, { error: "no such scene" });
        const b = await body(req);
        // Imported here: session.mjs imports this file
        const { analyze } = await import("./session.mjs");
        const { report } = await analyze(m[1], { perf: b.perf !== false });
        return send(res, 200, report);
      }
      m = p.match(/^\/api\/scenes\/([^/]+)\/(report|review)$/);
      if (m) {
        const f = path.join(SCENES, m[1], ".ms", m[2] + ".json");
        return fs.existsSync(f) ? send(res, 200, fs.readFileSync(f)) : send(res, 404, { error: `no ${m[2]} yet` });
      }
      if (p === "/api/make" && req.method === "POST") {
        const b = await body(req);
        const prompt = String(b.prompt || "").trim();
        if (!prompt) return send(res, 400, { error: "say what to make" });
        const { slugFor, guessFormat } = await import("./make.mjs");
        const id = /^[a-z0-9][a-z0-9-]*$/.test(b.id || "") && !fs.existsSync(path.join(SCENES, b.id)) ? b.id : slugFor(prompt);
        const args = [path.join(ROOT, "bin", "ms.mjs"), "make", prompt, "--id", id, "--format", b.format || guessFormat(prompt),
          ...(/^[a-z]+$/.test(b.agent || "") ? ["--agent", b.agent] : [])];
        const child = spawn(process.execPath, args, { cwd: ROOT, stdio: "ignore", windowsHide: true });
        making.set(id, child);
        child.on("exit", () => { making.delete(id); broadcast({ type: "projects" }); });
        // the scaffold lands within a second; the card shows progress from make.json
        setTimeout(() => broadcast({ type: "projects" }), 1200);
        return send(res, 202, { id });
      }
      if (p === "/api/scenes" && req.method === "POST") {
        const b = await body(req);
        const { newScene } = await import("./scaffold.mjs");
        newScene(String(b.id || ""), { format: b.format, kind: b.kind || undefined, title: b.title || undefined });
        return send(res, 201, { id: b.id });
      }
      m = p.match(/^\/api\/scenes\/([^/]+)\/(audio|files|render|poster|duplicate|sounds|edit)$/);
      if (m) {
        const [, id, what] = m;
        if (!validId(id)) return send(res, 404, { error: "no such scene" });
        if (what === "audio") return send(res, 200, await sceneAudio(id));
        if (what === "edit" && req.method === "POST") {
          // { ops: [...], tweens: MS.tweens() from the stage } -> rewrite scene.js; the watcher reloads the stage
          const b = await body(req);
          const { applyEdits } = await import("./edit.mjs");
          return send(res, 200, { changes: applyEdits(id, b.tweens || [], b.ops || [], { dry: !!b.dry }) });
        }
        if (what === "sounds") {
          const { kitInfo } = await import("./audio.mjs");
          return send(res, 200, await kitInfo(id));
        }
        if (what === "poster" && req.method === "POST") { await poster(id); return send(res, 200, projects().find(x => x.id === id)); }
        if (what === "duplicate" && req.method === "POST") {
          const b = await body(req);
          duplicate(id, String(b.id || ""));
          return send(res, 201, { id: b.id });
        }
        if (what === "files" && req.method === "GET") return send(res, 200, sceneFiles(id));
        if (what === "files" && req.method === "POST") {
          const name = path.basename(url.searchParams.get("name") || "");
          if (!/^[\w][\w .()-]*$/.test(name) || !UPLOADS.has(path.extname(name).toLowerCase()))
            return send(res, 400, { error: `upload media only (${[...UPLOADS].join(" ")}), plain file names` });
          const file = path.join(SCENES, id, name);
          await new Promise((resolve, reject) => {
            const out = fs.createWriteStream(file);
            req.pipe(out);
            out.on("finish", resolve);
            out.on("error", reject);
          });
          broadcast({ type: "files", scene: id });
          return send(res, 201, { name, size: fs.statSync(file).size });
        }
        if (what === "render" && req.method === "POST") {
          if (rendering.has(id)) return send(res, 409, { error: "already rendering" });
          rendering.add(id);
          try {
            const { render } = await import("./render.mjs");
            const r = await render(id);
            broadcast({ type: "files", scene: id });
            return send(res, 200, { file: path.relative(path.join(SCENES, id), r.file || path.join(SCENES, id, ".ms", `${id}.mp4`)) });
          } finally { rendering.delete(id); }
        }
      }
      // Taste tokens from MOTION.md as a script, unless the scene ships its own tokens.js
      m = p.match(/^\/scenes\/([^/]+)\/tokens\.js$/);
      if (m && validId(m[1]) && !fs.existsSync(path.join(SCENES, m[1], "tokens.js"))) return send(res, 200, tokensScript(m[1]), TYPES[".js"]);
      for (const [prefix, dir] of MOUNTS) {
        if (!p.startsWith(prefix)) continue;
        const file = path.resolve(dir, "." + p.slice(prefix.length - 1));
        if (!file.startsWith(dir)) return send(res, 403, "forbidden", "text/plain");
        const target = fs.existsSync(file) && fs.statSync(file).isDirectory() ? path.join(file, "index.html") : file;
        if (!fs.existsSync(target)) break;
        const type = TYPES[path.extname(target)] || "application/octet-stream";
        // Ranges, or <audio>/<video> cannot seek (the studio sets currentTime on every scrub)
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
        if (range) {
          const size = fs.statSync(target).size;
          const start = range[1] ? +range[1] : size - +range[2], end = range[1] && range[2] ? Math.min(+range[2], size - 1) : size - 1;
          res.writeHead(206, { "content-type": type, "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes",
            "content-length": end - start + 1, "cache-control": "no-store" });
          return fs.createReadStream(target, { start, end }).pipe(res);
        }
        return send(res, 200, fs.readFileSync(target), type);
      }
      send(res, 404, "not found", "text/plain");
    } catch (e) {
      send(res, 500, { error: String(e.message || e) });
    }
  });

  // Live reload. "change": scene code edited (reload the stage); "notes": notes.json written (by the CLI or the
  // studio); "report": a lint run finished. Other files under .ms (stills, sheets, renders) are ignored.
  if (watch && fs.existsSync(SCENES)) {
    let timer = null, pending = new Map();
    fs.watch(SCENES, { recursive: true }, (_ev, file) => {
      if (!file) return;
      const parts = file.split(/[\\/]/);
      const name = parts[parts.length - 1];
      const type = name === "notes.json" ? "notes" : name === "report.json" ? "report" : name === "review.json" ? "review" : name === "make.json" ? "projects"
        : parts.includes(".ms") ? null : "change";
      if (!type) return;
      pending.set(parts[0] + ":" + type, { type, scene: parts[0] });
      clearTimeout(timer);
      timer = setTimeout(() => {
        for (const ev of pending.values()) broadcast(ev);
        pending = new Map();
      }, 150);
    });
  }

  return new Promise(resolve => server.listen(port, host, () => {
    const { port: actual } = server.address();
    resolve({ server, port: actual, url: `http://${host}:${actual}` });
  }));
}
