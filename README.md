<div align="center">

# Motion Studio

**Coding agents write motion blind. This gives them eyes.**

One prompt in. A linted, judged, sound-designed MP4 out, and every frame checked on the way.

[![License: MIT](https://img.shields.io/badge/license-MIT-2f73c0)](LICENSE)
[![Stars](https://img.shields.io/github/stars/GodrezJr2/motion-studio?style=flat&color=2f73c0)](https://github.com/GodrezJr2/motion-studio/stargazers)
![Node 18+](https://img.shields.io/badge/node-18%2B-2f73c0)
![Works with Claude Code, Codex, Gemini CLI, OpenCode](https://img.shields.io/badge/agents-Claude%20Code%20·%20Codex%20·%20Gemini%20·%20OpenCode-2f73c0)

</div>

Every scene is a folder you can open, scrub and remix: `node bin/ms.mjs serve`, then pick it on the home page.
The repo ships the engine, one starter scene (`scenes/demo-hero`) and the lint fixture; your own scenes and renders
stay on your machine (`scenes/*` and `media/` are gitignored).

## Examples

Three 9:16 pieces an agent built in the studio from a brief, with an Indonesian voice-over and sound. Each preview
loops eight silent seconds; click it for the full video with sound. Their scene sources are not in this repo.

<table>
<tr>
<td align="center" width="33%">
<a href="https://github.com/user-attachments/assets/c370c834-a759-4f76-a8a9-ef66622e49da"><img src="docs/examples/langit.webp" width="240" alt="Langit: a spectrum chart asking why the sky is not violet, then the sun over the horizon"></a><br>
<b>Langit</b><br>
<sub>A 43 s science explainer: why the sky is blue (Rayleigh scattering).</sub>
</td>
<td align="center" width="33%">
<a href="https://github.com/user-attachments/assets/938eda6b-9cf6-43a7-afad-3513d7666bd9"><img src="docs/examples/hening.webp" width="240" alt="Hening: a typed command, then glass notification cards sorting into four decks over blue silk light"></a><br>
<b>Hening</b><br>
<sub>A 55 s ad for a made-up focus app: WebGL silk light behind glass cards.</sub>
</td>
<td align="center" width="33%">
<a href="https://github.com/user-attachments/assets/a942be88-8028-4dc7-a3fc-ee1eedecff85"><img src="docs/examples/lintasi.webp" width="240" alt="Lintasi: a late-truck message from a customer, a leaking margin bucket, then the title"></a><br>
<b>Lintasi</b><br>
<sub>A 22 s ad for a trip-tracking app for truck brokerages, on demo data.</sub>
</td>
</tr>
</table>

---

An agent can write a GSAP timeline. What it cannot do is see whether the result teleports, stops dead or strobes.
Motion Studio turns one seekable timeline into things a model can read:

- a tween table with the source line of every call;
- velocity curves sampled every frame;
- a lint report;
- a contact sheet and full-size frames;
- a verdict from a second model.

You pin notes on moments in the browser. The agent edits the exact call, checks its work, and replies.

```
 you ──note @ 2.4s──▶ agent ──edit scene.js──▶ lint + sheet ──looks──▶ fixes ──reply──▶ you
                                  ▲                                         │
                                  └──── critic (a different model) ◀────────┘
```

## Works with any coding agent

The studio is a plain CLI plus a browser UI. Any agent that can run shell commands and open a PNG can drive it.
The guide lives in [`AGENTS.md`](AGENTS.md), and each tool reads it from its own entry point:

| agent | reads | headless (`ms make`, `ms critic --run`) |
|---|---|---|
| Claude Code | `CLAUDE.md` → `@AGENTS.md` | `--agent claude` (default) |
| OpenAI Codex | `AGENTS.md` | `--agent codex` |
| Gemini CLI | `GEMINI.md` → `@AGENTS.md` | `--agent gemini` |
| OpenCode | `AGENTS.md` | `--agent opencode` |
| Cursor, Copilot | `AGENTS.md` | by hand: `ms critic` packet → `--record` |
| Aider | `.aider.conf.yml` loads `AGENTS.md` + `MOTION.md` | by hand |

Builder and critic can be different agents:

```sh
ms make "15s vertical ad for my app" --agent codex --critic-agent claude
```

## What it does

- **Reads the timeline.** `ms tweens` lists every tween with its start, duration, ease, targets and `scene.js:line:col`.
- **Measures every curve.** `ms lint` samples each tracked element at 60 fps. It flags teleports, hard stops, jerk,
  strobing, dead time, overshoot on type, ease soup and dropped frames.
- **Edits the exact call.** `ms edit <scene> dot-sweep --dur 0.6 --ease ms.out` rewrites only that call. In the
  studio, double-click a bar to do the same.
- **Takes notes from you.** Pin a note on a time and a point. The agent reads it (`ms notes`), looks at the frame,
  fixes it and answers (`ms reply`).
- **Lets a second model judge.** `ms critic --run` sends a packet to a fresh agent: the sheet, frames, brief, taste
  file and lint report. SHIP is recomputed from the scores; the builder never gets to claim it.
- **Goes from one prompt to an MP4.** `ms make "<idea>"` scaffolds, pulls references, builds, runs critic rounds,
  lints, adds sound and renders. `--resume <id>` continues a stopped run.
- **Keeps taste in a file.** `MOTION.md` holds the house eases, paces, limits, formats and banned moves. Lint
  enforces it, the builder and critic read it, and any scene can override it.
- **Puts sound on the timeline.** Cues attach to tween ids. They render through
  [earshot](https://github.com/Leonxlnx/earshot), get loudness-normalised and are muxed into the MP4. The studio
  plays them in sync while you scrub.
- **Brings your own timeline.** Any page that builds a GSAP timeline and calls `MS.register(tl)` is a scene.
  HyperFrames compositions are adopted as they are: `ms import ./composition`.

## Quick start

Requirements:

- Node 18+
- Google Chrome
- ffmpeg on PATH
- for sound: an [earshot](https://github.com/Leonxlnx/earshot) checkout next to this repo (or set `EARSHOT_PY`)
- for `make` / `critic --run`: one of the agent CLIs above

```sh
npm install
node bin/ms.mjs serve                 # studio at http://127.0.0.1:4173
node bin/ms.mjs lint demo-hero        # curves + rules
node bin/ms.mjs sheet demo-hero       # contact sheet PNG
node bin/ms.mjs render demo-hero      # MP4, frame-exact with the studio
node bin/ms.mjs make "20s kinetic UI promo for my app"
```

## A scene

```html
<script src="/vendor/gsap/gsap.min.js"></script>
<script src="/vendor/gsap/CustomEase.min.js"></script>
<script src="tokens.js"></script>        <!-- MOTION.md eases as "ms.out", "ms.rest", ... -->
<script src="/core/runtime.js"></script>
<script>
  const tl = gsap.timeline();
  tl.from("[data-ms=title]", { y: 40, autoAlpha: 0, duration: 0.6, ease: "ms.out", id: "title-in" });
  MS.register(tl, { width: 1920, height: 1080, fps: 60, kind: "film",
    audio: { sfx: [{ at: "title-in", sound: "pop" }] } });
</script>
```

All motion lives on that one timeline, so the studio scrubber, lint and the renderer all see the same frames.

## Taste as a file

`MOTION.md` is the studio's motion law. Its YAML front matter is machine-read:

| key | used by |
|---|---|
| `eases` | every scene gets them as GSAP eases: `ms.out`, `ms.rest`, `ms.smooth`, `ms.land`, ... |
| `limits` | lint thresholds: overshoot, idle time, end hold, strobe speed, sound lead |
| `banned` | the critic's never-ship list |
| `critic` / `builder` | which agent and model judge and build, the score that ships, how many rounds |
| `formats`, `audio.kit` | scene sizes and safe areas; the earshot sound kit |

The prose below the front matter goes to the builder and the critic as written. A scene can override any key in
its own `scenes/<id>/MOTION.md`, e.g. a brand's motion language.

## Commands

```
ms list | new | serve | lint | sheet | frame | render | audio | tweens | edit
ms notes | reply | critic | review | make | import | refs | capture
```

Run `node bin/ms.mjs` with no arguments for the full usage. [`AGENTS.md`](AGENTS.md) covers the rest: the edit
loop, how to read each lint rule, the critic, sound, formats and the studio API.

## Layout

```
bin/ms.mjs        the CLI
core/             runtime (in the page), lint, sheet, render, audio, critic, make, agents, server
studio/           the browser studio: projects home, scrubber, curves, notes, inspector, sounds
scenes/<id>/      index.html + scene.js + brief.md (+ MOTION.md override); output goes to .ms/ (ignored)
MOTION.md         the house taste
AGENTS.md         the guide every coding agent reads
```

## Credits

Built on [GSAP](https://gsap.com) and Playwright with system Chrome; sound by
[earshot](https://github.com/Leonxlnx/earshot) (MIT); HyperFrames compositions supported through `ms import`.
The examples use music from [Mixkit](https://mixkit.co) under its free licence (#726 in Langit, "Your Breath" in
Hening, "Close Up" in Lintasi; the files are not included) and draft voices from edge-tts.

## Star history

<a href="https://star-history.com/#GodrezJr2/motion-studio&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=GodrezJr2/motion-studio&type=Date&theme=dark">
    <img alt="Star history chart" src="https://api.star-history.com/svg?repos=GodrezJr2/motion-studio&type=Date">
  </picture>
</a>

## License

[MIT](LICENSE). GSAP is loaded from npm under its own license; sound comes from earshot (MIT). The example videos
are not covered by the MIT license: Hening is a made-up product, and Lintasi's screens show demo data.
