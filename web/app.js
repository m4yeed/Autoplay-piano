const $ = (s, r = document) => r.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v === false || v == null) continue;
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) {
    if (kid === false || kid == null) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return n;
};

async function api(path, body) {
  const r = await fetch(
    "/api/" + path,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  return r.json();
}

// One step = one whitespace-separated group or a [bracket] group.
// Spaces, commas and dashes (- – — −) separate notes: f-g-s = three notes.
// Everything that is not a playable key (+ | . quotes ...) is removed.
// Groups without brackets: settings.bareNotes = 'single' plays every key as its own note;
// 'chord' plays a short group as one chord (longer than settings.maxChord is split).
const NOT_PLAYABLE = /[^a-zA-Z0-9!@#$%^&*()]/g;
const NOTE_BREAK = /[-\u2013\u2014\u2212,]/;
function parseNotes(t) {
  const max = data.settings.maxChord || 6;
  const single = data.settings.bareNotes !== "chord";
  const out = [];
  for (const m of t.match(/\[[^\]]*\]|[^\s\[\]]+/g) || []) {
    const bracket = m[0] === "[";
    for (const piece of bracket ? [m] : m.split(NOTE_BREAK)) {
      const s = piece.replace(NOT_PLAYABLE, "");
      if (!s) continue;
      if (!bracket && (single || s.length > max)) out.push(...s.split(""));
      else out.push(s);
    }
  }
  return out;
}

const data = { songs: [], settings: {} };
let view = "library",
  prevView = "library";
let current = null,
  steps = [],
  editing = false;
let st = {},
  lastToast = 0,
  bindsJson = "",
  scrubbing = false,
  scrubBusy = false;

/* ---------------------------------------------------------------- helpers */
function toast(text) {
  const t = el("div", { class: "toast" }, text);
  $("#toasts").append(t);
  setTimeout(() => t.remove(), 2700);
}

function caps(step) {
  return [...step].map((ch) =>
    el(
      "span",
      { class: "cap" + (/[A-Z!@#$%^&*()]/.test(ch) ? " shift" : "") },
      ch,
    ),
  );
}

function applyCss() {
  $("#user-css").textContent = data.settings.css || "";
}

function applyLook() {
  document.body.classList.toggle("no-boxes", data.settings.boxes === false);
  document.body.classList.toggle("no-anim", data.settings.animations === false);
}

async function setSetting(patch) {
  Object.assign(data.settings, patch);
  applyLook();
  const r = await api("settings", patch);
  if ("onTop" in patch && r.topmostOk === false)
    toast("Couldn't pin the window on top");
  if (("maxChord" in patch || "bareNotes" in patch) && current) {
    steps = parseNotes(current.notes);
    handle(await api("load", { steps, index: 0 }));
  }
}

/* ------------------------------------------------------------------ views */
function render() {
  const v = $("#view");
  v.replaceChildren();
  const inSong = view === "song" && !editing;
  $("#btn-back").hidden = view === "library";
  $("#btn-settings").hidden = view === "settings";
  $("#arm").hidden = !inSong;
  $("#btn-edit").hidden = !inSong;
  $("#btn-reset").hidden = !inSong;
  $("#title").textContent =
    view === "library"
      ? "Piano Trigger"
      : view === "settings"
        ? "Settings"
        : editing
          ? current.isNew
            ? "New song"
            : "Edit song"
          : current.title;
  document.body.classList.toggle(
    "compact-song",
    inSong && data.settings.viewMode === "compact",
  );
  const tr = inSong && current.transcription;
  $("#tr-badge").hidden = !tr;
  $("#tr-badge").textContent = tr
    ? "Transcription: " + current.transcription
    : "";
  v.append(
    view === "library"
      ? libraryView()
      : view === "settings"
        ? settingsView()
        : songView(),
  );
  paint();
  renderBinds();
  renderTriggers();
  updateCaptureBtn();
  syncArm();
}

function libraryView() {
  const list = data.songs.map((s) => {
    const del = el(
      "button",
      {
        class: "danger",
        onclick: async (e) => {
          e.stopPropagation();
          if (del.dataset.sure) {
            data.songs = data.songs.filter((x) => x.id !== s.id);
            await api("songs/delete", { id: s.id });
            render();
          } else {
            del.dataset.sure = 1;
            del.textContent = "Delete?";
            setTimeout(() => {
              del.textContent = "Remove";
              delete del.dataset.sure;
            }, 2500);
          }
        },
      },
      "Remove",
    );
    return el(
      "div",
      { class: "song-row", onclick: () => openSong(s) },
      el("div", { class: "song-name" }, s.title || "Untitled"),
      s.transcription && el("div", { class: "song-tr" }, s.transcription),
      el("div", { class: "song-count" }, parseNotes(s.notes).length + " notes"),
      del,
    );
  });
  return el(
    "div",
    { class: "view-fill library" },
    el(
      "div",
      { class: "library-head" },
      el("span", {}, list.length ? "Your songs" : ""),
      el("button", { class: "primary", onclick: newSong }, "New song"),
    ),
    list.length
      ? list
      : el(
          "div",
          { class: "empty" },
          el("b", {}, "No songs yet"),
          "Create one and paste your notes. Each group separated by a space, comma or dash is one trigger press, " +
            "for example: pfiF gjE gKD or f-g-s",
        ),
  );
}

function songView() {
  if (editing) return editView();
  if (data.settings.viewMode === "compact") {
    return el(
      "div",
      { class: "view-fill compact" },
      el(
        "div",
        { class: "ribbon", id: "ribbon" },
        steps.map((t, i) =>
          el(
            "button",
            { class: "note", "data-i": i, onclick: () => seek(i) },
            t,
          ),
        ),
      ),
      el("div", { class: "mini-progress" }, el("i", { id: "mini-fill" })),
    );
  }
  return el(
    "div",
    { class: "view-fill" },
    el(
      "section",
      { class: "stage", id: "stage" },
      el("div", { class: "stage-label", id: "stage-label" }),
      el("div", { class: "caps big", id: "big-caps" }),
      el("div", { class: "stage-meta", id: "stage-meta" }),
    ),
    el("div", { class: "triggers", id: "triggers-row" }),
    el(
      "section",
      { class: "ribbon-wrap" },
      el(
        "div",
        { class: "ribbon", id: "ribbon" },
        steps.map((t, i) =>
          el(
            "button",
            { class: "note", "data-i": i, onclick: () => seek(i) },
            el("span", { class: "note-n" }, i + 1),
            el("span", { class: "caps" }, caps(t)),
          ),
        ),
      ),
      el(
        "div",
        { class: "scrub-row" },
        el("input", {
          type: "range",
          id: "scrub",
          class: "scrub",
          min: 0,
          max: Math.max(0, steps.length - 1),
          value: 0,
          onpointerdown: () => {
            scrubbing = true;
          },
          oninput: (e) => scrubTo(+e.target.value),
          onchange: (e) => {
            scrubbing = false;
            seek(+e.target.value);
          },
        }),
        el("span", { id: "scrub-label" }),
      ),
    ),
  );
}

function editView() {
  const title = el("input", {
    type: "text",
    placeholder: "Song title",
    value: current.title,
  });
  const tr = el("input", {
    type: "text",
    placeholder: "Transcription to pick in the game (e.g. Original, C major)",
    value: current.transcription || "",
  });
  const area = el("textarea", {
    spellcheck: "false",
    placeholder: "pfiF gjE gKD ...",
  });
  area.value = current.notes;
  const count = el("span", {});
  const upd = () => {
    count.textContent = parseNotes(area.value).length + " notes";
  };
  area.addEventListener("input", upd);
  upd();
  return el(
    "div",
    { class: "view-fill editor" },
    title,
    tr,
    area,
    el(
      "div",
      { class: "editor-foot" },
      count,
      el(
        "button",
        {
          onclick: () => {
            if (current.isNew) {
              view = "library";
            }
            editing = false;
            render();
            autoArm();
          },
        },
        "Cancel",
      ),
      el(
        "button",
        {
          class: "primary",
          onclick: () => saveSong(title.value, area.value, tr.value),
        },
        "Save",
      ),
    ),
  );
}

function settingsView() {
  const s = data.settings;
  const card = (title, ...kids) =>
    el("section", { class: "card" }, el("h2", {}, title), ...kids);
  const row = (name, desc, ctrl) =>
    el(
      "div",
      { class: "row" },
      el(
        "div",
        {},
        el("div", { class: "row-name" }, name),
        desc && el("div", { class: "row-desc" }, desc),
      ),
      ctrl,
    );
  const mk = (on, fn) => {
    const input = el("input", {
      type: "checkbox",
      checked: !!on,
      onchange: (e) => fn(e.target.checked),
    });
    return { input, node: el("label", { class: "switch" }, input, el("i")) };
  };
  const sw = (on, fn) => mk(on, fn).node;
  // minimal look = no boxes + no animations + no click sound; each one can still be switched back on
  const syncMinimal = () => {
    const d = data.settings;
    minimalSw.input.checked =
      d.boxes === false && d.animations === false && !d.clickOn;
  };
  const boxesSw = mk(s.boxes !== false, (v) => {
    setSetting({ boxes: v });
    syncMinimal();
  });
  const animSw = mk(s.animations !== false, (v) => {
    setSetting({ animations: v });
    syncMinimal();
  });
  const clickSw = mk(s.clickOn, (v) => {
    setSetting({ clickOn: v });
    syncMinimal();
  });
  const minimalSw = mk(
    s.boxes === false && s.animations === false && !s.clickOn,
    (on) => {
      boxesSw.input.checked =
        animSw.input.checked =
        clickSw.input.checked =
          !on;
      setSetting({ boxes: !on, animations: !on, clickOn: !on });
    },
  );
  const range = (key, min, max, unit = " ms") => {
    const out = el("output", {}, s[key] + unit);
    return el(
      "div",
      { class: "range" },
      el("input", {
        type: "range",
        min,
        max,
        value: s[key],
        oninput: (e) => {
          out.textContent = e.target.value + unit;
          setSetting({ [key]: +e.target.value });
        },
      }),
      out,
    );
  };
  const mode = el(
    "select",
    { onchange: (e) => setSetting({ inputMode: e.target.value }) },
    el(
      "option",
      { value: "scancode", selected: s.inputMode === "scancode" },
      "Scancode (recommended)",
    ),
    el(
      "option",
      { value: "virtual", selected: s.inputMode === "virtual" },
      "Virtual key",
    ),
  );
  const viewMode = el(
    "select",
    { onchange: (e) => setSetting({ viewMode: e.target.value }) },
    el(
      "option",
      { value: "standard", selected: s.viewMode !== "compact" },
      "Standard",
    ),
    el(
      "option",
      { value: "compact", selected: s.viewMode === "compact" },
      "One line",
    ),
  );
  const clickType = el(
    "select",
    { onchange: (e) => setSetting({ clickType: e.target.value }) },
    ...[
      ["soft", "Soft"],
      ["tick", "Tick"],
      ["pop", "Pop"],
      ["wood", "Wood"],
    ].map(([v, name]) =>
      el("option", { value: v, selected: s.clickType === v }, name),
    ),
  );

  const bare = el(
    "select",
    {
      onchange: (e) => {
        setSetting({ bareNotes: e.target.value });
        syncChord();
      },
    },
    el(
      "option",
      { value: "single", selected: s.bareNotes !== "chord" },
      "Separate notes (standard sheets)",
    ),
    el(
      "option",
      { value: "chord", selected: s.bareNotes === "chord" },
      "One chord, up to a limit",
    ),
  );
  const chordRange = range("maxChord", 2, 12, " keys");
  const chordRow = row(
    "Longest chord",
    'Only used in "One chord" mode: a longer group is split into single notes. A [bracketed] group is always one chord.',
    chordRange,
  );
  const syncChord = () => {
    const off = data.settings.bareNotes !== "chord";
    chordRange.querySelector("input").disabled = off;
    chordRow.style.opacity = off ? 0.4 : 1;
  };
  syncChord();

  let t;
  const css = el("textarea", {
    id: "css-input",
    spellcheck: "false",
    placeholder: ":root { --accent: #b388ff; }",
  });
  css.value = s.css || "";
  css.addEventListener("input", () => {
    data.settings.css = css.value;
    applyCss();
    clearTimeout(t);
    t = setTimeout(() => setSetting({ css: css.value }), 400);
  });

  return el(
    "div",
    { class: "view-fill settings" },
    card(
      "Window",
      row(
        "Always on top",
        "Keep this window above the game. Works best with the game in windowed or borderless mode.",
        sw(s.onTop, (v) => setSetting({ onTop: v })),
      ),
    ),
    card(
      "Display",
      row(
        "Note display",
        "Standard: big next note, note cards and a slider. One line: a thin strip of upcoming notes that takes very little space.",
        viewMode,
      ),
      row(
        "Minimal mode",
        "Plain highlighted notes: no boxes, no animations, no sounds. You can switch any of them back on below.",
        minimalSw.node,
      ),
      row("Note boxes", "Draw notes inside boxes.", boxesSw.node),
      row(
        "Animations",
        "Key press effect, smooth scrolling and fades.",
        animSw.node,
      ),
    ),
    card(
      "Playback",
      row(
        "Auto arm",
        "Arm the triggers as soon as a song opens, so you can start playing right away.",
        sw(s.autoArm, (v) => setSetting({ autoArm: v })),
      ),
      row(
        "Loop song",
        "Start over after the last note.",
        sw(s.loop, (v) => setSetting({ loop: v })),
      ),
      row(
        "Minimum key hold",
        "A quick tap keeps the keys down at least this long. Holding a trigger holds the note.",
        range("holdMs", 8, 120),
      ),
      row(
        "Notes without brackets",
        "Separate notes: every key is its own note, only [bracketed] groups are chords (standard sheets). One chord: a short group like pfiF is pressed together.",
        bare,
      ),
      chordRow,
      row(
        "Input method",
        "If the game ignores the keys, try the other one.",
        mode,
      ),
    ),
    card(
      "Sound",
      row(
        "Click sound",
        "A short click on every note you trigger.",
        clickSw.node,
      ),
      row("Click style", "Plays a preview when you change it.", clickType),
      row("Click volume", null, range("clickVolume", 0, 100, " %")),
    ),
    card(
      "Triggers",
      row(
        "Trigger keys",
        "Each press plays the next note. Hold to sustain it. While Armed, these keys do not reach the game.",
        el(
          "button",
          {
            id: "add-bind",
            onclick: () =>
              api(st.capturing ? "capture/cancel" : "capture/start", {}).then(
                handle,
              ),
          },
          "Add trigger",
        ),
      ),
      el("div", { class: "binds", id: "binds-box" }),
    ),
    card(
      "Custom CSS",
      el(
        "div",
        { class: "row-desc", style: "padding:6px 0 10px" },
        "Applied instantly and saved. Override anything.",
      ),
      el("div", { class: "css-box" }, css),
      el(
        "details",
        {},
        el("summary", {}, "Variables and selectors"),
        el(
          "pre",
          {},
          ":root vars:\n  --bg --panel --panel-2 --line --text --muted\n  --accent --accent-ink --radius\n  --font --font-title --mono --texture\n\n" +
            "selectors:\n  #topbar  #title  #view  #arm  #btn-settings  .badge  body.compact-song  body.no-boxes  body.no-anim\n  .song-row  .song-name  .stage  .caps  .cap  .cap.shift\n  .triggers  .key  .ribbon  .note  .note.next  .note.done  .scrub\n  .mini-progress  .card  .row  .switch  .bind  .toast  body.armed",
        ),
      ),
    ),
    card(
      "Data",
      row(
        "Songs and settings folder",
        "Where your songs, settings and log are stored.",
        el("button", { onclick: () => api("openfolder", {}) }, "Open folder"),
      ),
    ),
  );
}

/* ------------------------------------------------------------ live updates */
function paint() {
  if (view !== "song" || editing || !$("#ribbon")) return;
  const i = st.index ?? 0,
    total = steps.length,
    loop = data.settings.loop;
  const bc = $("#big-caps");
  if (bc) {
    const showStep = i < total ? steps[i] : loop && total ? steps[0] : null;
    bc.replaceChildren(
      ...(showStep
        ? caps(showStep)
        : [el("div", { class: "stage-end" }, "End of song")]),
    );
    $("#stage-label").textContent = showStep
      ? "Next note"
      : "Press Restart to play again";
    $("#stage-meta").textContent = total
      ? `${Math.min(i + 1, total)} of ${total}`
      : "No notes in this song";
  }
  const rb = $("#ribbon"),
    cards = rb.children;
  for (let n = 0; n < cards.length; n++) {
    cards[n].classList.toggle("done", n < i);
    cards[n].classList.toggle("next", n === i);
  }
  const cur = cards[Math.min(i, cards.length - 1)];
  if (cur) rb.scrollTo({ left: cur.offsetLeft - rb.clientWidth * 0.18 });
  const sc = $("#scrub");
  if (sc && !scrubbing) sc.value = Math.min(i, Math.max(0, total - 1));
  const sl = $("#scrub-label");
  if (sl) sl.textContent = total ? `${Math.max(0, total - i)} left` : "";
  const mf = $("#mini-fill");
  if (mf) mf.style.width = total ? `${Math.min(100, (i / total) * 100)}%` : "0";
}

function pulse() {
  const s = $("#stage");
  if (!s) return;
  s.classList.remove("hit");
  void s.offsetWidth;
  s.classList.add("hit");
}

function renderTriggers() {
  const r = $("#triggers-row");
  if (!r) return;
  const b = data.settings.binds || [];
  r.replaceChildren(
    b.length ? "Triggers" : "No triggers yet. Add one in Settings.",
    ...b.map((x) => el("span", { class: "key" }, x.name)),
  );
}

function renderBinds() {
  const box = $("#binds-box");
  if (!box) return;
  box.replaceChildren(
    ...(data.settings.binds || []).map((b) =>
      el(
        "span",
        { class: "bind" },
        b.name,
        el(
          "button",
          {
            title: "Remove",
            onclick: () => api("binds/remove", { sc: b.sc }).then(handle),
          },
          "×",
        ),
      ),
    ),
  );
}

function updateCaptureBtn() {
  const b = $("#add-bind");
  if (b)
    b.textContent = st.capturing ? "Press a key… (Esc cancels)" : "Add trigger";
}

function syncArm() {
  document.body.classList.toggle("armed", !!st.armed);
  const i = $("#arm-input");
  if (i) i.checked = !!st.armed;
  $("#arm-text").textContent = st.armed ? "Armed" : "Off";
}

function handle(s) {
  const prev = st;
  st = s;
  if (s.toast.seq !== lastToast) {
    lastToast = s.toast.seq;
    if (s.toast.text) toast(s.toast.text);
  }
  const bj = JSON.stringify(s.binds);
  if (bj !== bindsJson) {
    bindsJson = bj;
    data.settings.binds = s.binds;
    renderBinds();
    renderTriggers();
  }
  if (s.capturing !== prev.capturing) updateCaptureBtn();
  if (s.index !== prev.index) paint();
  if (s.seq !== prev.seq) pulse();
  if (s.armed !== prev.armed) syncArm();
}

async function poll() {
  try {
    handle(await api("state"));
  } catch (e) {
    /* server busy */
  }
  setTimeout(poll, 70);
}

/* ---------------------------------------------------------------- actions */
async function openSong(song) {
  current = song;
  steps = parseNotes(song.notes);
  editing = false;
  view = "song";
  handle(await api("load", { steps, index: song.pos || 0 }));
  render();
  autoArm();
}

function newSong() {
  current = {
    id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36),
    title: "",
    notes: "",
    transcription: "",
    pos: 0,
    isNew: true,
  };
  steps = [];
  editing = true;
  view = "song";
  api("arm", { armed: false }).then(handle);
  render();
}

async function saveSong(title, notes, transcription) {
  const changed = notes !== current.notes;
  Object.assign(current, {
    title: title.trim() || "Untitled",
    notes,
    transcription: transcription.trim(),
    pos: changed ? 0 : current.pos,
  });
  delete current.isNew;
  const i = data.songs.findIndex((s) => s.id === current.id);
  if (i >= 0) data.songs[i] = current;
  else data.songs.push(current);
  await api("songs/save", { song: current });
  steps = parseNotes(notes);
  editing = false;
  handle(await api("load", { steps, index: current.pos }));
  render();
  autoArm();
}

// settings.autoArm: arm triggers as soon as a song screen is shown, so you can just play
async function autoArm() {
  if (data.settings.autoArm && view === "song" && !editing && !st.armed)
    handle(await api("arm", { armed: true }));
}

async function seek(i) {
  handle(await api("seek", { index: i }));
}

async function scrubTo(i) {
  if (scrubBusy) return;
  scrubBusy = true;
  try {
    handle(await api("seek", { index: i }));
  } finally {
    scrubBusy = false;
  }
}

async function leaveSong() {
  if (current && !editing && !current.isNew) {
    current.pos = st.index || 0;
    await api("songs/save", { song: current });
  }
  handle(await api("arm", { armed: false }));
}

window.addEventListener("pointerup", () => {
  scrubbing = false;
});

$("#btn-back").onclick = async () => {
  if (view === "settings") {
    view = prevView;
    if (st.capturing) await api("capture/cancel", {});
    render();
    autoArm();
    return;
  }
  await leaveSong();
  view = "library";
  editing = false;
  render();
};
// leaving the song screen disarms, so trigger keys can be typed in the CSS box
$("#btn-settings").onclick = async () => {
  prevView = view;
  view = "settings";
  handle(await api("arm", { armed: false }));
  render();
};
$("#btn-edit").onclick = async () => {
  editing = true;
  handle(await api("arm", { armed: false }));
  render();
};
$("#btn-reset").onclick = () => seek(0);
$("#arm-input").onchange = async (e) =>
  handle(await api("arm", { armed: e.target.checked }));

(async () => {
  const init = await api("init");
  data.songs = init.songs;
  data.settings = init.settings;
  st = init.state;
  lastToast = st.toast.seq;
  bindsJson = JSON.stringify(st.binds);
  applyCss();
  applyLook();
  render();
  poll();
})();
