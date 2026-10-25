---
# Motion Studio house taste. Machine-read by core/tokens.mjs: lint enforces `limits`, every scene gets the `eases`
# as GSAP eases named "ms.<name>", the critic gets `banned` and `critic`. A scene can override any key with its own
# scenes/<id>/MOTION.md (a brand's motion language wins over the house one).
version: 1
fps: 60
pace: calm # calm (default, a viewer is reading) | crisp (brief asks for energy)

# Cubic beziers [x1, y1, x2, y2]. Use as ease: "ms.out". Most pieces need three: out, a camera/travel ease, exit.
eases:
  out: [0.16, 1, 0.3, 1] # arrivals, reveals, word entrances. Never for fades out
  outSoft: [0.22, 1, 0.36, 1] # gentle settles, secondary arrivals, type
  exit: [0.55, 0.055, 0.675, 0.19] # leaving into a cut: speed grows to the last frame
  smooth: [0.65, 0, 0.35, 1] # fades, drifts, holds, breath
  inOut: [0.87, 0, 0.13, 1] # whips, lockup slides, morphs (fast middle)
  glide: [0.47, 0.2, 0.15, 1] # 150-350 px element moves with a soft landing
  rest: [0.45, 0, 0.1, 1] # any move that must end at rest, or starts after another move
  cam: [0.48, 0.1, 0, 0.9] # camera pushes: slow start, early peak, long settle
  ui: [0.4, 0, 0.2, 1] # small UI changes: toggles, chips, rows
  contact: [0.55, 0, 0.9, 0.55] # accelerating into an impact (arrives with speed)
  whip: [0.6, 0, 0.15, 1] # feature-to-feature whips, 0.4-0.5 s
  land: [0.3, 1.25, 0.5, 1] # a true landing only (about 6% overshoot), at most two per piece

# Durations in seconds. move = base + perPx * distance.
paces:
  calm: { moveBase: 0.5, movePerPx: 0.0016, word: 0.6, wordStagger: 0.18, exit: 0.4, fade: 0.2, group: 0.5 }
  crisp: { moveBase: 0.35, movePerPx: 0.00135, word: 0.43, wordStagger: 0.1, exit: 0.27, fade: 0.17, group: 0.4 }

limits:
  maxPxPerFrame: 25 # visible, unblurred move above this strobes
  overshoot: 0.07 # max overshoot past rest, as a share of the travel, and only on a true landing
  textOvershoot: 0.005 # type never overshoots
  maxLandings: 2 # moves that overshoot at all, per piece
  maxEases: 4 # distinct eases before it reads as no system
  speedRange: 3 # longest move lasts at least 3x the shortest, or everything feels one speed
  maxIdle: 1.2 # seconds with nothing moving, mid-piece (dead time)
  endHold: [0.6, 1.4] # films: last motion to last frame
  sfxLead: 0.033 # sound leads its picture event by 2 frames

formats: # ms new --format; re-lay out for each, never crop 16:9 to vertical
  "16:9": [1920, 1080]
  "9:16": [1080, 1920]
  "1:1": [1080, 1080]
  "4:5": [1080, 1350]
  web: [1440, 900]

audio:
  lufs: -14
  truePeak: -1
  kit: crisp # earshot kit: crisp (product, dev-tool) | calm | minimal | launch (cut to music); sfx name kit roles

critic:
  axes: [idea, motion, type, layout, finish]
  ship: 8 # every axis at or above this, and no blocker
  rounds: 3 # then ask Jay instead of polishing further
  agent: claude # claude | codex | gemini | opencode (core/agents.mjs); --agent or MS_AGENT overrides
  model: haiku # the judge: cheap and fast; model/effort apply only to the agent named here, --model overrides
  effort: low

builder: # ms make's builder: the same model Jay works with, not the cheap judge; --model on ms make overrides
  agent: claude # another agent (--agent codex) runs on its own default model unless --model is given
  model: opus
  effort: medium

banned:
  - "Page chrome: brand name in a corner, tracked-caps labels, counters (01 / 04), timecodes, BPM/FPS text, progress bars, corner brackets"
  - "Deck layouts: held left headline + grey sub-line, kicker above headline, headline left and device right"
  - "Generic UI cards: rounded card with status dot and label-value, three-dot toolbars, skeleton bars, invented names or numbers"
  - "Invented proof: stats, counters to unsourced numbers, testimonials, logos, features that are not in the brief or assets"
  - "Slogan copy: triplets of one-word sentences, 'Not just X. It's Y.', 'Unlock', 'Meet X', 'the future of'"
  - "Premium pastiche by default: near-black ground, radial glow, lens flare, one serif-italic word in a sans line"
  - "Bouncy easing on anything that merely arrives; glows; gradients on UI chrome; particle bursts"
  - "Dead time; everything fading in; idle bobbing everywhere"
  - "Web-footer ending: logo + tagline + button + URL, or an end card held past 1.4 s"
  - "Redrawn product UI or logo when the real one exists; 16:9 cropped to vertical"
---

# MOTION.md

Read this before writing any frame. The front matter is the machine part: lint fails what breaks `limits`, and
`ease: "ms.<name>"` gives you the curves. This prose is why the numbers exist.

## The laws

- **Entrances decay, exits accelerate.** Things arrive fast and settle (`ms.out`), leave slow then fast
  (`ms.exit`). Only the camera eases both ways (`ms.cam`).
- **Fades run 0.17-0.24 s on `ms.smooth`.** A fade-out on an `.out` ease puts half the change in the first frame:
  the element pops to half and drifts. Lint calls it `fade-pop`.
- **Linear is for drift only** (background creep, a clock, a marquee). Anything that starts or stops has a curve.
- **Duration grows with distance**: calm 0.5 s + 1.6 ms per px, crisp 0.35 s + 1.35 ms per px. The longest move
  lasts at least 3x the shortest (`same-speed`).
- **Consecutive moves overlap** by about 0.3 s, the second starting on a zero-slope curve (`ms.rest`, `ms.smooth`).
  Two moves that each ease to rest and then restart read as stall-then-lurch.
- **One hero motion plus at most two supporting ones** at any moment. Stillness after motion is a tool.
- **Speed limit**: past 25 px per frame an unblurred move strobes (`strobe`). A fast whip reads best next to
  something almost still.
- **Springs and overshoot belong to a true landing only**: an object reaching a surface or a lock, a contact you
  could put a sound on. 1-7% of the travel, at most two per piece. Cards, labels, chips and the camera never
  overshoot. **Type never overshoots** (`text-overshoot`).
- **Order a stagger by importance**, not DOM order: the thing that carries the idea leads (or lands last as the
  punchline). Grids 4 f per column, 6 f per row; a whole UI group arrives within 0.5 s.
- **A reading hold drifts** at 0.3-1 px per frame, it does not freeze; it may accelerate into the cut at the end.
- **No dead time**: nothing still for more than 1.2 s mid-piece unless it is a chosen breath before the payoff.
- **Films end mid-motion**: the last event to the last frame is 0.6-1.4 s.

## Beats (films and ads)

- 0-2 s: the hook, the most striking picture, not a logo.
- A new payoff every 3-5 s. One true thing per piece; features left out on purpose.
- The logo arrives by cause, once, near the end; the ending is smaller than the climax.
- Shots last whole bars when there is music: 100 BPM calm (bar 2.4 s), 120 BPM crisp (bar 2 s). Cuts on
  downbeats, state changes on beats, picture 2 frames after its sound.
- Works with sound off: the claim is readable in the picture.

## Sound

Music matched to the buyer, one continuous piece back-timed so its own ending lands on the end card. A soft sound
on small moves, the hero moments clearly audible, designed silence before the turn. Master -14 LUFS, true peak -1.

## Truth

Real screenshots, logos and copy come from Jay or the brief. Anything invented to look real is not shipped; a
sample placeholder is labelled as one.
