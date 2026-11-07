"use strict";

// Keep these UUIDs identical to include/config.h in the firmware.
const SERVICE_UUID = "ae6b0000-d452-4478-9a9f-6030f75771a7";
const CHR_BACKLIGHT = "ae6b0001-d452-4478-9a9f-6030f75771a7"; // [day%, night%, night_start_h, night_end_h]
const CHR_DISPLAY = "ae6b0002-d452-4478-9a9f-6030f75771a7";   // [contrast, flip]
const CHR_MESSAGE = "ae6b0003-d452-4478-9a9f-6030f75771a7";   // ASCII text
const MESSAGE_MAX_LEN = 21;

const $ = (id) => document.getElementById(id);
const el = {
  unsupported: $("unsupported"),
  status: $("status"),
  connectBtn: $("connectBtn"),
  fields: $("fields"),
  form: $("form"),
  applyBtn: $("applyBtn"),
  day: $("day"), dayOut: $("dayOut"),
  night: $("night"), nightOut: $("nightOut"),
  nstart: $("nstart"), nend: $("nend"), nightHint: $("nightHint"),
  contrast: $("contrast"), contrastOut: $("contrastOut"),
  flip: $("flip"),
  message: $("message"), msgCount: $("msgCount"),
  toast: $("msg"),
};

let device = null;
let chars = null; // { backlight, display, message }

// ------------------------------------------------------------------ UI helpers

function toast(text, kind) {
  el.toast.textContent = text;
  el.toast.className = "toast" + (kind ? " " + kind : "");
}

function setConnected(connected, name) {
  el.status.textContent = connected ? "接続中: " + name : "未接続";
  el.status.className = "status " + (connected ? "on" : "off");
  el.fields.disabled = !connected;
  el.connectBtn.textContent = connected ? "切断" : "接続";
}

function fillHours(select) {
  for (let h = 0; h < 24; h++) {
    const opt = document.createElement("option");
    opt.value = String(h);
    opt.textContent = String(h).padStart(2, "0") + ":00";
    select.appendChild(opt);
  }
}

function updateNightHint() {
  const s = Number(el.nstart.value);
  const e = Number(el.nend.value);
  const pad = (h) => String(h).padStart(2, "0");
  el.nightHint.textContent =
    "夜間 = " + pad(s) + ":00 以降 〜 " + pad(e) + ":59 まで(時刻をまたぐ設定も可)";
}

// Printable ASCII only, capped to the firmware's limit.
function sanitizeMessage(text) {
  return text.replace(/[^\x20-\x7e]/g, "").slice(0, MESSAGE_MAX_LEN);
}

function bindUi() {
  fillHours(el.nstart);
  fillHours(el.nend);
  el.nstart.value = "22";
  el.nend.value = "4";

  const sync = () => {
    el.dayOut.textContent = el.day.value;
    el.nightOut.textContent = el.night.value;
    el.contrastOut.textContent = el.contrast.value;
    updateNightHint();
    el.msgCount.textContent = el.message.value.length + " / " + MESSAGE_MAX_LEN;
  };
  for (const i of [el.day, el.night, el.contrast, el.nstart, el.nend]) {
    i.addEventListener("input", sync);
  }
  el.message.addEventListener("input", () => {
    const clean = sanitizeMessage(el.message.value);
    if (clean !== el.message.value) el.message.value = clean;
    sync();
  });
  sync();
}

// ------------------------------------------------------------------ BLE

async function readAll() {
  const [bl, ds, ms] = await Promise.all([
    chars.backlight.readValue(),
    chars.display.readValue(),
    chars.message.readValue(),
  ]).catch(async () => {
    // Some stacks dislike parallel GATT reads: fall back to sequential.
    const a = await chars.backlight.readValue();
    const b = await chars.display.readValue();
    const c = await chars.message.readValue();
    return [a, b, c];
  });

  el.day.value = bl.getUint8(0);
  el.night.value = bl.getUint8(1);
  el.nstart.value = String(bl.getUint8(2));
  el.nend.value = String(bl.getUint8(3));
  el.contrast.value = ds.getUint8(0);
  el.flip.checked = ds.getUint8(1) === 1;
  el.message.value = new TextDecoder("ascii").decode(ms);
  for (const i of [el.day, el.night, el.contrast, el.nstart, el.nend, el.message]) {
    i.dispatchEvent(new Event("input"));
  }
}

async function connectGatt() {
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(SERVICE_UUID);
  chars = {
    backlight: await service.getCharacteristic(CHR_BACKLIGHT),
    display: await service.getCharacteristic(CHR_DISPLAY),
    message: await service.getCharacteristic(CHR_MESSAGE),
  };
  await readAll();
  setConnected(true, device.name || "ESPmono-clock");
}

async function connect() {
  el.connectBtn.disabled = true;
  try {
    if (!device) {
      device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [SERVICE_UUID] }],
      });
      device.addEventListener("gattserverdisconnected", onDisconnected);
    }
    toast("接続中...");
    await connectGatt();
    toast("接続しました。現在の設定を読み込みました。", "ok");
  } catch (err) {
    if (err && err.name === "NotFoundError") {
      toast("デバイスが選択されませんでした。", "");
    } else {
      toast("接続に失敗しました: " + (err && err.message ? err.message : err), "err");
    }
    setConnected(false);
  } finally {
    el.connectBtn.disabled = false;
  }
}

function disconnect() {
  if (device && device.gatt.connected) device.gatt.disconnect();
}

function onDisconnected() {
  chars = null;
  setConnected(false);
  toast("切断されました。「接続」で再接続できます。", "");
}

async function apply(event) {
  event.preventDefault();
  if (!chars) return;
  el.applyBtn.disabled = true;
  try {
    const message = sanitizeMessage(el.message.value);
    el.message.value = message;
    // Sequential writes: Web Bluetooth allows one GATT operation at a time.
    await chars.backlight.writeValueWithResponse(new Uint8Array([
      Number(el.day.value), Number(el.night.value),
      Number(el.nstart.value), Number(el.nend.value),
    ]));
    await chars.display.writeValueWithResponse(new Uint8Array([
      Number(el.contrast.value), el.flip.checked ? 1 : 0,
    ]));
    await chars.message.writeValueWithResponse(new TextEncoder().encode(message));
    toast("時計に反映しました。", "ok");
  } catch (err) {
    toast("書き込みに失敗しました: " + (err && err.message ? err.message : err), "err");
  } finally {
    el.applyBtn.disabled = false;
  }
}

// ------------------------------------------------------------------ boot

bindUi();
setConnected(false);

if (!("bluetooth" in navigator)) {
  el.unsupported.hidden = false;
  el.connectBtn.disabled = true;
} else {
  el.connectBtn.addEventListener("click", () => {
    if (device && device.gatt.connected) disconnect();
    else connect();
  });
  el.form.addEventListener("submit", apply);
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => { /* PWA install is optional */ });
}
