// Motion Studio scene runtime. A scene page loads GSAP, then this file, builds one gsap timeline and calls
// MS.register(tl). The studio and the CLI drive the scene only through window.MS: seek, play, sample, tweens.
//
//   ?ms=studio   paused at 0, the studio's scrubber owns time
//   ?ms=capture  paused at 0, no transitions or caret, for sampling and rendering
//   (no param)   plays like a normal web page
(function () {
  const mode = new URLSearchParams(location.search).get("ms") || "live";
  let tl = null;
  let opts = {};
  const listeners = [];

  // Where each tween was written: the scene script's line:col of its .to/.from/.fromTo/.set call, keyed by its vars
  // object. `ms edit` and the studio inspector rewrite that call, so every bar is editable without an id.
  const where = new WeakMap();
  if (window.gsap) {
    const proto = gsap.core.Timeline.prototype;
    for (const m of ["to", "from", "fromTo", "set"]) {
      const orig = proto[m];
      proto[m] = function (...a) {
        const vars = m === "fromTo" ? a[2] : a[1];
        if (vars && typeof vars === "object") {
          const line = (new Error().stack || "").split("\n").slice(2).find(l => !/runtime\.js|gsap/.test(l)) || "";
          const at = line.match(/\/scenes\/[^/]+\/([^/?#:]+\.js)(?:\?[^:]*)?:(\d+):(\d+)/);
          if (at) where.set(vars, `${at[1]}:${at[2]}:${at[3]}`);
        }
        return orig.apply(this, a);
      };
    }
  }

  // Element name for curves and lint: data-ms="name", else id, else a short selector
  function nameOf(el) {
    if (el.dataset && el.dataset.ms) return el.dataset.ms;
    if (el.id) return "#" + el.id;
    const cls = typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/)[0] : "";
    return el.tagName.toLowerCase() + cls;
  }

  function tracked() {
    const marked = [...document.querySelectorAll("[data-ms]")];
    if (marked.length) return marked;
    // No markers: every element some tween targets
    const set = new Set();
    for (const t of tweens(true)) for (const el of t._targets) if (el instanceof Element) set.add(el);
    return [...set];
  }

  // "text" elements may never overshoot. data-ms-role wins; otherwise text tags count as type
  const TEXT_TAGS = /^(H[1-6]|P|SPAN|EM|STRONG|B|I|LABEL|LI|BLOCKQUOTE|FIGCAPTION)$/;
  function roleOf(el) {
    if (el.dataset && el.dataset.msRole) return el.dataset.msRole;
    return TEXT_TAGS.test(el.tagName) && el.textContent.trim() && !el.querySelector("img,svg,canvas,video") ? "text" : "object";
  }

  function rotationOf(el) {
    const m = getComputedStyle(el).transform;
    if (!m || m === "none") return 0;
    const v = m.match(/matrix\(([^)]+)\)/);
    if (!v) return 0;
    const [a, b] = v[1].split(",").map(Number);
    return Math.round(Math.atan2(b, a) * 180 / Math.PI * 100) / 100;
  }

  function easeName(ease) {
    if (!ease) return "none";
    if (typeof ease === "string") return ease;
    return ease.name || "custom";
  }

  // Stable per-element key, so lint can tell two unnamed circles apart
  const uids = new WeakMap();
  let nextUid = 0;
  const uid = el => { if (!uids.has(el)) uids.set(el, ++nextUid); return uids.get(el); };

  // Every tween in the timeline with absolute start time, for lanes and lint
  function tweens(raw) {
    if (!tl) return [];
    const out = [];
    const walk = (parent, offset) => {
      for (const child of parent.getChildren(false, true, true)) {
        const start = offset + child.startTime() / (parent.timeScale() || 1);
        if (child instanceof gsap.core.Timeline) { walk(child, start); continue; }
        const targets = child.targets();
        const vars = child.vars || {};
        const skip = new Set(["ease", "duration", "delay", "stagger", "onComplete", "onStart", "onUpdate", "repeat",
          "yoyo", "id", "immediateRender", "overwrite", "paused", "runBackwards", "startAt", "data", "repeatDelay",
          "callbackScope", "lazy", "inherit", "parent", "keyframes"]);
        out.push({
          id: vars.id || null,
          src: where.get(vars) || null,
          start: +start.toFixed(4),
          duration: +child.duration().toFixed(4),
          repeat: child.repeat ? child.repeat() : 0,
          ease: easeName(vars.ease || (child.parent && child.parent.vars.defaults && child.parent.vars.defaults.ease) || "power1.out"),
          props: Object.keys(vars).filter(k => !skip.has(k)),
          from: !!vars.runBackwards,
          targets: targets.filter(t => t instanceof Element).map(nameOf),
          // what it writes, per element: attr / css objects spread into their keys
          els: targets.filter(t => t instanceof Element).map(uid),
          writes: Object.keys(vars).filter(k => !skip.has(k)).flatMap(k => (k === "attr" || k === "css") && vars[k] && typeof vars[k] === "object" ? Object.keys(vars[k]).map(a => `${k}.${a}`) : [k]),
          _targets: raw ? targets : undefined,
        });
      }
    };
    walk(tl, 0);
    return raw ? out : out.map(({ _targets, ...rest }) => rest);
  }

  // What the viewer sees: opacity multiplies down from every ancestor, and visibility:hidden is 0. A child of a
  // shot that fades out is gone too, so its last move is a cut, not a hard stop.
  function seenOpacity(el) {
    // display:none (a typed char not typed yet) has no box: unseen, not at 0,0
    if (getComputedStyle(el).visibility === "hidden" || !el.getClientRects().length) return 0;
    let o = 1;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) o *= +getComputedStyle(n).opacity;
    return o;
  }

  function snapshot(els, vw, vh) {
    return els.map(el => {
      const r = el.getBoundingClientRect();
      return [
        +(r.left + r.width / 2).toFixed(2), +(r.top + r.height / 2).toFixed(2),
        +r.width.toFixed(2), +r.height.toFixed(2),
        +seenOpacity(el).toFixed(3), rotationOf(el),
        r.right < 0 || r.bottom < 0 || r.left > vw || r.top > vh ? 0 : 1,
      ];
    });
  }

  const MS = {
    mode,
    register(timeline, o = {}) {
      tl = timeline;
      opts = { width: 1440, height: 900, fps: 60, background: null, ...o };
      if (mode !== "live") tl.pause(0);
      if (mode === "capture") {
        // Only the timeline moves things in capture: CSS transitions and the caret would differ frame to frame
        document.documentElement.classList.add("ms-capture");
        const st = document.createElement("style");
        st.textContent = ".ms-capture *,.ms-capture *::before,.ms-capture *::after{transition:none!important;animation-play-state:paused!important;caret-color:transparent!important}";
        document.head.appendChild(st);
      }
      listeners.forEach(fn => fn());
      window.parent !== window && window.parent.postMessage({ type: "ms:ready", info: MS.info() }, "*");
    },
    onReady(fn) { tl ? fn() : listeners.push(fn); },
    get ready() { return !!tl; },
    info() {
      return { duration: tl ? +tl.duration().toFixed(4) : 0, ...opts, tracked: tracked().map(nameOf) };
    },
    time() { return tl ? tl.time() : 0; },
    seek(t) { if (tl) { tl.pause(); tl.seek(Math.max(0, Math.min(t, tl.duration())), false); } return MS.time(); },
    play(rate = 1) { if (tl) { tl.timeScale(rate); if (tl.progress() >= 1) tl.seek(0); tl.play(); } },
    pause() { tl && tl.pause(); },
    // Not isActive(): that is still false on the first frame after play() from 0
    playing() { return !!tl && !tl.paused() && tl.progress() < 1; },
    tweens() { return tweens(false); },
    // Seek through the whole timeline at fps and record each tracked element: x, y, w, h, opacity, rotation, visible
    sample(fps = 60) {
      const els = tracked();
      const dur = tl ? tl.duration() : 0;
      const n = Math.max(1, Math.round(dur * fps)) + 1;
      const vw = innerWidth, vh = innerHeight;
      const frames = [];
      for (let i = 0; i < n; i++) { MS.seek(Math.min(i / fps, dur)); frames.push(snapshot(els, vw, vh)); }
      MS.seek(0);
      return { fps, duration: dur, viewport: [vw, vh], names: els.map(nameOf), roles: els.map(roleOf), channels: ["x", "y", "w", "h", "opacity", "rotation", "visible"], frames };
    },
    // Real-time playback in this browser: frame intervals tell whether the motion actually runs at 60 fps
    async measure(seconds) {
      if (!tl) return null;
      const dur = Math.min(seconds || tl.duration(), tl.duration() || 0);
      const gaps = [];
      tl.seek(0); tl.timeScale(1); tl.play();
      await new Promise(res => {
        let last = performance.now();
        const start = last;
        const step = now => { gaps.push(now - last); last = now; now - start < dur * 1000 ? requestAnimationFrame(step) : res(); };
        requestAnimationFrame(step);
      });
      tl.pause(0);
      return gaps.slice(1);
    },
  };

  window.MS = MS;

  // HyperFrames compositions do not call MS.register: they park a paused timeline in window.__timelines and the
  // root carries data-composition-id / data-width / data-height; clips are shown by their data-start/data-duration.
  // Adopt that timeline, with the clip windows put on it as sets, so the studio, lint and render treat it as a scene.
  addEventListener("load", () => {
    if (tl || !window.__timelines || !window.gsap) return;
    const root = document.querySelector("[data-composition-id]");
    const t = (root && window.__timelines[root.dataset.compositionId]) || Object.values(window.__timelines)[0];
    if (!t) return;
    let end = t.duration();
    for (const el of document.querySelectorAll(".clip[data-start]")) {
      const s = +el.dataset.start || 0, d = +el.dataset.duration;
      t.set(el, { visibility: "hidden" }, 0);
      t.set(el, { visibility: "visible" }, s);
      if (d) { t.set(el, { visibility: "hidden" }, s + d); end = Math.max(end, s + d); }
    }
    if (end > t.duration()) t.to({}, { duration: end - t.duration() });
    const ds = (root && root.dataset) || {};
    MS.register(t, { width: +ds.width || 1920, height: +ds.height || 1080, fps: 60, kind: ds.kind || "film", source: "hyperframes" });
  });

  addEventListener("message", ev => {
    const m = ev.data || {};
    if (m.type === "ms:seek") MS.seek(m.t);
    else if (m.type === "ms:play") MS.play(m.rate);
    else if (m.type === "ms:pause") MS.pause();
  });
  // Report time to the studio while playing, so the scrubber follows
  if (mode === "studio") {
    const tick = () => {
      if (tl && tl.isActive()) window.parent.postMessage({ type: "ms:time", t: tl.time() }, "*");
      else if (tl && tl.progress() >= 1 && !tl.paused()) { tl.pause(); window.parent.postMessage({ type: "ms:ended", t: tl.time() }, "*"); }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
})();
