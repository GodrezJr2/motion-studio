// The reference shelf. Taste comes from examples: your saved references, starred repos and motion skills live in
// memory-core's library (the RAG), and `pull` brings the best matches for a brief into the scene (.ms/refs/refs.md
// plus their images) so the builder and the critic both look at the bar. `capture` screenshots (and optionally
// records) a live site into refs/<slug>/ and saves it back to the library, where it waits in the library inbox.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { launch } from "./browser.mjs";
import { outDir } from "./session.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SHELF = path.join(ROOT, "refs");

// Same config as memory-core's mc client: MC_URL + MC_TOKEN, or ~/.memory-core.json {url, token}
function config() {
  let url = process.env.MC_URL, token = process.env.MC_TOKEN;
  const file = path.join(os.homedir(), ".memory-core.json");
  if (!(url && token) && fs.existsSync(file)) {
    const c = JSON.parse(fs.readFileSync(file, "utf8"));
    url = url || c.url; token = token || c.token;
  }
  if (!url || !token) throw new Error(`no memory-core configured: set MC_URL and MC_TOKEN, or create ${file}`);
  return { url: url.replace(/\/$/, ""), token };
}

async function api(route, { body, raw } = {}) {
  const { url, token } = config();
  const r = await fetch(url + route, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${token}`, "x-mc-client": "motion-studio", ...(body ? { "content-type": "application/json" } : {}) },
    body: body && JSON.stringify(body),
  });
  if (!r.ok) {
    const e = new Error(`memory-core ${route}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    e.status = r.status;
    throw e;
  }
  return raw ? Buffer.from(await r.arrayBuffer()) : r.json();
}

// Below this cosine the library returns whatever is nearest (a Threads analysis for "hero motion"): drop it
const MIN_SIMILARITY = 0.45;
export const search = (query, { type, category, k = 5, min = MIN_SIMILARITY } = {}) =>
  api("/api/v1/library/search", { body: { query, type, category, k } })
    .then(j => (j.results || []).filter(r => r.similarity == null || r.similarity >= min));

// Saved references (with images), then starred repos and motion skills as text, into scenes/<id>/.ms/refs/
export async function pull(id, query, { k = 5 } = {}) {
  const dir = path.join(outDir(id), "refs");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const [refs, repos, skills] = await Promise.all([
    search(query, { type: "ref", k }),
    search(query, { type: "repo", k: 3 }),
    search(query, { type: "skill", category: "motion", k: 3 }),
  ]);
  const lines = [`# References for "${query}"`, "", "Pulled from memory-core's library. Look at the images: they set the bar,", "they are not layouts to copy.", ""];
  let images = 0, noDetail = false;
  for (const r of refs) {
    lines.push(`## #${r.id} ${r.title}`, r.summary || "", r.url ? `link: ${r.url}` : "");
    try {
      const d = await api(`/api/v1/library/ref?id=${r.id}`);
      for (const [n, m] of (d.images || []).slice(0, 3).entries()) {
        const f = path.join(dir, `ref-${r.id}-${n}.jpg`);
        fs.writeFileSync(f, await api(`/api/v1/library/media/${m.sha256}?size=view`, { raw: true }));
        lines.push(`image: ${f}`);
        images++;
      }
    } catch (e) {
      if (e.status !== 404) throw e;
      noDetail = true; // server without /library/ref yet: text only (library_view over MCP still shows images)
    }
    lines.push("");
  }
  if (repos.length) lines.push("## Starred repos", ...repos.map(r => `- #${r.id} ${r.title}: ${r.summary || ""}`), "");
  if (skills.length) lines.push("## Motion skills", ...skills.map(r => `- #${r.id} ${r.title}: ${r.summary || ""}`), "");
  const file = path.join(dir, "refs.md");
  fs.writeFileSync(file, lines.filter((l, i, a) => l || a[i - 1]).join("\n"));
  return { file, refs: refs.length, repos: repos.length, skills: skills.length, images, noDetail };
}

export function readPulled(id) {
  const f = path.join(outDir(id), "refs", "refs.md");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
}

const slugOf = url => new URL(url).hostname.replace(/^www\./, "").replace(/[^a-z0-9]+/gi, "-") +
  (new URL(url).pathname.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 40).replace(/^(?=.)/, "-"));

// Screenshot a live site (and record `clip` seconds of it, scrolled slowly so motion and scroll effects show)
export async function capture(url, { clip = 0, note = "", width = 1440, height = 900, push = true, scene } = {}) {
  const slug = slugOf(url);
  const dir = path.join(SHELF, slug);
  fs.mkdirSync(dir, { recursive: true });
  const browser = await launch();
  let shot, video;
  try {
    const ctx = await browser.newContext({ viewport: { width, height }, ...(clip ? { recordVideo: { dir, size: { width, height } } } : {}) });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 45000 }).catch(() => page.waitForLoadState("load"));
    await page.waitForTimeout(1500); // let entrance animations land before the still
    shot = path.join(dir, "shot.png");
    await page.screenshot({ path: shot });
    if (clip) {
      await page.evaluate(() => scrollTo(0, 0));
      const steps = Math.round(clip * 10);
      for (let i = 0; i < steps; i++) { await page.mouse.wheel(0, 60); await page.waitForTimeout(100); }
      const v = page.video();
      await ctx.close();
      video = path.join(dir, "clip.mp4");
      await toMp4(await v.path(), video, clip); // the recording also holds the page load: keep the scroll
    } else await ctx.close();
  } finally {
    await browser.close();
  }
  const meta = { url, note, captured: new Date().toISOString(), shot, video: video || null, library: null };
  if (push) {
    try {
      const r = await api("/api/v1/library/capture", { body: {
        image: fs.readFileSync(shot).toString("base64"), url, scope: "project:motion-studio", group: `ms-${slug}`,
        note: [note, video ? `clip on the laptop: ${video}` : "", "captured by Motion Studio"].filter(Boolean).join(" · "),
      } });
      meta.library = { id: r.id, merged: r.merged };
    } catch (e) {
      meta.library = { error: e.status === 404 ? "memory-core has no /library/capture route yet (deploy pending): kept local" : e.message };
    }
  }
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  if (scene) {
    const sdir = path.join(outDir(scene), "refs");
    fs.mkdirSync(sdir, { recursive: true });
    fs.copyFileSync(shot, path.join(sdir, `site-${slug}.png`));
    fs.appendFileSync(path.join(sdir, "refs.md"), `\n## ${url}\n${note}\nimage: ${path.join(sdir, `site-${slug}.png`)}\n${video ? `clip: ${video}\n` : ""}`);
  }
  return meta;
}

function toMp4(webm, mp4, last) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-sseof", `-${last + 0.3}`, "-i", webm, "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p",
      "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", mp4], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", d => { err += d; });
    p.on("close", code => { if (code === 0) { fs.rmSync(webm, { force: true }); resolve(); } else reject(new Error(`ffmpeg: ${err.trim()}`)); });
  });
}
