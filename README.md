# Motion Studio

**Models write motion blind. This gives them eyes.**

[![Motion Studio, 41 s film](media/readme.gif)](media/motion-studio.mp4)

*41 s film with sound: [media/motion-studio.mp4](media/motion-studio.mp4). It was made in the studio itself; the UI,
terminal output, scores and notes in it come from real runs.*

An LLM agent can write a GSAP timeline, but it cannot see whether the result teleports, stops dead or strobes.
Motion Studio turns one seekable timeline into things a model can read: a tween table with the source line of every
call, velocity curves sampled every frame, a lint report, a contact sheet, full-size frames, and a second model that
judges the piece. You pin notes on moments in the browser; the agent edits the exact call, checks, and replies.

## What it does

- **Reads the timeline.** `ms tweens` lists every tween with start, duration, ease, targets and `scene.js:line:col`.
- **Measures every curve.** `ms lint` samples each tracked element at 60 fps and flags teleports, hard stops, jerk,
  strobing, dead time, overshoot on type, ease soup and dropped frames.
- **Edits the exact call.** `ms edit <scene> dot-sweep --dur 0.6 --ease ms.out` rewrites only that call. The studio
  inspector does the same on a double-click.
- **Notes from you.** Pin a note on a time and point in the studio; the agent reads it with `ms notes`, looks at the
  frame, fixes, and answers with `ms reply`.
- **A second model judges.** `ms critic --run` sends a packet (sheet, frames, brief, taste file, lint) to a fresh
  `claude -p`. SHIP is recomputed from the scores, never claimed by the builder.
- **One prompt to an MP4.** `ms make "15s vertical ad for X"` scaffolds, pulls references, builds, runs critic
  rounds, lints, adds sound and renders. `--resume <id>` continues a stopped run.
- **Bring your own timeline.** Any page that builds a GSAP timeline and calls `MS.register(tl)` is a scene.
  HyperFrames compositions (`window.__timelines`) are adopted as they are: `ms import ./composition`.
- **Taste as a file.** `MOTION.md` holds the house eases, paces, limits, formats and banned moves. Lint enforces it,
  the builder and the critic read it, and a scene can override it with its own.
- **Sound on the timeline.** Cues attach to tween ids and render through [earshot](https://github.com/Leonxlnx/earshot), loudness
  normalised, muxed into the MP4.

## Quick start

Needs Node 18+, Google Chrome, ffmpeg on PATH, and [Claude Code](https://claude.com/claude-code) for `critic` and
`make`.

```sh
npm install
node bin/ms.mjs serve                 # studio at http://127.0.0.1:4173
node bin/ms.mjs lint demo-hero        # curves + rules
node bin/ms.mjs sheet demo-hero       # contact sheet PNG
node bin/ms.mjs render demo-hero      # MP4, frame-exact with the studio
node bin/ms.mjs make "15s vertical ad for my app"
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
  MS.register(tl, { width: 1920, height: 1080, fps: 60, kind: "film" });
</script>
```

All motion lives on that one timeline, so the studio scrubber, lint and the renderer see the same frames.
`CLAUDE.md` is the agent's guide: the loop, how to read lint, the critic, sound and formats.

## Commands

```
ms list | new | serve | lint | sheet | frame | render | audio | tweens | edit
ms notes | reply | critic | review | make | import | refs | capture
```

Run `node bin/ms.mjs` with no arguments for the full usage.
