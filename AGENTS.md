# Motion Studio — agent guide

For every coding agent (Claude Code, Codex, Gemini CLI, OpenCode, Cursor, Copilot, Aider, ...). The studio is a
plain CLI plus a browser UI, so any agent that can run shell commands and read PNGs can drive it.

The user pins notes on moments of a motion scene in the studio. You edit the scene until the motion is right, check it
with your own eyes (lint + contact sheet), and answer each note. Motion must be high detail and buttery: every move
eases to rest, nothing teleports or stops dead, playback holds 60 fps.

## Taste first

Read `MOTION.md` before writing any frame. Its YAML front matter is machine-read: lint enforces `limits`, the critic
gets `banned` and `critic`, and every scene gets the `eases` as GSAP eases `"ms.out"`, `"ms.rest"`, `"ms.land"`, ...
(use these, not power3/expo). A scene may override any key in its own `scenes/<id>/MOTION.md` (a brand's motion
language). Put the brief in `scenes/<id>/brief.md`: kind, audience, feel, the one idea; the critic judges against it.

## Scene format

`scenes/<id>/index.html` loads `/vendor/gsap/gsap.min.js`, `/vendor/gsap/CustomEase.min.js`, `tokens.js` (served
virtually from MOTION.md), `/core/runtime.js`, then the scene script, which builds **one** GSAP timeline and calls
`MS.register(tl, { width, height, fps, kind })`. `kind` is `"web"` (plays then rests), `"film"` or `"ad"` (end-hold
and beat rules apply). Rules:

- All motion lives on that timeline (no free-running rAF loops, CSS animations or timers): the studio scrubs it,
  lint samples it, render seeks it frame by frame. Anything off the timeline will not show up or will flicker.
- Mark the elements that matter with `data-ms="name"`. Lint, curves and stage highlights use these names.
  Without any `data-ms`, every tween target is tracked under a generated name.
- Animate `x`, `y`, `scale`, `rotation`, `opacity`/`autoAlpha`, `clipPath`, SVG attributes. Not layout props.
- Fonts: wait-free (`display=block` or local), otherwise the first frames render in a fallback font.
- Add `id` to a tween (`{ id: "dot-travel" }`) when a note is likely to point at it; it shows in `ms tweens`.

## The loop

```
node bin/ms.mjs notes <scene>                 # open notes: time, point (x%,y% of the frame), text
node bin/ms.mjs frame <scene> <t>             # still at the note's moment; open the PNG to see what the user saw
node bin/ms.mjs tweens <scene>                # timeline table: which tween is active at that time
# edit scenes/<scene>/scene.js
node bin/ms.mjs lint <scene> --no-perf        # fast: curve + tween rules
node bin/ms.mjs sheet <scene>                 # stills + velocity curves + issues in one PNG; Read it
node bin/ms.mjs reply <scene> <note-id> "what changed and why" --resolve
```

The studio (`node bin/ms.mjs serve`, http://127.0.0.1:4173) reloads the scene on every save, keeps the playhead
where the user left it, re-lints, and shows your replies under their notes. For a phone on the same tailnet/LAN:
`node bin/ms.mjs serve --host 0.0.0.0`.

Retiming is a structured edit, not hand surgery: the runtime records where each tween was written (`ms tweens`
shows `#index` and `scene.js:line:col`), and `ms edit` rewrites only that call.

```
node bin/ms.mjs edit <scene> dot-sweep --dur 0.6 --ease ms.out   # by id, scene.js:12:4 or #7
node bin/ms.mjs edit <scene> "#3" --shift -0.1                     # relative positions ("<0.1", "-=0.3") stay relative
node bin/ms.mjs edit <scene> --after 2.0 --shift 0.3               # push everything from 2.0 s on
```

The user can do the same in the studio: double-click a bar for start / duration / ease / stagger.

Reply in one or two sentences: what changed (ease, duration, offset, path) and the lint result. Resolve only when
the note is addressed; if you disagree or need their eye, reply without `--resolve`.

## Reading lint

| rule | means | usual fix |
|---|---|---|
| teleport | moved in one frame | give it a duration, or hide behind opacity 0 |
| hard-stop | still fast on its last frame | ease out, or a later tween overwrites it |
| jerk | velocity kinks mid-move | merge chained tweens, or make both sides of the seam reach zero speed |
| linear / linear-ease | constant speed | ease, unless a loop or marquee |
| too-fast / sluggish | eye cannot follow / drags | 200-500ms for UI-sized moves |
| layout-prop | animates left/width/… | x / y / scale / clipPath |
| all-at-once | 6+ elements start on one frame | stagger 30-60ms |
| dropped-frames | real playback misses 60 fps | blur, filters, shadows, layout in the moving layer |
| text-overshoot | type passes its rest point | ms.out / ms.outSoft, never back/elastic on text |
| bouncy | overshoot above `limits.overshoot` | only a true landing (ms.land), 1-7% of travel |
| landings | more than `maxLandings` overshooting moves | keep the one or two real contacts |
| fade-pop | fade-out on an out ease (half gone in one frame) | ms.smooth, 0.17-0.24 s |
| strobe | visible move over 25 px/frame | longer, softer start (ms.rest/ms.glide) |
| dead-time | nothing moves for over `maxIdle` mid-piece | overlap, drift, or a chosen breath |
| end-hold | film/ad: last motion to end outside `endHold` | trim or extend the hold |
| same-speed / ease-soup / off-token (info) | one tempo / too many eases / eases outside MOTION.md | vary duration by distance, stick to ms.* |

Motion that is bad on purpose (the "before" of a before/after) gets `data-ms-role="demo"`: lint lists it once and does
not judge its curves. Jerk is judged only on moves of 0.4 s or longer: a short fade peaks sharply by design. Opacity is what the viewer
sees (ancestors multiply, visibility:hidden is 0), so a move that ends as its shot fades out is a cut, not a hard stop.

Lint is a floor, not taste. A 100 can still be dull; the sheet's curves show rhythm (overlap, stagger, settle).
`scenes/lint-fixture` breaks every rule on purpose: `ms lint lint-fixture` must keep reporting 3 errors, 9 warns, 1 info.

## Critic loop (builder never judges its own work)

```
node bin/ms.mjs critic <scene> --run          # packet (sheet + full-size key frames + brief + MOTION.md + lint +
                                              # open items) -> headless critic agent -> ledger .ms/review.json
node bin/ms.mjs critic <scene>                # packet only: prompt at .ms/critic/prompt.md, for another judge
node bin/ms.mjs critic <scene> --record answer.md
node bin/ms.mjs review <scene>                # ledger: rounds, scores, open issues
```

The judge runs on MOTION.md `critic.agent` / `model` / `effort` (claude, haiku, low: cheap and fast; `--agent`, `--model` override).
SHIP is recomputed, never claimed: every axis >= `critic.ship`, no blocker, no open major from earlier rounds. Fix
what is real, push back in the brief on what is a misread (say the kind and what chrome is real UI). After
`critic.rounds` rounds without SHIP, stop polishing and show the user the ledger.

## Make (one prompt to a finished piece)

`node bin/ms.mjs make "<what to make>" [--id x] [--format 9:16] [--rounds 2] [--no-render] [--model m] [--agent a] [--critic-agent a]`: scaffold
(format guessed from the words: reel/story -> 9:16, square -> 1:1, landing -> web, else 16:9) -> refs pull ->
builder agent on MOTION.md `builder` (claude, opus, medium: the model you work with; the judge stays on haiku) (writes
brief, scene, sound cues; lints and reads its own sheet) -> critic rounds, the builder
resumed to fix each -> lint -> sound + render. Progress in `.ms/make.json`; `ms make --resume <id>` continues a stopped run (skips a finished build, redoes an
interrupted fix, then judges once more); the studio's New form runs it when a
description is given (`POST /api/make {prompt, id?, format?}`) and the card shows the stage.

## Agents

`ms make` and `ms critic --run` hand work to a headless coding agent through `core/agents.mjs`:

| agent | CLI it runs | builder | critic |
|---|---|---|---|
| `claude` (default) | `claude -p --output-format stream-json` | acceptEdits, studio CLI only | Read + ffmpeg only |
| `codex` | `codex exec --json` | `--full-auto` | `--sandbox read-only`, frames attached with `-i` |
| `gemini` | `gemini -p --output-format json` | `--approval-mode yolo` | default approvals (reads only) |
| `opencode` | `opencode run --format json` | `--auto` | frames attached with `-f` |

Choose with MOTION.md `builder.agent` / `critic.agent`, `--agent` (and `ms make --critic-agent`), or `MS_AGENT`.
MOTION.md `model`/`effort` belong to the agent named there; another agent runs on its own default unless
`--model` is given (`--model provider/model` for opencode). Keep the critic a different model from the builder.
Adding an agent is one entry in `AGENTS`: its flags and how to read its event stream into `{ text, session }`.

Without any of these, an agent in an interactive session can still do the whole loop by hand: `ms critic <scene>`
writes the packet, a fresh session judges it, `ms critic <scene> --record answer.md` files the verdict.

## HyperFrames

`node bin/ms.mjs import <composition.html|dir> [--id x]` copies a HyperFrames composition into `scenes/<id>`, swaps its
GSAP CDN script for the vendored one plus `/core/runtime.js`, and writes a brief. The runtime adopts the timeline in
`window.__timelines` (the `[data-composition-id]` one) with each `.clip[data-start][data-duration]` window as sets, so
studio, lint and render work unchanged. Inline-script tweens have no source line: `ms edit` cannot rewrite them.

## New scene

`node bin/ms.mjs new <id> --format 16:9|9:16|1:1|4:5|web [--kind ad|film|web] [--title "..."]` writes a skeleton at
the MOTION.md `formats` size with a `.safe` box (`--safe-*` vars: where platform UI covers a feed video) and a
`brief.md` to fill. Lay out each format for itself; never crop 16:9 to vertical.

## References

```
node bin/ms.mjs refs "<query>" [--type ref|repo|skill]   # search memory-core's library (saved refs, starred repos, skills)
node bin/ms.mjs refs <scene> --pull "<query>"           # best matches -> .ms/refs/refs.md + images; the critic sees them
node bin/ms.mjs capture <url> [--clip 4] [--note "..."] [--scene <id>]   # still + scroll clip -> refs/<slug>/, to the library inbox
```

Pull refs before building a new piece and look at the images: they set the bar for detail and finish, they are not
layouts to copy. Needs MC_URL + MC_TOKEN or `~/.memory-core.json`.

## Sound

Declare it on the timeline: `MS.register(tl, { ..., audio: { music: { src: "music.mp3", from: "end", gain: -3 },
sfx: [{ at: "<tween id>", edge: "start"|"end", offset: 0, sound: "land", gain: 0 }, { t: 2.4, sound: "tick" }] } })`.

Sounds come from earshot (github.com/Leonxlnx/earshot, MIT; a sibling checkout `../earshot` with its `.venv`, or set `EARSHOT_PY`):
designed sounds and CC0 recordings fitted as code, every take audited. `sound:` resolves in this order:

1. a kit role: tick, tick.crisp, tock, hit, land, land.light, pop, whoosh.short, whoosh.long, suck, riser, drop,
   key, key.space, key.return, click, click.confirm, snap, swell, bell, text. The kit is MOTION.md `audio.kit`
   (crisp | calm | minimal | launch, rendered once to `sounds/<kit>/`) or the scene's own `kit.json`. Repeated cues
   rotate takes; bells climb pitches; `pitch: "E5"` picks one. Some roles are off per kit (crisp: riser/swell/suck).
2. a bank id, e.g. `"ui_pop/soft"` (`earshot sfx list`, 252 sounds) with `pitch`/`dur`/`apex`/`seed` on the cue.
3. a file in the scene folder (e.g. `audio/raw/1492.wav`); give it `sync:` = seconds from the file start to the onset
   (clicks) or peak (whooshes) that should meet the event (`analyze.py` in earshot's real-sound skill measures both).
4. `synth:tick|pop|thud|whoosh`: placeholder only.

Cues sync on the take's onset (whooshes/swells on their peak) and lead the event by `limits.sfxLead`.
`from: "end"` back-times the music so its ending lands on the last frame. `ms audio <scene>` prints the cue sheet
and builds `.ms/<scene>.wav` (two-pass loudnorm to -14 LUFS / -1 dBTP); `ms render` muxes it in (`--no-audio` to
skip). Check what you cannot hear: `.venv/Scripts/python.exe -m earshot timeline <wav>` lists the events it hears.
The studio's Sounds tab auditions every role. Music comes from the user; never claim a mix sounds good without saying it
was only measured, not heard.

Voice-over sits on the same timeline: `audio: { vo: [{ at: "<tween id>" | t: 0.3, text: "Satu garis untuk semua
trip.", voice?, gain?, provider? }] }`. Speech starts on the cue (the take's leading silence is measured and
skipped). Defaults come from MOTION.md `audio.vo`:

- `provider: edge` (default): free Microsoft Edge read-aloud voices via `pip install edge-tts`, good for drafts and
  timing. Indonesian: `id-ID-ArdiNeural`, `id-ID-GadisNeural`; `python -m edge_tts -l` lists the rest.
- `provider: elevenlabs`: paid. Needs `ELEVENLABS_API_KEY` in the env or in `.env` at the repo root (gitignored).
  Voice id and model under `audio.vo.elevenlabs`. Ask the user before switching a piece to it: every new or
  changed line costs credits.

Takes are cached in `sounds/vo/` by provider + voice + model + text, so an unchanged line is never synthesised (or
paid for) twice. Music ducks under the voice with a sidechain compressor (`audio.vo.duck`, the ratio; 3 measured
about 6 dB under an edge voice; 0 = off). `ms vo <scene>` synthesises the lines and prints each one's span and word
timings: write the line first, then fit the picture to it (land a reveal on the word, not the word on the reveal).
It warns when a line runs into the next one or past the end. Write lines short (one idea, 6-10 words) and read the
numbers aloud as words if the voice stumbles on them.

Music, the way the strongest published launch-film prompts do it:

- One licensed track (Mixkit, Pixabay, CC0/CC BY; raw files in `scenes/<id>/audio/raw/`, never committed) at about
  120-130 BPM. Measure its tempo and drop first, then place it with `from: <seconds>` so the drop lands on the hero
  reveal; let the picture follow the music's grid where you can (a bar is 4 beats of 60/BPM s).
- Effects only on real on-screen actions: one soft whoosh per real scene change, a click or pop per tap, one soft note
  on the logo. Keep them just above the bed, never louder than the music; fade the music under the end card.
- Banned: EDM risers, whooshes on everything, stock "tech interface" beds, a synthesized hit doubling the drop.

## Projects

The studio opens on a Projects home (posters, notes/lint/critic chips, hover plays the render, duplicate, new).
`#<id>` opens the editor. API: `GET /api/projects`, `POST /api/scenes/:id/poster`, `POST /api/scenes/:id/duplicate
{id}`, `GET /api/scenes/:id/sounds`.

## Video

`node bin/ms.mjs render <scene> [--fps 60] [--scale 1]` → `scenes/<scene>/.ms/<scene>.mp4`, frame-exact with the
studio. Needs ffmpeg on PATH. Output, stills, sheets and reports go to `.ms/` (not source).
