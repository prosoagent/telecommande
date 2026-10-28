"use strict";

// Télés du Wi-Fi pilotées directement depuis la page (sans app installée sur la télé).
// Fonctionne parce que la page est servie en http : Safari bloque ces requêtes depuis une page https.

const Local = (() => {
  const PROBE_MS = 1300;

  // Sous-réseaux les plus courants des box et routeurs
  const SUBNETS = [
    "192.168.1", "192.168.0", "192.168.2", "192.168.3", "192.168.4", "192.168.5", "192.168.10",
    "192.168.11", "192.168.31", "192.168.50", "192.168.68", "192.168.86", "192.168.88", "192.168.100",
    "192.168.178", "192.168.188", "10.0.0", "10.0.1", "10.1.1", "172.16.0",
  ];

  // Touches Android (celles des boutons de la page) → touches de chaque marque
  const ROKU = { 26: "PowerOff", 176: "Info", 178: "InputHDMI1", 164: "VolumeMute", 19: "Up", 20: "Down", 21: "Left",
    22: "Right", 23: "Select", 4: "Back", 3: "Home", 82: "Info", 24: "VolumeUp", 25: "VolumeDown", 85: "Play",
    89: "Rev", 90: "Fwd", 166: "ChannelUp", 167: "ChannelDown" };
  const SAMSUNG = { 26: "KEY_POWER", 176: "KEY_MENU", 178: "KEY_SOURCE", 164: "KEY_MUTE", 19: "KEY_UP", 20: "KEY_DOWN",
    21: "KEY_LEFT", 22: "KEY_RIGHT", 23: "KEY_ENTER", 4: "KEY_RETURN", 3: "KEY_HOME", 82: "KEY_TOOLS",
    24: "KEY_VOLUP", 25: "KEY_VOLDOWN", 85: "KEY_PLAY", 89: "KEY_REWIND", 90: "KEY_FF", 166: "KEY_CHUP", 167: "KEY_CHDOWN" };
  const LG = { 176: "MENU", 164: "MUTE", 19: "UP", 20: "DOWN", 21: "LEFT", 22: "RIGHT", 23: "ENTER", 4: "BACK",
    3: "HOME", 82: "INFO", 24: "VOLUMEUP", 25: "VOLUMEDOWN", 85: "PLAY", 89: "REWIND", 90: "FASTFORWARD",
    166: "CHANNELUP", 167: "CHANNELDOWN" };

  const APPS = {
    roku: [["Netflix", "12"], ["YouTube", "837"], ["Prime Video", "13"], ["Disney+", "291097"], ["Spotify", "22297"]],
    samsung: [["Netflix", "11101200001"], ["YouTube", "111299001912"], ["Prime Video", "3201512006785"],
      ["Disney+", "3201901017640"], ["Spotify", "3201606009684"]],
    lg: [["Netflix", "netflix"], ["YouTube", "youtube.leanback.v4"], ["Prime Video", "amazon"],
      ["Disney+", "com.disney.disneyplus-prod"], ["Spotify", "spotify-beehive"]],
    cast: [["Netflix", "Netflix"], ["YouTube", "YouTube"]],
  };

  const LABEL = { roku: "Roku", samsung: "Samsung", lg: "LG", cast: "Google TV / Android TV" };

  // --- Sondes réseau ---

  function timeout(ms) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    return { signal: c.signal, done: () => clearTimeout(t) };
  }

  /** "open" si un serveur http répond, "host" si la machine existe mais refuse, null si personne. */
  async function probe(url, ms = PROBE_MS) {
    const t = timeout(ms);
    const start = Date.now();
    try {
      await fetch(url, { mode: "no-cors", cache: "no-store", signal: t.signal });
      return "open";
    } catch (e) {
      return !t.signal.aborted && Date.now() - start < ms - 100 ? "host" : null;
    } finally {
      t.done();
    }
  }

  async function readJson(url, ms = PROBE_MS) {
    const t = timeout(ms);
    try {
      const r = await fetch(url, { cache: "no-store", signal: t.signal });
      return await r.json();
    } catch (e) {
      return null;
    } finally {
      t.done();
    }
  }

  function wsOpens(url, ms = PROBE_MS) {
    return new Promise((resolve) => {
      let ws;
      const t = setTimeout(() => { try { ws.close(); } catch (e) {} resolve(false); }, ms);
      try {
        ws = new WebSocket(url);
        ws.onopen = () => { clearTimeout(t); ws.close(); resolve(true); };
        ws.onerror = () => { clearTimeout(t); resolve(false); };
      } catch (e) {
        clearTimeout(t);
        resolve(false);
      }
    });
  }

  /** Identifie la télé à une adresse IP, ou null. */
  async function identify(ip) {
    const [cast, roku, samsung, lg] = await Promise.all([
      readJson(`http://${ip}:8008/setup/eureka_info?params=name,device_info`),
      probe(`http://${ip}:8060/`),
      probe(`http://${ip}:8001/api/v2/`),
      wsOpens(`ws://${ip}:3000`),
    ]);
    if (roku === "open") return { type: "roku", ip, name: "Roku" };
    if (samsung === "open") {
      const info = await readJson(`http://${ip}:8001/api/v2/`);
      return { type: "samsung", ip, name: (info && info.device && info.device.name) || "Samsung" };
    }
    if (lg) return { type: "lg", ip, name: "LG" };
    if (cast) {
      const model = cast.device_info && cast.device_info.model_name;
      return { type: "cast", ip, name: cast.name || model || "Google TV" };
    }
    return null;
  }

  /** Trouve les sous-réseaux joignables (la box répond en .1 ou .254). */
  async function findSubnets(extra) {
    const list = [...new Set([...(extra || []), ...SUBNETS])];
    const found = await Promise.all(list.map(async (s) => {
      const [a, b] = await Promise.all([probe(`http://${s}.1/`, 1500), probe(`http://${s}.254/`, 1500)]);
      // Une box qui répond vraiment (page web) passe avant une simple réponse de refus
      return a || b ? { s, score: a === "open" || b === "open" ? 0 : 1 } : null;
    }));
    return found.filter(Boolean).sort((x, y) => x.score - y.score).map((x) => x.s);
  }

  /** Cherche les télés du Wi-Fi ; onFound est appelé à chaque télé trouvée, onProgress de 0 à 1. */
  async function scan({ extraSubnets, onFound, onProgress }) {
    const subnets = (await findSubnets(extraSubnets)).slice(0, 2);
    const ips = [];
    subnets.forEach((s) => { for (let i = 2; i < 255; i++) ips.push(`${s}.${i}`); });
    let done = 0;
    const results = [];
    const worker = async () => {
      while (ips.length) {
        const ip = ips.shift();
        const tv = await identify(ip);
        if (tv) { results.push(tv); onFound && onFound(tv); }
        done++;
        onProgress && onProgress(done / (done + ips.length));
      }
    };
    await Promise.all(Array.from({ length: 48 }, worker));
    return { subnets, tvs: results };
  }

  async function reachable(tv) {
    if (tv.type === "cast") return !!(await readJson(`http://${tv.ip}:8008/setup/eureka_info?params=name`, 1500));
    if (tv.type === "roku") return (await probe(`http://${tv.ip}:8060/`, 1500)) === "open";
    if (tv.type === "samsung") return (await probe(`http://${tv.ip}:8001/api/v2/`, 1500)) === "open";
    if (tv.type === "lg") return wsOpens(`ws://${tv.ip}:3000`, 1500);
    return false;
  }

  // --- Pilotage ---

  const sockets = {};  // id → connexion WebSocket ouverte (Samsung, LG)

  function post(url) {
    return fetch(url, { method: "POST", mode: "no-cors", body: "" }).catch(() => {});
  }

  function samsung(tv, onToken) {
    const s = sockets[tv.id];
    if (s && s.ws.readyState <= 1) return s;
    const name = btoa("Télécommande".normalize("NFD").replace(/[̀-ͯ]/g, ""));
    const url = `ws://${tv.ip}:8001/api/v2/channels/samsung.remote.control?name=${name}` + (tv.token ? `&token=${tv.token}` : "");
    const ws = new WebSocket(url);
    const conn = { ws, queue: [] };
    ws.onopen = () => { conn.queue.forEach((m) => ws.send(m)); conn.queue = []; };
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m.event === "ms.channel.connect" && m.data && m.data.token) onToken(m.data.token);
      } catch (err) {}
    };
    sockets[tv.id] = conn;
    return conn;
  }

  function samsungSend(tv, msg, onToken) {
    const c = samsung(tv, onToken);
    const text = JSON.stringify(msg);
    if (c.ws.readyState === 1) c.ws.send(text);
    else c.queue.push(text);
  }

  function lg(tv, onToken) {
    const s = sockets[tv.id];
    if (s && s.ws.readyState <= 1) return s;
    const ws = new WebSocket(`ws://${tv.ip}:3000`);
    const conn = { ws, ready: false, queue: [], pointer: null, pointerQueue: [], seq: 0 };
    const permissions = ["LAUNCH", "LAUNCH_WEBAPP", "APP_TO_APP", "CONTROL_AUDIO", "CONTROL_DISPLAY",
      "CONTROL_INPUT_JOYSTICK", "CONTROL_INPUT_MEDIA_PLAYBACK", "CONTROL_INPUT_TV", "CONTROL_POWER",
      "READ_APP_STATUS", "READ_CURRENT_CHANNEL", "READ_INPUT_DEVICE_LIST", "READ_RUNNING_APPS",
      "WRITE_NOTIFICATION_TOAST", "READ_POWER_STATE", "CONTROL_MOUSE_AND_KEYBOARD", "READ_SETTINGS"];
    ws.onopen = () => ws.send(JSON.stringify({
      type: "register", id: "reg",
      payload: { forcePairing: false, pairingType: "PROMPT", "client-key": tv.token || undefined,
        manifest: { manifestVersion: 1, appVersion: "1.1", permissions } },
    }));
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch (err) { return; }
      if (m.type === "registered") {
        if (m.payload && m.payload["client-key"]) onToken(m.payload["client-key"]);
        conn.ready = true;
        conn.queue.forEach((q) => ws.send(q));
        conn.queue = [];
        ws.send(JSON.stringify({ type: "request", id: "pointer", uri: "ssap://com.webos.service.networkinput/getPointerInputSocket" }));
      } else if (m.id === "pointer" && m.payload && m.payload.socketPath) {
        const p = new WebSocket(m.payload.socketPath);
        p.onopen = () => { conn.pointer = p; conn.pointerQueue.forEach((b) => p.send(b)); conn.pointerQueue = []; };
      }
    };
    sockets[tv.id] = conn;
    return conn;
  }

  function lgRequest(tv, uri, payload, onToken) {
    const c = lg(tv, onToken);
    const text = JSON.stringify({ type: "request", id: "r" + (++c.seq), uri, payload: payload || {} });
    if (c.ready) c.ws.send(text);
    else c.queue.push(text);
  }

  function lgButton(tv, name, onToken) {
    const c = lg(tv, onToken);
    const text = `type:button\nname:${name}\n\n`;
    if (c.pointer && c.pointer.readyState === 1) c.pointer.send(text);
    else c.pointerQueue.push(text);
  }

  /** Envoie une touche ; renvoie false si cette télé ne la gère pas depuis le Wi-Fi. */
  function key(tv, code, onToken) {
    if (tv.type === "roku") {
      if (!ROKU[code]) return false;
      post(`http://${tv.ip}:8060/keypress/${ROKU[code]}`);
      return true;
    }
    if (tv.type === "samsung") {
      if (!SAMSUNG[code]) return false;
      samsungSend(tv, { method: "ms.remote.control",
        params: { Cmd: "Click", DataOfCmd: SAMSUNG[code], Option: "false", TypeOfRemote: "SendRemoteKey" } }, onToken);
      return true;
    }
    if (tv.type === "lg") {
      if (code === 26) { lgRequest(tv, "ssap://system/turnOff", {}, onToken); return true; }
      if (!LG[code]) return false;
      lgButton(tv, LG[code], onToken);
      return true;
    }
    return false;
  }

  function launch(tv, appId, onToken) {
    if (tv.type === "roku") post(`http://${tv.ip}:8060/launch/${appId}`);
    else if (tv.type === "cast") post(`http://${tv.ip}:8008/apps/${appId}`);
    else if (tv.type === "samsung") {
      samsungSend(tv, { method: "ms.channel.emit",
        params: { event: "ed.apps.launch", to: "host", data: { appId, action_type: "DEEP_LINK" } } }, onToken);
    } else if (tv.type === "lg") lgRequest(tv, "ssap://system.launcher/launch", { id: appId }, onToken);
  }

  function setVolume(tv, level, onToken) {
    if (tv.type === "lg") lgRequest(tv, "ssap://audio/setVolume", { volume: level }, onToken);
  }

  return { scan, identify, reachable, key, launch, setVolume, APPS, LABEL };
})();
