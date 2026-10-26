// Templates: a finished scene saved with its motion, and its words, pictures and colours pulled out into
// content.json, so the next piece is the same timeline with new content. `ms template save <scene> <name>` keeps a
// copy, `ms new <id> --template <name> [--fill content.json]` starts a scene from it. Templates live in MS_TEMPLATES,
// else recipes/templates/ (local and gitignored: a template studied from someone else's piece is never published).
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./server.mjs";

const SCENES = path.join(ROOT, "scenes");
export const templatesDir = () => process.env.MS_TEMPLATES || path.join(ROOT, "recipes", "templates");
const validId = id => /^[a-z0-9][a-z0-9-]*$/.test(id);

// Not part of a template: renders and reports, the user's notes, the study link, and the scene's own sound files
// (a study remake's audio is the reference's, and content.json names any music)
const SKIP = /[\\/](\.ms|notes\.json|ref\.json|audio)$/;

const readJSON = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };

// What a template asks for: data-slot names in the markup, MS.slot(...) names in the script, and content.json
export function slotsOf(dir) {
  const html = fs.existsSync(path.join(dir, "index.html")) ? fs.readFileSync(path.join(dir, "index.html"), "utf8") : "";
  const js = fs.existsSync(path.join(dir, "scene.js")) ? fs.readFileSync(path.join(dir, "scene.js"), "utf8") : "";
  const content = readJSON(path.join(dir, "content.json")) || {};
  const names = new Set([...html.matchAll(/data-slot="([^"]+)"/g), ...js.matchAll(/MS\.slot\(\s*["']([^"']+)/g)].map(m => m[1]));
  return { text: [...names], images: (content.images || []).length, colors: Object.keys(content.colors || {}), content };
}

export function listTemplates() {
  const dir = templatesDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => {
    const t = path.join(dir, d.name);
    const meta = readJSON(path.join(t, "template.json")) || {};
    return { name: d.name, dir: t, ...meta, slots: slotsOf(t) };
  });
}

export function saveTemplate(scene, name, { about } = {}) {
  if (!validId(name)) throw new Error(`template "${name}": use lowercase letters, digits and dashes`);
  const src = path.join(SCENES, scene);
  if (!fs.existsSync(src)) throw new Error(`no scene "${scene}"`);
  if (!fs.existsSync(path.join(src, "content.json"))) {
    throw new Error(`scene "${scene}" has no content.json: pull its words, pictures and colours into slots first (see AGENTS.md "Templates")`);
  }
  const dst = path.join(templatesDir(), name);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true, filter: f => !SKIP.test(f) });
  // The template's defaults carry no music: the source scene's track is not part of the template
  const content = readJSON(path.join(dst, "content.json"));
  delete content.music;
  fs.writeFileSync(path.join(dst, "content.json"), JSON.stringify(content, null, 2) + "\n");
  const meta = { from: scene, saved: new Date().toISOString().slice(0, 10), ...(about && { about }) };
  fs.writeFileSync(path.join(dst, "template.json"), JSON.stringify(meta, null, 2) + "\n");
  return { dir: dst, slots: slotsOf(dst) };
}

// A new scene from a template; `fill` (a content.json path or object) replaces the defaults key by key
export function fromTemplate(id, name, { fill } = {}) {
  if (!validId(id)) throw new Error(`scene id "${id}": use lowercase letters, digits and dashes`);
  const src = path.join(templatesDir(), name);
  if (!fs.existsSync(src)) throw new Error(`no template "${name}" in ${templatesDir()} (ms template list)`);
  const dst = path.join(SCENES, id);
  if (fs.existsSync(dst)) throw new Error(`scene "${id}" already exists`);
  fs.cpSync(src, dst, { recursive: true, filter: f => !/[\\/]template\.json$/.test(f) });
  const content = readJSON(path.join(dst, "content.json")) || {};
  const extra = typeof fill === "string" ? readJSON(fill) : fill;
  if (typeof fill === "string" && !extra) throw new Error(`--fill ${fill}: not a JSON file`);
  if (extra) {
    for (const k of ["text", "colors"]) if (extra[k]) content[k] = { ...content[k], ...extra[k] };
    for (const [k, v] of Object.entries(extra)) if (k !== "text" && k !== "colors") content[k] = v;
  }
  fs.writeFileSync(path.join(dst, "content.json"), JSON.stringify(content, null, 2) + "\n");
  return { dir: dst, slots: slotsOf(dst) };
}
