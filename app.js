"use strict";

// ---------------------------------------------------------------------------
// BLE protocol — keep identical to include/config.h in the firmware.
// ---------------------------------------------------------------------------
const UUID = {
  service: "ae6b0000-d452-4478-9a9f-6030f75771a7",
  backlight: "ae6b0001-d452-4478-9a9f-6030f75771a7", // [day%, night%, night_start_h, night_end_h]
  display: "ae6b0002-d452-4478-9a9f-6030f75771a7",   // [contrast, flip]
  message: "ae6b0003-d452-4478-9a9f-6030f75771a7",   // ASCII
  scene: "ae6b0004-d452-4478-9a9f-6030f75771a7",     // [scene, cycle_s, speed_pct, flags]
  params: "ae6b0005-d452-4478-9a9f-6030f75771a7",    // write [scene, p0..p3]; read = selected scene
  action: "ae6b0006-d452-4478-9a9f-6030f75771a7",    // write [code]
  status: "ae6b0007-d452-4478-9a9f-6030f75771a7",    // notify [proto, active_scene, fps, flags]
  mirror: "ae6b0008-d452-4478-9a9f-6030f75771a7",    // notify: LCD frames (delta + RLE, chunked)
  newsCfg: "ae6b0009-d452-4478-9a9f-6030f75771a7",   // R/W [source, interval_min]
  newsUrl: "ae6b000a-d452-4478-9a9f-6030f75771a7",   // R/W custom RSS URL (ASCII)
  newsStatus: "ae6b000b-d452-4478-9a9f-6030f75771a7", // notify [state, count, age_min u16, error u16]
  playlist: "ae6b000c-d452-4478-9a9f-6030f75771a7",  // R/W [count][count x (scene, seconds u16 LE, news_source, dwell_s, flags)]
};
const PROTO_VERSION = 2;
const MESSAGE_MAX_LEN = 21;
const FLAG = { CLOCK: 1, FPS: 2, DEPTH: 4, NAME: 8 };
const ACTION = { DROP: 1, RESET: 2, NEXT: 3, LCD_REINIT: 4, LCD_FAULT_TEST: 5, TIME_SYNC: 6, NEWS_REFRESH: 7 };
const NEWS_SCENE = 8;
const NEWS_CUSTOM = 255;
const NEWS_DEFAULT_SRC = 254; // playlist entry: "use the default news source"
const PLAYLIST_MAX = 16;
const MAX_NEWS_FEEDS = 5;     // feeds the firmware keeps at the same time
const PL_ALL = 1;             // flag: show every unread article once
const NEWS_URL_MAX = 119;
// Same order as the preset table in src/news.cpp.
const NEWS_PRESETS = [
  "NHK ニュース 主要", "NHK 社会", "NHK 政治", "NHK 経済", "NHK 国際", "NHK スポーツ",
  "NHK 科学・医療", "NHK 文化・エンタメ", "Yahoo!ニュース 主要", "Yahoo!ニュース IT", "BBC News World(英語)",
];

// esp_reset_reason_t values reported by the firmware (Status bytes 4..5).
const RESET_REASONS = {
  0: ["不明(USB 経由のリセットなど)", false], 1: ["電源投入", false], 2: ["外部リセット", false], 3: ["ソフトウェアリセット", false],
  4: ["パニック(プログラムのクラッシュ)", true], 5: ["割り込みウォッチドッグ", true],
  6: ["タスクウォッチドッグ", true], 7: ["ウォッチドッグ", true], 8: ["ディープスリープ復帰", false],
  9: ["ブラウンアウト(電源電圧の低下)", true], 10: ["SDIO", false], 11: ["USB", false],
};

// ---------------------------------------------------------------------------
// Scene catalogue. Parameter ranges mirror the mapping done in the firmware
// (mapf(p, lo, hi) etc.); `def` mirrors each scene's defaults().
// ---------------------------------------------------------------------------
const range = (label, lo, hi, def, o = {}) => ({ type: "range", label, lo, hi, def, ...o });
const steps = (label, items, def) => ({ type: "steps", label, items, def });
const toggle = (label, def) => ({ type: "toggle", label, def });

const SCENES = [
  { name: "Clock", ja: "時計", desc: "日付と大きな時刻。メッセージは曜日と交互に表示。", params: [] },
  {
    name: "Hypercube 4D", ja: "4次元超立方体",
    desc: "4 次元の正多胞体を 6 つの回転面で回し、4D→3D→2D と投影します。辺は頂点間距離から自動生成。",
    params: [
      steps("形状", ["超立方体", "16胞体", "24胞体"], 0),
      range("4D 回転の速さ", 0.25, 2.2, 90, { unit: "×" }),
      range("4D の視点距離", 1.7, 4.5, 110),
      range("ズーム", 0.6, 1.5, 128, { unit: "×" }),
    ],
  },
  {
    name: "Morph Surface", ja: "変形する曲面",
    desc: "球→トーラス→メビウスの帯→クラインの壺。同じ格子の頂点を補間して滑らかに変形します。",
    params: [
      range("変形の速さ", 0.15, 1.2, 110, { unit: "×" }),
      steps("格子の細かさ", ["粗い", "ふつう", "細かい"], 1),
      steps("形状", ["自動", "球", "トーラス", "メビウス", "クライン"], 0),
      range("回転の速さ", 0.1, 1.4, 100, { unit: "×" }),
    ],
  },
  {
    name: "Terrain Flyover", ja: "山脈の上空飛行",
    desc: "フラクタルノイズの地形を、スカイライン法で本物の隠線消去をしながら飛びます。",
    params: [
      range("起伏", 0.25, 1.5, 150),
      range("荒さ", 0.3, 0.65, 110),
      range("飛行速度", 0.25, 2.2, 110, { unit: "×" }),
      range("カメラの高さ", 0.35, 1.1, 110),
    ],
  },
  {
    name: "Lorenz Butterfly", ja: "ローレンツ(バタフライ効果)",
    desc: "RK4 でローレンツ方程式を解き、初期値が少しだけ違う 2 本(実線と点線)が離れていく様子を見せます。",
    params: [
      range("ρ(24.7 未満はカオスにならない)", 20, 48, 73, { digits: 1 }),
      range("軌跡の長さ", 80, 380, 150, { digits: 0 }),
      { type: "log", label: "初期値の差", def: 85, lo: -4, hi: -1 },
      range("カメラ周回の速さ", 0.05, 0.9, 100, { unit: "×" }),
    ],
  },
  {
    name: "Warp Starfield", ja: "ワープ航行",
    desc: "3D の星を透視投影して流します。近い星ほど大きく、残像で速度感を出します。",
    params: [
      range("星の数", 30, 180, 150, { digits: 0 }),
      range("ワープ速度", 0.15, 2.0, 120, { unit: "×" }),
      range("残像の長さ", 0, 0.5, 110),
      range("ロール(回転)", 0, 1.2, 40),
    ],
  },
  {
    name: "Platonic Solids", ja: "正多面体",
    desc: "5 つの正多面体。面の向きで凸多面体を厳密に隠線消去し、頂点・辺・面の数も表示します。",
    params: [
      steps("立体", ["正4面体", "立方体", "正8面体", "正12面体", "正20面体", "自動切替"], 5),
      range("回転の速さ", 0.2, 2.0, 110, { unit: "×" }),
      range("宙返りの量", 0, 1, 128),
      toggle("X線(隠れた辺も点線で表示)", 0),
    ],
  },
  {
    name: "Ripple Tank", ja: "波動シミュレーション",
    desc: "2 次元の波動方程式を差分法で実際に解いた水面。雨が降り、水滴ボタンで石を落とせます。",
    params: [
      range("波の速さ", 0.1, 0.46, 150, { digits: 2 }),
      range("減衰", 0.0005, 0.03, 40, { digits: 4 }),
      range("雨の量", 0, 3, 70, { unit: "/s" }),
      range("波の高さ", 0.3, 1.5, 100),
    ],
  },
  {
    name: "News", ja: "ニュース(見出し)",
    desc: "RSS から取得した見出しを日本語で 1 件ずつ表示します(文字送り → 表示 → スライド)。配信元と更新間隔は下の「ニュース」で選べます。",
    params: [
      range("1 件の表示時間", 3, 15, 85, { unit: " 秒", digits: 1 }),
      range("文字の出る速さ", 10, 120, 80, { unit: " 字/秒", digits: 0 }),
      toggle("ヘッダー(配信元・件数・何分前)を表示", 255),
      toggle("ランダムな順番で表示", 0),
    ],
  },
];

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const el = {
  unsupported: $("unsupported"), status: $("status"), connectBtn: $("connectBtn"),
  fields: $("fields"), live: $("live"), lcd: $("lcd"), mirrorOn: $("mirrorOn"),
  sceneGrid: $("sceneGrid"), mode: $("mode"), modeHint: $("modeHint"), nextBtn: $("nextBtn"),
  plRows: $("plRows"), plWarn: $("plWarn"), plDirty: $("plDirty"), plAdd: $("plAdd"), plSample: $("plSample"),
  plReset: $("plReset"), plApply: $("plApply"),
  paramTitle: $("paramTitle"), sceneDesc: $("sceneDesc"), params: $("params"),
  dropBtn: $("dropBtn"), resetBtn: $("resetBtn"), defaultsBtn: $("defaultsBtn"),
  reinitBtn: $("reinitBtn"), faultBtn: $("faultBtn"), syncBtn: $("syncBtn"), diagInfo: $("diagInfo"),
  newsSource: $("newsSource"), newsUrl: $("newsUrl"), newsUrlRow: $("newsUrlRow"), newsInterval: $("newsInterval"),
  newsApply: $("newsApply"), newsRefresh: $("newsRefresh"), newsInfo: $("newsInfo"),
  speed: $("speed"), speedOut: $("speedOut"),
  fClock: $("fClock"), fDepth: $("fDepth"), fName: $("fName"), fFps: $("fFps"),
  form: $("form"), applyBtn: $("applyBtn"),
  day: $("day"), dayOut: $("dayOut"), night: $("night"), nightOut: $("nightOut"),
  nstart: $("nstart"), nend: $("nend"), nightHint: $("nightHint"),
  contrast: $("contrast"), contrastOut: $("contrastOut"), flip: $("flip"),
  message: $("message"), msgCount: $("msgCount"), toast: $("msg"),
};

const state = {
  device: null,
  chars: null,
  selected: 1,
  active: -1,
  fps: 0,
  diag: null, // { reason, boots } from the Status characteristic
  news: { source: 0, interval: 30, url: "", status: null }, // status: { state, count, age, error }
  cycle: 20,            // 0 = pinned scene; non-zero = play the playlist
  playlist: [],         // [{ scene, seconds, source, dwell, all }]
  plDirty: false,       // edited here but not written to the device yet
  entry: 255,           // playlist entry being played (from the status), 255 = none
  speed: 100,
  flags: 13,
  params: SCENES.map((s) => s.params.map((p) => p.def)), // per-scene cache (raw 0..255)
};

function toast(text, kind) {
  el.toast.textContent = text;
  el.toast.className = "toast" + (kind ? " " + kind : "");
}
const errText = (e) => (e && e.message ? e.message : String(e));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// GATT access: Web Bluetooth allows ONE operation at a time, so everything is
// funnelled through a promise chain. Slider drags use a "latest value wins"
// writer on top of it so the radio never gets a backlog.
// ---------------------------------------------------------------------------
let gattChain = Promise.resolve();
function gatt(fn) {
  const run = gattChain.then(fn, fn);
  gattChain = run.catch(() => {});
  return run;
}

function writeNoResp(chr, bytes) {
  const data = new Uint8Array(bytes);
  return chr.writeValueWithoutResponse ? chr.writeValueWithoutResponse(data) : chr.writeValue(data);
}

class LatestWriter {
  constructor(send) { this.send = send; this.pending = null; this.busy = false; }
  set(value) { this.pending = value; this.pump(); }
  async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.pending !== null) {
        const v = this.pending;
        this.pending = null;
        let tries = 0;
        for (;;) {
          try { await gatt(() => this.send(v)); break; }
          catch (e) { if (++tries >= 3 || !state.chars) break; await sleep(40); }
        }
        await sleep(15); // gentle pacing
      }
    } finally { this.busy = false; }
  }
}
const sceneWriter = new LatestWriter((b) => writeNoResp(state.chars.scene, b));
const paramsWriter = new LatestWriter((b) => writeNoResp(state.chars.params, b));

function sendScene() {
  if (!state.chars) return;
  sceneWriter.set([state.selected, state.cycle, state.speed, state.flags]);
}
function sendParams() {
  if (!state.chars) return;
  paramsWriter.set([state.selected, ...state.params[state.selected]]);
}
function sendAction(code) {
  if (!state.chars) return;
  gatt(() => writeNoResp(state.chars.action, [code])).catch((e) => toast("送信に失敗: " + errText(e), "err"));
}

// ---------------------------------------------------------------------------
// Rendering of the scene picker and parameter panel
// ---------------------------------------------------------------------------
function renderScenes() {
  el.sceneGrid.textContent = "";
  SCENES.forEach((s, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "scene-btn";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(i === state.selected));
    const name = document.createElement("span");
    name.textContent = s.name;
    const small = document.createElement("small");
    small.textContent = s.ja;
    b.append(name, small);
    if (i === state.active) {
      const now = document.createElement("span");
      now.className = "now";
      now.textContent = "▶ 表示中";
      b.append(now);
    }
    b.addEventListener("click", () => selectScene(i));
    el.sceneGrid.append(b);
  });
}

function fmtParam(spec, p) {
  if (spec.type === "log") return "10^" + (spec.lo + ((spec.hi - spec.lo) * p) / 255).toFixed(1);
  if (spec.type === "range") {
    const v = spec.lo + ((spec.hi - spec.lo) * p) / 255;
    const d = spec.digits !== undefined ? spec.digits : 2;
    return v.toFixed(d) + (spec.unit || "");
  }
  return "";
}

function stepIndex(spec, p) { return Math.min(spec.items.length - 1, Math.floor((p * spec.items.length) / 256)); }
function stepValue(spec, i) { return Math.min(255, Math.round(((i + 0.5) * 256) / spec.items.length)); }

function renderParams() {
  const s = SCENES[state.selected];
  el.paramTitle.textContent = s.name + " の設定";
  el.sceneDesc.textContent = s.desc;
  el.params.textContent = "";
  el.dropBtn.hidden = state.selected !== 7;
  el.defaultsBtn.hidden = s.params.length === 0;

  s.params.forEach((spec, k) => {
    const wrap = document.createElement("div");
    wrap.className = "param";
    const name = document.createElement("div");
    name.className = "name";
    const lab = document.createElement("span");
    lab.textContent = spec.label;
    name.append(lab);
    wrap.append(name);

    const commit = (v) => { state.params[state.selected][k] = v; sendParams(); };

    if (spec.type === "range" || spec.type === "log") {
      const out = document.createElement("output");
      name.append(out);
      const input = document.createElement("input");
      input.type = "range"; input.min = "0"; input.max = "255";
      input.value = String(state.params[state.selected][k]);
      input.setAttribute("aria-label", spec.label);
      const upd = () => { out.textContent = fmtParam(spec, Number(input.value)); };
      upd();
      input.addEventListener("input", () => { upd(); commit(Number(input.value)); });
      wrap.append(input);
    } else if (spec.type === "steps") {
      const row = document.createElement("div");
      row.className = "steps";
      const cur = stepIndex(spec, state.params[state.selected][k]);
      spec.items.forEach((label, i) => {
        const b = document.createElement("button");
        b.type = "button"; b.textContent = label;
        b.setAttribute("aria-pressed", String(i === cur));
        b.addEventListener("click", () => {
          for (const x of row.children) x.setAttribute("aria-pressed", "false");
          b.setAttribute("aria-pressed", "true");
          commit(stepValue(spec, i));
        });
        row.append(b);
      });
      wrap.append(row);
    } else if (spec.type === "toggle") {
      const label = document.createElement("label");
      label.className = "check";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = state.params[state.selected][k] >= 128;
      cb.addEventListener("change", () => commit(cb.checked ? 255 : 0));
      const t = document.createElement("span");
      t.textContent = spec.label;
      label.append(cb, t);
      wrap.textContent = ""; // the toggle carries its own label
      wrap.append(label);
    }
    el.params.append(wrap);
  });
}

// ---------------------------------------------------------------------------
// Playlist editor
// ---------------------------------------------------------------------------
const clampInt = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(v) || 0)));

function defaultPlaylist() {
  return SCENES.map((_, i) => ({ scene: i, seconds: 20, source: NEWS_DEFAULT_SRC, dwell: 0, all: false }));
}

// "News reading": NHK top -> Yahoo IT -> NHK science (all unread articles, 10 s each) -> Ripple.
function samplePlaylist() {
  const news = (source) => ({ scene: NEWS_SCENE, seconds: 900, source, dwell: 10, all: true });
  return [news(0), news(9), news(6), { scene: 7, seconds: 60, source: NEWS_DEFAULT_SRC, dwell: 0, all: false }];
}

function serializePlaylist(list) {
  const b = [list.length];
  for (const e of list) {
    const isNews = e.scene === NEWS_SCENE;
    const sec = isNews && e.all ? 900 : clampInt(e.seconds, 5, 3600);
    b.push(e.scene, sec & 255, sec >> 8, isNews ? e.source : NEWS_DEFAULT_SRC, isNews ? clampInt(e.dwell, 0, 120) : 0,
      isNews && e.all ? PL_ALL : 0);
  }
  return new Uint8Array(b);
}

function parsePlaylist(dv) {
  const n = Math.min(dv.getUint8(0), PLAYLIST_MAX);
  const list = [];
  for (let i = 0; i < n && 1 + (i + 1) * 6 <= dv.byteLength; i++) {
    const o = 1 + i * 6;
    list.push({
      scene: Math.min(dv.getUint8(o), SCENES.length - 1),
      seconds: dv.getUint8(o + 1) | (dv.getUint8(o + 2) << 8),
      source: dv.getUint8(o + 3), dwell: dv.getUint8(o + 4), all: (dv.getUint8(o + 5) & PL_ALL) !== 0,
    });
  }
  return list;
}

const sceneLabel = (i) => SCENES[i].name + "(" + SCENES[i].ja + ")";

function plMarkDirty() {
  state.plDirty = true;
  el.plDirty.hidden = false;
  updatePlaylistHighlight();
  updatePlaylistWarning();
}

// Which news feeds does the firmware have to fetch for this list (the default feed is always kept)?
function feedsInUse() {
  const set = new Set([state.news.source]);
  for (const e of state.playlist) {
    if (e.scene === NEWS_SCENE) set.add(e.source === NEWS_DEFAULT_SRC ? state.news.source : e.source);
  }
  return set;
}

function updatePlaylistWarning() {
  const n = feedsInUse().size;
  el.plWarn.hidden = n <= MAX_NEWS_FEEDS;
  el.plWarn.textContent = "ニュースの配信元が " + n + " 種類あります。同時に保持できるのは " + MAX_NEWS_FEEDS +
    " 種類までなので、超えた分は取得されません。";
}

function updatePlaylistHighlight() {
  [...el.plRows.children].forEach((row, i) => {
    const cur = !state.plDirty && state.cycle !== 0 && i === state.entry;
    row.classList.toggle("current", cur);
    const now = row.querySelector(".now");
    if (now) now.hidden = !cur;
  });
}

function movePlaylist(i, d) {
  const j = i + d;
  if (j < 0 || j >= state.playlist.length) return;
  [state.playlist[i], state.playlist[j]] = [state.playlist[j], state.playlist[i]];
  plMarkDirty();
  renderPlaylist();
}

function renderPlaylist() {
  el.plRows.textContent = "";
  state.playlist.forEach((e, i) => {
    const isNews = e.scene === NEWS_SCENE;
    const row = document.createElement("div");
    row.className = "pl-row";

    const head = document.createElement("div");
    head.className = "pl-head";
    const idx = document.createElement("span");
    idx.className = "idx";
    idx.textContent = String(i + 1);
    const now = document.createElement("span");
    now.className = "now";
    now.textContent = "▶ 再生中";
    now.hidden = true;
    const sp = document.createElement("span");
    sp.className = "sp";
    head.append(idx, now, sp);
    const btn = (label, title, fn, disabled) => {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = label; b.title = title; b.setAttribute("aria-label", title);
      b.disabled = !!disabled;
      b.addEventListener("click", fn);
      return b;
    };
    head.append(
      btn("↑", "上へ", () => movePlaylist(i, -1), i === 0),
      btn("↓", "下へ", () => movePlaylist(i, 1), i === state.playlist.length - 1),
      btn("✕", "削除", () => { state.playlist.splice(i, 1); plMarkDirty(); renderPlaylist(); }),
    );

    const fields = document.createElement("div");
    fields.className = "pl-fields";
    const field = (labelText, control, full) => {
      const l = document.createElement("label");
      if (full) l.className = "full";
      l.append(labelText, control);
      fields.append(l);
    };

    const sceneSel = document.createElement("select");
    SCENES.forEach((_, k) => {
      const o = document.createElement("option");
      o.value = String(k); o.textContent = sceneLabel(k);
      sceneSel.append(o);
    });
    sceneSel.value = String(e.scene);
    sceneSel.addEventListener("change", () => { e.scene = Number(sceneSel.value); plMarkDirty(); renderPlaylist(); });
    field("シーン", sceneSel, true);

    const num = (value, lo, hi, onInput) => {
      const n = document.createElement("input");
      n.type = "number"; n.min = String(lo); n.max = String(hi); n.step = "1"; n.inputMode = "numeric";
      n.value = String(value);
      n.addEventListener("input", () => { onInput(clampInt(n.value, lo, hi)); plMarkDirty(); });
      return n;
    };

    if (isNews) {
      const src = document.createElement("select");
      const add = (v, t) => { const o = document.createElement("option"); o.value = String(v); o.textContent = t; src.append(o); };
      add(NEWS_DEFAULT_SRC, "既定の配信元(「ニュース」で設定)");
      NEWS_PRESETS.forEach((t, k) => add(k, t));
      add(NEWS_CUSTOM, "任意の RSS(「ニュース」で入力した URL)");
      src.value = String(e.source);
      src.addEventListener("change", () => { e.source = Number(src.value); plMarkDirty(); });
      field("配信元", src, true);

      const modeSel = document.createElement("select");
      for (const [v, t] of [["all", "全記事(未読を全部)"], ["time", "時間を指定"]]) {
        const o = document.createElement("option"); o.value = v; o.textContent = t; modeSel.append(o);
      }
      modeSel.value = e.all ? "all" : "time";
      modeSel.addEventListener("change", () => { e.all = modeSel.value === "all"; plMarkDirty(); renderPlaylist(); });
      field("表示の長さ", modeSel);
      field("1 記事あたり(秒、0=ニュースの設定)", num(e.dwell, 0, 120, (v) => { e.dwell = v; }));
      if (!e.all) field("このエントリの合計(秒)", num(e.seconds, 5, 3600, (v) => { e.seconds = v; }));
    } else {
      field("表示する秒数", num(e.seconds, 5, 3600, (v) => { e.seconds = v; }));
    }

    row.append(head, fields);
    el.plRows.append(row);
  });
  el.plAdd.disabled = state.playlist.length >= PLAYLIST_MAX;
  el.plDirty.hidden = !state.plDirty;
  updatePlaylistWarning();
  updatePlaylistHighlight();
}

async function applyPlaylist() {
  if (!state.chars) return;
  if (state.playlist.length === 0) { toast("プレイリストが空です。1 件以上追加してください。", "err"); return; }
  el.plApply.disabled = true;
  try {
    await gatt(() => state.chars.playlist.writeValueWithResponse(serializePlaylist(state.playlist)));
    state.plDirty = false;
    el.plDirty.hidden = true;
    if (state.cycle === 0) { state.cycle = 20; sendScene(); renderGlobals(); } // writing a playlist implies "play it"
    toast("プレイリストを反映しました(最初から再生します)。", "ok");
    updatePlaylistHighlight();
  } catch (err) {
    toast("プレイリストの書き込みに失敗: " + errText(err), "err");
  } finally { el.plApply.disabled = false; }
}

function renderGlobals() {
  el.mode.value = state.cycle === 0 ? "fixed" : "playlist";
  el.modeHint.textContent = state.cycle === 0
    ? "上で選んだシーンを表示し続けます(「プレイリスト」は使いません)。"
    : "「プレイリスト」の順に自動で切り替えます。";
  el.speed.value = state.speed;
  el.speedOut.textContent = state.speed;
  el.fClock.checked = !!(state.flags & FLAG.CLOCK);
  el.fDepth.checked = !!(state.flags & FLAG.DEPTH);
  el.fName.checked = !!(state.flags & FLAG.NAME);
  el.fFps.checked = !!(state.flags & FLAG.FPS);
}

function renderDiag() {
  const d = state.diag;
  if (!d) { el.diagInfo.textContent = ""; return; }
  const [name, bad] = RESET_REASONS[d.reason] || ["不明(" + d.reason + ")", false];
  el.diagInfo.textContent = "前回の起動理由: " + name + " / 起動 " + d.boots + " 回目" +
    (bad ? " — 電源やクラッシュが原因で再起動しています。USB ケーブルや 3.3V/GND の接触、電源を確認してください。"
         : " — 起動回数が勝手に増えていくなら本体が再起動しています(電源側の接触)。増えないのに液晶だけ消えるなら、液晶側の配線(CS/DC/RST/SCLK/MOSI)の接触が原因です。");
}

function readDiag(dv) {
  if (dv.byteLength >= 6) { state.diag = { reason: dv.getUint8(4), boots: dv.getUint8(5) }; renderDiag(); }
}

// ---------------------------------------------------------------------------
// News card
// ---------------------------------------------------------------------------
function newsErrorText(code) {
  if (code & 0x8000) {
    const c = code & 0x7fff; // HTTPClient/TLS error, sign flipped by the firmware
    const names = { 1: "接続できません", 2: "送信に失敗", 3: "ヘッダーの送信に失敗", 4: "ステータスの受信に失敗",
      5: "受信に失敗", 6: "接続が切れました", 7: "ストリームの書き込みに失敗", 8: "接続が切れました",
      9: "接続が切れました", 10: "メモリ不足", 11: "応答がありません(タイムアウト)", 12: "応答が不正です" };
    return (names[c] || "通信エラー") + "(-" + c + ")。証明書の検証失敗や圏外の可能性があります";
  }
  if (code === 1) return "URL を開始できません";
  if (code === 2) return "見出しが見つかりません(RSS ではない/形式が違う)";
  if (code === 3) return "取得タスクを開始できません";
  return "HTTP " + code;
}

function renderNewsInfo() {
  const s = state.news.status;
  if (!s) { el.newsInfo.textContent = ""; return; }
  const age = s.age === 0xffff ? "時刻不明" : s.age < 60 ? s.age + " 分前" : Math.floor(s.age / 60) + " 時間前";
  const parts = ["まだ取得していません", "取得中…", "取得済み: " + s.count + " 件(" + age + ")", "取得に失敗: " + newsErrorText(s.error)];
  el.newsInfo.textContent = parts[s.state] || "";
  if (s.state === 3 && s.count > 0) el.newsInfo.textContent += " / 前回の " + s.count + " 件(" + age + ")を表示中";
}

function readNewsStatus(dv) {
  if (dv.byteLength < 6) return;
  state.news.status = {
    state: dv.getUint8(0), count: dv.getUint8(1),
    age: dv.getUint8(2) | (dv.getUint8(3) << 8), error: dv.getUint8(4) | (dv.getUint8(5) << 8),
  };
  renderNewsInfo();
}

function renderNewsControls() {
  el.newsSource.value = String(state.news.source);
  el.newsInterval.value = String(state.news.interval);
  el.newsUrl.value = state.news.url;
  el.newsUrlRow.hidden = state.news.source !== NEWS_CUSTOM;
}

const newsUrlOk = (u) => u.length <= NEWS_URL_MAX && /^https?:\/\/[\x21-\x7e]{3,}$/.test(u);

async function applyNews() {
  if (!state.chars) return;
  const source = Number(el.newsSource.value);
  const interval = Number(el.newsInterval.value);
  const url = el.newsUrl.value.trim();
  if (source === NEWS_CUSTOM && !newsUrlOk(url)) {
    toast("URL は http:// か https:// で始まる半角文字(119 文字まで)で入力してください。", "err");
    return;
  }
  el.newsApply.disabled = true;
  try {
    if (source === NEWS_CUSTOM) {
      await gatt(() => state.chars.newsUrl.writeValueWithResponse(new TextEncoder().encode(url)));
    }
    await gatt(() => state.chars.newsCfg.writeValueWithResponse(new Uint8Array([source, interval])));
    state.news.source = source; state.news.interval = interval;
    if (source === NEWS_CUSTOM) state.news.url = url;
    toast("ニュース設定を反映しました。まもなく取得します。", "ok");
  } catch (err) {
    toast("ニュース設定の書き込みに失敗: " + errText(err), "err");
  } finally { el.newsApply.disabled = false; }
}

function renderLive() {
  const name = state.active >= 0 ? SCENES[state.active].name : "—";
  el.live.textContent = name + " · " + (state.fps || "—") + " fps";
}

async function selectScene(i) {
  state.selected = i;
  renderScenes();
  renderParams();
  if (!state.chars) return;
  // Switch first, then read that scene's stored parameters back (ordered on the GATT queue).
  try {
    await gatt(() => writeNoResp(state.chars.scene, [state.selected, state.cycle, state.speed, state.flags]));
    const dv = await gatt(() => state.chars.params.readValue());
    if (dv.getUint8(0) === i) {
      for (let k = 0; k < 4; k++) state.params[i][k] = dv.getUint8(1 + k);
      if (state.selected === i) renderParams();
    }
  } catch (e) { toast("シーン切り替えに失敗: " + errText(e), "err"); }
}

// ---------------------------------------------------------------------------
// LCD mirror: reassemble chunks, apply delta/RLE ops, paint a dot-matrix look.
// ---------------------------------------------------------------------------
const FRAME_BYTES = 1024;
const frame = new Uint8Array(FRAME_BYTES);
const lcdCtx = el.lcd.getContext("2d");
const mirror = { frameId: -1, parts: [], got: 0, count: 0, synced: false };

function paintLcd() {
  const css = getComputedStyle(document.documentElement);
  const bg = css.getPropertyValue("--lcd-bg").trim() || "#0c120a";
  lcdCtx.fillStyle = bg;
  lcdCtx.fillRect(0, 0, el.lcd.width, el.lcd.height);
  const S = 4; // 3 px dot + 1 px gap
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 128; x++) {
      const on = (frame[(y >> 3) * 128 + x] >> (y & 7)) & 1;
      lcdCtx.fillStyle = on ? "#c8f56a" : "#17200f";
      lcdCtx.fillRect(x * S, y * S, S - 1, S - 1);
    }
  }
}

function applyPayload(p) {
  const key = (p[0] & 1) === 1;
  if (!key && !mirror.synced) return; // wait for a keyframe
  if (key) frame.fill(0);
  let pos = 0;
  let i = 1;
  while (i + 1 < p.length) {
    const skip = p[i++];
    const len = p[i++];
    pos += skip;
    if (pos + len > FRAME_BYTES || i + len > p.length) { mirror.synced = false; return; }
    frame.set(p.subarray(i, i + len), pos);
    i += len;
    pos += len;
  }
  if (key) mirror.synced = true;
  paintLcd();
}

function onMirror(ev) {
  const dv = ev.target.value;
  if (dv.byteLength < 4) return;
  const id = dv.getUint8(0), idx = dv.getUint8(1), count = dv.getUint8(2);
  const body = new Uint8Array(dv.buffer, dv.byteOffset + 3, dv.byteLength - 3);
  if (id !== mirror.frameId) {
    if (mirror.got !== mirror.count && mirror.frameId !== -1) mirror.synced = false; // lost a frame
    mirror.frameId = id; mirror.parts = new Array(count); mirror.got = 0; mirror.count = count;
  }
  if (idx < count && !mirror.parts[idx]) {
    mirror.parts[idx] = body.slice();
    mirror.got++;
  }
  if (mirror.got === mirror.count) {
    let total = 0;
    for (const part of mirror.parts) total += part.length;
    const payload = new Uint8Array(total);
    let o = 0;
    for (const part of mirror.parts) { payload.set(part, o); o += part.length; }
    mirror.parts = []; mirror.got = 0; mirror.count = 0;
    applyPayload(payload);
  }
}

function onStatus(ev) {
  const dv = ev.target.value;
  if (dv.byteLength < 4) return;
  if (dv.getUint8(0) !== PROTO_VERSION) toast("ファームウェアの通信バージョンが異なります。", "err");
  state.active = dv.getUint8(1);
  state.fps = dv.getUint8(2);
  state.entry = dv.byteLength >= 7 ? dv.getUint8(6) : 255;
  readDiag(dv);
  renderLive();
  renderScenes();
  updatePlaylistHighlight();
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------
function setConnected(connected, name) {
  el.status.textContent = connected ? "接続中: " + name : "未接続";
  el.status.className = "status " + (connected ? "on" : "off");
  el.fields.disabled = !connected;
  el.connectBtn.textContent = connected ? "切断" : "接続";
}

async function readAll() {
  const c = state.chars;
  const sc = await gatt(() => c.scene.readValue());
  state.selected = Math.min(sc.getUint8(0), SCENES.length - 1);
  state.cycle = sc.getUint8(1);
  state.speed = sc.getUint8(2);
  state.flags = sc.getUint8(3);
  const pr = await gatt(() => c.params.readValue());
  if (pr.getUint8(0) < SCENES.length) {
    for (let k = 0; k < 4; k++) state.params[pr.getUint8(0)][k] = pr.getUint8(1 + k);
  }
  const bl = await gatt(() => c.backlight.readValue());
  const ds = await gatt(() => c.display.readValue());
  const ms = await gatt(() => c.message.readValue());
  el.day.value = bl.getUint8(0);
  el.night.value = bl.getUint8(1);
  el.nstart.value = String(bl.getUint8(2));
  el.nend.value = String(bl.getUint8(3));
  el.contrast.value = ds.getUint8(0);
  el.flip.checked = ds.getUint8(1) === 1;
  el.message.value = new TextDecoder("ascii").decode(ms);
  for (const i of [el.day, el.night, el.contrast, el.nstart, el.nend, el.message]) i.dispatchEvent(new Event("input"));
  const st = await gatt(() => c.status.readValue());
  if (st.getUint8(0) !== PROTO_VERSION) toast("ファームウェアの通信バージョンが異なります。", "err");
  state.active = st.getUint8(1);
  state.fps = st.getUint8(2);
  readDiag(st);

  const nc = await gatt(() => c.newsCfg.readValue());
  state.news.source = nc.getUint8(0);
  state.news.interval = nc.getUint8(1);
  const nu = await gatt(() => c.newsUrl.readValue());
  state.news.url = new TextDecoder("ascii").decode(nu);
  readNewsStatus(await gatt(() => c.newsStatus.readValue()));
  state.entry = st.byteLength >= 7 ? st.getUint8(6) : 255;
  const pl = await gatt(() => c.playlist.readValue());
  if (pl.byteLength >= 1) state.playlist = parsePlaylist(pl);
  state.plDirty = false;
}

async function connectGatt() {
  const server = await state.device.gatt.connect();
  const service = await server.getPrimaryService(UUID.service);
  const names = ["backlight", "display", "message", "scene", "params", "action", "status", "mirror",
    "newsCfg", "newsUrl", "newsStatus", "playlist"];
  const list = await Promise.all(names.map((n) => service.getCharacteristic(UUID[n])));
  state.chars = Object.fromEntries(names.map((n, i) => [n, list[i]]));

  await readAll();
  state.chars.status.addEventListener("characteristicvaluechanged", onStatus);
  state.chars.mirror.addEventListener("characteristicvaluechanged", onMirror);
  state.chars.newsStatus.addEventListener("characteristicvaluechanged", (ev) => readNewsStatus(ev.target.value));
  await gatt(() => state.chars.status.startNotifications());
  await gatt(() => state.chars.newsStatus.startNotifications());
  if (el.mirrorOn.checked) await gatt(() => state.chars.mirror.startNotifications());

  renderGlobals(); renderScenes(); renderParams(); renderLive(); renderNewsControls(); renderNewsInfo(); renderPlaylist();
  setConnected(true, state.device.name || "ESPmono-clock");
}

async function connect() {
  el.connectBtn.disabled = true;
  try {
    if (!state.device) {
      state.device = await navigator.bluetooth.requestDevice({ filters: [{ services: [UUID.service] }] });
      state.device.addEventListener("gattserverdisconnected", onDisconnected);
    }
    toast("接続中...");
    mirror.synced = false;
    await connectGatt();
    toast("接続しました。", "ok");
  } catch (err) {
    state.chars = null;
    toast(err && err.name === "NotFoundError" ? "デバイスが選択されませんでした。" : "接続に失敗しました: " + errText(err),
      err && err.name === "NotFoundError" ? "" : "err");
    setConnected(false);
  } finally { el.connectBtn.disabled = false; }
}

function disconnect() { if (state.device && state.device.gatt.connected) state.device.gatt.disconnect(); }

function onDisconnected() {
  state.chars = null;
  state.active = -1;
  gattChain = Promise.resolve();
  setConnected(false);
  renderScenes(); renderLive();
  toast("切断されました。「接続」で再接続できます。", "");
}

// ---------------------------------------------------------------------------
// Static controls
// ---------------------------------------------------------------------------
function fillHours(select) {
  for (let h = 0; h < 24; h++) {
    const o = document.createElement("option");
    o.value = String(h);
    o.textContent = String(h).padStart(2, "0") + ":00";
    select.append(o);
  }
}
const sanitizeMessage = (t) => t.replace(/[^\x20-\x7e]/g, "").slice(0, MESSAGE_MAX_LEN);

function bindUi() {
  fillHours(el.nstart); fillHours(el.nend);
  el.nstart.value = "22"; el.nend.value = "4";
  const sync = () => {
    el.dayOut.textContent = el.day.value;
    el.nightOut.textContent = el.night.value;
    el.contrastOut.textContent = el.contrast.value;
    const p = (h) => String(h).padStart(2, "0");
    el.nightHint.textContent = "夜間 = " + p(el.nstart.value) + ":00 以降 〜 " + p(el.nend.value) + ":59 まで(日をまたぐ設定も可)";
    el.msgCount.textContent = el.message.value.length + " / " + MESSAGE_MAX_LEN;
  };
  for (const i of [el.day, el.night, el.contrast, el.nstart, el.nend]) i.addEventListener("input", sync);
  el.message.addEventListener("input", () => {
    const clean = sanitizeMessage(el.message.value);
    if (clean !== el.message.value) el.message.value = clean;
    sync();
  });
  sync();

  el.mode.addEventListener("change", () => {
    state.cycle = el.mode.value === "fixed" ? 0 : 20;  // any non-zero value means "play the playlist"
    sendScene();
    renderGlobals();
    updatePlaylistHighlight();
  });
  el.plAdd.addEventListener("click", () => {
    if (state.playlist.length >= PLAYLIST_MAX) return;
    state.playlist.push({ scene: 1, seconds: 20, source: NEWS_DEFAULT_SRC, dwell: 0, all: false });
    plMarkDirty();
    renderPlaylist();
  });
  el.plSample.addEventListener("click", () => { state.playlist = samplePlaylist(); plMarkDirty(); renderPlaylist(); });
  el.plReset.addEventListener("click", () => { state.playlist = defaultPlaylist(); plMarkDirty(); renderPlaylist(); });
  el.plApply.addEventListener("click", applyPlaylist);
  el.speed.addEventListener("input", () => { state.speed = Number(el.speed.value); el.speedOut.textContent = state.speed; sendScene(); });
  const flag = (box, bit) => box.addEventListener("change", () => {
    state.flags = box.checked ? state.flags | bit : state.flags & ~bit;
    sendScene();
  });
  flag(el.fClock, FLAG.CLOCK); flag(el.fDepth, FLAG.DEPTH); flag(el.fName, FLAG.NAME); flag(el.fFps, FLAG.FPS);

  el.nextBtn.addEventListener("click", () => sendAction(ACTION.NEXT));
  el.dropBtn.addEventListener("click", () => sendAction(ACTION.DROP));
  el.resetBtn.addEventListener("click", () => sendAction(ACTION.RESET));
  for (const [i, name] of NEWS_PRESETS.entries()) {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = name;
    el.newsSource.append(o);
  }
  const custom = document.createElement("option");
  custom.value = String(NEWS_CUSTOM);
  custom.textContent = "任意の RSS(URL を入力)";
  el.newsSource.append(custom);
  el.newsSource.addEventListener("change", () => { el.newsUrlRow.hidden = Number(el.newsSource.value) !== NEWS_CUSTOM; });
  el.newsApply.addEventListener("click", applyNews);
  el.newsRefresh.addEventListener("click", () => { sendAction(ACTION.NEWS_REFRESH); toast("ニュースを更新します(数秒かかります)。", "ok"); });
  el.reinitBtn.addEventListener("click", () => { sendAction(ACTION.LCD_REINIT); toast("液晶を再初期化しました。", "ok"); });
  el.faultBtn.addEventListener("click", () => {
    sendAction(ACTION.LCD_FAULT_TEST);
    toast("液晶を一瞬消しました。0.5 秒以内に自動で戻れば正常です。", "");
  });
  el.syncBtn.addEventListener("click", () => { sendAction(ACTION.TIME_SYNC); toast("時刻合わせを開始しました(数秒かかります)。", "ok"); });
  el.defaultsBtn.addEventListener("click", () => {
    state.params[state.selected] = SCENES[state.selected].params.map((p) => p.def);
    renderParams();
    sendParams();
  });

  el.mirrorOn.addEventListener("change", () => {
    if (!state.chars) return;
    mirror.synced = false;
    gatt(() => (el.mirrorOn.checked ? state.chars.mirror.startNotifications() : state.chars.mirror.stopNotifications()))
      .catch((e) => toast("ライブ表示の切り替えに失敗: " + errText(e), "err"));
  });

  el.form.addEventListener("submit", applyDisplaySettings);
}

async function applyDisplaySettings(event) {
  event.preventDefault();
  if (!state.chars) return;
  el.applyBtn.disabled = true;
  try {
    const message = sanitizeMessage(el.message.value);
    el.message.value = message;
    await gatt(() => state.chars.backlight.writeValueWithResponse(new Uint8Array([
      Number(el.day.value), Number(el.night.value), Number(el.nstart.value), Number(el.nend.value)])));
    await gatt(() => state.chars.display.writeValueWithResponse(new Uint8Array([
      Number(el.contrast.value), el.flip.checked ? 1 : 0])));
    await gatt(() => state.chars.message.writeValueWithResponse(new TextEncoder().encode(message)));
    toast("時計に反映しました。", "ok");
  } catch (err) {
    toast("書き込みに失敗しました: " + errText(err), "err");
  } finally { el.applyBtn.disabled = false; }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
bindUi();
setConnected(false);
renderScenes();
renderParams();
renderGlobals();
renderLive();
renderNewsControls();
state.playlist = defaultPlaylist();
renderPlaylist();
paintLcd();

if (!("bluetooth" in navigator)) {
  el.unsupported.hidden = false;
  el.connectBtn.disabled = true;
} else {
  el.connectBtn.addEventListener("click", () => (state.device && state.device.gatt.connected ? disconnect() : connect()));
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => { /* PWA install is optional */ });
}
