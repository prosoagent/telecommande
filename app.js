"use strict";

// Relais MQTT public : tous les messages sont chiffrés (AES-GCM) avec la clé propre à chaque télé.
const BROKER = "wss://broker.hivemq.com:8884/mqtt";
const FAVORITES = ["youtube", "netflix", "prime", "disney", "canal", "spotify", "twitch", "plex"];

const $ = (id) => document.getElementById(id);

// Télés : [{ id, type, name, … }] ; une seule est pilotée à la fois.
// type "relay" : télé avec l'app Télécommande (via Internet, de partout, clé k)
// type "roku" | "samsung" | "lg" | "cast" : télé du Wi-Fi pilotée directement (ip)
let tvs = loadTvs();
let currentId = readStore("stv-current") || (tvs[0] && tvs[0].id);
const states = {};     // id → dernier état reçu par le relais
const nearby = {};     // id → true si la télé du Wi-Fi répond
let found = [];        // télés trouvées par la dernière recherche
let scanning = false;
let client = null;
let dragging = false;

function readStore(k) {
  try { return localStorage.getItem(k); } catch (e) { return null; }
}

function writeStore(k, v) {
  try { localStorage.setItem(k, v); } catch (e) {}
}

function loadTvs() {
  let list = [];
  try { list = JSON.parse(readStore("stv-tvs")) || []; } catch (e) {}
  // Ancien format (une seule télé)
  try {
    const old = JSON.parse(readStore("stv"));
    if (old && old.id && !list.some((t) => t.id === old.id)) list.push({ id: old.id, k: old.k, name: "" });
  } catch (e) {}
  list.forEach((t) => { if (!t.type) t.type = "relay"; });
  // Le QR code ouvre la page avec #id=…&k=… ; ce fragment n'est jamais envoyé au serveur web.
  const h = new URLSearchParams(location.hash.slice(1));
  const id = h.get("id"), k = h.get("k");
  if (id && k) {
    const existing = list.find((t) => t.id === id);
    if (existing) existing.k = k;
    else list.push({ id, type: "relay", k, name: "" });
    writeStore("stv-current", id);
  }
  writeStore("stv-tvs", JSON.stringify(list));
  return list;
}

function saveTvs() {
  writeStore("stv-tvs", JSON.stringify(tvs));
}

function current() {
  return tvs.find((t) => t.id === currentId);
}

function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

// Chiffrement AES-GCM par une bibliothèque : crypto.subtle n'existe pas sur une page http.
function encrypt(tv, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = nobleGcm(b64urlToBytes(tv.k), iv).encrypt(new TextEncoder().encode(JSON.stringify(obj)));
  const all = new Uint8Array(12 + ct.length);
  all.set(iv);
  all.set(ct, 12);
  return btoa(String.fromCharCode(...all));
}

function decrypt(tv, text) {
  const all = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  const pt = nobleGcm(b64urlToBytes(tv.k), all.slice(0, 12)).decrypt(all.slice(12));
  return JSON.parse(new TextDecoder().decode(pt));
}

async function sendTo(tv, c, v, d) {
  if (!client || !client.connected) return false;
  const n = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
  client.publish(`stv/${tv.id}/c`, encrypt(tv, { c, v, d, t: Date.now(), n }), { qos: 0 });
  return true;
}

async function send(c, v, d) {
  const tv = current();
  if (!tv) return;
  if (tv.type === "relay") {
    if (!(await sendTo(tv, c, v, d))) toast("Pas de connexion");
    return;
  }
  const saveToken = (token) => { tv.token = token; saveTvs(); };
  if (c === "key" && !Local.key(tv, v, saveToken)) toast("Touche indisponible sur cette télé depuis le Wi-Fi");
  else if (c === "app") Local.launch(tv, v, saveToken);
  else if (c === "vol") Local.setVolume(tv, v, saveToken);
}

function tvLabel(tv) {
  return tv.name || (states[tv.id] && states[tv.id].name) || "Télé";
}

function tvSubtitle(tv) {
  if (tv.type !== "relay") {
    const where = nearby[tv.id] === undefined ? "Recherche…" : nearby[tv.id] ? "Sur ce Wi-Fi" : "Pas sur ce Wi-Fi";
    return `${Local.LABEL[tv.type]} · ${where}`;
  }
  const s = states[tv.id];
  return !s ? "Recherche…" : s.online ? "Allumée · accessible de partout" : "Éteinte ou hors ligne";
}

function tvOnline(tv) {
  if (tv.type !== "relay") return nearby[tv.id];
  return states[tv.id] ? states[tv.id].online : undefined;
}

function setStatus(kind, text) {
  $("status").className = "status " + kind;
  $("status-text").textContent = text;
}

function render() {
  const tv = current();
  $("tv-name").textContent = tv ? tvLabel(tv) : "Télé";
  renderList();

  if (!tv) return setStatus("", "Aucune télé");
  $("vol-row").classList.toggle("hidden", !(tv.type === "relay" || tv.type === "lg"));
  if (tv.type !== "relay") return renderLocal(tv);

  const state = states[tv.id];
  if (!client || !client.connected) return setStatus("", "Connexion…");
  if (!state) return setStatus("", "Recherche…");
  if (!state.online) return setStatus("off", "Éteinte");
  if (!state.ready) return setStatus("", "Préparation…");
  setStatus("ok", "Connectée");

  const vol = $("vol");
  if (!dragging) {
    vol.max = state.max || 100;
    vol.value = state.muted ? 0 : state.vol;
    paintVolume();
  }

  renderApps(tv, (state.apps || []).slice().sort((a, b) => rank(a) - rank(b) || a.l.localeCompare(b.l)));
}

function renderLocal(tv) {
  if (nearby[tv.id] === undefined) setStatus("", "Recherche…");
  else if (nearby[tv.id]) setStatus("ok", "Sur ce Wi-Fi");
  else setStatus("off", "Pas sur ce Wi-Fi");
  renderApps(tv, Local.APPS[tv.type].map(([l, p]) => ({ l, p })));
}

function renderApps(tv, apps) {
  const box = $("apps");
  const sig = tv.id + ":" + apps.map((a) => a.p).join(",");
  if (box.dataset.sig !== sig) {
    box.dataset.sig = sig;
    box.replaceChildren(...apps.map((a) => {
      const b = document.createElement("button");
      b.textContent = a.l;
      b.addEventListener("click", () => { haptic(); send("app", a.p); });
      return b;
    }));
  }
}

function rank(app) {
  const name = (app.l + " " + app.p).toLowerCase();
  const i = FAVORITES.findIndex((f) => name.includes(f));
  return i < 0 ? 99 : i;
}

// --- Liste des télés (feuille du bas) ---

function renderList() {
  const box = $("tv-list");
  box.replaceChildren(...tvs.map((tv) => {
    const online = tvOnline(tv);
    const row = document.createElement("div");
    row.className = "tv-row" + (tv.id === currentId ? " current" : "") + (online === undefined ? "" : online ? " online" : " offline");
    const dot = document.createElement("span");
    dot.className = "dot";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = tvLabel(tv);
    const sub = document.createElement("span");
    sub.className = "sub";
    sub.textContent = tvSubtitle(tv);
    name.appendChild(sub);
    const rename = iconButton('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>', "Renommer");
    rename.addEventListener("click", (e) => {
      e.stopPropagation();
      const n = prompt("Nom de cette télé", tvLabel(tv));
      if (n && n.trim()) { tv.name = n.trim(); saveTvs(); render(); }
    });
    const del = iconButton('<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>', "Retirer");
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!confirm(`Retirer « ${tvLabel(tv)} » de tes télés ?`)) return;
      tvs = tvs.filter((t) => t.id !== tv.id);
      saveTvs();
      if (client) client.unsubscribe(`stv/${tv.id}/s`);
      if (currentId === tv.id) select(tvs[0] && tvs[0].id);
      render();
    });
    row.append(dot, name, rename, del);
    row.addEventListener("click", () => { select(tv.id); closeSheet(); });
    return row;
  }));
  renderFound();
}

// --- Recherche des télés du Wi-Fi ---

function isKnown(f) {
  return tvs.some((t) => (t.ip && t.ip === f.ip) ||
    (t.type === "relay" && f.type === "cast" && tvLabel(t) === f.name));
}

function renderFound() {
  const box = $("found-list");
  const fresh = found.filter((f) => !isKnown(f));
  $("scan-state").textContent = scanning ? $("scan-state").textContent
    : found.length ? (fresh.length ? `${fresh.length} nouvelle(s) télé(s) trouvée(s)` : "Aucune nouvelle télé") : "";
  box.replaceChildren(...fresh.map((f) => {
    const row = document.createElement("div");
    row.className = "tv-row";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = f.name;
    const sub = document.createElement("span");
    sub.className = "sub";
    sub.textContent = `${Local.LABEL[f.type]} · ${f.ip}` + (f.type === "cast" ? " · applis seulement" : "");
    name.appendChild(sub);
    const add = document.createElement("button");
    add.className = "pill";
    add.textContent = "Ajouter";
    row.append(name, add);
    row.addEventListener("click", () => addLocal(f));
    return row;
  }));
}

function addLocal(f) {
  const tv = { id: "l-" + f.ip, type: f.type, ip: f.ip, name: f.name };
  tvs = tvs.filter((t) => t.id !== tv.id).concat(tv);
  nearby[tv.id] = true;
  saveTvs();
  select(tv.id);
  closeSheet();
  if (tv.type === "samsung" || tv.type === "lg") toast("Accepte la demande qui s'affiche sur la télé");
}

async function scanWifi() {
  if (scanning) return;
  scanning = true;
  found = [];
  $("scan").disabled = true;
  $("scan-state").textContent = "Recherche des box…";
  renderFound();
  const extraSubnets = tvs.filter((t) => t.ip).map((t) => t.ip.split(".").slice(0, 3).join("."));
  try {
    const res = await Local.scan({
      extraSubnets,
      onFound: (f) => { found.push(f); renderFound(); },
      onProgress: (p) => { $("scan-state").textContent = `Recherche sur le Wi-Fi… ${Math.round(p * 100)} %`; },
    });
    if (!res.subnets.length) $("scan-state").textContent = "Réseau non reconnu : entre l'adresse IP de la télé ci-dessous";
  } finally {
    scanning = false;
    $("scan").disabled = false;
    if (found.length || $("scan-state").textContent.startsWith("Recherche")) renderFound();
    refreshNearby();
  }
  const fresh = found.filter((f) => !isKnown(f));
  if (fresh.length && $("sheet").classList.contains("hidden")) toast(`${fresh.length} télé(s) trouvée(s) sur ce Wi-Fi`);
}

async function addByIp() {
  const ip = $("ip").value.trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return toast("Adresse IP invalide");
  $("scan-state").textContent = "Vérification…";
  const f = await Local.identify(ip);
  if (!f) {
    $("scan-state").textContent = "Aucune télé reconnue à cette adresse";
    return;
  }
  addLocal(f);
}

async function refreshNearby() {
  await Promise.all(tvs.filter((t) => t.type !== "relay").map(async (t) => {
    nearby[t.id] = await Local.reachable(t);
  }));
  // En arrivant dans une autre maison : on bascule sur une télé de ce Wi-Fi si l'actuelle est injoignable
  const tv = current();
  if (tv && tvOnline(tv) === false) {
    const here = tvs.find((t) => tvOnline(t));
    if (here) select(here.id);
  }
  render();
}

function iconButton(paths, label) {
  const b = document.createElement("button");
  b.setAttribute("aria-label", label);
  b.innerHTML = `<svg viewBox="0 0 24 24">${paths}</svg>`;
  return b;
}

function select(id) {
  currentId = id;
  writeStore("stv-current", id || "");
  $("apps").dataset.sig = "";
  const tv = current();
  if (tv) sendTo(tv, "ping");
  render();
}

function openSheet() {
  renderList();
  $("sheet").classList.remove("hidden");
}

function closeSheet() {
  $("sheet").classList.add("hidden");
}

// --- Curseur de volume : on envoie le niveau exact pendant qu'on glisse ---

function paintVolume() {
  const vol = $("vol");
  const pct = vol.max > 0 ? (vol.value / vol.max) * 100 : 0;
  vol.style.setProperty("--p", pct + "%");
  $("vol-value").textContent = vol.value;
}

function bindVolume() {
  const vol = $("vol");
  let last = 0, pending = null;
  const push = () => {
    last = Date.now();
    pending = null;
    send("vol", Number(vol.value));
  };
  vol.addEventListener("pointerdown", () => { dragging = true; });
  vol.addEventListener("input", () => {
    dragging = true;
    paintVolume();
    clearTimeout(pending);
    if (Date.now() - last > 120) push();
    else pending = setTimeout(push, 120);
  });
  const end = () => {
    if (!dragging) return;
    clearTimeout(pending);
    push();
    setTimeout(() => { dragging = false; }, 600);
  };
  vol.addEventListener("change", end);
  vol.addEventListener("pointerup", end);
  vol.addEventListener("pointercancel", end);
}

function haptic() {
  if (navigator.vibrate) navigator.vibrate(8);
}

let toastTimer;
function toast(text) {
  $("toast").textContent = text;
  $("toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").classList.remove("show"), 1600);
}

// Appui sur une touche ; les touches marquées data-repeat se répètent tant qu'on garde le doigt dessus.
function bindKeys() {
  document.querySelectorAll("[data-key]").forEach((btn) => {
    const code = Number(btn.dataset.key);
    let delay, repeat;
    const stop = () => {
      clearTimeout(delay);
      clearInterval(repeat);
      btn.classList.remove("down");
    };
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      btn.classList.add("down");
      haptic();
      send("key", code);
      if (btn.hasAttribute("data-repeat")) {
        delay = setTimeout(() => { repeat = setInterval(() => send("key", code), 130); }, 400);
      }
    });
    ["pointerup", "pointerleave", "pointercancel"].forEach((ev) => btn.addEventListener(ev, stop));
    btn.addEventListener("contextmenu", (e) => e.preventDefault());
  });
}

function start() {
  if (!current() && tvs.length) currentId = tvs[0].id;
  $("remote").classList.remove("hidden");
  if (!navigator.standalone && !matchMedia("(display-mode: standalone)").matches && !readStore("stv-install-hidden")) {
    $("install").classList.remove("hidden");
  }
  $("install-close").addEventListener("click", () => {
    $("install").classList.add("hidden");
    writeStore("stv-install-hidden", "1");
  });

  bindKeys();
  bindVolume();
  $("tv-switch").addEventListener("click", openSheet);
  $("sheet").addEventListener("click", (e) => { if (e.target.id === "sheet") closeSheet(); });
  $("scan").addEventListener("click", scanWifi);
  $("ip-add").addEventListener("click", addByIp);

  client = mqtt.connect(BROKER, {
    clientId: "stv-p-" + Math.random().toString(16).slice(2, 10),
    keepalive: 30,
    reconnectPeriod: 2000,
    clean: true,
  });
  client.on("connect", () => {
    // On suit l'état de toutes les télés, pour voir lesquelles sont allumées
    tvs.forEach((tv) => client.subscribe(`stv/${tv.id}/s`));
    const tv = current();
    if (tv) sendTo(tv, "ping");
    render();
  });
  client.on("close", render);
  client.on("message", async (topic, message) => {
    const tv = tvs.find((t) => topic === `stv/${t.id}/s`);
    if (!tv) return;
    try {
      states[tv.id] = await decrypt(tv, message.toString());
      render();
    } catch (e) {
      // Message qui ne vient pas de cette télé : ignoré
    }
  });

  // Au retour dans l'app, on redemande l'état à la télé et on revérifie le Wi-Fi
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    const tv = current();
    if (client.connected && tv && tv.type === "relay") sendTo(tv, "ping");
    refreshNearby();
  });
  render();
  refreshNearby();
  // Recherche automatique des télés du Wi-Fi à chaque ouverture
  if (!tvs.length) openSheet();
  setTimeout(scanWifi, tvs.length ? 1500 : 0);
}

// Hauteur réelle de l'écran (les unités vh/dvh sont fausses dans une app installée sur iOS)
function measure() {
  document.documentElement.style.setProperty("--vh", window.innerHeight / 100 + "px");
}
measure();
window.addEventListener("resize", measure);
window.addEventListener("orientationchange", () => setTimeout(measure, 300));

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
start();
