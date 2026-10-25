// Studio: drives the scene iframe through its window.MS (same origin), draws the timeline from MS.tweens(),
// pins notes to (time, x%, y%) and shows lint issues on the timeline and over the stage.
(() => {
  const $ = s => document.querySelector(s);
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : String(k));
    return el;
  };
  const api = async (url, opts = {}) => {
    const r = await fetch(url, { ...opts, headers: { "content-type": "application/json" }, body: opts.body && JSON.stringify(opts.body) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || r.status);
    return data;
  };
  const SEV = ["error", "warn", "info"];

  const S = {
    scenes: [], id: null, info: null, tweens: [], groups: [], notes: [], report: null,
    t: 0, playing: false, rate: 1, loop: true, onion: false, sound: true, audio: null, files: [], pinning: false, selNote: null, hl: null, linting: false,
  };
  let MS = null;
  let loadToken = 0;
  const frame = $("#frame"), stage = $("#stage"), well = $("#well"), wrap = $("#lanes-wrap");
  const fps = () => (S.info && S.info.fps) || 60;
  const dur = () => (S.info && S.info.duration) || 1;

  // ── scenes ─────────────────────────────────────────
  async function loadScenes() {
    S.scenes = await api("/api/scenes");
    const list = $("#scene-list");
    list.replaceChildren(...S.scenes.map(s => h("li", {}, h("button", { "data-id": s.id, onclick: () => go(s.id) },
      h("span", {}, s.title), h("span", { class: "n" })))));
    markScenes();
  }
  function markScenes() {
    for (const b of document.querySelectorAll("#scene-list button")) b.setAttribute("aria-current", b.dataset.id === S.id);
  }

  async function openScene(id, keep = null) {
    const token = ++loadToken;
    const wasPlaying = keep && keep.playing;
    S.id = id;
    if (!keep) { S.t = 0; S.selNote = null; S.hl = null; }
    markScenes();
    MS = null;
    pause();
    frame.src = `/scenes/${id}/?ms=studio&v=${Date.now()}`;
    await new Promise(res => frame.addEventListener("load", res, { once: true }));
    const win = frame.contentWindow;
    const t0 = performance.now();
    while (!(win.MS && win.MS.ready)) {
      if (token !== loadToken) return;
      if (performance.now() - t0 > 10000) { $("#scene-title").textContent = id + " — never called MS.register()"; return; }
      await new Promise(r => setTimeout(r, 30));
    }
    if (token !== loadToken) return;
    MS = win.MS;
    S.info = MS.info();
    S.tweens = MS.tweens();
    const title = (S.scenes.find(s => s.id === id) || {}).title || id;
    $("#scene-title").textContent = title;
    $("#scene-meta").textContent = `${S.info.width}×${S.info.height} · ${S.info.fps} fps · ${S.tweens.length} tweens`;
    $("#tc-end").textContent = tc(dur());
    drawTimeline();
    drawTracked();
    fit();
    seek(keep ? Math.min(keep.t, dur()) : 0);
    if (wasPlaying) play();
    loadAudio();
    await Promise.all([loadNotes(), loadReport(), loadFiles()]);
  }

  // ── stage ─────────────────────────────────────────
  let scale = 1;
  function fit() {
    if (!S.info) return;
    const r = well.getBoundingClientRect();
    const m = innerWidth < 960 ? 20 : 64;
    scale = Math.min((r.width - m) / S.info.width, (r.height - m) / S.info.height, 1);
    stage.style.width = S.info.width * scale + "px";
    stage.style.height = S.info.height * scale + "px";
    frame.style.width = S.info.width + "px";
    frame.style.height = S.info.height + "px";
    frame.style.transform = `scale(${scale})`;
    drawOverlay();
  }

  // Element of a tracked name inside the scene document
  function elementOf(name) {
    const doc = frame.contentDocument;
    if (!doc) return null;
    try {
      return doc.querySelector(`[data-ms="${CSS.escape(name)}"]`) || (/^[#.]/.test(name) ? doc.querySelector(name) : null);
    } catch { return null; }
  }

  function drawOverlay() {
    const pins = $("#pins");
    pins.replaceChildren();
    // Issue regions active right now, and the hovered element
    const boxes = [];
    if (S.onion && S.report) {
      for (const i of S.report.issues) if (S.t >= i.t0 - 0.06 && S.t <= i.t1 + 0.06) boxes.push({ name: i.element, label: i.rule, cls: i.severity });
    }
    if (S.hl) boxes.push({ name: S.hl, label: S.hl, cls: "sel" });
    for (const b of boxes) {
      const el = elementOf(b.name);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      pins.append(h("div", { class: `hit ${b.cls}`, style: `left:${r.left * scale}px;top:${r.top * scale}px;width:${r.width * scale}px;height:${r.height * scale}px` }, h("span", {}, b.label)));
    }
    S.notes.forEach((n, i) => {
      const far = Math.abs(n.t - S.t) > 0.25;
      pins.append(h("div", {
        class: `pin${far ? " far" : ""}${n.status === "resolved" ? " resolved" : ""}${S.selNote === n.id ? " sel" : ""}`,
        style: `left:${n.x}%;top:${n.y}%`, title: n.text,
        onclick: e => { e.stopPropagation(); selectNote(n.id, true); },
      }, i + 1));
    });
  }

  // ── time ─────────────────────────────────────────
  const tc = t => {
    const f = Math.round(t * fps());
    return `${String(Math.floor(f / fps())).padStart(2, "0")}:${String(f % fps()).padStart(2, "0")}`;
  };
  function seek(t) {
    S.t = Math.max(0, Math.min(t, dur()));
    if (MS) MS.seek(S.t);
    showTime();
  }
  function showTime() {
    $("#tc").textContent = tc(S.t);
    $("#tc-sec").textContent = S.t.toFixed(3) + "s";
    $("#playhead").style.transform = `translateX(${x(S.t)}px)`;
    drawOverlay();
  }
  function play() {
    if (!MS) return;
    if (S.t >= dur() - 1e-3) seek(0);
    MS.play(S.rate);
    S.playing = true;
    document.body.classList.add("playing");
    syncAudio(true);
  }
  function pause() {
    if (MS) MS.pause();
    snd.pause();
    S.playing = false;
    document.body.classList.remove("playing");
  }
  const toggle = () => (S.playing ? pause() : play());
  const step = n => { pause(); seek(Math.round(S.t * fps() + n) / fps()); };

  let gating = false;
  (function tick() {
    if (S.playing && MS && !gating) {
      S.t = MS.time();
      if (!MS.playing()) {
        if (S.loop) { MS.seek(0); MS.play(S.rate); S.t = 0; syncAudio(true); }
        else { S.playing = false; snd.pause(); document.body.classList.remove("playing"); }
      } else syncAudio(false);
      showTime();
    }
    requestAnimationFrame(tick);
  })();

  // ── timeline ─────────────────────────────────────────
  const trackW = () => Math.max(50, wrap.clientWidth - 16);
  const x = t => (t / dur()) * trackW();

  function easePath(name) {
    let fn;
    try { fn = gsap.parseEase(name); } catch { fn = null; }
    if (typeof fn !== "function") fn = p => p;
    const pts = Array.from({ length: 41 }, (_, i) => fn(i / 40));
    const lo = Math.min(0, ...pts), hi = Math.max(1, ...pts);
    return pts.map((v, i) => `${i ? "L" : "M"}${(i / 40 * 100).toFixed(2)},${(92 - (v - lo) / (hi - lo) * 84).toFixed(2)}`).join("");
  }

  function drawTimeline() {
    // One lane per target set, in first-start order
    const groups = new Map();
    for (const tw of S.tweens) {
      if (!tw.targets.length) continue;
      const key = tw.targets.join(" ");
      if (!groups.has(key)) groups.set(key, { key, names: tw.targets, tweens: [] });
      groups.get(key).tweens.push(tw);
    }
    S.groups = [...groups.values()];
    const W = trackW();
    const issuesOf = g => (S.report ? S.report.issues.filter(i => g.names.includes(i.element)) : []);

    $("#labels").replaceChildren(...S.groups.map(g => h("div", {
      "data-key": g.key, title: g.key, class: g.names.includes(S.hl) ? "hl" : "",
      onmouseenter: () => highlight(g.names[0]), onmouseleave: () => highlight(null),
    }, issuesOf(g).length ? h("i", {}, "●") : null, g.names.length > 2 ? `${g.names[0]} +${g.names.length - 1}` : g.key)));

    $("#lanes").replaceChildren(...S.groups.map(g => h("div", { class: "lane" + (g.names.includes(S.hl) ? " hl" : "") },
      issuesOf(g).map(i => h("div", { class: `shade ${i.severity}`, style: `left:${x(i.t0)}px;width:${Math.max(3, x(i.t1) - x(i.t0))}px` })),
      g.tweens.map(tw => {
        const span = tw.repeat < 0 ? dur() - tw.start : tw.duration * (tw.repeat + 1);
        const w = Math.max(3, x(span));
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 100 100");
        svg.setAttribute("preserveAspectRatio", "none");
        svg.innerHTML = `<path d="${easePath(tw.ease)}"/>`;
        return h("div", {
          class: `bar${tw.from ? " from" : ""}${tw.repeat ? " loop" : ""}`, "data-start": tw.start, "data-i": S.tweens.indexOf(tw),
          style: `left:${x(tw.start)}px;width:${w}px`,
          title: `${tw.start.toFixed(2)}s +${tw.duration.toFixed(2)}s · ${tw.ease}${tw.from ? " · from" : ""} · ${tw.props.join(", ")}${tw.id ? " · id " + tw.id : ""}${tw.src ? " · double-click to edit" : ""}`,
        }, svg, w > 70 ? h("span", {}, `${tw.ease} · ${tw.props.join(",")}`) : null);
      }))));

    // Ruler: frame ticks when there is room, seconds labelled
    const pps = W / dur();
    const minor = pps > 400 ? 1 / fps() * 6 : pps > 120 ? 0.1 : 0.25;
    const label = pps > 220 ? 0.25 : pps > 90 ? 0.5 : 1;
    const ruler = $("#ruler");
    const kids = [];
    for (let t = 0; t <= dur() + 1e-6; t += minor) {
      const isLabel = Math.abs(t / label - Math.round(t / label)) < 1e-6;
      kids.push(h("div", { class: "tick" + (isLabel ? " s" : ""), style: `left:${x(t)}px` }, isLabel ? h("b", {}, t.toFixed(label < 1 ? 2 : 0).replace(/\.?0+$/, "") + "s") : null));
    }
    if (S.report) for (const i of S.report.issues) kids.push(h("div", { class: `iss ${i.severity}`, style: `left:${x(i.t0)}px;width:${Math.max(4, x(i.t1) - x(i.t0))}px`, title: `${i.rule}: ${i.message}` }));
    if (S.audio) for (const c of S.audio.cues) kids.push(h("div", { class: "cue", style: `left:${x(c.event)}px`, title: `${c.sound} at ${c.event.toFixed(2)}s` }));
    S.notes.forEach((n, i) => kids.push(h("div", {
      class: "flag" + (n.status === "resolved" ? " resolved" : ""), style: `left:${x(n.t)}px`, title: n.text,
      onpointerdown: e => e.stopPropagation(), onclick: () => selectNote(n.id, true),
    }, i + 1)));
    ruler.replaceChildren(...kids);
    showTime();
  }

  // Scrub anywhere on the ruler or lanes
  wrap.addEventListener("pointerdown", e => {
    if (!MS || e.button !== 0) return;
    pause();
    wrap.setPointerCapture(e.pointerId);
    const left = wrap.getBoundingClientRect().left;
    let raf = 0, last = e.clientX;
    const apply = () => { raf = 0; seek(((last - left) / trackW()) * dur()); };
    apply();
    const move = ev => { last = ev.clientX; raf ||= requestAnimationFrame(apply); };
    const up = () => { wrap.removeEventListener("pointermove", move); wrap.removeEventListener("pointerup", up); wrap.removeEventListener("pointercancel", up); };
    wrap.addEventListener("pointermove", move);
    wrap.addEventListener("pointerup", up);
    wrap.addEventListener("pointercancel", up);
  });

  // ── tracked + highlight ─────────────────────────────────────────
  function drawTracked() {
    const names = (S.info && S.info.tracked) || [];
    $("#tracked-count").textContent = names.length || "";
    const bad = new Set(S.report ? S.report.issues.map(i => i.element) : []);
    $("#tracked").replaceChildren(...names.map(n => h("li", {
      class: (bad.has(n) ? "issue" : "") + (S.hl === n ? " hl" : ""),
      onmouseenter: () => highlight(n), onmouseleave: () => highlight(null),
    }, n)));
  }
  function highlight(name) {
    S.hl = name;
    for (const [i, g] of S.groups.entries()) {
      const on = !!name && g.names.includes(name);
      $("#labels").children[i]?.classList.toggle("hl", on);
      $("#lanes").children[i]?.classList.toggle("hl", on);
      $("#lanes").children[i]?.querySelectorAll(".bar").forEach(b => b.classList.toggle("on", on));
    }
    for (const li of $("#tracked").children) li.classList.toggle("hl", li.textContent === name);
    drawOverlay();
  }

  // ── notes ─────────────────────────────────────────
  async function loadNotes() {
    if (!S.id) return;
    S.notes = await api(`/api/scenes/${S.id}/notes`);
    drawNotes();
    drawTimeline();
    const btn = document.querySelector(`#scene-list button[data-id="${S.id}"] .n`);
    const open = S.notes.filter(n => n.status === "open").length;
    if (btn) btn.textContent = open ? open + " open" : "";
  }

  function drawNotes() {
    const open = S.notes.filter(n => n.status === "open").length;
    $("#notes-count").textContent = open || "";
    const list = $("#notes");
    if (!S.notes.length) {
      list.replaceChildren(h("li", { class: "empty" }, "No notes yet. Scrub to a moment, press N, click the frame, say what should change."));
      return;
    }
    list.replaceChildren(...S.notes.map((n, i) => {
      const reply = h("form", { class: "reply", onsubmit: async e => {
        e.preventDefault();
        const v = e.target.elements.r.value.trim();
        if (!v) return;
        await api(`/api/scenes/${S.id}/notes/${n.id}`, { method: "POST", body: { reply: v, by: "jay" } });
        loadNotes();
      } }, h("input", { name: "r", placeholder: "Reply…", autocomplete: "off" }));
      return h("li", { class: `note ${n.status}${S.selNote === n.id ? " sel" : ""}`, "data-id": n.id },
        h("header", {},
          h("span", { class: "num" }, i + 1),
          h("button", { class: "at", onclick: () => selectNote(n.id, true) }, `${n.t.toFixed(2)}s · ${tc(n.t)}`),
          h("span", { class: "st" }, n.status)),
        h("div", { class: "body" }, n.text),
        n.replies.map(r => h("div", { class: "rep" + (r.by === "jay" ? "" : " ai") }, h("b", {}, r.by === "jay" ? "Jay" : "AI"), r.text)),
        h("div", { class: "acts" },
          h("button", { onclick: async () => {
            await api(`/api/scenes/${S.id}/notes/${n.id}`, { method: "POST", body: { status: n.status === "open" ? "resolved" : "open" } });
            loadNotes();
          } }, n.status === "open" ? "Resolve" : "Reopen"),
          h("button", { onclick: () => { reply.classList.toggle("open"); reply.elements.r.focus(); } }, "Reply"),
          h("button", { onclick: async () => { await api(`/api/scenes/${S.id}/notes/${n.id}`, { method: "DELETE" }); loadNotes(); } }, "Delete")),
        reply);
    }));
  }

  function selectNote(id, go) {
    S.selNote = id;
    const n = S.notes.find(m => m.id === id);
    tab("notes");
    if (go && n) { pause(); seek(n.t); }
    drawNotes();
    drawOverlay();
    document.querySelector(`.note[data-id="${id}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function startPin() {
    if (!MS) return;
    pause();
    S.pinning = true;
    stage.classList.add("pinning");
    $("#pin-at").textContent = `${S.t.toFixed(2)}s`;
    $("#pin-hint").hidden = false;
  }
  function endPin() {
    S.pinning = false;
    stage.classList.remove("pinning");
    $("#pin-hint").hidden = true;
    $("#pop").hidden = true;
  }
  let draft = null;
  stage.addEventListener("click", e => {
    if (!S.pinning) return;
    const r = stage.getBoundingClientRect();
    draft = { t: S.t, x: +((e.clientX - r.left) / r.width * 100).toFixed(2), y: +((e.clientY - r.top) / r.height * 100).toFixed(2) };
    const w = well.getBoundingClientRect();
    const pop = $("#pop");
    pop.hidden = false;
    pop.style.left = Math.min(e.clientX - w.left + 14, w.width - 316) + "px";
    pop.style.top = Math.min(e.clientY - w.top + 14, w.height - 130) + "px";
    $("#pop-at").textContent = `Note at ${S.t.toFixed(2)}s`;
    $("#pin-hint").hidden = true;
    const ta = $("#pop-text");
    ta.value = "";
    ta.focus();
  });
  $("#pop-text").addEventListener("keydown", async e => {
    if (e.key === "Escape") { e.preventDefault(); endPin(); }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const text = e.target.value.trim();
      if (!text || !draft) return;
      const note = await api(`/api/scenes/${S.id}/notes`, { method: "POST", body: { ...draft, text } });
      endPin();
      await loadNotes();
      selectNote(note.id, false);
    }
  });
  $("#add-note").addEventListener("click", startPin);

  // ── lint ─────────────────────────────────────────
  async function loadReport() {
    S.report = await api(`/api/scenes/${S.id}/report`).catch(() => null);
    drawReport();
  }
  function drawReport() {
    const r = S.report;
    const score = $("#score");
    score.textContent = r ? r.score : "—";
    score.classList.toggle("bad", !!r && r.issues.some(i => i.severity === "error"));
    $("#lint-score").innerHTML = r ? `${r.score}<small> /100</small>` : "—";
    $("#lint-perf").textContent = r ? (r.perf ? `p95 ${r.perf.p95}ms · ${r.perf.droppedPct}% dropped` : "curves only, playback not measured") : "Not linted yet";
    if (!S.linting) $("#lint-state").textContent = r ? "linted " + new Date(r.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
    $("#issues-count").textContent = r && r.issues.length ? r.issues.length : "";
    const list = $("#issues");
    if (!r) list.replaceChildren(h("li", { class: "empty" }, "Run lint to sample every element's curve and measure real playback."));
    else if (!r.issues.length) list.replaceChildren(h("li", { class: "empty" }, "Clean. Every move eases to rest, nothing teleports, playback holds 60 fps."));
    else list.replaceChildren(...[...r.issues].sort((a, b) => SEV.indexOf(a.severity) - SEV.indexOf(b.severity) || a.t0 - b.t0).map(i => h("li", {
      class: `issue ${i.severity}`,
      onclick: () => { pause(); seek(i.t0); highlight(i.element); if (!S.onion) setOnion(true); },
      onmouseenter: () => highlight(i.element), onmouseleave: () => highlight(null),
    }, h("div", { class: "h" }, h("b", {}, i.rule), h("span", { class: "el" }, i.element), h("code", {}, `${i.t0.toFixed(2)}s`)),
      h("p", {}, i.message), h("small", {}, i.fix))));
    drawTracked();
    drawTimeline();
  }
  async function runLint(perf = true) {
    if (!S.id || S.linting) return;
    S.linting = true;
    $("#run-lint").disabled = true;
    $("#lint-state").textContent = perf ? "linting + measuring…" : "linting…";
    try {
      S.report = await api(`/api/scenes/${S.id}/lint`, { method: "POST", body: { perf } });
    } catch (e) {
      $("#lint-state").textContent = "lint failed: " + e.message;
    }
    S.linting = false;
    $("#run-lint").disabled = false;
    drawReport();
  }
  $("#run-lint").addEventListener("click", () => runLint(true));

  // ── sound ─────────────────────────────────────────
  // The same mix the render muxes in (built by the server, cached until the scene changes), played in step with
  // the timeline. Below ¼× speed it stays silent: stretched sound says nothing about timing.
  const snd = $("#snd");
  async function loadAudio() {
    const id = S.id, btn = $("#sound");
    btn.dataset.state = "loading";
    btn.title = "Building the sound…";
    const a = await api(`/api/scenes/${id}/audio`).catch(e => ({ error: e.message }));
    if (id !== S.id) return;
    // Held in memory, so a resync seek is instant instead of a new range request
    const blob = a.src && await fetch(a.src).then(r => r.blob()).catch(() => null);
    if (id !== S.id) return;
    if (snd.src.startsWith("blob:")) URL.revokeObjectURL(snd.src);
    S.audio = blob ? a : null;
    if (blob) snd.src = URL.createObjectURL(blob); else snd.removeAttribute("src");
    btn.dataset.state = a.error ? "error" : a.src ? "" : "none";
    btn.title = a.error ? "Sound failed: " + a.error : a.src ? `Sound (M) · ${a.cues.length} cues${a.music ? " + music" : ""} · ${a.lufs} LUFS` : "No sound declared in MS.register(tl, { audio })";
    drawTimeline();
    if (S.playing) syncAudio(true);
  }
  // Starting sound takes ~80 ms, so the timeline waits for it instead of chasing it with seeks (a seek per frame
  // stutters); after that only a real drift resyncs.
  let gate = 0;
  async function syncAudio(force) {
    if (!S.audio || !MS) return;
    if (!(S.playing && S.sound && S.rate >= 0.25)) { if (!snd.paused) snd.pause(); return; }
    if (snd.playbackRate !== S.rate) snd.playbackRate = S.rate;
    if (gating || S.t >= dur() - 0.02) return;
    const drift = S.t - snd.currentTime;
    if (!force && !snd.paused && Math.abs(drift) < 0.25) {
      // Small drift (the sound's output stalls a few frames after starting): ease the picture's speed toward the
      // sound's clock, at most ±20 %, instead of jumping either one
      const k = Math.abs(drift) < 0.015 ? 1 : 1 - Math.max(-0.1, Math.min(0.1, drift)) * 2;
      if (S.t < dur() - 0.05) MS.play(S.rate * k);
      return;
    }
    const g = ++gate;
    gating = true;
    MS.pause();
    snd.currentTime = S.t;
    try {
      await snd.play();
      // play() resolves before the sound's clock moves: start the picture when it does
      const t0 = snd.currentTime, w = performance.now();
      while (snd.currentTime === t0 && !snd.paused && performance.now() - w < 300) await new Promise(r => requestAnimationFrame(r));
    } catch { /* blocked or interrupted: the picture plays on without sound */ }
    gating = false;
    if (g !== gate || !S.playing) return;
    MS.seek(snd.paused ? S.t : snd.currentTime);
    MS.play(S.rate);
  }
  function setSound(v) { S.sound = v; $("#sound").setAttribute("aria-pressed", v); syncAudio(true); }
  $("#sound").addEventListener("click", () => setSound(!S.sound));

  // ── files ─────────────────────────────────────────
  const GROUPS = [["output", "Renders & output"], ["source", "Source"], ["assets", "Assets"], ["refs", "References"]];
  const size = b => b < 1024 ? b + " B" : b < 1048576 ? (b / 1024).toFixed(0) + " KB" : (b / 1048576).toFixed(1) + " MB";
  const ago = ms => { const m = (Date.now() - ms) / 60000; return m < 1 ? "now" : m < 60 ? Math.round(m) + "m" : m < 1440 ? Math.round(m / 60) + "h" : Math.round(m / 1440) + "d"; };
  async function loadFiles() {
    if (!S.id) return;
    S.files = await api(`/api/scenes/${S.id}/files`).catch(() => []);
    $("#files").replaceChildren(...GROUPS.map(([g, label]) => {
      const list = S.files.filter(f => f.group === g).sort((a, b) => b.mtime - a.mtime);
      if (!list.length) return null;
      return h("section", { class: "fgroup" }, h("h3", {}, label),
        h("ul", {}, list.map(f => h("li", {}, h("button", { onclick: () => view(f), title: f.name },
          h("span", { class: "nm" }, f.name.replace(/^\.ms\/(refs\/)?/, "")),
          h("span", { class: "sz" }, `${size(f.size)} · ${ago(f.mtime)}`))))));
    }).filter(Boolean));
  }
  async function view(f) {
    const ext = f.name.split(".").pop().toLowerCase();
    const src = f.url + "?v=" + Math.round(f.mtime);
    $("#viewer-name").textContent = f.name;
    $("#viewer-open").href = src;
    $("#viewer-dl").href = src;
    $("#viewer-dl").setAttribute("download", f.name.split("/").pop());
    const body = $("#viewer-body");
    if (/^(png|jpe?g|webp|gif|svg)$/.test(ext)) body.replaceChildren(h("img", { src, alt: f.name }));
    else if (/^(mp4|webm)$/.test(ext)) body.replaceChildren(h("video", { src, controls: true, autoplay: true }));
    else if (/^(wav|mp3|m4a|ogg)$/.test(ext)) body.replaceChildren(h("audio", { src, controls: true, autoplay: true }));
    else if (f.size < 400000) body.replaceChildren(h("pre", {}, await fetch(src).then(r => r.text())));
    else body.replaceChildren(h("p", { class: "mute" }, "No preview. Use Open or Download."));
    pause();
    $("#viewer").showModal();
  }
  const closeViewer = () => $("#viewer").close();
  $("#viewer-close").addEventListener("click", closeViewer);
  $("#viewer").addEventListener("close", () => $("#viewer-body").replaceChildren());
  $("#viewer").addEventListener("click", e => { if (e.target === e.currentTarget) closeViewer(); });

  // ── sounds: the scene's earshot kit, every role auditionable ──
  let kitFor = null;
  const preview = new Audio();
  async function loadSounds() {
    if (!S.id || kitFor === S.id) return;
    $("#kit-note").textContent = "Rendering kit… (first time takes a minute)";
    const kit = await api(`/api/scenes/${S.id}/sounds`).catch(e => ({ error: e.message || "kit failed" }));
    if (kit.error) { $("#kit-note").textContent = kit.error; return; }
    kitFor = S.id;
    $("#kit-note").textContent = `Kit “${kit.name}”${kit.own ? " (this scene's kit.json)" : " from MOTION.md"}. ${kit.note}`.trim();
    const play = (u, b) => { preview.pause(); preview.src = u; preview.play(); b.classList.add("on"); preview.onended = preview.onpause = () => b.classList.remove("on"); };
    $("#roles").replaceChildren(...kit.roles.map(r => h("li", { class: r.off ? "off" : "" },
      h("div", { class: "rhead" }, h("b", {}, r.role), r.off ? h("span", { class: "mute" }, r.off)
        : h("button", { class: "copy", title: "Copy a cue for scene.js", onclick: e => {
            navigator.clipboard && navigator.clipboard.writeText(`{ t: ${S.t.toFixed(2)}, sound: "${r.role}" }`);
            e.currentTarget.textContent = "copied"; } }, "copy cue")),
      r.off ? null : h("div", { class: "takes" }, r.takes.map((t, i) =>
        h("button", { class: "take", title: `${r.sound}${t.pitch ? " · pitch " + t.pitch : ""}`, onclick: e => play(t.url, e.currentTarget) }, "▶ " + (i + 1)))),
      r.note ? h("p", { class: "mute" }, r.note) : null)));
  }

  // ── inspector: double-click a bar, change start / duration / ease / stagger; the server rewrites that call in
  // scene.js (core/edit.mjs) and the stage reloads at the same playhead ──
  const insp = $("#insp");
  function inspect(tw, px, py) {
    const eases = [...new Set([...Object.keys(frame.contentWindow.MS_TOKENS?.eases || {}).map(k => "ms." + k), tw.ease])];
    $("#insp-what").textContent = `${tw.targets.join(" ")} · ${tw.from ? "from " : ""}${tw.props.join(", ")}`;
    $("#insp-src").textContent = (tw.id ? tw.id + " · " : "") + tw.src;
    $("#insp-at").value = tw.start;
    $("#insp-dur").value = tw.duration;
    $("#insp-ease").replaceChildren(...eases.map(e => h("option", { value: e, selected: e === tw.ease }, e)));
    $("#insp-stagger").value = "";
    $("#insp-msg").textContent = "";
    insp.tw = tw;
    insp.hidden = false;
    const r = insp.getBoundingClientRect();
    insp.style.left = Math.max(8, Math.min(innerWidth - r.width - 8, px - r.width / 2)) + "px";
    insp.style.top = Math.max(8, py - r.height - 14) + "px";
    $("#insp-dur").focus();
  }
  async function applyInspect(e) {
    e.preventDefault();
    const tw = insp.tw, op = { tween: tw.src };
    const at = +$("#insp-at").value, d = +$("#insp-dur").value, ease = $("#insp-ease").value, st = $("#insp-stagger").value;
    if (Math.abs(at - tw.start) > 1e-4) op.at = at;
    if (Math.abs(d - tw.duration) > 1e-4) op.dur = d;
    if (ease !== tw.ease) op.ease = ease;
    if (st !== "") op.stagger = +st;
    if (Object.keys(op).length === 1) { insp.hidden = true; return; }
    const r = await fetch(`/api/scenes/${S.id}/edit`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ops: [op], tweens: S.tweens }) }).then(r => r.json());
    if (r.error) { $("#insp-msg").textContent = r.error; return; }
    insp.hidden = true;
  }
  $("#insp-form").addEventListener("submit", applyInspect);
  $("#insp-cancel").addEventListener("click", () => { insp.hidden = true; });
  insp.addEventListener("keydown", e => { if (e.key === "Escape") insp.hidden = true; });
  wrap.addEventListener("dblclick", e => {
    const bar = document.elementFromPoint(e.clientX, e.clientY)?.closest(".bar");
    const tw = bar && S.tweens[+bar.dataset.i];
    if (tw && tw.src) inspect(tw, e.clientX, bar.getBoundingClientRect().top);
  });

  async function upload(list) {
    const drop = $("#drop"), was = drop.textContent;
    for (const f of list) {
      drop.textContent = `Uploading ${f.name}…`;
      const r = await fetch(`/api/scenes/${S.id}/files?name=${encodeURIComponent(f.name)}`, { method: "POST", body: f });
      if (!r.ok) { drop.textContent = (await r.json().catch(() => ({}))).error || "upload failed"; return; }
    }
    drop.textContent = was;
    loadFiles();
  }
  $("#upload").addEventListener("click", () => $("#upload-input").click());
  $("#upload-input").addEventListener("change", e => { upload([...e.target.files]); e.target.value = ""; });
  const right = document.querySelector(".right");
  right.addEventListener("dragover", e => { if (!S.id) return; e.preventDefault(); tab("files"); $("#drop").classList.add("over"); });
  right.addEventListener("dragleave", e => { if (!right.contains(e.relatedTarget)) $("#drop").classList.remove("over"); });
  right.addEventListener("drop", e => { e.preventDefault(); $("#drop").classList.remove("over"); if (e.dataTransfer.files.length) upload([...e.dataTransfer.files]); });

  $("#render").addEventListener("click", async () => {
    const b = $("#render");
    b.disabled = true;
    b.textContent = "Rendering…";
    try {
      const r = await api(`/api/scenes/${S.id}/render`, { method: "POST" });
      await loadFiles();
      const f = S.files.find(x => x.name === r.file.replace(/\\/g, "/"));
      if (f) view(f);
    } catch (e) { $("#drop").textContent = "Render failed: " + e.message; }
    b.disabled = false;
    b.textContent = "Render MP4";
  });

  // ── projects home ─────────────────────────────────────────
  // Every scene as a card: a still near the end, format, length, where it stands (open notes, lint, critic, render).
  // Hovering a rendered project plays its MP4. Stills are taken by the server, one at a time, when missing or stale.
  const home = $("#home");
  const RATIOS = [["16:9", 16 / 9], ["9:16", 9 / 16], ["1:1", 1], ["4:5", 4 / 5]];
  const formatOf = p => {
    if (!p.width) return "";
    if (p.kind === "web") return "web";
    const r = p.width / p.height, hit = RATIOS.find(([, v]) => Math.abs(v - r) < 0.02);
    return hit ? hit[0] : `${p.width}×${p.height}`;
  };
  let projects = [];
  async function loadProjects() {
    projects = await api("/api/projects").catch(() => projects);
    drawProjects();
    clearTimeout(loadProjects.t);
    if (projects.some(x => x.make && x.make.running)) loadProjects.t = setTimeout(() => !home.hidden && loadProjects(), 4000);
    for (const p of projects.filter(x => !x.posterFresh && !(x.make && x.make.running))) {
      const fresh = await api(`/api/scenes/${p.id}/poster`, { method: "POST" }).catch(() => null);
      if (!fresh || home.hidden) continue;
      projects = projects.map(x => x.id === fresh.id ? fresh : x);
      const old = document.querySelector(`.card[data-id="${CSS.escape(fresh.id)}"]`);
      if (old) old.replaceWith(card(fresh));
    }
  }
  function card(p) {
    const fmt = formatOf(p);
    const mf = p.make && p.make.format;
    const ratio = p.width ? `${p.width}/${p.height}` : mf && mf !== "web" ? mf.replace(":", "/") : "16/9";
    const media = h("button", { class: "thumb", onclick: () => go(p.id), "aria-label": `Open ${p.title}` },
      h("div", { class: "frame", style: `aspect-ratio:${ratio}` },
        p.poster ? h("img", { src: p.poster, alt: "", loading: "lazy" }) : h("span", { class: "wait mute" }, "taking a still…")),
      p.duration ? h("span", { class: "dur" }, p.duration.toFixed(1) + "s") : null);
    if (p.render) {
      let v = null;
      media.addEventListener("pointerenter", () => {
        v = h("video", { src: p.render, muted: true, loop: true, playsinline: true, autoplay: true });
        v.muted = true;
        media.querySelector(".frame").append(v);
      });
      media.addEventListener("pointerleave", () => { if (v) v.remove(); v = null; });
    }
    const verdict = p.critic && p.critic.verdict;
    const mk = p.make && (p.make.running || p.make.error) ? p.make : null;
    if (mk && !p.poster) media.querySelector(".wait").textContent = mk.error ? "build failed" : "building…";
    return h("li", { class: "card" + (mk && mk.running ? " making" : ""), "data-id": p.id }, media,
      h("div", { class: "body" },
        h("h3", {}, h("a", { href: "#" + p.id }, p.title)),
        h("p", { class: "mute meta" }, [fmt, p.kind !== fmt && p.kind, p.width ? `${p.width}×${p.height}` : null, `edited ${ago(p.edited)}`].filter(Boolean).join(" · ")),
        h("div", { class: "chips" },
          p.notes ? h("span", { class: "chip hot" }, `${p.notes} open note${p.notes > 1 ? "s" : ""}`) : null,
          p.lint != null ? h("span", { class: `chip${p.lint < 80 ? " warn" : ""}` }, `lint ${p.lint}`) : null,
          verdict ? h("span", { class: `chip${verdict === "SHIP" ? " ok" : ""}` }, `critic r${p.critic.round} ${verdict.toLowerCase()}`) : null,
          p.render ? h("span", { class: "chip ok" }, "rendered") : null,
          mk ? h("span", { class: `chip ${mk.error ? "warn" : "hot"}` }, mk.error ? "make failed" : `AI · ${mk.stage}`) : null),
        mk ? h("p", { class: "mute mklog", title: mk.error || mk.last.join("\n") }, mk.error || mk.last[mk.last.length - 1] || "") : null,
        h("div", { class: "acts" },
          h("a", { class: "btn", href: "#" + p.id }, "Open"),
          h("button", { class: "btn", onclick: () => dup(p) }, "Duplicate"))));
  }
  function drawProjects() {
    const q = $("#proj-q").value.trim().toLowerCase();
    const list = projects.filter(p => !q || (p.title + " " + p.id + " " + formatOf(p) + " " + (p.kind || "")).toLowerCase().includes(q));
    $("#projects").replaceChildren(...list.map(card));
    $("#proj-count").textContent = projects.length;
    $("#proj-empty").hidden = !!list.length || !projects.length;
  }
  $("#proj-q").addEventListener("input", drawProjects);
  async function dup(p) {
    let id = p.id + "-copy", n = 2;
    while (projects.some(x => x.id === id)) id = `${p.id}-copy-${n++}`;
    await api(`/api/scenes/${p.id}/duplicate`, { method: "POST", body: { id } });
    await loadScenes();
    loadProjects();
  }

  // New project: the id follows the title until it is typed by hand
  const nf = $("#new-form");
  let idTouched = false;
  const slug = s => s.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-").slice(0, 40);
  nf.elements.title.addEventListener("input", () => { if (!idTouched) nf.elements.id.value = slug(nf.elements.title.value); });
  nf.elements.id.addEventListener("input", () => { idTouched = true; });
  for (const r of nf.querySelectorAll("[name=format]")) r.addEventListener("change", () => { r.dataset.touched = "1"; });
  nf.addEventListener("reset", () => nf.querySelectorAll("[name=format]").forEach(r => delete r.dataset.touched));
  function newProject(open = true) {
    if (home.hidden) go("");
    nf.hidden = !open;
    $("#new-project").hidden = open;
    if (open) { idTouched = false; nf.elements.title.focus(); }
  }
  $("#new-project").addEventListener("click", () => newProject(true));
  $("#new-scene").addEventListener("click", () => newProject(true));
  $("#new-cancel").addEventListener("click", () => { nf.reset(); $("#new-err").textContent = ""; newProject(false); });
  // With a description the button reads "Make with AI": the server runs `ms make` and the card shows its progress
  nf.elements.prompt.addEventListener("input", () => { $("#new-go").textContent = nf.elements.prompt.value.trim() ? "Make with AI" : "Create"; });
  nf.addEventListener("submit", async e => {
    e.preventDefault();
    const el = nf.elements;
    try {
      const prompt = el.prompt.value.trim();
      if (prompt) {
        const fmt = nf.querySelector("[name=format]:checked").dataset.touched ? el.format.value : "";
        await api("/api/make", { method: "POST", body: { prompt, id: el.id.value.trim() || undefined, format: fmt || undefined } });
        nf.reset();
        $("#new-go").textContent = "Create";
        $("#new-err").textContent = "";
        newProject(false);
        setTimeout(loadProjects, 1500);
        return;
      }
      if (!el.title.value.trim() || !el.id.value.trim()) throw new Error("give it a title, or describe it for the AI");
      const { id } = await api("/api/scenes", { method: "POST", body: { id: el.id.value.trim(), title: el.title.value.trim(), format: el.format.value, kind: el.kind.value } });
      nf.reset();
      $("#new-err").textContent = "";
      newProject(false);
      await loadScenes();
      go(id);
    } catch (err) { $("#new-err").textContent = err.message; }
  });

  // Route: "#" is the home, "#<id>" the editor on that scene. Back returns home.
  const go = id => { if (location.hash.slice(1) === id) route(); else location.hash = id; };
  function route() {
    const id = decodeURIComponent(location.hash.slice(1));
    const showHome = !id || !S.scenes.some(s => s.id === id);
    home.hidden = !showHome;
    document.body.classList.toggle("at-home", showHome);
    if (showHome) { pause(); $("#viewer").open && $("#viewer").close(); document.title = "Motion Studio"; loadProjects(); }
    else if (id !== S.id || !MS) { openScene(id); document.title = id + " · Motion Studio"; }
  }
  addEventListener("hashchange", route);

  // ── controls ─────────────────────────────────────────
  function tab(name) {
    for (const b of document.querySelectorAll(".tabs button")) b.setAttribute("aria-selected", b.dataset.tab === name);
    $("#panel-notes").hidden = name !== "notes";
    $("#panel-lint").hidden = name !== "lint";
    $("#panel-files").hidden = name !== "files";
    $("#panel-sounds").hidden = name !== "sounds";
    if (name === "sounds") loadSounds();
  }
  for (const b of document.querySelectorAll(".tabs button")) b.addEventListener("click", () => tab(b.dataset.tab));
  function setRate(r) {
    S.rate = r;
    for (const b of document.querySelectorAll("#rates button")) b.setAttribute("aria-pressed", +b.dataset.rate === r);
    if (S.playing) { MS.play(r); syncAudio(true); }
  }
  for (const b of document.querySelectorAll("#rates button")) b.addEventListener("click", () => setRate(+b.dataset.rate));
  const setLoop = v => { S.loop = v; $("#loop").setAttribute("aria-pressed", v); };
  function setOnion(v) { S.onion = v; $("#onion").setAttribute("aria-pressed", v); drawOverlay(); }
  $("#loop").addEventListener("click", () => setLoop(!S.loop));
  $("#onion").addEventListener("click", () => setOnion(!S.onion));
  $("#play").addEventListener("click", toggle);
  $("#step-back").addEventListener("click", () => step(-1));
  $("#step-fwd").addEventListener("click", () => step(1));
  $("#to-start").addEventListener("click", () => { pause(); seek(0); });

  addEventListener("keydown", e => {
    if (e.target.closest("textarea, input, select") || !home.hidden) return;
    const k = e.key;
    if (k === " ") { e.preventDefault(); toggle(); }
    else if (k === "ArrowLeft" || k === "ArrowRight") { e.preventDefault(); step((k === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 10 : 1)); }
    else if (k === "Home") { pause(); seek(0); }
    else if (k === "End") { pause(); seek(dur()); }
    else if (k === "n" || k === "N") startPin();
    else if (k === "l" || k === "L") setLoop(!S.loop);
    else if (k === "i" || k === "I") setOnion(!S.onion);
    else if (k === "m" || k === "M") setSound(!S.sound);
    else if (k === "Escape") endPin();
    else if ("1234".includes(k)) setRate([0.1, 0.25, 0.5, 1][+k - 1]);
  });
  // The well changes size when the timeline grows (more lanes) as well as on window resize
  new ResizeObserver(() => fit()).observe(well);
  new ResizeObserver(() => S.info && drawTimeline()).observe(wrap);

  // ── live reload ─────────────────────────────────────────
  function connect() {
    const es = new EventSource("/api/events");
    const live = $("#live");
    const dots = [live, $("#home-live")];
    es.onopen = () => dots.forEach(d => d.classList.add("on"));
    es.onerror = () => dots.forEach(d => d.classList.remove("on"));
    es.onmessage = async ev => {
      const m = JSON.parse(ev.data);
      if (m.type === "change") await loadScenes();
      if (!home.hidden) { if (m.type !== "files") loadProjects(); return; }
      if (m.scene !== S.id) return;
      live.classList.remove("flash"); void live.offsetWidth; live.classList.add("flash");
      if (m.type === "change") {
        await openScene(S.id, { t: S.t, playing: S.playing });
        runLint(false);
      } else if (m.type === "notes") loadNotes();
      else if (m.type === "report" && !S.linting) loadReport();
      else if (m.type === "files") loadFiles();
    };
  }

  (async () => {
    await loadScenes();
    connect();
    route();
  })();
})();
