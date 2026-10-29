// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 Defani Arman (Alfitriansyah)
//
// GeoLibre external plugin: Live MCP Bridge
//
// The GeoLibre MCP server that ships with the `geolibre` Python package only
// edits `.geolibre.json` files on disk; it cannot see the app that is running.
// This plugin closes that gap, the same way the QGIS MCP plugin does for QGIS:
//
//   AI client  <--stdio-->  geolibre-live (Python MCP server)
//                               |  WebSocket server on 127.0.0.1:<port>
//                               v
//                           this plugin (WebSocket *client*, inside GeoLibre)
//                               |  GeoLibre plugin API (app.*) + MapLibre map
//                               v
//                           the live map
//
// The plugin is the client, not the server, because code running inside the
// app's webview cannot listen on a port. The desktop CSP already allows
// `ws://127.0.0.1:*`, so no host change is needed.
//
// Protocol (JSON text frames):
//   plugin -> server  {type:"hello", token, plugin:{id,version}, app:{renderer,locale}}
//   server -> plugin  {type:"welcome"} | {type:"reject", reason}
//   server -> plugin  {type:"request", id, method, params}
//   plugin -> server  {type:"response", id, ok:true, result} | {type:"response", id, ok:false, error}
//
// Self-contained ES module: no imports (the external-plugin loader does not
// resolve relative or bare imports inside the zip).

const PLUGIN_ID = "geolibre-live-bridge";
const PLUGIN_NAME = "Live MCP Bridge";
const PLUGIN_VERSION = "0.11.1";
const PANEL_ID = `${PLUGIN_ID}-panel`;
const SETTINGS_KEY = `${PLUGIN_ID}:settings`;

const DEFAULT_PORT = 9878;
// The stdio MCP server every desktop client launches (`uv tool install` puts it here).
const DEFAULT_COMMAND = "C:\\Users\\ASUS\\.local\\bin\\geolibre-live.exe";
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 10000;
const MAX_FEATURES = 5000; // hard ceiling per get_layer_features call
const COORD_DECIMALS = 6; // ~0.1 m at the equator; enough for any map read-out

// ############################################################################
// ########## State and settings ##############################################
// ############################################################################

const state = {
  app: null,
  map: null,
  ws: null,
  status: "disconnected", // disconnected | connecting | connected | rejected
  statusDetail: "",
  enabled: false,
  reconnectTimer: null,
  reconnectDelay: RECONNECT_MIN_MS,
  log: [],
  listeners: new Set(),
  disposePanel: null,
  settings: loadSettings(),
};

function loadSettings() {
  const defaults = { port: DEFAULT_PORT, token: "", autoConnect: true, allowExec: false, command: DEFAULT_COMMAND, activeClient: "claude", skin: false, settingsRev: 3 };
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return defaults;
    const saved = JSON.parse(raw);
    // rev 2: Claude became the default client; move older settings over once
    if (!(saved.settingsRev >= 2)) Object.assign(saved, { activeClient: "claude", settingsRev: 2 });
    // rev 3: the app keeps its own UI by default (the workbench skin is opt-in: /skin on)
    if (!(saved.settingsRev >= 3)) Object.assign(saved, { skin: false, settingsRev: 3 });
    return { ...defaults, ...saved };
  } catch {
    return defaults;
  }
}

function saveSettings() {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  } catch {
    /* storage unavailable: settings last for this session only */
  }
}

function setStatus(status, detail = "") {
  state.status = status;
  state.statusDetail = detail;
  notify();
}

// PROCESS status box: names the geoprocessing/SQL currently running.
state.proc = { kind: "idle", text: "tools ready — waiting for a command…", code: "" };

function setProc(kind, text, code = "") {
  state.proc = { kind, text, code };
  notify();
}

function pushLog(line) {
  const stamp = new Date().toLocaleTimeString();
  state.log.unshift(`${stamp}  ${line}`);
  state.log.length = Math.min(state.log.length, 40);
  notify();
}

function notify() {
  for (const fn of state.listeners) {
    try {
      fn();
    } catch {
      /* a broken listener must not stop the others */
    }
  }
}

// ############################################################################
// ########## WebSocket client ################################################
// ############################################################################

function connect() {
  state.enabled = true;
  clearTimeout(state.reconnectTimer);
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  const url = `ws://127.0.0.1:${Number(state.settings.port) || DEFAULT_PORT}`;
  setStatus("connecting", url);
  let ws;
  try {
    ws = new WebSocket(url);
  } catch (err) {
    setStatus("disconnected", String(err?.message ?? err));
    scheduleReconnect();
    return;
  }
  state.ws = ws;

  ws.onopen = () => {
    ws.send(
      JSON.stringify({
        type: "hello",
        token: state.settings.token || "",
        plugin: { id: PLUGIN_ID, version: PLUGIN_VERSION },
        app: {
          renderer: state.app?.getMapRenderer?.() ?? "maplibre",
          locale: state.app?.getLocale?.() ?? null,
          userAgent: navigator.userAgent,
        },
      }),
    );
  };

  ws.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === "welcome") {
      state.reconnectDelay = RECONNECT_MIN_MS;
      setStatus("connected", url);
      pushLog("Nyambung ka server MCP");
      if (!assistant.history.length) {
        renderBubble({ status: "info", message: "Asistén AI GeoLibre geus siap. Ketik di dieu atawa ngaliwatan klien MCP." });
      }
      renderListenBadge();
      return;
    }
    if (msg.type === "reject") {
      // A wrong token will not fix itself; stop retrying until the user acts.
      state.enabled = false;
      setStatus("rejected", msg.reason || "ditolak server");
      pushLog(`Ditolak: ${msg.reason || "-"}`);
      ws.close();
      return;
    }
    if (msg.type === "request") {
      const reply = await handleRequest(msg.method, msg.params || {});
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "response", id: msg.id, ...reply }));
      }
    }
  };

  ws.onclose = () => {
    if (state.ws === ws) state.ws = null;
    if (state.status !== "rejected") setStatus("disconnected", "");
    if (state.enabled) scheduleReconnect();
  };

  ws.onerror = () => {
    /* onclose follows and handles the retry */
  };
}

function disconnect() {
  state.enabled = false;
  clearTimeout(state.reconnectTimer);
  state.ws?.close();
  state.ws = null;
  setStatus("disconnected", "");
}

function scheduleReconnect() {
  clearTimeout(state.reconnectTimer);
  const delay = state.reconnectDelay;
  state.reconnectDelay = Math.min(state.reconnectDelay * 2, RECONNECT_MAX_MS);
  state.reconnectTimer = setTimeout(() => {
    if (state.enabled) connect();
  }, delay);
}

// ############################################################################
// ########## Request handlers ################################################
// ############################################################################

async function handleRequest(method, params) {
  const handler = HANDLERS[method];
  if (!handler) return { ok: false, error: `Metode tidak dikenal: ${method}` };
  setProc("run", `${PROC_LABEL[method] ?? "handling"} …`, method);
  const step = activityStep(method);
  try {
    const result = await handler(params);
    pushLog(`OK  ${method}`);
    if (step) Object.assign(step, { status: "ok", ms: Date.now() - step.t0 });
    setProc("ok", `${method} done.`, method);
    return { ok: true, result };
  } catch (err) {
    const message = String(err?.message ?? err);
    pushLog(`ERR ${method}: ${message}`);
    if (step) Object.assign(step, { status: "err", ms: Date.now() - step.t0 });
    setProc("err", `${method} failed — ${message}`, method);
    return { ok: false, error: message };
  }
}

// One AI turn as the CLI shows it: started when a message is read or a map
// tool runs, ended by the assistant's done/info reply (or 2 min of silence).
const activity = { since: 0, last: 0, steps: [] };
// Chat plumbing, not work the user asked for.
const QUIET_METHODS = new Set(["ping", "chat_listen", "chat_wait", "chat_inbox", "assistant_say", "chat_stop"]);
const ACTIVITY_IDLE_MS = 120000;

function activityStart() {
  if (!activity.since) {
    Object.assign(activity, { since: Date.now(), steps: [] });
    agent.baseline = closeButtons();
    agent.collapsed = collapsedSections();
    agentOn("reading your message");
  }
  activity.last = Date.now();
}

function activityStep(method) {
  if (QUIET_METHODS.has(method)) return null;
  activityStart();
  const step = { method, label: PROC_LABEL[method] ?? method, status: "run", t0: Date.now(), ms: 0 };
  activity.steps.push(step);
  agentOn(step.label);
  return step;
}

/** Close the turn; returns its summary for the reply line. */
function activityEnd() {
  if (!activity.since) return null;
  const run = { ms: Date.now() - activity.since, tools: activity.steps.map((s) => s.method) };
  Object.assign(activity, { since: 0, last: 0, steps: [] });
  if (state.settings.autoClose !== false) closeOpened().finally(() => agentOff());
  else agentOff();
  notify();
  return run;
}

// Requests to open something (Indonesian, Sundanese, English) keep it open.
const OPEN_INTENT = /\b(buka|bukakeun|open|tampilkan|tampilkeun|pidangkeun|t[eé]mbongkeun|show)\b/i;

// Close buttons of panels/dialogs, except the Live MCP dock itself.
const CLOSE_LABEL = /^(close|close panel|close .+|tutup( .+)?)$/i;

function closeButtons() {
  const out = new Set();
  try {
    for (const { item, node } of uiCollect()) {
      if (!CLOSE_LABEL.test(item.label) || /live mcp/i.test(item.label)) continue;
      const host = node.closest("aside,section,[role=dialog],[class*=panel],[class*=Panel]");
      if (host?.querySelector(".glb-cli")) continue;
      out.add(node);
    }
  } catch {
    /* best-effort */
  }
  return out;
}

/**
 * Tidy up after a turn: close menus, then every panel/dialog that was opened
 * while the AI worked (its close button was not there when the turn started).
 */
async function closeOpened() {
  await sleep(900);
  if (activity.since) return; // a new turn started meanwhile
  // "buka SQL" / "open the style panel": the user wants it left open
  const ask = String(chat.lastAsk || "");
  const keep = OPEN_INTENT.test(ask) && !/\b(tutup|tutupkeun|close)\b/i.test(ask);
  if (keep) agent.baseline = new Set([...(agent.baseline ?? []), ...closeButtons()]);
  const base = agent.baseline ?? new Set();
  if (document.querySelector("[role=menu],[role=listbox],[data-radix-popper-content-wrapper]")) {
    uiKey(document.activeElement || document.body, "Escape");
    await sleep(150);
  }
  const fresh = [...closeButtons()].filter((n) => !base.has(n));
  // sidebar sections ("Expand Style" -> "Collapse Style") the AI opened
  const wasCollapsed = keep ? new Set() : agent.collapsed ?? new Set();
  try {
    for (const { item, node } of uiCollect()) {
      const m = /^collapse (.+)$/i.exec(item.label);
      if (m && wasCollapsed.has(m[1].toLowerCase()) && !/live mcp/i.test(m[1])) fresh.push(node);
    }
  } catch {
    /* best-effort */
  }
  for (const node of fresh.reverse()) {
    if (!node.isConnected) continue;
    await agentPoint(node, "close", uiLabel(node));
    for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) uiFire(node, t);
    await sleep(180);
  }
  agent.baseline = agent.collapsed = null;
}

/** Names of sidebar sections that are collapsed now (their button says "Expand …"). */
function collapsedSections() {
  const out = new Set();
  try {
    for (const { item } of uiCollect()) {
      const m = /^expand (.+)$/i.exec(item.label);
      if (m) out.add(m[1].toLowerCase());
    }
  } catch {
    /* best-effort */
  }
  return out;
}

function activityTimeout() {
  const running = activity.steps.some((s) => s.status === "run");
  if (activity.since && !running && !chat.typing && Date.now() - activity.last > ACTIVITY_IDLE_MS) activityEnd();
}

// Human-readable label for the PROCESS box, per MCP Bridge method.
const PROC_LABEL = {
  ping: "mariksa GeoLibre",
  get_state: "maca kaayaan peta",
  list_layers: "ngabéréndélkeun lapisan",
  get_project: "maca proyék",
  get_layer_features: "maca fitur lapisan",
  get_selection: "maca pilihan",
  screenshot: "moto peta",
  set_view: "mindahkeun tempoan peta",
  zoom_to_layer: "zoom ka lapisan",
  set_basemap: "ngaganti peta dasar",
  add_geojson_layer: "nambahkeun lapisan GeoJSON",
  exec_js: "ngajalankeun JS",
  tutorial: "muka tutorial",
  chat_listen: "ngadéngékeun pesen anjeun",
  chat_wait: "nungguan pesen anjeun",
  chat_inbox: "maca kotak pesen",
  assistant_say: "némbongkeun jawaban",
  ui_list: "nyeken tampilan",
  ui_read: "maca layar",
  ui_click: "ngaklik",
  ui_hover: "nunjuk",
  ui_type: "ngetik",
  ui_key: "mencét kenop",
  add_tile_layer: "nambahkeun lapisan ubin",
  show_chart: "nyieun grafik",
  activate_plugin: "ngaganti plugin",
  layout: "nyieun layout",
};

function requireApp() {
  if (!state.app) throw new Error("Plugin belum aktif di GeoLibre.");
  return state.app;
}

function currentMap() {
  // Re-read every time: GeoLibre rebuilds the map on a renderer swap.
  return state.app?.getMap?.() ?? null;
}

function round(value) {
  const f = 10 ** COORD_DECIMALS;
  return Math.round(value * f) / f;
}

function roundCoords(coords) {
  if (typeof coords === "number") return round(coords);
  if (Array.isArray(coords)) return coords.map(roundCoords);
  return coords;
}

function roundGeometry(geometry) {
  if (!geometry) return geometry;
  if (geometry.type === "GeometryCollection") {
    return { ...geometry, geometries: geometry.geometries.map(roundGeometry) };
  }
  return { ...geometry, coordinates: roundCoords(geometry.coordinates) };
}

function listLayers() {
  const app = requireApp();
  return app.listLayers?.() ?? [];
}

function resolveLayer(ref) {
  if (!ref) throw new Error("Parameter 'layer' (id atau nama) wajib diisi.");
  const layers = listLayers();
  const byId = layers.find((l) => l.id === ref);
  if (byId) return byId;
  const lower = String(ref).toLowerCase();
  const byName = layers.filter((l) => String(l.name).toLowerCase() === lower);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    throw new Error(`Nama layer '${ref}' ambigu (${byName.length} layer). Pakai id: ${byName.map((l) => l.id).join(", ")}`);
  }
  throw new Error(`Layer '${ref}' tidak ditemukan. Layer yang ada: ${layers.map((l) => l.name).join(", ") || "(kosong)"}`);
}

function viewState() {
  const app = requireApp();
  const map = currentMap();
  const view = {
    bounds: app.getViewBounds?.() ?? null,
    projection: app.getMapProjection?.() ?? null,
  };
  if (map) {
    const c = map.getCenter();
    Object.assign(view, {
      center: [round(c.lng), round(c.lat)],
      zoom: Math.round(map.getZoom() * 100) / 100,
      bearing: Math.round(map.getBearing() * 10) / 10,
      pitch: Math.round(map.getPitch() * 10) / 10,
      canvasSize: [map.getCanvas().clientWidth, map.getCanvas().clientHeight],
    });
  }
  return view;
}

function featureSummary(feature, includeGeometry) {
  const out = {
    id: feature.id ?? null,
    geometryType: feature.geometry?.type ?? null,
    properties: feature.properties ?? {},
  };
  if (includeGeometry) out.geometry = roundGeometry(feature.geometry);
  return out;
}

function bboxOfFeatures(features) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const visit = (c) => {
    if (typeof c[0] === "number") {
      if (c[0] < minX) minX = c[0];
      if (c[1] < minY) minY = c[1];
      if (c[0] > maxX) maxX = c[0];
      if (c[1] > maxY) maxY = c[1];
    } else {
      for (const x of c) visit(x);
    }
  };
  const visitGeom = (g) => {
    if (!g) return;
    if (g.type === "GeometryCollection") g.geometries.forEach(visitGeom);
    else if (g.coordinates) visit(g.coordinates);
  };
  for (const f of features) visitGeom(f.geometry);
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
}

// Replace inlined feature arrays with a count so a project snapshot stays small.
function slimProject(project, includeStyles) {
  const clone = JSON.parse(JSON.stringify(project));
  for (const layer of clone.layers ?? []) {
    if (layer.geojson?.features) {
      layer.geojson = { type: "FeatureCollection", featureCount: layer.geojson.features.length };
    }
    if (layer.source?.data?.features) {
      layer.source.data = { type: "FeatureCollection", featureCount: layer.source.data.features.length };
    }
    if (!includeStyles) delete layer.style;
  }
  if (!includeStyles) delete clone.styles;
  // Credentials never leave the app through this bridge.
  delete clone.plugins?.settings;
  for (const key of ["processingHistory", "storymap", "printLayout", "widgets"]) {
    if (clone[key] !== undefined) clone[key] = "(dihilangkan — terlalu besar untuk ringkasan)";
  }
  return clone;
}

function screenshot({ max_width = 1280, format = "jpeg", quality = 0.85 } = {}) {
  const map = currentMap();
  if (!map) throw new Error("Screenshot hanya didukung pada renderer MapLibre (peta 2D).");
  const mime = format === "png" ? "image/png" : "image/jpeg";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timeout menunggu frame peta.")), 5000);
    // The WebGL drawing buffer is cleared after compositing, so read it inside
    // the render event of a frame we force, not at an arbitrary time.
    map.once("render", () => {
      clearTimeout(timer);
      try {
        const src = map.getCanvas();
        const scale = Math.min(1, Number(max_width) / src.width);
        const out = document.createElement("canvas");
        out.width = Math.max(1, Math.round(src.width * scale));
        out.height = Math.max(1, Math.round(src.height * scale));
        const ctx = out.getContext("2d");
        if (mime === "image/jpeg") {
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, out.width, out.height);
        }
        ctx.drawImage(src, 0, 0, out.width, out.height);
        const dataUrl = out.toDataURL(mime, quality);
        resolve({
          mimeType: mime,
          data: dataUrl.slice(dataUrl.indexOf(",") + 1),
          width: out.width,
          height: out.height,
          note: "Hanya kanvas peta (WebGL). Panel, legenda, dan kontrol HTML tidak ikut.",
        });
      } catch (err) {
        reject(err);
      }
    });
    map.triggerRepaint();
  });
}

// Resolve once the camera stops moving (fitBounds/easeTo animate), so the
// reported view is where the map ended up, not where it started.
function waitForMoveEnd(timeoutMs = 4000) {
  const map = currentMap();
  if (!map) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      map.off("moveend", finish);
      resolve();
    };
    map.on("moveend", finish);
    setTimeout(finish, timeoutMs);
    // A jumpTo to the current view fires no moveend; don't wait for nothing.
    setTimeout(() => {
      if (!map.isMoving()) finish();
    }, 120);
  });
}

const HANDLERS = {
  ping: () => ({
    pong: true,
    plugin: { id: PLUGIN_ID, version: PLUGIN_VERSION },
    renderer: state.app?.getMapRenderer?.() ?? null,
    locale: state.app?.getLocale?.() ?? null,
    time: new Date().toISOString(),
  }),

  get_state: () => {
    const app = requireApp();
    const snapshot = app.getProjectSnapshot?.() ?? null;
    const selectedLayerId = app.getSelectedLayerId?.() ?? null;
    return {
      projectName: snapshot?.name ?? null,
      renderer: app.getMapRenderer?.() ?? null,
      view: viewState(),
      basemap: app.getActiveBasemap?.() ?? null,
      layers: listLayers(),
      layerGroups: app.listLayerGroups?.() ?? [],
      selectedLayer: selectedLayerId ? listLayers().find((l) => l.id === selectedLayerId) ?? { id: selectedLayerId } : null,
      selectedFeatureCount: app.getSelectedFeatures?.()?.length ?? 0,
      drawnFeatureCount: app.getDrawnFeatures?.()?.length ?? 0,
      terrainEnabled: app.isTerrainEnabled?.() ?? null,
      activeRightPanel: app.getActiveRightPanel?.() ?? null,
      openFloatingPanels: app.getOpenFloatingPanels?.() ?? [],
    };
  },

  list_layers: () => ({
    layers: listLayers(),
    layerGroups: requireApp().listLayerGroups?.() ?? [],
    selectedLayerId: requireApp().getSelectedLayerId?.() ?? null,
  }),

  get_project: ({ include_styles = false } = {}) => {
    const app = requireApp();
    if (!app.getProjectSnapshot) throw new Error("Versi GeoLibre ini belum punya getProjectSnapshot().");
    return slimProject(app.getProjectSnapshot(), include_styles);
  },

  get_layer_features: ({ layer, limit = 50, offset = 0, include_geometry = false } = {}) => {
    const app = requireApp();
    const info = resolveLayer(layer);
    if (!app.getLayerFeatures) throw new Error("Versi GeoLibre ini belum punya getLayerFeatures().");
    const all = app.getLayerFeatures(info.id) ?? [];
    const n = Math.max(0, Math.min(Number(limit) || 50, MAX_FEATURES));
    const start = Math.max(0, Number(offset) || 0);
    const slice = all.slice(start, start + n);
    const fields = new Set();
    for (const f of all.slice(0, 200)) Object.keys(f.properties ?? {}).forEach((k) => fields.add(k));
    return {
      layer: info,
      totalFeatures: all.length,
      offset: start,
      returned: slice.length,
      fields: [...fields],
      bbox: bboxOfFeatures(all),
      features: slice.map((f) => featureSummary(f, include_geometry)),
    };
  },

  get_selection: ({ limit = 50, include_geometry = false } = {}) => {
    const app = requireApp();
    const selected = app.getSelectedFeatures?.() ?? [];
    const drawn = app.getDrawnFeatures?.() ?? [];
    const n = Math.max(0, Math.min(Number(limit) || 50, MAX_FEATURES));
    return {
      selectedLayerId: app.getSelectedLayerId?.() ?? null,
      selectedCount: selected.length,
      selected: selected.slice(0, n).map((f) => featureSummary(f, include_geometry)),
      drawnCount: drawn.length,
      drawn: drawn.slice(0, n).map((f) => featureSummary(f, include_geometry)),
    };
  },

  screenshot,

  set_view: ({ center, zoom, bearing, pitch, bbox, duration = 0 } = {}) => {
    const app = requireApp();
    if (bbox) {
      if (!Array.isArray(bbox) || bbox.length !== 4) throw new Error("bbox harus [west, south, east, north].");
      if (!app.fitBounds) throw new Error("Versi GeoLibre ini belum punya fitBounds().");
      const settled = waitForMoveEnd();
      app.fitBounds(bbox.map(Number));
      return settled.then(() => ({ view: viewState() }));
    }
    const map = currentMap();
    if (!map) throw new Error("set_view dengan center/zoom butuh renderer MapLibre.");
    const opts = {};
    if (center) opts.center = center;
    if (zoom !== undefined && zoom !== null) opts.zoom = Number(zoom);
    if (bearing !== undefined && bearing !== null) opts.bearing = Number(bearing);
    if (pitch !== undefined && pitch !== null) opts.pitch = Number(pitch);
    const settled = waitForMoveEnd();
    if (Number(duration) > 0) map.easeTo({ ...opts, duration: Number(duration) });
    else map.jumpTo(opts);
    return settled.then(() => ({ view: viewState() }));
  },

  zoom_to_layer: ({ layer, padding_ratio = 0.05 } = {}) => {
    const app = requireApp();
    const info = resolveLayer(layer);
    const bbox = bboxOfFeatures(app.getLayerFeatures?.(info.id) ?? []);
    if (!bbox) throw new Error(`Layer '${info.name}' tidak punya fitur vektor yang bisa dihitung extent-nya.`);
    const dx = (bbox[2] - bbox[0]) * padding_ratio || 0.001;
    const dy = (bbox[3] - bbox[1]) * padding_ratio || 0.001;
    const settled = waitForMoveEnd();
    app.fitBounds?.([bbox[0] - dx, bbox[1] - dy, bbox[2] + dx, bbox[3] + dy]);
    return settled.then(() => ({ layer: info, bbox, view: viewState() }));
  },

  set_basemap: ({ style_url } = {}) => {
    if (!style_url) throw new Error("style_url wajib diisi.");
    requireApp().setBasemap(style_url);
    return { basemap: style_url };
  },

  add_geojson_layer: ({ name = "Layer dari MCP", geojson } = {}) => {
    const app = requireApp();
    let fc = typeof geojson === "string" ? JSON.parse(geojson) : geojson;
    if (!fc || typeof fc !== "object") throw new Error("geojson wajib berupa objek GeoJSON.");
    if (fc.type === "Feature") fc = { type: "FeatureCollection", features: [fc] };
    else if (fc.type !== "FeatureCollection") {
      fc = { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: fc }] };
    }
    const id = app.addGeoJsonLayer(name, fc);
    return { layerId: id, name, featureCount: fc.features.length };
  },

  // Drives the "Mode Tutorial" plugin (recording, template, captions,
  // annotations, zoom) through the API it exposes on window.__glbTutorial.
  tutorial: async ({ action, params } = {}) => {
    const api = window.__glbTutorial;
    if (!api) throw new Error("Plugin Mode Tutorial belum aktif. Pasang/aktifkan dulu di Manage Plugins.");
    if (!action || action === "help") return api.help();
    if (typeof api[action] !== "function" || action.startsWith("_")) {
      throw new Error(`Aksi tutorial tidak dikenal: ${action}. Coba action="help".`);
    }
    const value = await api[action](params || {});
    return JSON.parse(JSON.stringify(value ?? { ok: true }));
  },

  exec_js: async ({ code } = {}) => {
    if (!state.settings.allowExec) {
      throw new Error("Eksekusi JavaScript dimatikan. Aktifkan 'Izinkan exec_js' di panel Live MCP Bridge bila memang perlu.");
    }
    // Trusted-code path, same trust level as any installed plugin; off by default.
    // eslint-disable-next-line no-new-func
    const fn = new Function("app", "map", `return (async () => { ${code} })();`);
    const value = await fn(state.app, currentMap());
    return JSON.parse(JSON.stringify(value ?? null));
  },
};

// ############################################################################
// ########## Assistant avatar + speech bubble ################################
// ############################################################################
//
// A small robot sits in the bottom-right corner of the map while the plugin is
// active. The MCP client drives it through the `assistant_say` method:
//   status "greeting" / "info"  -> bubble with the message, fades after a while
//   status "working"            -> "Gaskeun Pak Defani…" + task list, stays up
//   status "done"               -> "Izin Pak, selesai…" + toast notification
// Pass `question` (what the user typed to the AI) to show the exchange as a
// small chat: the user's photo + name with the question, then the robot's
// answer. Later calls without `question` update the same answer (e.g.
// working -> done). Clicking the robot shows or hides the conversation.

const ROBOT_PNG = "data:image/png;base64,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";
const USER_AVATAR = "data:image/jpeg;base64,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";
const USER_NAME = "Defani Ganteng";
const BOT_NAME = "AI Assistant";
// Claude Code mascot, for this personal copy only (not part of any published plugin)
const CLAUDE_AVATAR = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAb8AAAG/CAMAAAD/zSlAAAAAUVBMVEX////Zd1f89vTjnIfYcU7YdVTbgGP35eD++/rkppT99vLYc1HXbUnqtKXchGfwyb3sva/ae1zkoo/57Ojlq5rVYjjWaEH239juxLfquKny1c6ybTtSAAAEeUlEQVR4nO3dy3ITMRRFURPaxE0MfmCSmP//UArGkgbCkfoUa82vSyc7Y3u3AwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP5bTzzS6Hw/1s88zvpjcL/ny3HhUY6X59H9vuw/8Sj77/ol0y+bftn0y6ZfNv2y6ZdNv2z6ZdMvm37Z9MumXzb9sumXTb9s+mXTL5t+2fTLpl82/bLpl02/bPpl0y+bftn0y6ZfNv2y6ZdNv2z6ZdMvm37Z9MumXzb9sumXTb9s+mXTL5t+2fTLpl82/bLpl02/bPpl0y+bftn0y6ZftqR++5qH/kU+1qM35PS7NHSOH661oW9ETL/l1vjM95eu8aO9nBobbkvPR+b0Ww/VjzycQ/qd63+Ww6rf1ulXpt9A+pU36Ld5+pXpN5B+5Q36bZ5+ZfoNpF95g36bp1+ZfgPpV96g3+bpV6bfQPqVN+i3efqV6TeQfuUN+m2efmX6DaRfeYN+m6dfmX4D6VfeoN/m6Vem30D6lTfot3n6lek3kH7lDfptnn5l+g2kX3mDfpunX5l+A+lX3qDf5ulXpt9A+pU36Ld5+pXpN5B+5Q36bZ5+ZfoNpF95g36bp1+ZfgPpV96g3+bpV5HS770+YXy/pz5vnf2ujc+8h/Q7NzZce/t1dtj1ruj9qvyYb5nvMnxddz82Qb9s+mXTL5t+2fTLpl82/bLpl02/bPpl0y+bftn0y6ZfNv2y6ZdNv2z6ZdMvm37Z9MumXzb9sumXTb9s+mXTL5t+2fTLpl82/bLpl02/bPpl0y+bftn0y6ZfNv2y6ZdNv2z6ZdMvm37Z9MumXzb9sumXTb9s+mXTL5t+2fTLpl+23bHP0vv7D5Tsl84Ou29d7utFwMfZX9Z7X4jdoUvv7x9RtP/y3Buik36P9KffWPo9kn7Z9MumXzb9sumXTb9s+mXTL5t+2fTLpl82/bLpl02/bPpl0y+bftn0y6ZfNv2y6ZdNv2z6ZdMvm37Z9MumXzb9sumXTb9s+mXTL5t+2fTLpl82/bLpl02/bPpl0y+bftn0y6ZfNv2y6ZdNv2z6ZdMvm37Z9MumXzb9sk3od1leqlovrV+9tP4jWncfofctrbv61XIZ3W/39LXm8H6sTliu9buv93r4Zd3V7z7Abl3qGe71u6dr/e71/VC/G52v5dTotzZ+ceLc6Hcb9/y/bo1+5/rZodH9eBr3/H/S2e+Q0u/e2KCffrPpp59+8+inn37z6KeffvPop59+8+inn37z6KeffvPop59+8+inn37z6KeffvPop59+8+inn37z6KeffvPop59+8+inn37z6KeffvPop59+8+inn37z6KeffvPop59+8+inn37z6KeffvPop59+8+inn37z6KeffvPoF97v51Lzem1svx/rd+vA9/+xvlbfcmz1u9bvfqb0e7t9q7mdGt9f/qt1N+75f50ab/lVPzu07t7GPR8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYJjfZyfanU9hqZAAAAAASUVORK5CYII=";
const CHAT_MAX_ITEMS = 40; // user + assistant messages kept in the bubble
const BUBBLE_AUTOHIDE_MS = 15000;

const assistant = {
  root: null,
  bubble: null,
  chatEl: null,
  tasksEl: null,
  timeEl: null,
  toast: null,
  terminalEl: null,
  hideTimer: null,
  toastTimer: null,
  last: null,
  history: [],
  unsub: null,
};

function mountAssistant(map) {
  unmountAssistant();
  const host = map?.getContainer?.() ?? null;
  if (!host) return;

  const root = el("div", { className: "glb-bot" });
  const bubble = el("div", { className: "glb-bot-bubble", hidden: true });
  const closeBtn = el("button", { type: "button", className: "glb-bot-close", textContent: "×", title: "Close" });
  const chatEl = el("div", { className: "glb-chat" });
  const tasksEl = el("ul", { className: "glb-bot-tasks" });
  const timeEl = el("div", { className: "glb-bot-time" });
  const listenEl = el("div", { className: "glb-chat-listen" });
  const chipsEl = el("div", { className: "glb-chat-chips" });
  const input = el("textarea", {
    className: "glb-chat-input",
    rows: 1,
    placeholder: "Ketik pesen\u2026",
    title: "Enter ngirim \u00B7 Shift+Enter baris anyar \u00B7 Ctrl+/ muka obrolan",
  });
  // Defani edition: docked in the sidebar the panel is plain text, no icons.
  const dockHost = window.__glbDockHost || null;
  const plain = !!dockHost;
  const sendBtn = el("button", { type: "button", className: "glb-chat-send", title: "Send", textContent: plain ? "Send" : "\u27A4" });
  const composer = el("div", { className: "glb-chat-composer" }, [input]);
  const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
  let micBtn = null;
  if (Speech) {
    micBtn = el("button", { type: "button", className: "glb-chat-mic", title: "Speak", textContent: plain ? "Mic" : "\uD83C\uDFA4" });
    composer.append(micBtn);
  }
  composer.append(sendBtn);
  bubble.append(closeBtn, listenEl, chatEl, tasksEl, timeEl, chipsEl, composer);

  const avatarBtn = el("button", { type: "button", className: "glb-bot-avatar", title: "Asistén AI GeoLibre" });
  const img = el("img", { src: ROBOT_PNG, alt: "AI assistant" });
  const dot = el("span", { className: "glb-bot-dot" });
  avatarBtn.append(img, dot);

  const toast = el("div", { className: "glb-bot-toast", hidden: true });

  root.append(bubble, avatarBtn);
  // Defani edition: inside GeoLibre the chat lives in the "Live MCP" dock
  // (window.__glbDockHost, set by the app) instead of floating on the map, as
  // one simple panel: connection, chat, then the MCP client setup guide.
  let disposeDockSections = null;
  if (dockHost) {
    // Defani CLI edition: the whole dock is one terminal (renderPanel), with
    // its own prompt line; the bubble stays hidden.
    root.classList.add("glb-docked");
    bubble.hidden = true;
    const term = el("div");
    assistant.terminalEl = term;
    disposeDockSections = renderPanel(term);
    root.prepend(term);
    dockHost.append(root, toast);
  } else if (typeof window.__glbOpenDock !== "function") {
    // Outside the Defani build there is no dock: float on the map as before.
    host.append(root, toast);
  }

  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    bubble.hidden = true;
  });
  avatarBtn.addEventListener("click", () => {
    if (bubble.hidden) openChat();
    else bubble.hidden = true;
  });

  const autosize = () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 96)}px`;
  };
  const submit = () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    autosize();
    sendUserMessage(text);
  };
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", (e) => {
    e.stopPropagation(); // keep map/app shortcuts from eating keystrokes
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  for (const evt of ["keyup", "keypress"]) input.addEventListener(evt, (e) => e.stopPropagation());
  sendBtn.addEventListener("click", submit);

  if (micBtn) {
    let rec = null;
    micBtn.addEventListener("click", () => {
      if (rec) {
        rec.stop();
        return;
      }
      try {
        rec = new Speech();
        rec.lang = "id-ID";
        rec.interimResults = true;
        const base = input.value ? `${input.value.trim()} ` : "";
        rec.onresult = (ev) => {
          let said = "";
          for (let i = 0; i < ev.results.length; i += 1) said += ev.results[i][0].transcript;
          input.value = base + said;
          autosize();
        };
        rec.onend = () => {
          rec = null;
          micBtn.classList.remove("is-on");
          input.focus();
        };
        rec.onerror = (ev) => {
          pushSystemNote(`Mikropon teu bisa dipaké (${ev.error || "error"}).`);
        };
        micBtn.classList.add("is-on");
        rec.start();
      } catch (err) {
        rec = null;
        pushSystemNote(`Mikropon teu aya: ${err?.message ?? err}`);
      }
    });
  }

  const onShortcut = (e) => {
    // Ctrl+/ (or Cmd+/) opens the chat from anywhere in GeoLibre.
    if ((e.ctrlKey || e.metaKey) && e.key === "/") {
      e.preventDefault();
      openChat();
    }
  };
  document.addEventListener("keydown", onShortcut);
  const badgeTimer = setInterval(renderListenBadge, 3000);
  // Keep map gestures from firing through the bubble.
  for (const evt of ["mousedown", "dblclick", "wheel", "touchstart"]) {
    root.addEventListener(evt, (e) => e.stopPropagation());
  }

  Object.assign(assistant, { root, bubble, chatEl, tasksEl, timeEl, toast, input, listenEl, chipsEl, plain });
  assistant.cleanup = () => {
    document.removeEventListener("keydown", onShortcut);
    clearInterval(badgeTimer);
    disposeDockSections?.();
  };
  loadChat();
  renderChat();
  renderChips();
  renderListenBadge();

  const update = () => {
    root.dataset.status = state.status;
    dot.dataset.status = state.status;
  };
  state.listeners.add(update);
  assistant.unsub = () => state.listeners.delete(update);
  update();
}

function unmountAssistant() {
  clearTimeout(assistant.hideTimer);
  clearTimeout(assistant.toastTimer);
  assistant.unsub?.();
  assistant.cleanup?.();
  assistant.cleanup = null;
  assistant.root?.remove();
  assistant.toast?.remove();
  Object.assign(assistant, { root: null, bubble: null, chatEl: null, tasksEl: null, timeEl: null, toast: null, terminalEl: null, unsub: null });
}

function renderBubble(msg) {
  if (!assistant.bubble) return;
  const { status = "info", message = "", tasks = [], task = null, question = "" } = msg;
  assistant.last = msg;
  clearTimeout(assistant.hideTimer);

  assistant.root.dataset.mode = status;
  assistant.bubble.dataset.mode = status;

  const now = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const history = assistant.history;
  let q = question ? String(question).trim() : "";
  // A message typed in GeoLibre is already in the log; don't echo it twice.
  const lastUser = [...history].reverse().find((m) => m.role === "user");
  if (q && lastUser && lastUser.text.trim() === q) q = "";
  if (q) history.push({ role: "user", text: q, time: now, state: "read", via: "claude" });
  if (message) chat.typing = false;
  const prev = history[history.length - 1];
  // task labels go into the log too, so other chat views can show progress
  const taskList = [...(Array.isArray(tasks) ? tasks : []), ...(task ? [task] : [])];
  // plain labels, or { label, done } when the AI ticks steps off one by one
  const taskLabels = taskList.map((t) => (typeof t === "string" ? t : { label: t.label ?? String(t), done: !!t.done }));
  if (!q && prev && prev.role === "bot" && prev.status === "working") {
    // Same exchange moving on (working -> done/info): update the answer in place.
    Object.assign(prev, { text: message, status, time: now, ...(taskLabels.length ? { tasks: taskLabels } : {}) });
  } else if (message) {
    history.push({ role: "bot", text: message, status, time: now, via: chat.lastVia || "geolibre", ...(taskLabels.length ? { tasks: taskLabels } : {}) });
  }
  history.splice(0, Math.max(0, history.length - CHAT_MAX_ITEMS));
  // a done/info reply closes the CLI turn: stamp its time and tools on the reply
  const reply = history[history.length - 1];
  if (status === "working") activityStart();
  else if (activity.since && reply?.role === "bot") reply.run = activityEnd();
  saveChat();
  renderChat();
  renderChips(status);

  const list = [...(Array.isArray(tasks) ? tasks : []), ...(task ? [task] : [])];
  assistant.tasksEl.replaceChildren(
    ...list.map((t) => {
      if (typeof t === "string") return el("li", { textContent: t, className: status === "done" ? "is-done" : "is-running" });
      const li = el("li", { textContent: t.label ?? String(t), className: t.done ? "is-done" : "is-running" });
      return li;
    }),
  );
  assistant.tasksEl.hidden = list.length === 0 || !!assistant.terminalEl;
  if (assistant.terminalEl) {
    assistant.bubble.hidden = true;
  } else {
    assistant.bubble.hidden = false;
    assistant.timeEl.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  if (status === "greeting" || status === "info") {
    assistant.hideTimer = setTimeout(() => {
      if (assistant.bubble && assistant.last === msg && !chatBusy()) assistant.bubble.hidden = true;
    }, BUBBLE_AUTOHIDE_MS);
  }
  if (status === "done") showToast(message);
}

function renderChat() {
  renderTerminals();
  const chatEl = assistant.chatEl;
  if (!chatEl) return;
  // CLI edition: the docked terminal replaces the chat box entirely.
  if (assistant.terminalEl) return;
  chatEl.replaceChildren(
    ...assistant.history
      .filter((m) => m.role === "system" || (m.via || "geolibre") !== "kobo-connector")
      .map((m) => {
      if (m.role === "system") return el("div", { className: "glb-chat-note", textContent: m.text });
      const isUser = m.role === "user";
      const meta = [
        el("span", { className: "glb-chat-name", textContent: isUser ? USER_NAME : BOT_NAME }),
        el("span", { className: "glb-chat-time", textContent: m.time }),
      ];
      if (isUser && m.state) {
        const tick = { queued: "\u2713", read: "\u2713\u2713" }[m.state] ?? "";
        meta.push(el("span", { className: `glb-chat-tick is-${m.state}`, textContent: tick, title: m.state === "read" ? "Geus dibaca asistén" : "Kakirim, nungguan dibaca" }));
      }
      const body = [el("div", { className: "glb-chat-meta" }, meta)];
      if (m.text) body.push(el("div", { className: "glb-chat-text", textContent: m.text }));
      if (m.chart) body.push(bubbleChartNode(m));
      return el("div", { className: `glb-chat-row ${isUser ? "from-user" : "from-bot"}` }, [
        ...chatAvatar(isUser ? USER_AVATAR : ROBOT_PNG, isUser ? USER_NAME : BOT_NAME),
        el("div", { className: `glb-chat-body${m.chart ? " has-chart" : ""}` }, body),
      ]);
    }),
    ...(chat.typing
      ? [
          el("div", { className: "glb-chat-row from-bot" }, [
            ...chatAvatar(ROBOT_PNG, BOT_NAME),
            el("div", { className: "glb-chat-body glb-chat-typing" }, [el("span"), el("span"), el("span")]),
          ]),
        ]
      : []),
  );
  chatEl.scrollTop = chatEl.scrollHeight;
}

// Every open CLI terminal (dock and/or floating panel) re-renders from the
// shared chat history.
const cliViews = new Set();

function renderTerminals() {
  for (const view of cliViews) view.renderOut();
}

/** One chat-history item as CLI lines: `>` for the user, `●` for the AI, `⎿` for detail. */
function cliMessage(m, charts) {
  if (m.role === "system") return [cliLine("glb-cli-sys", "⎿", m.text)];
  if (m.role === "user") {
    const tick = m.state === "queued" ? " · queued" : "";
    return [el("div", { className: "glb-cli-user" }, [
      el("span", { className: "glb-cli-g", textContent: ">" }),
      el("span", { className: "glb-cli-x", textContent: m.text || "" }),
      el("span", { className: "glb-cli-meta", textContent: `${m.time || ""}${tick}` }),
    ])];
  }
  const out = [];
  if (m.text) out.push(cliLine(`glb-cli-ai is-${m.status || "info"}`, "●", m.text));
  for (const t of m.tasks ?? []) {
    const label = typeof t === "string" ? t : t.label;
    const done = typeof t === "string" ? m.status === "done" : t.done;
    out.push(cliLine(`glb-cli-task${done ? " is-done" : " is-running"}`, done ? "✓" : "◌", label));
  }
  if (m.chart) {
    let node = charts.get(m);
    if (!node) {
      node = el("div", { className: "glb-cli-chart" });
      renderChartInto(node, m.chart, { height: 220 });
      charts.set(m, node);
    }
    out.push(node);
  }
  if (m.run) {
    const tools = [...new Set(m.run.tools)];
    const shown = tools.slice(0, 4).join(", ") + (tools.length > 4 ? ` +${tools.length - 4}` : "");
    out.push(cliLine("glb-cli-run", "✳", `Digarap ${fmtSecs(m.run.ms)}${tools.length ? ` · ${shown}` : ""}`));
  }
  return out;
}

function cliLine(cls, glyph, text) {
  return el("div", { className: `glb-cli-line ${cls}` }, [
    el("span", { className: "glb-cli-g", textContent: glyph }),
    el("span", { className: "glb-cli-x", textContent: text ?? "" }),
  ]);
}

/** Avatar image for a chat row; none in the plain sidebar panel. */
function chatAvatar(src, alt) {
  return assistant.plain ? [] : [el("img", { className: "glb-chat-avatar", src, alt })];
}

// Chart nodes are cached per message, so re-rendering the chat log moves the
// existing Plotly plot instead of drawing it again.
const bubbleCharts = new WeakMap();
function bubbleChartNode(m) {
  let node = bubbleCharts.get(m);
  if (!node) {
    node = el("div");
    renderChartInto(node, m.chart, { height: 230 });
    bubbleCharts.set(m, node);
  }
  return node;
}

function showToast(message) {
  const toast = assistant.toast;
  if (!toast) return;
  clearTimeout(assistant.toastTimer);
  toast.replaceChildren(
    ...(assistant.plain ? [] : [el("img", { src: ROBOT_PNG, alt: "" })]),
    el("div", {}, [el("strong", { textContent: "Tugas beres" }), el("span", { textContent: message })]),
  );
  toast.hidden = false;
  toast.classList.remove("glb-bot-toast-in");
  void toast.offsetWidth; // restart the slide-in animation
  toast.classList.add("glb-bot-toast-in");
  assistant.toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 8000);
}

// ---------------------------------------------------------------------------
// Two-way chat: messages typed in GeoLibre reach the AI client.
//
// Claude cannot be woken up from here, so the AI pulls messages: it calls
// `chat_wait` (long-poll) in a loop while "listening" and `chat_inbox` at the
// start of a turn. Messages typed while nobody listens stay queued (and survive
// a restart through localStorage) until the next pull.
// ---------------------------------------------------------------------------

const CHAT_STORE_KEY = `${PLUGIN_ID}:chat`;
const LISTEN_GRACE_MS = 90000; // still "listening" this long after a wait returns
const QUICK_REPLIES = {
  done: ["Mantap", "Robah", "Poto peta"],
  working: ["Eureun heula"],
  idle: ["Kumaha peta ayeuna?", "Zoom ka lapisan nu dipilih", "Poto peta"],
};

const chat = {
  outbox: [], // unread user messages {id, text, time, ts, context}
  waiters: [], // pending chat_wait resolvers
  waiting: 0,
  listenUntil: 0,
  typing: false,
  hintShown: false,
};

function chatBusy() {
  const a = assistant;
  if (!a.bubble) return false;
  return isListening() || chat.typing || (a.input && (a.input.value.trim() || document.activeElement === a.input)) || a.bubble.contains(document.activeElement);
}

function isListening() {
  return chat.waiting > 0 || Date.now() < chat.listenUntil;
}

function renderListenBadge() {
  const on = isListening();
  const queued = chat.outbox.length;
  if (hub.lastListen !== on || hub.lastQueued !== queued) {
    hub.lastListen = on;
    hub.lastQueued = queued;
    hubNotify();
  }
  for (const view of cliViews) view.renderFoot();
  const node = assistant.listenEl;
  if (!node) return;
  node.dataset.on = on ? "1" : "0";
  node.textContent = on
    ? "● Asistén keur ngadéngékeun"
    : `○ Asistén teu ngadéngékeun${queued ? ` · ${queued} ngantri` : ""} — ketik “dengar geolibre” di klien MCP`;
}

function renderChips(status = "idle") {
  const node = assistant.chipsEl;
  if (!node) return;
  const list = QUICK_REPLIES[status] ?? QUICK_REPLIES.idle;
  node.replaceChildren(
    ...list.map((label) => {
      const b = el("button", { type: "button", className: "glb-chat-chip", textContent: label });
      b.addEventListener("click", () => sendUserMessage(label));
      return b;
    }),
  );
}

function openChat() {
  if (window.__glbDockHost === undefined && typeof window.__glbOpenDock === "function") {
    window.__glbOpenDock();
  }
  if (!assistant.bubble) {
    const map = currentMap();
    if (map) mountAssistant(map);
  }
  if (!assistant.bubble) return;
  clearTimeout(assistant.hideTimer);
  assistant.bubble.hidden = false;
  if (!assistant.history.length) {
    assistant.history.push({ role: "bot", text: "Halo, Kang! Ketik paménta di handap. Dibaca pas mode dengar hurung.", status: "info", time: nowHM() });
    renderChat();
  }
  renderListenBadge();
  setTimeout(() => (assistant.cliInput ?? assistant.input)?.focus(), 0);
}

function nowHM() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function pushSystemNote(text) {
  assistant.history.push({ role: "system", text, time: nowHM() });
  assistant.history.splice(0, Math.max(0, assistant.history.length - CHAT_MAX_ITEMS));
  saveChat();
  renderChat();
}

function mapContext() {
  const ctx = {};
  try {
    const v = viewState();
    Object.assign(ctx, { center: v.center, zoom: v.zoom, bounds: v.bounds });
    const app = state.app;
    const selId = app?.getSelectedLayerId?.() ?? null;
    if (selId) {
      const layer = (app.listLayers?.() ?? []).find((l) => l.id === selId);
      ctx.selectedLayer = layer ? { id: layer.id, name: layer.name } : { id: selId };
    }
    const n = app?.getSelectedFeatures?.()?.length ?? 0;
    if (n) ctx.selectedFeatureCount = n;
  } catch {
    /* context is best-effort */
  }
  return ctx;
}

function sendUserMessage(text, extra = {}) {
  const id = `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const time = nowHM();
  const context = { ...mapContext(), ...(extra && typeof extra === "object" ? extra : {}) };
  const msg = { id, text, time, ts: new Date().toISOString(), context };
  assistant.history.push({ role: "user", text, time, state: "queued", id, via: context.source || "geolibre" });
  assistant.history.splice(0, Math.max(0, assistant.history.length - CHAT_MAX_ITEMS));
  chat.outbox.push(msg);
  if (assistant.tasksEl) {
    assistant.tasksEl.replaceChildren();
    assistant.tasksEl.hidden = true;
  }
  if (chat.waiters.length) {
    deliverToWaiters();
  } else if (!isListening() && !chat.hintShown) {
    chat.hintShown = true;
    pushSystemNote("Pesen disimpen. Asistén bakal maca lamun mode dengar hurung — ketik “dengar geolibre” di klien MCP.");
  }
  saveChat();
  renderChat();
  renderListenBadge();
  // A message sent from another plugin's chat view does not pop the bubble open.
  if (!context.source) assistant.bubble && (assistant.bubble.hidden = false);
  return { id, queued: chat.outbox.length, listening: isListening() };
}

function drainOutbox(max = 20) {
  const out = chat.outbox.splice(0, max);
  const ids = new Set(out.map((m) => m.id));
  for (const h of assistant.history) if (h.role === "user" && ids.has(h.id)) h.state = "read";
  if (out.length) {
    activityStart();
    chat.typing = true;
    chat.hintShown = false;
    // The next bot reply belongs to whichever view sent the last message drained here.
    chat.lastVia = out[out.length - 1].context?.source || "geolibre";
    chat.lastAsk = out.map((m) => m.text).join(" \n");
  }
  saveChat();
  renderChat();
  renderListenBadge();
  return out;
}

function deliverToWaiters() {
  const waiter = chat.waiters.shift();
  if (waiter) waiter();
}

function saveChat() {
  try {
    // History is intentionally NOT persisted — the panel starts clean each run;
    // only the outbox (queued user messages while disconnected) is kept.
    window.localStorage.setItem(CHAT_STORE_KEY, JSON.stringify({ outbox: chat.outbox }));
  } catch {
    /* storage unavailable: chat lives for this session only */
  }
  hubNotify();
}

function loadChat() {
  if (assistant.loaded) return;
  assistant.loaded = true;
  try {
    // Clear any history saved by an older plugin version, then start fresh.
    const raw = window.localStorage.getItem(CHAT_STORE_KEY);
    if (raw) window.localStorage.removeItem(CHAT_STORE_KEY);
    const data = raw ? JSON.parse(raw) : {};
    if (Array.isArray(data.outbox)) chat.outbox.push(...data.outbox);
  } catch {
    /* corrupt or missing store: start fresh */
  }
}

HANDLERS.chat_wait = ({ timeout_s = 45, max = 20 } = {}) => {
  const limitMs = Math.max(1, Math.min(Number(timeout_s) || 45, 300)) * 1000;
  chat.waiting += 1;
  renderListenBadge();
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      chat.waiters = chat.waiters.filter((w) => w !== finish);
      chat.waiting = Math.max(0, chat.waiting - 1);
      chat.listenUntil = Date.now() + LISTEN_GRACE_MS;
      const messages = drainOutbox(max);
      resolve({ messages, listening: true, waitedMs: limitMs });
    };
    const timer = setTimeout(finish, limitMs);
    if (chat.outbox.length) finish();
    else chat.waiters.push(finish);
  });
};

HANDLERS.chat_inbox = ({ mark_read = true, max = 20 } = {}) => {
  if (!mark_read) return { messages: chat.outbox.slice(0, max), listening: isListening() };
  return { messages: drainOutbox(max), listening: isListening() };
};

HANDLERS.chat_listen = ({ listening = false, note = null } = {}) => {
  if (listening) chat.listenUntil = Date.now() + LISTEN_GRACE_MS;
  else {
    chat.listenUntil = 0;
    chat.typing = false;
    for (const w of [...chat.waiters]) w();
  }
  if (note) pushSystemNote(String(note));
  if (!listening && assistant.tasksEl) {
    assistant.tasksEl.replaceChildren();
    assistant.tasksEl.hidden = true;
  }
  renderChips("idle");
  renderChat();
  renderListenBadge();
  return { listening: isListening(), queued: chat.outbox.length };
};

const DEFAULT_MESSAGES = {
  greeting: "Halo, Kang! Abdi asistén AI GeoLibre. Aya naon nu bisa dibantu?",
  working: "Ké sakedap nya, kasép",
  done: "Geus beres, Kang. Aya nu rék dirobah?",
  info: "",
};

HANDLERS.assistant_say = ({ status = "info", message, tasks, task, question } = {}) => {
  if (!["greeting", "working", "done", "info"].includes(status)) {
    throw new Error("status harus greeting, working, done, atau info.");
  }
  if (!assistant.bubble) {
    const map = currentMap();
    if (map) mountAssistant(map);
  }
  if (!assistant.bubble) throw new Error("Avatar asisten belum bisa dipasang (peta MapLibre belum siap).");
  const text = message && String(message).trim() ? String(message) : DEFAULT_MESSAGES[status];
  renderBubble({ status, message: text, tasks, task, question });
  return { shown: true, status, message: text, question: question || null, messages: assistant.history.length };
};

// ############################################################################
// ########## UI automation (click menus, buttons, fields) ####################
// ############################################################################
//
// Lets the MCP client operate GeoLibre's own interface (menus such as
// "Add Data", plugin panels, dialogs) from inside the page, so no desktop
// "computer use" window is needed. The plugin already runs as trusted code in
// the host document, so it can find and click elements directly.
//
// Elements are addressed by their visible label (text, aria-label, title or
// placeholder) or by a `ref` number handed out by ui_list. Labels are matched
// exact first, then prefix, then substring, preferring whatever sits in the
// topmost open menu or dialog.

const UI_SELECTOR = [
  "button",
  "a[href]",
  "summary",
  "input",
  "select",
  "textarea",
  "[role=button]",
  "[role=menuitem]",
  "[role=menuitemcheckbox]",
  "[role=menuitemradio]",
  "[role=tab]",
  "[role=option]",
  "[role=checkbox]",
  "[role=switch]",
  "[role=radio]",
  "[role=combobox]",
  "[role=treeitem]",
  "[role=link]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");
const UI_CONTAINER = "[role=menu],[role=dialog],[role=alertdialog],[role=listbox],[role=tooltip],[data-radix-popper-content-wrapper]";
const UI_OWN = ".glb-bot, .glb-bot-toast, .glb-live-panel, .glb-agent";

// ---------------------------------------------------------------------------
// Agent mode: while the AI works through MCP, GeoLibre gets an orange frame,
// a "Claude keur make GeoLibre anjeun" pill, and a virtual cursor that glides to
// each element it clicks, hovers or types into.
// ---------------------------------------------------------------------------

const agent = { root: null, pill: null, cursor: null, x: null, y: null, offTimer: null };
const AGENT_MOVE_MS = 380;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

function agentLayer() {
  if (agent.root?.isConnected) return agent.root;
  const ns = "http://www.w3.org/2000/svg";
  // pixel arrow cursor, 1 unit = 1 cell
  const arrow = document.createElementNS(ns, "svg");
  arrow.setAttribute("viewBox", "0 0 8 12");
  arrow.setAttribute("shape-rendering", "crispEdges");
  ["#.......", "##......", "#o#.....", "#oo#....", "#ooo#...", "#oooo#..", "#ooooo#.", "#oo####.", "#o#o#...", "##.#o#..", "#...#o#.", "....##.."].forEach((row, y) =>
    [...row].forEach((c, x) => {
      if (c === ".") return;
      const r = document.createElementNS(ns, "rect");
      for (const [k, v] of Object.entries({ x, y, width: 1, height: 1 })) r.setAttribute(k, String(v));
      r.setAttribute("class", c === "#" ? "edge" : "fill");
      arrow.append(r);
    }),
  );
  agent.cursor = el("div", { className: "glb-agent-cursor" }, [arrow, el("span", { className: "glb-agent-tag" })]);
  agent.pill = el("div", { className: "glb-agent-pill" }, [
    el("span", { className: "glb-agent-star", textContent: "✻" }),
    el("b", { textContent: "Claude keur make GeoLibre anjeun" }),
    el("span", { className: "glb-agent-what" }),
  ]);
  agent.root = el("div", { className: "glb-agent", hidden: true }, [el("div", { className: "glb-agent-frame" }), agent.pill, agent.cursor]);
  document.body.append(agent.root);
  return agent.root;
}

/** Turn agent mode on (or keep it on) and say what is happening right now. */
function agentOn(what) {
  clearTimeout(agent.offTimer);
  const root = agentLayer();
  root.hidden = false;
  document.documentElement.classList.add("glb-agent-on");
  if (what) agent.pill.querySelector(".glb-agent-what").textContent = cap(what);
}

function agentOff(delay = 1500) {
  clearTimeout(agent.offTimer);
  agent.offTimer = setTimeout(() => {
    document.documentElement.classList.remove("glb-agent-on");
    if (agent.root) agent.root.hidden = true;
    agent.x = agent.y = null;
  }, delay);
}

/**
 * Move the cursor like a hand on a mouse: a slightly curved path that eases
 * out, with a small overshoot that settles back. Speed follows distance.
 */
async function agentMove(x, y) {
  const cursor = agent.cursor;
  // first action of a turn: enter from the bottom-right corner
  const from = agent.x === null ? { x: window.innerWidth - 40, y: window.innerHeight - 40 } : { x: agent.x, y: agent.y };
  Object.assign(agent, { x, y });
  const dx = x - from.x;
  const dy = y - from.y;
  const dist = Math.hypot(dx, dy);
  if (reducedMotion() || dist < 2) {
    cursor.style.transform = `translate(${x}px, ${y}px)`;
    return;
  }
  const ms = Math.min(950, 240 + dist * 0.6);
  const bend = (Math.random() < 0.5 ? -1 : 1) * Math.min(90, dist * 0.2);
  const cx = from.x + dx / 2 - (dy / dist) * bend;
  const cy = from.y + dy / 2 + (dx / dist) * bend;
  const over = Math.min(6, dist * 0.03);
  const frames = [];
  for (let i = 0; i <= 16; i++) {
    const e = 1 - Math.pow(1 - i / 16, 3); // ease-out along the curve
    const px = (1 - e) ** 2 * from.x + 2 * (1 - e) * e * cx + e * e * (x + (dx / dist) * over);
    const py = (1 - e) ** 2 * from.y + 2 * (1 - e) * e * cy + e * e * (y + (dy / dist) * over);
    frames.push({ transform: `translate(${px}px, ${py}px)`, offset: (i / 16) * 0.88 });
  }
  frames.push({ transform: `translate(${x}px, ${y}px)`, offset: 1 }); // settle back from the overshoot
  cursor.style.transition = "none";
  const anim = cursor.animate(frames, { duration: ms, easing: "linear", fill: "forwards" });
  // a hidden/minimized window never finishes animations: don't wait forever
  await Promise.race([anim.finished.catch(() => {}), sleep(ms + 250)]);
  cursor.style.transform = `translate(${x}px, ${y}px)`;
  anim.cancel();
}

/**
 * Show a layer row being dragged: a ghost of the row slides from where it was
 * to where it ended up, with the cursor holding it.
 */
async function agentDrag(row, before) {
  if (!row?.isConnected || !before || reducedMotion()) return;
  const after = row.getBoundingClientRect();
  if (Math.abs(after.top - before.top) < 2) return;
  const ghost = row.cloneNode(true);
  ghost.classList.add("glb-agent-ghost");
  ghost.removeAttribute("id");
  Object.assign(ghost.style, { left: `${before.left}px`, top: `${before.top}px`, width: `${before.width}px`, height: `${before.height}px` });
  agent.root.append(ghost);
  agent.cursor.querySelector(".glb-agent-tag").textContent = AGENT_WORDS.drag[0];
  agent.cursor.classList.add("is-press");
  const dy = after.top - before.top;
  const ms = Math.min(700, 280 + Math.abs(dy) * 1.5);
  const g = ghost.animate([{ transform: "translateY(0) rotate(0)" }, { transform: `translateY(${dy * 0.5}px) rotate(-0.6deg)`, offset: 0.5 }, { transform: `translateY(${dy}px)` }], { duration: ms, easing: "cubic-bezier(.4,0,.2,1)", fill: "forwards" });
  agentMove(agent.x, agent.y + dy);
  await Promise.race([g.finished.catch(() => {}), sleep(ms + 250)]);
  agent.cursor.classList.remove("is-press");
  ghost.remove();
  const drop = el("div", { className: "glb-agent-box is-drop" });
  Object.assign(drop.style, { left: `${after.left - 3}px`, top: `${after.top - 3}px`, width: `${after.width + 6}px`, height: `${after.height + 6}px` });
  agent.root.append(drop);
  setTimeout(() => drop.remove(), 900);
}

/**
 * Glide the virtual cursor to `node`, outline it, and (for clicks) ripple.
 * Resolves once the cursor has arrived, so the real action follows the motion.
 */
// What the cursor tag and the pill say for each action (casual Sundanese).
const AGENT_WORDS = {
  click: ["klik", "Ngaklik"], "right-click": ["klik katuhu", "Ngaklik katuhu"], hover: ["tunjuk", "Nunjuk"],
  type: ["ketik", "Ngetik di"], select: ["pilih", "Milih di"], key: ["kenop", "Mencét"],
  close: ["tutup", "Nutup"], drag: ["sered", "Nyered"],
};

async function agentPoint(node, kind, label) {
  const [tag, verb] = AGENT_WORDS[kind] ?? [kind, kind];
  agentOn(`${verb} “${String(label ?? "").slice(0, 40)}”`);
  const rect = node.getBoundingClientRect?.();
  if (!rect || (!rect.width && !rect.height)) return;
  const x = rect.left + Math.min(rect.width / 2, 24);
  const y = rect.top + rect.height / 2;
  agent.cursor.querySelector(".glb-agent-tag").textContent = tag;
  const box = el("div", { className: `glb-agent-box is-${kind}` });
  Object.assign(box.style, { left: `${rect.left - 3}px`, top: `${rect.top - 3}px`, width: `${rect.width + 6}px`, height: `${rect.height + 6}px` });
  await agentMove(x, y);
  agent.root.append(box);
  setTimeout(() => box.remove(), kind === "type" ? 2400 : 1200);
  // a person aims for a moment before pressing
  if (!reducedMotion()) await sleep(90 + Math.random() * 140);
  if (kind === "click" || kind === "right-click" || kind === "close") {
    const cursor = agent.cursor;
    const ripple = el("div", { className: "glb-agent-ripple" });
    Object.assign(ripple.style, { left: `${x}px`, top: `${y}px` });
    agent.root.append(ripple);
    setTimeout(() => ripple.remove(), 600);
    cursor.classList.add("is-press");
    setTimeout(() => cursor.classList.remove("is-press"), 160);
  }
}
let uiRefCounter = 0;

function uiClean(s) {
  return unbrand(String(s ?? "").replace(/\s+/g, " ").trim());
}

function uiLabel(node) {
  const aria = node.getAttribute("aria-label");
  if (aria) return uiClean(aria);
  const labelledby = node.getAttribute("aria-labelledby");
  if (labelledby) {
    const t = labelledby.split(/\s+/).map((id) => document.getElementById(id)?.innerText ?? "").join(" ");
    if (uiClean(t)) return uiClean(t);
  }
  const tag = node.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") {
    const id = node.id && document.querySelector(`label[for="${CSS.escape(node.id)}"]`);
    const wrap = node.closest("label");
    const txt = uiClean(id?.innerText || wrap?.innerText || "");
    if (txt) return txt.slice(0, 80);
    return uiClean(node.getAttribute("placeholder") || node.getAttribute("name") || node.getAttribute("title") || node.type || tag);
  }
  const text = uiClean(node.innerText || node.textContent);
  if (text) return text.slice(0, 80);
  return uiClean(node.getAttribute("title") || node.getAttribute("data-tooltip") || node.querySelector?.("[title]")?.getAttribute("title") || "");
}

function uiVisible(node) {
  if (node.closest(UI_OWN)) return false;
  if (node.closest("[aria-hidden=true],[hidden],[inert]")) return false;
  const rects = node.getClientRects();
  if (!rects.length) return false;
  const r = node.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  if (r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth) return false;
  const cs = getComputedStyle(node);
  return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.05;
}

function uiContainerOf(node) {
  const c = node.closest(UI_CONTAINER);
  if (!c) return null;
  const role = c.getAttribute("role") || "popup";
  const title = uiClean(c.getAttribute("aria-label") || c.querySelector("h1,h2,h3,[class*=title]")?.innerText || "");
  return { el: c, role, title: title.slice(0, 60) };
}

function uiCollect() {
  const out = [];
  const seen = new Set();
  for (const node of document.querySelectorAll(UI_SELECTOR)) {
    if (seen.has(node) || !uiVisible(node)) continue;
    // A clickable wrapper around another clickable: keep the inner one only.
    if (node.querySelector(UI_SELECTOR) && !/^(input|select|textarea)$/i.test(node.tagName) && node.getAttribute("role") !== "menuitem") {
      const inner = node.querySelector(UI_SELECTOR);
      if (inner && uiVisible(inner) && uiLabel(inner) === uiLabel(node)) continue;
    }
    seen.add(node);
    const label = uiLabel(node);
    if (!label) continue;
    if (!node.dataset.glbRef) node.dataset.glbRef = String(++uiRefCounter);
    const cont = uiContainerOf(node);
    const tag = node.tagName.toLowerCase();
    const item = {
      ref: Number(node.dataset.glbRef),
      label,
      kind: node.getAttribute("role") || (tag === "input" ? `input:${node.type || "text"}` : tag),
    };
    if (cont) item.in = cont.title ? `${cont.role}: ${cont.title}` : cont.role;
    if (node.disabled || node.getAttribute("aria-disabled") === "true") item.disabled = true;
    const checked = node.getAttribute("aria-checked") ?? (node.type === "checkbox" || node.type === "radio" ? String(node.checked) : null);
    if (checked !== null) item.checked = checked === "true";
    if (node.getAttribute("aria-expanded") !== null) item.expanded = node.getAttribute("aria-expanded") === "true";
    if (/^(input|textarea|select)$/.test(tag) && node.type !== "checkbox" && node.type !== "radio") item.value = String(node.value ?? "").slice(0, 80);
    out.push({ item, node, cont });
  }
  return out;
}

function uiResolve(target, { nth = 0, within = null } = {}) {
  if (target === undefined || target === null || target === "") throw new Error("target wajib diisi (label atau ref).");
  const refMatch = typeof target === "number" ? target : /^(?:ref:?)?\s*(\d+)$/i.exec(String(target))?.[1];
  const all = uiCollect();
  if (refMatch !== undefined && refMatch !== null) {
    const hit = all.find((c) => c.item.ref === Number(refMatch));
    if (hit) return hit;
    const node = document.querySelector(`[data-glb-ref="${Number(refMatch)}"]`);
    if (node && uiVisible(node)) return { item: { ref: Number(refMatch), label: uiLabel(node) }, node, cont: uiContainerOf(node) };
    throw new Error(`ref ${refMatch} tidak ditemukan atau sudah tidak terlihat. Panggil live_ui_list lagi.`);
  }
  let pool = all;
  if (within) {
    const w = uiClean(within).toLowerCase();
    pool = all.filter((c) => (c.item.in || "").toLowerCase().includes(w) || uiClean(c.node.closest("section,aside,[role=dialog],[role=menu],form,div[class*=panel]")?.innerText || "").toLowerCase().includes(w));
  }
  const q = uiClean(target).toLowerCase();
  const tiers = [
    pool.filter((c) => c.item.label.toLowerCase() === q),
    pool.filter((c) => c.item.label.toLowerCase().startsWith(q)),
    pool.filter((c) => c.item.label.toLowerCase().includes(q)),
  ];
  for (const tier of tiers) {
    if (!tier.length) continue;
    // Prefer the most recently opened menu/dialog (last in document order).
    const inPopup = tier.filter((c) => c.cont);
    const ranked = inPopup.length ? [...inPopup].reverse().concat(tier.filter((c) => !c.cont)) : tier;
    const pick = ranked[Math.min(Number(nth) || 0, ranked.length - 1)];
    return pick;
  }
  const sample = all.slice(0, 40).map((c) => c.item.label).join(" | ");
  throw new Error(`Elemen '${target}' tidak ditemukan. Yang terlihat antara lain: ${sample}`);
}

function uiFire(node, type, extra = {}) {
  const r = node.getBoundingClientRect();
  const init = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: r.left + r.width / 2,
    clientY: r.top + r.height / 2,
    button: 0,
    buttons: type.endsWith("down") ? 1 : 0,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    ...extra,
  };
  const Ctor = type.startsWith("pointer") && window.PointerEvent ? PointerEvent : MouseEvent;
  node.dispatchEvent(new Ctor(type, init));
}

const uiSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function uiSnapshotLabels() {
  return new Set(uiCollect().map((c) => `${c.item.in || ""}::${c.item.label}`));
}

async function uiAfter(before, waitMs) {
  await uiSleep(waitMs);
  const now = uiCollect();
  const appeared = now.filter((c) => !before.has(`${c.item.in || ""}::${c.item.label}`)).map((c) => c.item);
  const popups = [...document.querySelectorAll(UI_CONTAINER)].filter((c) => uiVisible(c) || c.getClientRects().length);
  return {
    appeared: appeared.slice(0, 60),
    openPopups: popups.map((p) => uiClean(p.getAttribute("aria-label") || p.getAttribute("role") || "popup")).slice(0, 5),
  };
}

HANDLERS.ui_list = ({ query = "", within = "", limit = 120 } = {}) => {
  let items = uiCollect();
  if (within) {
    const w = uiClean(within).toLowerCase();
    items = items.filter((c) => (c.item.in || "").toLowerCase().includes(w));
  }
  if (query) {
    const q = uiClean(query).toLowerCase();
    items = items.filter((c) => c.item.label.toLowerCase().includes(q));
  }
  const total = items.length;
  // Items inside open menus/dialogs first: they are what the user is looking at.
  items.sort((a, b) => (b.cont ? 1 : 0) - (a.cont ? 1 : 0));
  return { total, items: items.slice(0, Math.max(1, Math.min(Number(limit) || 120, 400))).map((c) => c.item) };
};

HANDLERS.ui_click = async ({ target, nth = 0, within = null, double = false, right = false, wait_ms = 400 } = {}) => {
  const { node, item } = uiResolve(target, { nth, within });
  if (item.disabled) throw new Error(`'${item.label}' sedang nonaktif (disabled).`);
  const before = uiSnapshotLabels();
  node.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  await agentPoint(node, right ? "right-click" : "click", item.label);
  // moving a layer: remember where its row was, to animate the drag afterwards
  const dragRow = /move (layer )?(up|down)|reorder|to (top|bottom)/i.test(item.label)
    ? node.closest("li,[role=listitem],[role=treeitem],[draggable=true],[data-layer-id]") ?? node.parentElement?.parentElement
    : null;
  const dragFrom = dragRow?.getBoundingClientRect();
  for (const t of ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"]) uiFire(node, t);
  if (right) {
    uiFire(node, "pointerdown", { button: 2, buttons: 2 });
    uiFire(node, "mousedown", { button: 2, buttons: 2 });
    uiFire(node, "pointerup", { button: 2 });
    uiFire(node, "mouseup", { button: 2 });
    uiFire(node, "contextmenu", { button: 2 });
  } else {
    uiFire(node, "pointerdown");
    uiFire(node, "mousedown");
    node.focus?.({ preventScroll: true });
    uiFire(node, "pointerup");
    uiFire(node, "mouseup");
    uiFire(node, "click");
    if (double) {
      uiFire(node, "click", { detail: 2 });
      uiFire(node, "dblclick", { detail: 2 });
    }
  }
  if (dragRow) {
    await sleep(60); // let the list re-render
    await agentDrag(dragRow, dragFrom);
  }
  const after = await uiAfter(before, Math.max(0, Math.min(Number(wait_ms) || 0, 5000)));
  return { clicked: item, ...after };
};

HANDLERS.ui_hover = async ({ target, nth = 0, within = null, wait_ms = 400 } = {}) => {
  const { node, item } = uiResolve(target, { nth, within });
  const before = uiSnapshotLabels();
  await agentPoint(node, "hover", item.label);
  for (const t of ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"]) uiFire(node, t);
  const after = await uiAfter(before, Math.max(0, Math.min(Number(wait_ms) || 0, 5000)));
  return { hovered: item, ...after };
};

function uiSetValue(node, value) {
  const proto = node.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : node.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(node, value);
  else node.value = value;
  node.dispatchEvent(new Event("input", { bubbles: true }));
  node.dispatchEvent(new Event("change", { bubbles: true }));
}

function uiKey(node, key) {
  const map = { enter: "Enter", escape: "Escape", esc: "Escape", tab: "Tab", arrowdown: "ArrowDown", arrowup: "ArrowUp", arrowleft: "ArrowLeft", arrowright: "ArrowRight", space: " ", backspace: "Backspace", delete: "Delete" };
  const k = map[String(key).toLowerCase()] ?? key;
  const init = { key: k, code: k === " " ? "Space" : k, bubbles: true, cancelable: true, composed: true };
  node.dispatchEvent(new KeyboardEvent("keydown", init));
  node.dispatchEvent(new KeyboardEvent("keypress", init));
  node.dispatchEvent(new KeyboardEvent("keyup", init));
}

HANDLERS.ui_type = async ({ target, text = "", clear = true, submit = false, nth = 0, within = null, wait_ms = 500 } = {}) => {
  const { node, item } = uiResolve(target, { nth, within });
  let field = node;
  if (!/^(INPUT|TEXTAREA|SELECT)$/.test(field.tagName) && !field.isContentEditable) {
    field = node.querySelector("input,textarea,select,[contenteditable=true]") ?? node;
  }
  const before = uiSnapshotLabels();
  await agentPoint(field, field.tagName === "SELECT" ? "select" : "type", item.label);
  field.focus?.();
  if (field.isContentEditable) {
    if (clear) field.textContent = "";
    document.execCommand?.("insertText", false, String(text));
  } else if (field.tagName === "SELECT") {
    const opt = [...field.options].find((o) => uiClean(o.text).toLowerCase() === uiClean(text).toLowerCase() || o.value === text);
    if (!opt) throw new Error(`Pilihan '${text}' tidak ada. Pilihan: ${[...field.options].map((o) => uiClean(o.text)).join(" | ")}`);
    uiSetValue(field, opt.value);
  } else {
    // type it out live (short text), then settle on the full value
    const start = clear ? "" : String(field.value ?? "");
    const full = start + String(text);
    if (!reducedMotion() && String(text).length <= 80) {
      // human rhythm: uneven keystrokes, a beat after spaces and punctuation
      const s = String(text);
      for (let i = 1; i < s.length; i++) {
        uiSetValue(field, start + s.slice(0, i));
        const ch = s[i - 1];
        await sleep(/[\s.,;:/]/.test(ch) ? 70 + Math.random() * 90 : 22 + Math.random() * 48);
      }
    }
    uiSetValue(field, full);
  }
  if (submit) uiKey(field, "Enter");
  const after = await uiAfter(before, Math.max(0, Math.min(Number(wait_ms) || 0, 5000)));
  return { typed: { ...item, value: String(field.value ?? field.textContent ?? "").slice(0, 120) }, ...after };
};

HANDLERS.ui_key = async ({ key = "Escape", target = null, wait_ms = 300 } = {}) => {
  const node = target ? uiResolve(target).node : document.activeElement || document.body;
  const before = uiSnapshotLabels();
  if (node !== document.body) await agentPoint(node, "key", key);
  else agentOn(`key “${key}”`);
  uiKey(node, key);
  const after = await uiAfter(before, Math.max(0, Math.min(Number(wait_ms) || 0, 5000)));
  return { key, ...after };
};

HANDLERS.ui_read = ({ target = null, max_chars = 4000 } = {}) => {
  let node;
  if (target) node = uiResolve(target).node.closest(UI_CONTAINER) ?? uiResolve(target).node;
  else {
    const popups = [...document.querySelectorAll(UI_CONTAINER)].filter((p) => p.getClientRects().length && !p.closest(UI_OWN));
    node = popups[popups.length - 1] ?? null;
  }
  if (!node) throw new Error("Tidak ada menu/dialog yang terbuka. Beri target (label) untuk membaca bagian tertentu.");
  const text = uiClean(node.innerText).slice(0, Math.max(100, Math.min(Number(max_chars) || 4000, 20000)));
  return { text };
};

HANDLERS.add_tile_layer = ({ name = "Tile layer", url, attribution, opacity, min_zoom, max_zoom, tile_size } = {}) => {
  const app = requireApp();
  if (!url || !/\{z\}/.test(url)) throw new Error("url harus template XYZ dengan {z}/{x}/{y}.");
  if (!app.addTileLayer) throw new Error("Versi GeoLibre ini belum punya addTileLayer().");
  const options = {};
  if (attribution) options.attribution = attribution;
  if (opacity !== undefined && opacity !== null) options.opacity = Number(opacity);
  if (min_zoom !== undefined && min_zoom !== null) options.minzoom = Number(min_zoom);
  if (max_zoom !== undefined && max_zoom !== null) options.maxzoom = Number(max_zoom);
  if (tile_size) options.tileSize = Number(tile_size);
  const id = app.addTileLayer(name, url, options);
  return { layerId: id, name, url };
};

// ---------------------------------------------------------------------------
// Workbench skin: GeoLibre laid out like a desktop GIS (QGIS-style title strip,
// flat text menu bar, docks with thin title bars, boxed status-bar fields), in
// monochrome. Duplicate controls are hidden by the stylesheet; everything is
// scoped under :root.glb-qskin so `/skin off` restores the app as it was.
// ---------------------------------------------------------------------------

const SKIN = { title: null, input: null, timer: null };

/** The Simple GIS mark: an eye whose iris is a globe. */
const BRAND_SVG =
  '<path d="M1.5 12C4.6 6.2 8.2 4.2 12 4.2s7.4 2 10.5 7.8c-3.1 5.8-6.7 7.8-10.5 7.8S4.6 17.8 1.5 12z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>' +
  '<circle cx="12" cy="12" r="5.4" fill="none" stroke="#7fb3d5" stroke-width="1.3"/>' +
  '<path d="M6.6 12h10.8M12 6.6c-2.2 2.9-2.2 7.9 0 10.8M12 6.6c2.2 2.9 2.2 7.9 0 10.8" fill="none" stroke="#7fb3d5" stroke-width=".9"/>';

function skinGlyph() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "glb-qtitle-mark");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = BRAND_SVG;
  return svg;
}

// ---------------------------------------------------------------------------
// Rebrand: every visible "GeoLibre" reads "Simple GIS" (text, tooltips,
// placeholders, page title, favicon, header logo). aria-labels are left alone,
// and label readers (uiClean / tbLabel) map the new name back, so menu paths
// and the AI's UI tools keep matching the app's real labels.
// ---------------------------------------------------------------------------

const BRAND = { name: "Simple GIS", observer: null, saved: new Map(), logo: null, favicon: null };
const BRAND_RE = /GeoLibre(?: Desktop)?|geolibre/g;

function rebrandText(s) {
  return s.replace(BRAND_RE, (m) => (m === "geolibre" ? "simple gis" : BRAND.name));
}

/** Labels shown as "Simple GIS" back to the app's own name, for matching. */
function unbrand(s) {
  return BRAND.observer ? s.replace(/Simple GIS/g, "GeoLibre").replace(/simple gis/g, "geolibre") : s;
}

function rebrandNode(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    const p = node.parentElement;
    if (p && /^(SCRIPT|STYLE|TEXTAREA)$/.test(p.tagName)) return;
    if (BRAND_RE.test(node.data)) {
      BRAND_RE.lastIndex = 0;
      BRAND.saved.set(node, node.data);
      node.data = rebrandText(node.data);
    }
    BRAND_RE.lastIndex = 0;
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  for (const attr of ["title", "placeholder", "alt"]) {
    const v = node.getAttribute(attr);
    if (v && /geolibre/i.test(v)) node.setAttribute(attr, rebrandText(v));
  }
  // inputs showing the app name as their value (e.g. dialogs that echo it)
  if (node.tagName === "INPUT" && node.readOnly && /GeoLibre/.test(node.value)) node.value = rebrandText(node.value);
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) rebrandNode(n);
    else for (const attr of ["title", "placeholder", "alt"]) {
      const v = n.getAttribute(attr);
      if (v && /geolibre/i.test(v)) n.setAttribute(attr, rebrandText(v));
    }
  }
}

/** Swap the header's brand logo for the eye-and-globe mark. */
function rebrandLogo() {
  const span = document.querySelector("#root header > span:first-child");
  if (!span || span.querySelector(".glb-brand-mark")) return;
  for (const img of span.querySelectorAll("svg, img")) img.style.display = "none";
  const mark = skinGlyph();
  mark.setAttribute("class", "glb-brand-mark");
  span.prepend(mark);
  BRAND.logo = { span, mark };
}

function rebrandOn() {
  if (BRAND.observer) return;
  BRAND.observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "characterData") rebrandNode(r.target);
      else if (r.type === "attributes") rebrandNode(r.target);
      else for (const n of r.addedNodes) rebrandNode(n);
    }
    if (/geolibre/i.test(document.title)) document.title = rebrandText(document.title);
    rebrandLogo();
  });
  BRAND.observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["title", "placeholder", "alt"] });
  rebrandNode(document.body);
  document.title = rebrandText(document.title || BRAND.name);
  rebrandLogo();
  const icon = document.querySelector("link[rel~=icon]") ?? document.head.appendChild(el("link", { rel: "icon" }));
  BRAND.favicon = { icon, href: icon.getAttribute("href") };
  icon.setAttribute("href", `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" color="#e8e8e8">${BRAND_SVG}</svg>`)}`);
}

function rebrandOff() {
  BRAND.observer?.disconnect();
  BRAND.observer = null;
  for (const [node, text] of BRAND.saved) if (node.isConnected) node.data = text;
  BRAND.saved.clear();
  if (BRAND.logo) {
    BRAND.logo.mark.remove();
    for (const img of BRAND.logo.span.querySelectorAll("svg, img")) img.style.display = "";
    BRAND.logo = null;
  }
  if (BRAND.favicon) {
    if (BRAND.favicon.href) BRAND.favicon.icon.setAttribute("href", BRAND.favicon.href);
    BRAND.favicon = null;
  }
}

/** The app's own project-name field (hidden by the skin; the title strip edits it). */
function skinAppNameInput() {
  const header = document.querySelector("#root header");
  return [...(header?.querySelectorAll("input") ?? [])].find((i) => /project name/i.test(uiLabel(i))) ?? null;
}

function skinOn() {
  document.documentElement.classList.add("glb-qskin");
  if (SKIN.title?.isConnected) return;
  const input = el("input", { type: "text", className: "glb-qtitle-name", spellcheck: false, title: "Ngaran proyék (klik pikeun ngaganti)" });
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter" || e.key === "Escape") input.blur();
  });
  input.addEventListener("change", () => {
    const app = skinAppNameInput();
    if (app) uiSetValue(app, input.value.trim() || "Untitled Project");
  });
  SKIN.input = input;
  // the Simple GIS mark, then the project name
  const logo = skinGlyph();
  SKIN.title = el("div", { className: "glb-qtitle", role: "banner" }, [logo, input]);
  document.body.prepend(SKIN.title);
  const pull = () => {
    const app = skinAppNameInput();
    if (app && document.activeElement !== input) input.value = app.value || "Untitled Project";
    input.style.width = `${Math.max(6, input.value.length + 1)}ch`;
    // the menu bar starts right after it
    document.documentElement.style.setProperty("--glb-qtitle-w", `${Math.ceil(SKIN.title.getBoundingClientRect().width)}px`);
  };
  pull();
  SKIN.timer = setInterval(() => { pull(); if (!LB.el?.isConnected) leftBarOn(); }, 1000);
}

function skinOff() {
  document.documentElement.classList.remove("glb-qskin");
  clearInterval(SKIN.timer);
  SKIN.title?.remove();
  Object.assign(SKIN, { title: null, input: null, timer: null });
}

/** The whole opt-in workbench: skin, rename, left bar, Layer Styling dock, Toolbox. */
function workbenchOn(app) {
  skinOn();
  rebrandOn();
  if (app) {
    registerLayerStyling(app);
    registerToolbox(app);
  }
  setTimeout(leftBarOn, 0);
}

function workbenchOff() {
  skinOff();
  rebrandOff();
  leftBarOff();
  state.disposeStyling?.();
  state.disposeStyling = null;
  state.disposeToolbox?.();
  state.disposeToolbox = null;
}

// ---------------------------------------------------------------------------
// Layer Styling dock, laid out like QGIS's (src/app/qgslayerstylingwidget.cpp):
// a layer picker on top, a vertical page list on the left (vector: Symbology,
// Labels, History; raster: Symbology, Transparency, History), the page on the
// right, and Undo / Redo / Live update / Apply at the bottom.
//
// Vector styles are written as a QGIS QML document and applied with
// app.importLayerStyle (GeoLibre's own QML reader: singleSymbol,
// categorizedSymbol, graduatedSymbol, RuleRenderer, simple labeling), so they
// are saved with the project. Raster pages drive the MapLibre raster paint
// (QGIS's "Layer Rendering" and "Resampling" groups).
// ---------------------------------------------------------------------------

const LS_PANEL_ID = `${PLUGIN_ID}-styling`;
const LS = { root: null, layerId: null, state: null, undo: [], redo: [], live: true, timer: null, unsub: null, history: [] };

const LS_RENDERERS = [
  ["single", "Single Symbol"],
  ["categorized", "Categorized"],
  ["graduated", "Graduated"],
  ["rule-based", "Rule-based"],
];
const LS_MODES = [
  ["equal", "Equal Interval"],
  ["quantile", "Equal Count (Quantile)"],
  ["jenks", "Natural Breaks (Jenks)"],
  ["pretty", "Pretty Breaks"],
  ["stddev", "Standard Deviation"],
];
// ---- 300 searchable colour palettes (ramps) -------------------------------------
// Named ramps from ColorBrewer, matplotlib, cmocean and common GIS schemes, each
// also reversed, plus light-to-dark ramps for 24 hues and 8 qualitative sets in
// pastel / vivid. A ramp is a list of stops sampled evenly by lsRamp().
const LS_RAMP_BASE = {
  // ColorBrewer sequential
  Blues: ["#f7fbff", "#c6dbef", "#6baed6", "#2171b5", "#08306b"],
  Greens: ["#f7fcf5", "#c7e9c0", "#74c476", "#238b45", "#00441b"],
  Greys: ["#ffffff", "#d9d9d9", "#969696", "#525252", "#000000"],
  Oranges: ["#fff5eb", "#fdd0a2", "#fd8d3c", "#d94801", "#7f2704"],
  Purples: ["#fcfbfd", "#dadaeb", "#9e9ac8", "#6a51a3", "#3f007d"],
  Reds: ["#fff5f0", "#fcbba1", "#fb6a4a", "#cb181d", "#67000d"],
  BuGn: ["#f7fcfd", "#ccece6", "#66c2a4", "#238b45", "#00441b"],
  BuPu: ["#f7fcfd", "#bfd3e6", "#8c96c6", "#88419d", "#4d004b"],
  GnBu: ["#f7fcf0", "#ccebc5", "#7bccc4", "#2b8cbe", "#084081"],
  OrRd: ["#fff7ec", "#fdd49e", "#fc8d59", "#d7301f", "#7f0000"],
  PuBu: ["#fff7fb", "#d0d1e6", "#74a9cf", "#0570b0", "#023858"],
  PuBuGn: ["#fff7fb", "#d0d1e6", "#67a9cf", "#02818a", "#014636"],
  PuRd: ["#f7f4f9", "#d4b9da", "#df65b0", "#ce1256", "#67001f"],
  RdPu: ["#fff7f3", "#fcc5c0", "#f768a1", "#ae017e", "#49006a"],
  YlGn: ["#ffffe5", "#d9f0a3", "#78c679", "#238443", "#004529"],
  YlGnBu: ["#ffffd9", "#c7e9b4", "#41b6c4", "#225ea8", "#081d58"],
  YlOrBr: ["#ffffe5", "#fee391", "#fe9929", "#cc4c02", "#662506"],
  YlOrRd: ["#ffffcc", "#fed976", "#fd8d3c", "#e31a1c", "#800026"],
  // ColorBrewer diverging
  BrBG: ["#543005", "#bf812d", "#f6e8c3", "#80cdc1", "#003c30"],
  PiYG: ["#8e0152", "#de77ae", "#f7f7f7", "#7fbc41", "#276419"],
  PRGn: ["#40004b", "#9970ab", "#f7f7f7", "#5aae61", "#00441b"],
  PuOr: ["#2d004b", "#8073ac", "#f7f7f7", "#e08214", "#7f3b08"],
  RdBu: ["#67001f", "#d6604d", "#f7f7f7", "#4393c3", "#053061"],
  RdGy: ["#67001f", "#d6604d", "#ffffff", "#878787", "#1a1a1a"],
  RdYlBu: ["#a50026", "#f46d43", "#ffffbf", "#74add1", "#313695"],
  RdYlGn: ["#a50026", "#f46d43", "#ffffbf", "#66bd63", "#006837"],
  Spectral: ["#9e0142", "#f46d43", "#ffffbf", "#66c2a5", "#5e4fa2"],
  // ColorBrewer qualitative (discrete)
  Set1: ["#e41a1c", "#377eb8", "#4daf4a", "#984ea3", "#ff7f00", "#ffff33", "#a65628", "#f781bf", "#999999"],
  Set2: ["#66c2a5", "#fc8d62", "#8da0cb", "#e78ac3", "#a6d854", "#ffd92f", "#e5c494", "#b3b3b3"],
  Set3: ["#8dd3c7", "#ffffb3", "#bebada", "#fb8072", "#80b1d3", "#fdb462", "#b3de69", "#fccde5", "#d9d9d9", "#bc80bd", "#ccebc5", "#ffed6f"],
  Pastel1: ["#fbb4ae", "#b3cde3", "#ccebc5", "#decbe4", "#fed9a6", "#ffffcc", "#e5d8bd", "#fddaec", "#f2f2f2"],
  Pastel2: ["#b3e2cd", "#fdcdac", "#cbd5e8", "#f4cae4", "#e6f5c9", "#fff2ae", "#f1e2cc", "#cccccc"],
  Dark2: ["#1b9e77", "#d95f02", "#7570b3", "#e7298a", "#66a61e", "#e6ab02", "#a6761d", "#666666"],
  Accent: ["#7fc97f", "#beaed4", "#fdc086", "#ffff99", "#386cb0", "#f0027f", "#bf5b17", "#666666"],
  Paired: ["#a6cee3", "#1f78b4", "#b2df8a", "#33a02c", "#fb9a99", "#e31a1c", "#fdbf6f", "#ff7f00", "#cab2d6", "#6a3d9a", "#ffff99", "#b15928"],
  // perceptual (matplotlib / seaborn)
  Viridis: ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"],
  Magma: ["#000004", "#51127c", "#b73779", "#fc8961", "#fcfdbf"],
  Inferno: ["#000004", "#56106e", "#bb3754", "#f98e09", "#fcffa4"],
  Plasma: ["#0d0887", "#7e03a8", "#cc4778", "#f89540", "#f0f921"],
  Cividis: ["#00224e", "#434e6c", "#7d7c78", "#bcaf6f", "#fee838"],
  Turbo: ["#30123b", "#4686fb", "#1ae4b6", "#a2fc3c", "#fabb39", "#e4460a", "#7a0403"],
  Mako: ["#0b0405", "#382a54", "#395d9c", "#3496a5", "#60ceac", "#def5e5"],
  Rocket: ["#03051a", "#4c1d4b", "#a11a5b", "#e83f3f", "#f69c73", "#faebdd"],
  Twilight: ["#e2d9e2", "#6f8ec0", "#3b2560", "#a44a4a", "#e2d9e2"],
  Coolwarm: ["#3b4cc0", "#8db0fe", "#dddddd", "#f49a7b", "#b40426"],
  Jet: ["#00007f", "#0000ff", "#00ffff", "#ffff00", "#ff0000", "#7f0000"],
  Rainbow: ["#6e40aa", "#417de0", "#1ac7c2", "#40f373", "#aff05b", "#e2b72f", "#ff5e63"],
  Cubehelix: ["#000000", "#1a3a3a", "#5c7f3f", "#c78b71", "#c3c4f0", "#ffffff"],
  // cmocean
  Thermal: ["#042333", "#3c0f8a", "#a93f6e", "#f58a3b", "#e8fa5b"],
  Haline: ["#2a186c", "#1e5c8e", "#1b9993", "#6bc77a", "#fdef9a"],
  Solar: ["#331418", "#7a2a1e", "#b3541b", "#de9427", "#e0fd4a"],
  Ice: ["#040613", "#2a3a7b", "#3d7fb4", "#80c5d6", "#eafdfd"],
  Oxy: ["#400505", "#6a6a69", "#a5a5a4", "#e0e0df", "#d6d93f"],
  Deep: ["#fdfecc", "#8fd8a5", "#3a9da7", "#3d5f9b", "#281a2c"],
  Dense: ["#e6f1f1", "#93c4dc", "#6c86d0", "#6a47a0", "#360e24"],
  Algae: ["#d7f9d0", "#8ccc7a", "#3b9a48", "#136330", "#122414"],
  Matter: ["#fdedb0", "#f5a571", "#d55c5f", "#90305e", "#2f0f3e"],
  Turbid: ["#e9f6ab", "#c3a76f", "#93704c", "#5c4630", "#221e1b"],
  Speed: ["#fffdcd", "#c8c56a", "#6ea43e", "#28702f", "#172313"],
  Amp: ["#f1ecec", "#e0a99c", "#cd6352", "#9f2132", "#3c0912"],
  Tempo: ["#fff6f4", "#9cc9a5", "#3a9391", "#1e5875", "#151d44"],
  Rain: ["#eeedf3", "#a8c3a3", "#3c9883", "#215e7a", "#232242"],
  Balance: ["#181c43", "#3d6dbf", "#f1ecec", "#c6533e", "#3c0912"],
  Delta: ["#112040", "#2a7cb0", "#fffdcd", "#4f9a3a", "#172313"],
  Curl: ["#151d44", "#2d8187", "#fef6f5", "#c15a65", "#340d35"],
  Tarn: ["#fffdcd", "#c8a56a", "#f9f6f4", "#3c9883", "#232242"],
  // GIS schemes
  Terrain: ["#336699", "#00a0b0", "#55bb44", "#ddd888", "#aa8866", "#ffffff"],
  Elevation: ["#008435", "#33cc00", "#f4f071", "#f4bd45", "#99643d", "#a1a1a1", "#ffffff"],
  Hypsometric: ["#71ab6f", "#a4c584", "#e6dfa6", "#d8b27a", "#b47f53", "#9b7366", "#f2efe9"],
  Bathymetry: ["#f7fcf0", "#a8ddb5", "#4eb3d3", "#0868ac", "#081d58"],
  Ocean: ["#007f00", "#004c7f", "#0019ff", "#4c99ff", "#b2e5ff"],
  NDVI: ["#a50026", "#d73027", "#fee08b", "#a6d96a", "#1a9850", "#004529"],
  Vegetation: ["#ffffe5", "#d9f0a3", "#78c679", "#238443", "#004529"],
  LandCover: ["#419bdf", "#397d49", "#88b053", "#7a87c6", "#e49635", "#dfc35a", "#c4281b", "#a59b8f"],
  Temperature: ["#2c7bb6", "#abd9e9", "#ffffbf", "#fdae61", "#d7191c"],
  Precipitation: ["#ffffff", "#c6dbef", "#6baed6", "#2171b5", "#08306b", "#3f007d"],
  Slope: ["#38a800", "#b0e000", "#ffff00", "#ffaa00", "#ff0000"],
  Aspect: ["#ff0000", "#ffa500", "#ffff00", "#00ff00", "#00ffff", "#0000ff", "#ff00ff", "#ff0000"],
  Hillshade: ["#000000", "#5a5a5a", "#b4b4b4", "#ffffff"],
  Heat: ["#000000", "#800000", "#ff0000", "#ffff00", "#ffffff"],
  Fire: ["#ffffcc", "#ffeda0", "#feb24c", "#f03b20", "#bd0026", "#300000"],
  Earth: ["#4b2e1e", "#8c6239", "#c2a26b", "#e3d6a8", "#93a06d", "#4c6b3b"],
  Sepia: ["#fff8e7", "#e6cfa0", "#b98b54", "#7a5230", "#3b2716"],
  Ice2Fire: ["#08306b", "#6baed6", "#f7f7f7", "#fd8d3c", "#67000d"],
};

function lsBuildRamps() {
  const ramps = {};
  for (const [name, stops] of Object.entries(LS_RAMP_BASE)) {
    ramps[name] = stops;
    ramps[`${name} (reversed)`] = [...stops].reverse();
  }
  const hues = [["Red", 0], ["Vermilion", 15], ["Orange", 30], ["Amber", 45], ["Yellow", 55], ["Lime", 75], ["Chartreuse", 90], ["Green", 120], ["Emerald", 140], ["Spring", 150], ["Teal", 170], ["Cyan", 185], ["Sky", 200], ["Azure", 210], ["Blue", 225], ["Indigo", 240], ["Violet", 260], ["Purple", 275], ["Magenta", 300], ["Fuchsia", 315], ["Rose", 335], ["Crimson", 350], ["Brown", 25], ["Olive", 65]];
  for (const [n, h] of hues) {
    const s = n === "Brown" || n === "Olive" ? 0.45 : 0.75;
    ramps[`${n} light to dark`] = [0.93, 0.75, 0.55, 0.38, 0.2].map((l) => lsHslHex(h, s, l));
  }
  for (const [n, h] of hues) {
    const s = n === "Brown" || n === "Olive" ? 0.45 : 0.75;
    ramps[`${n} dark to light`] = [0.2, 0.38, 0.55, 0.75, 0.93].map((l) => lsHslHex(h, s, l));
  }
  // two-hue sequential ramps and hue-white-hue diverging ramps
  const pairs = [["Yellow", "Red"], ["Yellow", "Green"], ["Yellow", "Blue"], ["Yellow", "Purple"], ["Orange", "Red"], ["Orange", "Brown"], ["Lime", "Teal"], ["Green", "Blue"], ["Green", "Indigo"], ["Cyan", "Blue"], ["Cyan", "Purple"], ["Sky", "Indigo"], ["Blue", "Purple"], ["Blue", "Magenta"], ["Violet", "Rose"], ["Purple", "Red"], ["Rose", "Crimson"], ["Amber", "Crimson"], ["Spring", "Azure"], ["Emerald", "Indigo"], ["Teal", "Violet"], ["Chartreuse", "Emerald"], ["Olive", "Brown"], ["Amber", "Olive"], ["Sky", "Teal"], ["Fuchsia", "Indigo"], ["Vermilion", "Purple"], ["Lime", "Blue"], ["Yellow", "Brown"], ["Orange", "Purple"]];
  const hueOf = Object.fromEntries(hues);
  for (const [a, b] of pairs) ramps[`${a} to ${b}`] = [lsHslHex(hueOf[a], 0.8, 0.85), lsHslHex(hueOf[a], 0.75, 0.6), lsHslHex(hueOf[b], 0.7, 0.45), lsHslHex(hueOf[b], 0.75, 0.25)];
  for (const [a, b] of [["Red", "Blue"], ["Orange", "Purple"], ["Brown", "Teal"], ["Magenta", "Green"], ["Crimson", "Sky"], ["Amber", "Indigo"]]) {
    ramps[`${a} – white – ${b}`] = [lsHslHex(hueOf[a], 0.7, 0.35), lsHslHex(hueOf[a], 0.7, 0.7), "#f7f7f7", lsHslHex(hueOf[b], 0.6, 0.7), lsHslHex(hueOf[b], 0.7, 0.35)];
  }
  // qualitative sets (golden-angle hues from different start angles) up to 300 ramps
  const sets = [["Pastel", 0.6, 0.8], ["Vivid", 0.85, 0.5], ["Muted", 0.35, 0.55]];
  for (let k = 0; Object.keys(ramps).length < 300; k++) {
    const [name, s, l] = sets[k % 3];
    ramps[`${name} set ${Math.floor(k / 3) + 1}`] = Array.from({ length: 10 }, (_, i) => lsHslHex((k * 29 + i * 137.508) % 360, s, l));
  }
  return ramps;
}

// "random" is golden-angle hues; every other entry is a named ramp
const LS_RAMPS = { random: null, ...lsBuildRamps() };

// KLHK thematic styles, SK MENLHK 399/2024 Lampiran II (from the official ArcGIS layer files,
// via Layout Composer's KLHK_SYMBOLOGY): [unit, sub, name, geom, field, symbol|null,
// [[value, label|0, symbol]]]; a symbol is [fill, outline, outlineWidthMm, hatched, markerSizeMm].
const KLHK_STYLES = [["PKTL","IPSDH","DEFORESTASI_YYYY_YYYY_AR_250K","polygon","",["#FF0000",null,0.14,0,0],[]],["PKTL","IPSDH","KLASTERIHN_PNT_250K","point","",["#000000",null,0,0,3.53],[]],["PKTL","IPSDH","NSDHKWSHUTAN_YYYY_AR_250K","polygon","f_perubaha",null,[["HL menjadi HP",0,["#00AD00","#000000",0,1,0]],["HL menjadi HPK",0,["#00AD00","#000000",0,1,0]],["HL menjadi HPT",0,["#00AD00","#000000",0,1,0]],["HL menjadi KSA/KPA",0,["#00AD00","#000000",0,1,0]],["HP menjadi KSA/KPA",0,["#FFFF00","#000000",0,1,0]],["HPK menjadi APL",0,["#FF5EFF","#000000",0.14,0,0]],["HPK menjadi HL",0,["#FF5EFF","#000000",0,1,0]],["HPK menjadi HP",0,["#FF5EFF","#000000",0,1,0]],["HPK menjadi HPT",0,["#FF5EFF","#000000",0,1,0]],["HPT menjadi HPK",0,["#8AF200","#000000",0,1,0]],["HPT menjadi KSA/KPA",0,["#8AF200","#000000",0,1,0]],["KSA/KPA menjadi HL",0,["#AD3FFF","#000000",0,1,0]],["KSA/KPA menjadi HP",0,["#AD3FFF","#000000",0,1,0]],["KSA/KPA menjadi HPK",0,["#AD3FFF","#000000",0,1,0]],["KSA/KPA menjadi HPT",0,["#AD3FFF","#000000",0,1,0]],["Tetap APL",0,["#FFFFFF","#6E6E6E",0,0,0]],["Tetap HL",0,["#00AD00",null,0,0,0]],["Tetap HP",0,["#FFFF00",null,0,0,0]],["Tetap HPK",0,["#FF5EFF",null,0,0,0]],["Tetap HPT",0,["#8AF200",null,0,0,0]],["Tetap KSA/KPA",0,["#AD3FFF",null,0,0,0]],["Tetap Tubuh Air",0,["#D4FCF7",null,0,0,0]]]],["PKTL","IPSDH","NSDHPL_YYYY_AR_250K","polygon","id_pl_peru",null,[["20012001",0,["#60E663",null,0.04,0,0]],["20012002",0,["#4CE600","#0070FF",0.14,1,0]],["20014000",0,["#55FF00","#267300",0.14,1,0]],["20022002",0,["#72FF00",null,0.04,0,0]],["20022005",0,["#72FF00",null,0.04,0,0]],["20022006",0,["#A3FF73","#895A44",0.14,1,0]],["20024000",0,["#A3FF73","#A8A800",0.35,1,0]],["20042004",0,["#8EA700",null,0.04,0,0]],["20044000",0,["#FFFFFF","#895A44",0.14,1,0]],["20052005",0,["#60E663","#000000",0,1,0]],["20054000",0,["#FFFFFF","#00786C",0.14,1,0]],["20062006",0,["#D3E598",null,0.04,0,0]],["20064000",0,[null,"#730000",0.14,1,0]],["40002006",0,[null,"#4E4E4E",0.14,1,0]],["40004000",0,["#FFFFFF","#6E6E6E",0,0,0]],["200414000",0,["#FFFFFF","#897044",0.14,1,0]],["200420041",0,["#A8A800","#FF0000",0.14,1,0]],["200512006",0,["#FFFFFF","#AAFF00",0.14,1,0]],["200514000",0,["#AAFF00","#000000",0,1,0]],["200520051",0,["#55FF00","#004C73",0.14,1,0]],["400020041",0,["#FFFFFF","#FF0000",0.14,1,0]],["2004120041",0,["#C1A700",null,0.04,0,0]],["2005120051",0,["#72FF00","#000000",0,1,0]]]],["PKTL","IPSDH","PHYYYY_AR_250K","polygon","pl2020_id",null,[["2001","Hutan Lahan Kering Primer",["#60E663",null,0.04,0,0]],["2002","Hutan Lahan Kering Sekunder",["#72FF00",null,0.04,0,0]],["2005","Hutan Rawa Primer",["#60E663","#000000",0,1,0]],["20051","Hutan Rawa Sekunder",["#72FF00","#000000",0,1,0]],["2004","Hutan Mangrove Primer",["#8EA700",null,0.04,0,0]],["20041","Hutan Mangrove Sekunder",["#C1A700",null,0.04,0,0]],["2006","Hutan Tanaman Industri ( HTI )",["#D3E598",null,0.04,0,0]]]],["PKTL","IPSDH","PIPPIB_YYYY_X_AR_250K","polygon","PIPPIB22_1",null,[["PIPPIB GAMBUT",0,["#FF7F7F",null,0,0,0]],["PIPPIB KAWASAN",0,["#00A884",null,0,0,0]],["PIPPIB PRIMER",0,["#00A884",null,0,0,0]]]],["PKTL","IPSDH","PLYYYY_AR_250K","polygon","PL2020_ID",null,[["2001","Hutan Lahan Kering Primer",["#60E663",null,0.04,0,0]],["2002","Hutan Lahan Kering Sekunder",["#72FF00",null,0.04,0,0]],["2005","Hutan Rawa Primer",["#60E663","#000000",0,1,0]],["20051","Hutan Rawa Sekunder",["#72FF00","#000000",0,1,0]],["2004","Hutan Mangrove Primer",["#8EA700",null,0.04,0,0]],["20041","Hutan Mangrove Sekunder",["#C1A700",null,0.04,0,0]],["2007","Semak/Belukar",["#EBC0A7",null,0.04,0,0]],["20071","Semak/Belukar Rawa",["#EBC0A7","#000000",0,1,0]],["3000","Savana",["#D5FF00",null,0.04,0,0]],["2006","Hutan Tanaman Industri ( HTI )",["#D3E598",null,0.04,0,0]],["2010","Perkebunan",["#E5D298",null,0.04,0,0]],["20091","Pertanian Lahan Kering",["#F6FEA7",null,0.04,0,0]],["20092","Pertanian Lahan Kering Bercampur dengan Semak",["#EDF500",null,0.04,0,0]],["20122,6000","Transmigrasi",["#728EA7",null,0.04,0,0]],["20093","Sawah",[{"c":"#A8D6FF","z":0.18,"s":[0.35,0.35]},"#6E6E6E",0,0,0]],["20094","Tambak",["#7CF4F4",null,0.04,0,0]],["2014","Tanah Terbuka",[{"c":"#D60073","z":0.18,"s":[0.35,0.35]},"#6E6E6E",0,0,0]],["20141","Pertambangan",["#A70000",null,0.04,0,0]],["2012","Permukiman",["#4E4E4E",null,0.04,0,0]],["5001","Tubuh Air",["#D4FCF7",null,0.35,0,0]],["20121","Pelabuhan Udara/Laut",["#D60073","#6E6E6E",0,0,0]],["5011,50011","Rawa",["#98E5E5","#000000",0,1,0]],["2500","Awan",["#D1D1D1",null,0.04,0,0]]]],["PKTL","IPSDH","POTENSIHUTAN_AR_250K","polygon","Kls_Biomas",null,[["1",0,["#498A00",null,0.14,0,0]],["4",0,["#006100",null,0.14,0,0]],["5",0,["#FF2200",null,0.14,0,0]],["6",0,["#FF6F00",null,0.14,0,0]],["7",0,["#FFA600",null,0.14,0,0]],["8",0,["#FFE600",null,0.14,0,0]],["9",0,["#D6E600",null,0.14,0,0]],["10",0,["#8BB500",null,0.14,0,0]]]],["PKTL","IPSDH","REFORESTASI_YYYY_YYYY_AR_250K","polygon","",["#38A800",null,0,0,0],[]],["PKTL","PDLKWS","DDDTLH_AR_250K","polygon","STATUS",null,[["Belum Terlampaui",0,["#FFFF73","#6E6E6E",0,0,0]],["Terlampaui",0,["#894444","#6E6E6E",0,0,0]]]],["PKTL","PDLKWS","EKOREGION_DARAT_AR_500K","polygon","nameko2017",null,[["Ekoregion Kompleks Dataran Denudasional  Kep. Bangka Belitung,Ekoregion Kompleks Dataran Denudasional Kep. Riau","Kompleks Dataran Denudasional",["#FFEBAF",null,0.14,0,0]],["Ekoregion Kompleks Dataran Fluvial  Air Bangis,Ekoregion Kompleks Dataran Fluvial  Batang - Demak - Pati - Blora,Ekoregion Kompleks Dataran Fluvial  Baturube - Bakiriang,Ekoregion Kompleks Dataran Fluvial  Cilacap,Ekoregion Kompleks Dataran Fluvial  Cilegon  Indramayu - Pekalongan,Ekoregion Kompleks Dataran Fluvial  Idirayeuk - Binjai - Sutan Syarif Qasim,Ekoregion Kompleks Dataran Fluvial  Muko-Muko - Air Alas,Ekoregion Kompleks Dataran Fluvial  P. Seram,Ekoregion Kompleks Dataran Fluvial  Tanjung Santigi - Tanjung Randangan,Ekoregion Kompleks Dataran Fluvial Alas Purwo,Ekoregion Kompleks Dataran Fluvial Bali - Lombok,Ekoregion Kompleks Dataran Fluvial Bojonegoro - Gresik - Sidoarjo,Ekoregion Kompleks Dataran Fluvial Bundong-Bundong,Ekoregion Kompleks Dataran Fluvial D. Limboto,Ekoregion Kompleks Dataran Fluvial Donggala - Poso,Ekoregion Kompleks Dataran Fluvial Flores,Ekoregion Kompleks Dataran Fluvial Kuala Kuayan - Kasongan,Ekoregion Kompleks Dataran Fluvial Lakitan Utara - Terusan Sialang,Ekoregion Kompleks Dataran Fluvial Lereh - Senggi,Ekoregion Kompleks Dataran Fluvial Maluku Utara,Ekoregion Kompleks Dataran Fluvial Meulaboh,Ekoregion Kompleks Dataran Fluvial Polewali - Palopo,Ekoregion Kompleks Dataran Fluvial Rawa Aopa Watumohai,Ekoregion Kompleks Dataran Fluvial Rawa Singkil,Ekoregion Kompleks Dataran Fluvial S. Mamberamo - Foja,Ekoregion Kompleks Dataran Fluvial S. Onggak Mongondow,Ekoregion Kompleks Dataran Fluvial S.Belayan - S. Kelinjau,Ekoregion Kompleks Dataran Fluvial Sentarum,Ekoregion Kompleks Dataran Fluvial Sumbawa,Ekoregion Kompleks Dataran Fluvial Timor Tengah Selatan,Ekoregion Kompleks Dataran Fluvial Wera - Tavaili","Kompleks Dataran Fluvial",["#BEE8FF",null,0.04,0,0]],["Ekoregion Kompleks Dataran Gambut Pantai Timur Sumatera,Ekoregion Kompleks Dataran Gambut S. Katingan - S. Sebangau,Ekoregion Kompleks Dataran Gambut S. Mange - S. Dadau,Ekoregion Kompleks Dataran Gambut S. Sembakung,Ekoregion Kompleks Dataran Gambut S. Terentang - S. Kapuas,Ekoregion Kompleks Dataran Gambut Sungai Fakuja - Sungai Foli,Ekoregion Kompleks Dataran Gambut Sungai Kuis - Sungai Bapai.,Ekoregion Kompleks Dataran Gambut Sungai Siriwo - Sungai Poronai,Ekoregion Kompleks Dataran Gambut Sungai Wakamba - Sungai Warembori","Kompleks Dataran Gambut",["#A3FF73",null,0.04,0,0]],["Ekoregion Kompleks Dataran Karst  P. Babar - Lemola - Wetar Dsk","Kompleks Dataran Karst  ",["#E1E1E1",null,0.04,0,0]],["Ekoregion Kompleks Dataran Organik/Coral Jawa,Ekoregion Kompleks Dataran Organik/Koral P. Misol - P. Kofiau","Kompleks Dataran Organik/Coral",["#D3FFBE",null,0.04,0,0]],["Ekoregion Kompleks Dataran Pantai S. Bian - S. Kumbe,Ekoregion Kompleks Dataran Pantai Sanga-sanga,Ekoregion Kompleks Dataran Pantai Sebatik - Nunukan,Ekoregion Kompleks Dataran Pantai Tanjung Selor - Tarakan","Kompleks Dataran Pantai",["#00C5FF",null,0.04,0,0]],["Ekoregion Kompleks Dataran Struktural  Kep. Aru,Ekoregion Kompleks Dataran Struktural Bangkalan - Sumenep,Ekoregion Kompleks Dataran Struktural Mahakam,Ekoregion Kompleks Dataran Struktural P. Laut,Ekoregion Kompleks Dataran Struktural P. Salawati - Batanta Barat.,Ekoregion Kompleks Dataran Struktural Pamekasan,Ekoregion Kompleks Dataran Struktural Rembang - Tuban,Ekoregion Kompleks Dataran Struktural S. Darau,Ekoregion Kompleks Dataran Struktural Teluk Bintuni,Ekoregion Kompleks Dataran Struktural Tesso Nilo - Bukit Dua Belas","Kompleks Dataran Struktural",["#E8BEFF",null,0.04,0,0]],["Ekoregion Kompleks Dataran Vulkanik  Bantar Waru,Ekoregion Kompleks Dataran Vulkanik Bantul - Nganjuk - Probolinggo,Ekoregion Kompleks Dataran Vulkanik Banyuwangi,Ekoregion Kompleks Dataran Vulkanik Benakat Semangus - Way Kambas,Ekoregion Kompleks Dataran Vulkanik Jember,Ekoregion Kompleks Dataran Vulkanik Serang - Tangerang - Depok","Kompleks Dataran Vulkanik",["#F6D9DF",null,0.04,0,0]],["Ekoregion Kompleks Organik/Koral Bali - Lombok,Ekoregion Kompleks Organik/Koral Flores,Ekoregion Kompleks Organik/Koral Sumba,Ekoregion Kompleks Organik/Koral Sumbawa,Ekoregion Kompleks Organik/Koral Timor Tengah Selatan","Kompleks Organik/Kora",["#64C864",null,0.04,0,0]],["Ekoregion Kompleks Pegunungan Denudasional  P. Seram,Ekoregion Kompleks Pegunungan Denudasional Gunung Belakang,Ekoregion Kompleks Pegunungan Denudasional Sumba,Ekoregion Kompleks Pegunungan Denudasional Timor Tengah Selatan,Ekoregion Kompleks Pegunungan Denudasional Vulkanik Bukit Jumak","Kompleks Pegunungan Denudasional",["#FFAA00",null,0.04,0,0]],["Ekoregion Kompleks Pegunungan Glasial Puncak Jaya","Kompleks Pegunungan Glasial ",["#686868",null,0.04,0,0]],["Ekoregion Kompleks Pegunungan Struktural  Barumun - Malampah Alahan Panjang,Ekoregion Kompleks Pegunungan Struktural  Kerinci Seblat - Bukit Barisan Selatan,Ekoregion Kompleks Pegunungan Struktural  Lore Lindu - Bogani Nani Wartabone,Ekoregion Kompleks Pegunungan Struktural Bantimurung - Bulusaraung,Ekoregion Kompleks Pegunungan Struktural Flores,Ekoregion Kompleks Pegunungan Struktural Janthoi - Gunung Leuser,Ekoregion Kompleks Pegunungan Struktural Mahakam,Ekoregion Kompleks Pegunungan Struktural Maluku Utara,Ekoregion Kompleks Pegunungan Struktural Meratus,Ekoregion Kompleks Pegunungan Struktural P. Batanta.,Ekoregion Kompleks Pegunungan Struktural P. Buru,Ekoregion Kompleks Pegunungan Struktural P. Seram,Ekoregion Kompleks Pegunungan Struktural P. Waigeo,Ekoregion Kompleks Pegunungan Struktural Sumbawa,Ekoregion Kompleks Pegunungan Struktural Tamrau,Ekoregion Kompleks Pegunungan Struktural Tengah Papua,Ekoregion Kompleks Pegunungan Struktural Timor Tengah Selatan","Kompleks Pegunungan Struktural",["#AA66CD",null,0.04,0,0]],["Ekoregion Kompleks Pegunungan Vulkanik  Maninjau Utara Selatan - Gunung Sado,Ekoregion Kompleks Pegunungan Vulkanik Bali - Lombok,Ekoregion Kompleks Pegunungan Vulkanik Bawean,Ekoregion Kompleks Pegunungan Vulkanik Besowo Gadungan - Raden Soeryo Tretes,Ekoregion Kompleks Pegunungan Vulkanik Bromo - Dataran Tinggi Yang - Baluran,Ekoregion Kompleks Pegunungan Vulkanik Flores,Ekoregion Kompleks Pegunungan Vulkanik G.Halimun  - G.Salak -  G. Sawal,Ekoregion Kompleks Pegunungan Vulkanik Gumay Tebing Tinggi - Gunung Raya,Ekoregion Kompleks Pegunungan Vulkanik Gunung Muria,Ekoregion Kompleks Pegunungan Vulkanik Malino,Ekoregion Kompleks Pegunungan Vulkanik Maluku Utara,Ekoregion Kompleks Pegunungan Vulkanik Sumbawa","Kompleks Pegunungan Vulkanik",["#FF7F7F",null,0.04,0,0]],["Ekoregion Kompleks Perbukitan Denudasional Bukit Baka - Bukit Raya,Ekoregion Kompleks Perbukitan Denudasional Maluku Utara,Ekoregion Kompleks Perbukitan Denudasional Timor Tengah Selatan","Kompleks Perbukitan Denudasiona",["#FFAA00",null,0.04,0,0]],["Ekoregion Kompleks Perbukitan Karst  Bantimurung - Bulusaraung,Ekoregion Kompleks Perbukitan Karst  Buton Utara - Lambusango - Wakatobi,Ekoregion Kompleks Perbukitan Karst  Kep. Kei,Ekoregion Kompleks Perbukitan Karst  P. Seram,Ekoregion Kompleks Perbukitan Karst  P. Tanibar,Ekoregion Kompleks Perbukitan Karst  Pulau Batu Daka - Pulau Togean,Ekoregion Kompleks Perbukitan Karst  Pulau Kalapa,Ekoregion Kompleks Perbukitan Karst Alas Purwo,Ekoregion Kompleks Perbukitan Karst Bali - Lombok,Ekoregion Kompleks Perbukitan Karst Biak Numfor,Ekoregion Kompleks Perbukitan Karst Bukit Kalamotu,Ekoregion Kompleks Perbukitan Karst Flores,Ekoregion Kompleks Perbukitan Karst Gunung Kidul,Ekoregion Kompleks Perbukitan Karst Kep. Aru,Ekoregion Kompleks Perbukitan Karst Maluku Utara,Ekoregion Kompleks Perbukitan Karst Mangolo - Morowali - Pati Pati,Ekoregion Kompleks Perbukitan Karst P. Buru,Ekoregion Kompleks Perbukitan Karst P. Misol .,Ekoregion Kompleks Perbukitan Karst Pati - Rembang - Tuban,Ekoregion Kompleks Perbukitan Karst Pulau Lito Dudepo - Pulau Lito Ponelo,Ekoregion Kompleks Perbukitan Karst Soron - Teluk Bintuni,Ekoregion Kompleks Perbukitan Karst Sumba,Ekoregion Kompleks Perbukitan Karst Sumbawa,Ekoregion Kompleks Perbukitan Karst Tasikmalaya,Ekoregion Kompleks Perbukitan Karst Timor Tengah Selatan,Ekoregion Kompleks Perbukitan Karst Tulung Agung","Kompleks Perbukitan Karst",["#B2B2B2",null,0.04,0,0]],["Ekoregion Kompleks Perbukitan Solusional Karst Sangkurilang  Mangkaliat,Ekoregion Kompleks Perbukitan Solusional Karst Teluk Kelumpang","Kompleks Perbukitan Solusional Karst",["#F58764",null,0.04,0,0]],["Ekoregion Kompleks Perbukitan Struktural  Gunung Beser - Wadas Lintang,Ekoregion Kompleks Perbukitan Struktural  Kep. Kei,Ekoregion Kompleks Perbukitan Struktural  P. Babar - Lemola - Wetar Dsk,Ekoregion Kompleks Perbukitan Struktural  P. Tanibar,Ekoregion Kompleks Perbukitan Struktural  Rawa Aopa Watumohai - Kep Padamarang,Ekoregion Kompleks Perbukitan Struktural  Siranggas - Batang Gadis,Ekoregion Kompleks Perbukitan Struktural  Wonosari - Trenggalek,Ekoregion Kompleks Perbukitan Struktural Bali - Lombok,Ekoregion Kompleks Perbukitan Struktural Bukit Rimbang - Bukit Baling Dangku - Bukit Tiga Puluh,Ekoregion Kompleks Perbukitan Struktural Cani Sirenreng,Ekoregion Kompleks Perbukitan Struktural Ciamis,Ekoregion Kompleks Perbukitan Struktural Cut Nyak Dhien- Lampahan- Langkat,Ekoregion Kompleks Perbukitan Struktural Flores,Ekoregion Kompleks Perbukitan Struktural G. Gogugu - S. Ranoyapo,Ekoregion Kompleks Perbukitan Struktural Jalur Jayawijaya.,Ekoregion Kompleks Perbukitan Struktural Jonggol - Sumedang - Cilacap,Ekoregion Kompleks Perbukitan Struktural Kendal - Pati - Rembang -Tuban - Gresik,Ekoregion Kompleks Perbukitan Struktural Kep. Riau,Ekoregion Kompleks Perbukitan Struktural Kep. Yapen,Ekoregion Kompleks Perbukitan Struktural Maluku Utara,Ekoregion Kompleks Perbukitan Struktural Meratus,Ekoregion Kompleks Perbukitan Struktural Meru Betiri,Ekoregion Kompleks Perbukitan Struktural Npa Npa - Tanjung Peropa,Ekoregion Kompleks Perbukitan Struktural P. Seram,Ekoregion Kompleks Perbukitan Struktural Pantai Barat Sumatera,Ekoregion Kompleks Perbukitan Struktural S. Mamberamo - Foja,Ekoregion Kompleks Perbukitan Struktural Sumbawa,Ekoregion Kompleks Perbukitan Struktural Ujung Kulon - Cikepuh-  Leuweung Sancang","Kompleks Perbukitan Struktural ",["#CA7AF5",null,0.04,0,0]],["Ekoregion Kompleks Perbukitan Vulkanik  Gunung Slamet -Merapi,Ekoregion Kompleks Perbukitan Vulkanik  Rawa Dano,Ekoregion Kompleks Perbukitan Vulkanik  Wilis,Ekoregion Kompleks Perbukitan Vulkanik Bali - Lombok,Ekoregion Kompleks Perbukitan Vulkanik Flores,Ekoregion Kompleks Perbukitan Vulkanik G.Ceremai,Ekoregion Kompleks Perbukitan Vulkanik Kep. Banda,Ekoregion Kompleks Perbukitan Vulkanik Lawu Utara,Ekoregion Kompleks Perbukitan Vulkanik Manembo Nembo - Batu Putih,Ekoregion Kompleks Perbukitan Vulkanik Manembo Nembo - Duasudara - Tangkoko,Ekoregion Kompleks Perbukitan Vulkanik P. Babar - Lemola - Wetar Dsk,Ekoregion Kompleks Perbukitan Vulkanik Sibolangit - Dolok - Sipirok,Ekoregion Kompleks Perbukitan Vulkanik Sumbawa","Kompleks Perbukitan Vulkanik",["#FFBEBE",null,0.04,0,0]]]],["PKTL","PDLKWS","IJL_AR_250K","polygon","ARAHAN",null,[["1","1 (Lindung)",["#38A800","#6E6E6E",0,0,0]],["2","2 (Produksi)",["#FFFF73","#6E6E6E",0,0,0]],["3","3 (Rehabilitasi)",["#E69800","#6E6E6E",0,0,0]],["4","4 (Rehabilitasi Agroforestry)",["#737300","#6E6E6E",0,0,0]],["5","5 (Konversi)",["#FFBEBE","#6E6E6E",0,0,0]],["6","6 (APL)",["#CCCCCC","#6E6E6E",0,0,0]]]],["PKTL","PDLKWS","KBA_AR_250K","polygon","KBA_250",null,[["Danau pegunungan, Dnp","Danau pegunungan",["#00D2D2","#6E6E6E",0,0,0]],["Danau, Dn","Danau",["#00FDFF","#6E6E6E",0,0,0]],["Dataran fluvial bermaterial aluvium, 3F-V","Dataran fluvial bermaterial aluvium",["#AAC864","#6E6E6E",0,0,0]],["Dataran fluvial berombak-bergelombang bermaterial aluvium, 3ogF-V","Dataran fluvial berombak-bergelombang bermaterial aluvium",["#AAC864","#6E6E6E",0,0,0]],["Dataran fluviomarin bermaterial aluvium, 3Fm-V","Dataran fluviomarin bermaterial aluvium",["#AAFF64","#6E6E6E",0,0,0]],["Dataran fluviovulkanik bermaterial aluvium, 3Fv-V","Dataran fluviovulkanik bermaterial aluvium",["#78FFB4","#6E6E6E",0,0,0]],["Dataran lakustrin bermaterial aluvium, 3L-V","Dataran lakustrin bermaterial aluvium",["#C8FFC8","#6E6E6E",0,0,0]],["Dataran marin bermaterial batuan sedimen karbonat, 3M-IIsk","Dataran marin bermaterial batuan sedimen karbonat",["#96B4DC","#6E6E6E",0,0,0]],["Dataran marin berpasir bermaterial aluvium, 3Mp-V","Dataran marin berpasir bermaterial aluvium",["#B8D0EA","#6E6E6E",0,0,0]],["Dataran organik bermaterial gambut, 3O-VI","Dataran organik bermaterial gambut",["#64C864","#6E6E6E",0,0,0]],["Dataran organik koralian bermaterial batuan sedimen karbonat, 3O2-IIsk","Dataran organik koralian bermaterial batuan sedimen karbonat",["#F0C878","#6E6E6E",0,0,0]],["Dataran organik koralian berombak-bergelombang bermaterial batuan sedimen karbonat, 3ogO2-IIsk","Dataran organik koralian berombak-bergelombang bermaterial batuan sedimen karbonat",["#F0C878","#6E6E6E",0,0,0]],["Dataran solusional karst bermaterial batuan sedimen karbonat, 3K-IIsk","Dataran solusional karst bermaterial batuan sedimen karbonat",["#F58764","#6E6E6E",0,0,0]],["Dataran solusional karst berombak-bergelombang bermaterial batuan sedimen karbonat, 3ogK-IIsk","Dataran solusional karst berombak-bergelombang bermaterial batuan sedimen karbonat",["#F58764","#6E6E6E",0,0,0]],["Dataran struktural bermaterial batuan sedimen karbonat, 3S-IIsk","Dataran struktural bermaterial batuan sedimen karbonat",["#C85AF0","#6E6E6E",0,0,0]],["Dataran struktural berombak-bergelombang bermaterial batuan sedimen karbonat, 3ogS-IIsk","Dataran struktural berombak-bergelombang bermaterial batuan sedimen karbonat",["#C85AF0","#6E6E6E",0,0,0]],["Dataran struktural lipatan bermaterial batuan metamorfik, 3Stl-III","Dataran struktural lipatan bermaterial batuan metamorfik",["#F08CF5","#6E6E6E",0,0,0]],["Dataran struktural lipatan bermaterial campuran batuan sedimen karbonat dan non karbonat, 3Stl-IIcpk","Dataran struktural lipatan bermaterial campuran batuan sedimen karbonat dan non karbonat",["#F08CF5","#6E6E6E",0,0,0]],["Dataran struktural lipatan berombak-bergelombang bermaterial batuan metamorfik, 3ogStl-III","Dataran struktural lipatan berombak-bergelombang bermaterial batuan metamorfik",["#F08CF5","#6E6E6E",0,0,0]],["Dataran struktural lipatan berombak-bergelombang bermaterial batuan sedimen karbonat, 3ogStl-IIsk","Dataran struktural lipatan berombak-bergelombang bermaterial batuan sedimen karbonat",["#F08CF5","#6E6E6E",0,0,0]],["Dataran struktural lipatan berombak-bergelombang bermaterial batuan sedimen non karbonat, 3ogStl-IIsnk","Dataran struktural lipatan berombak-bergelombang bermaterial batuan sedimen non karbonat",["#F08CF5","#6E6E6E",0,0,0]],["Dataran struktural lipatan berombak-bergelombang bermaterial campuran batuan sedimen karbonat dan non karbonat, 3ogStl-IIcpk","Dataran struktural lipatan berombak-bergelombang bermaterial campuran batuan sedimen karbonat dan non karbonat",["#F9FCBB","#6E6E6E",0,0,0]],["Dataran struktural plutonik berombak-bergelombang bermaterial batuan beku dalam, 3ogSp-Ibd","Dataran struktural plutonik berombak-bergelombang bermaterial batuan beku dalam",["#E2646A","#6E6E6E",0,0,0]],["Dataran vulkanik bermaterial batuan beku luar, 3V-Ibl","Dataran vulkanik bermaterial batuan beku luar",["#FF5064","#6E6E6E",0,0,0]],["Dataran vulkanik bermaterial piroklastik, 3V-IV","Dataran vulkanik bermaterial piroklastik",["#FF5064","#6E6E6E",0,0,0]],["Dataran vulkanik berombak-bergelombang bermaterial batuan beku luar, 3ogV-Ibl","Dataran vulkanik berombak-bergelombang bermaterial batuan beku luar",["#FF5064","#6E6E6E",0,0,0]],["Dataran vulkanik berombak-bergelombang bermaterial campuran batuan beku luar dan piroklastik, 3ogV-Iblp","Dataran vulkanik berombak-bergelombang bermaterial campuran batuan beku luar dan piroklastik",["#FF5064","#6E6E6E",0,0,0]],["Dataran vulkanik berombak-bergelombang bermaterial piroklastik, 3ogV-IV","Dataran vulkanik berombak-bergelombang bermaterial piroklastik",["#FF5064","#6E6E6E",0,0,0]],["Dataran vulkanik kipas bermaterial piroklastik, 3Vkp-IV","Dataran vulkanik kipas bermaterial piroklastik",["#FF5096","#6E6E6E",0,0,0]],["Lembah sungai bermaterial aluvium, Ls-V","Lembah sungai bermaterial aluvium",["#8AA03C","#6E6E6E",0,0,0]],["Pegunungan denudasional bermaterial batuan metamorfik (ultrabasa), 1D-IIIub","Pegunungan denudasional bermaterial batuan metamorfik (ultrabasa)",["#916233",null,0,0,0]],["Pegunungan denudasional bermaterial batuan metamorfik, 1D-III","Pegunungan denudasional bermaterial batuan metamorfik",["#916233",null,0,0,0]],["Pegunungan denudasional bermaterial batuan sedimen karbonat, 1D-IIsk","Pegunungan denudasional bermaterial batuan sedimen karbonat",["#916233",null,0,0,0]],["Pegunungan denudasional bermaterial batuan sedimen non karbonat, 1D-IIsnk","Pegunungan denudasional bermaterial batuan sedimen non karbonat",["#916233",null,0,0,0]],["Pegunungan denudasional bermaterial campuran batuan beku luar dan piroklastik, 1D-Iblp","Pegunungan denudasional bermaterial campuran batuan beku luar dan piroklastik",["#916233",null,0,0,0]],["Pegunungan denudasional bermaterial campuran batuan sedimen karbonat dan non karbonat, 1D-IIcpk","Pegunungan denudasional bermaterial campuran batuan sedimen karbonat dan non karbonat",["#916233",null,0,0,0]],["Pegunungan glasial bermaterial batuan metamorfik, 1G-III","Pegunungan glasial bermaterial batuan metamorfik",["#7D7DF5","#6E6E6E",0,0,0]],["Pegunungan glasial bermaterial batuan sedimen karbonat, 1G-IIsk","Pegunungan glasial bermaterial batuan sedimen karbonat",["#7D7DF5","#6E6E6E",0,0,0]],["Pegunungan kerucut vulkanik bermaterial batuan beku luar, 1pkV-Ibl","Pegunungan kerucut vulkanik bermaterial batuan beku luar",["#D80E3E","#6E6E6E",0,0,0]],["Pegunungan kerucut vulkanik bermaterial campuran batuan beku luar dan piroklastik, 1pkV-Iblp","Pegunungan kerucut vulkanik bermaterial campuran batuan beku luar dan piroklastik",["#D80E3E","#6E6E6E",0,0,0]],["Pegunungan kerucut vulkanik bermaterial piroklastik, 1pkV-IV","Pegunungan kerucut vulkanik bermaterial piroklastik",["#D80E3E","#6E6E6E",0,0,0]],["Pegunungan kerucut vulkanik lereng atas bermaterial campuran batuan beku luar dan piroklastik, 1pkaV-Iblp","Pegunungan kerucut vulkanik lereng atas bermaterial campuran batuan beku luar dan piroklastik",["#D80E3E","#6E6E6E",0,0,0]],["Pegunungan kerucut vulkanik lereng bawah bermaterial batuan beku luar, 1pkbV-Ibl",0,["#D80E3E","#6E6E6E",0,0,0]],["Pegunungan kerucut vulkanik lereng bawah bermaterial campuran batuan beku luar dan piroklastik, 1pkbV-Iblp","Pegunungan kerucut vulkanik lereng bawah bermaterial campuran batuan beku luar dan piroklastik",["#D80E3E","#6E6E6E",0,0,0]],["Pegunungan kerucut vulkanik lereng bawah bermaterial piroklastik, 1pkbV-IV","Pegunungan kerucut vulkanik lereng bawah bermaterial piroklastik",["#D80E3E","#6E6E6E",0,0,0]],["Pegunungan kerucut vulkanik lereng puncak bermaterial campuran batuan beku luar dan piroklastik, 1pkpV-Iblp","Pegunungan kerucut vulkanik lereng puncak bermaterial campuran batuan beku luar dan piroklastik",["#D80E3E","#6E6E6E",0,0,0]],["Pegunungan kerucut vulkanik lereng tengah bermaterial campuran batuan beku luar dan piroklastik, 1pktV-Iblp","Pegunungan kerucut vulkanik lereng tengah bermaterial campuran batuan beku luar dan piroklastik",["#D80E3E","#6E6E6E",0,0,0]],["Pegunungan kerucut vulkanik lereng tengah bermaterial piroklastik, 1pktV-IV",0,["#D80E3E","#6E6E6E",0,0,0]],["Pegunungan solusional karst bermaterial batuan sedimen karbonat, 1K-IIsk","Pegunungan solusional karst bermaterial batuan sedimen karbonat",["#C5390D","#6E6E6E",0,0,0]],["Pegunungan struktural lipatan bermaterial batuan metamorfik, 1Stl-III","Pegunungan struktural lipatan bermaterial batuan metamorfik",["#870F91","#6E6E6E",0,0,0]],["Pegunungan struktural lipatan bermaterial batuan sedimen karbonat, 1Stl-IIsk","Pegunungan struktural lipatan bermaterial batuan sedimen karbonat",["#870F91","#6E6E6E",0,0,0]],["Pegunungan struktural lipatan bermaterial batuan sedimen non karbonat, 1Stl-IIsnk","Pegunungan struktural lipatan bermaterial batuan sedimen non karbonat",["#870F91","#6E6E6E",0,0,0]],["Pegunungan struktural lipatan bermaterial campuran batuan sedimen karbonat dan non karbonat, 1Stl-IIcpk","Pegunungan struktural lipatan bermaterial campuran batuan sedimen karbonat dan non karbonat",["#870F91","#6E6E6E",0,0,0]],["Pegunungan struktural patahan bermaterial batuan metamorfik, 1Stp-III","Pegunungan struktural patahan bermaterial batuan metamorfik",["#CA6CB6","#6E6E6E",0,0,0]],["Pegunungan struktural plutonik bermaterial batuan beku dalam, 1Sp-Ibd","Pegunungan struktural plutonik bermaterial batuan beku dalam",["#AA0E31","#6E6E6E",0,0,0]],["Pegunungan vulkanik bermaterial batuan beku luar, 1V-Ibl","Pegunungan vulkanik bermaterial batuan beku luar",["#DF0B0B","#6E6E6E",0,0,0]],["Pegunungan vulkanik bermaterial campuran batuan beku luar dan piroklastik, 1V-Iblp","Pegunungan vulkanik bermaterial campuran batuan beku luar dan piroklastik",["#DF0B0B","#6E6E6E",0,0,0]],["Pegunungan vulkanik bermaterial piroklastik, 1V-IV","Pegunungan vulkanik bermaterial piroklastik",["#DF0B0B","#6E6E6E",0,0,0]],["Pegunungan vulkanik lereng bawah bermaterial piroklastik, 1lbV-IV","Pegunungan vulkanik lereng bawah bermaterial piroklastik",["#DF0B0B","#6E6E6E",0,0,0]],["Perbukitan denudasional bermaterial batuan metamorfik (ultrabasa), 2D-IIIub","Perbukitan denudasional bermaterial batuan metamorfik (ultrabasa)",["#C89664",null,0,0,0]],["Perbukitan denudasional bermaterial batuan metamorfik, 2D-III","Perbukitan denudasional bermaterial batuan metamorfik",["#C89664",null,0,0,0]],["Perbukitan denudasional bermaterial batuan sedimen karbonat, 2D-IIsk","Perbukitan denudasional bermaterial batuan sedimen karbonat",["#C89664",null,0,0,0]],["Perbukitan denudasional bermaterial batuan sedimen non karbonat, 2D-IIsnk","Perbukitan denudasional bermaterial batuan sedimen non karbonat",["#C89664","#6E6E6E",0,0,0]],["Perbukitan denudasional bermaterial campuran batuan beku luar dan piroklastik, 2D-Iblp","Perbukitan denudasional bermaterial campuran batuan beku luar dan piroklastik",["#C89664","#6E6E6E",0,0,0]],["Perbukitan denudasional bermaterial campuran batuan sedimen karbonat dan non karbonat, 2D-IIcpk","Perbukitan denudasional bermaterial campuran batuan sedimen karbonat dan non karbonat",["#C89664","#6E6E6E",0,0,0]],["Perbukitan denudasional bermaterial piroklastik, 2D-IV","Perbukitan denudasional bermaterial piroklastik",["#C89664","#6E6E6E",0,0,0]],["Perbukitan glasial bermaterial batuan sedimen karbonat, 2G-IIsk","Perbukitan glasial bermaterial batuan sedimen karbonat",["#C8C8FA","#6E6E6E",0,0,0]],["Perbukitan kerucut vulkanik bermaterial batuan beku luar, 2kv-Ibl","Perbukitan kerucut vulkanik bermaterial batuan beku luar",["#E70F42","#6E6E6E",0,0,0]],["Perbukitan kerucut vulkanik bermaterial campuran batuan beku luar dan piroklastik, 2kv-Iblp","Perbukitan kerucut vulkanik bermaterial campuran batuan beku luar dan piroklastik",["#E70F42","#6E6E6E",0,0,0]],["Perbukitan kerucut vulkanik bermaterial piroklastik, 2kv-IV","Perbukitan kerucut vulkanik bermaterial piroklastik",["#E70F42","#6E6E6E",0,0,0]],["Perbukitan kerucut vulkanik parasiter bermaterial batuan beku luar, 2kpV-Ibl","Perbukitan kerucut vulkanik parasiter bermaterial batuan beku luar",["#E70F42","#6E6E6E",0,0,0]],["Perbukitan kerucut vulkanik parasiter bermaterial campuran batuan beku luar dan piroklastik, 2kpV-Iblp","Perbukitan kerucut vulkanik parasiter bermaterial campuran batuan beku luar dan piroklastik",["#E70F42","#6E6E6E",0,0,0]],["Perbukitan solusional karst bermaterial batuan sedimen karbonat, 2K-IIsk","Perbukitan solusional karst bermaterial batuan sedimen karbonat",["#F05018","#6E6E6E",0,0,0]],["Perbukitan struktural lipatan bermaterial batuan metamorfik, 2Stl-III","Perbukitan struktural lipatan bermaterial batuan metamorfik",["#D214DC","#6E6E6E",0,0,0]],["Perbukitan struktural lipatan bermaterial batuan sedimen karbonat, 2Stl-IIsk","Perbukitan struktural lipatan bermaterial batuan sedimen karbonat",["#D214DC","#6E6E6E",0,0,0]],["Perbukitan struktural lipatan bermaterial batuan sedimen non karbonat, 2Stl-IIsnk","Perbukitan struktural lipatan bermaterial batuan sedimen non karbonat",["#D214DC","#6E6E6E",0,0,0]],["Perbukitan struktural lipatan bermaterial campuran batuan sedimen karbonat dan non karbonat, 2Stl-IIcpk","Perbukitan struktural lipatan bermaterial campuran batuan sedimen karbonat dan non karbonat",["#D214DC","#6E6E6E",0,0,0]],["Perbukitan struktural patahan bermaterial batuan metamorfik, 2Stp-III","Perbukitan struktural patahan bermaterial batuan metamorfik",["#F08CF5","#6E6E6E",0,0,0]],["Perbukitan struktural plutonik bermaterial batuan beku dalam, 2Sp-Ibd","Perbukitan struktural plutonik bermaterial batuan beku dalam",["#CA0A57","#6E6E6E",0,0,0]],["Perbukitan vulkanik bermaterial batuan beku luar, 2V-Ibl","Perbukitan vulkanik bermaterial batuan beku luar",["#FF213B","#6E6E6E",0,0,0]],["Perbukitan vulkanik bermaterial campuran batuan beku luar dan piroklastik, 2V-Iblp","Perbukitan vulkanik bermaterial campuran batuan beku luar dan piroklastik",["#FF213B","#6E6E6E",0,0,0]],["Perbukitan vulkanik bermaterial piroklastik, 2V-IV","Perbukitan vulkanik bermaterial piroklastik",["#FF213B","#6E6E6E",0,0,0]],["Perbukitan vulkanik kubah lava bermaterial batuan beku luar, 2klV-Ibl","Perbukitan vulkanik kubah lava bermaterial batuan beku luar",["#FF213B","#6E6E6E",0,0,0]],["Perbukitan vulkanik lereng bawah bermaterial piroklastik, 2lbV-IV","Perbukitan vulkanik lereng bawah bermaterial piroklastik",["#FF213B","#6E6E6E",0,0,0]],["Perbukitan vulkanik lereng tengah bermaterial piroklastik, 2ltV-IV","Perbukitan vulkanik lereng tengah bermaterial piroklastik",["#FF213B","#6E6E6E",0,0,0]],["Tebing kaldera bermaterial campuran batuan beku luar dan piroklastik, 1tk-Iblp","Tebing kaldera bermaterial campuran batuan beku luar dan piroklastik",["#DF0B0B","#6E6E6E",0,0,0]]]],["PKTL","PDLKWS","KBA_AR_500K","polygon","NAMA",null,[["Danau",0,["#73B2FF",null,0.04,0,0]],["Dataran Fluvial Bali Nusa Tenggara",0,["#BEE8FF",null,0.04,0,0]],["Dataran Fluvial Jawa",0,["#BEE8FF",null,0.04,0,0]],["Dataran Fluvial Kalimantan",0,["#BEE8FF",null,0.04,0,0]],["Dataran Fluvial Maluku",0,["#BEE8FF",null,0.04,0,0]],["Dataran Fluvial Memberamo",0,["#BEE8FF",null,0.04,0,0]],["Dataran Fluvial Nabire - Sarmi",0,["#BEE8FF",null,0.04,0,0]],["Dataran Fluvial Seget - Bintuni",0,["#BEE8FF",null,0.04,0,0]],["Dataran Fluvial Sulawesi",0,["#BEE8FF",null,0.04,0,0]],["Dataran Fluvial Sumatera",0,["#BEE8FF",null,0.04,0,0]],["Dataran Gambut Kokonao - Digul",0,["#A3FF73",null,0.04,0,0]],["Dataran Gambut Kompleks Kahayan - Kapuas - Mahakam",0,["#A3FF73",null,0.04,0,0]],["Dataran Gambut Memberamo",0,["#A3FF73",null,0.04,0,0]],["Dataran Gambut Nabire - Sarmi",0,["#A3FF73",null,0.04,0,0]],["Dataran Gambut Seget - Bintuni",0,["#A3FF73",null,0.04,0,0]],["Dataran Gambut Sumatera",0,["#A3FF73",null,0.04,0,0]],["Dataran Karst Maluku",0,["#E1E1E1",null,0.04,0,0]],["Dataran Organik/Koral Bali Nusa Tenggara",0,["#D3FFBE",null,0.04,0,0]],["Dataran Organik/Koral Jawa",0,["#D3FFBE",null,0.04,0,0]],["Dataran Organik/Koral Kompleks Sorong",0,["#D3FFBE",null,0.04,0,0]],["Dataran Pantai Bali Nusa Tenggara",0,["#00C5FF",null,0.04,0,0]],["Dataran Pantai Barat Papua",0,["#00C5FF",null,0.04,0,0]],["Dataran Pantai Kalimantan",0,["#00C5FF",null,0.04,0,0]],["Dataran Pantai Maluku",0,["#00C5FF",null,0.04,0,0]],["Dataran Pantai Selatan Jawa",0,["#00C5FF",null,0.04,0,0]],["Dataran Pantai Selatan Papua",0,["#00C5FF",null,0.04,0,0]],["Dataran Pantai Sulawesi",0,["#00C5FF",null,0.04,0,0]],["Dataran Pantai Timur Sumatera",0,["#00C5FF",null,0.04,0,0]],["Dataran Pantai Utara Jawa",0,["#00C5FF",null,0.04,0,0]],["Dataran Pantai Utara Papua",0,["#00C5FF",null,0.04,0,0]],["Dataran Struktural Blok Selatan Jawa",0,["#E8BEFF",null,0.04,0,0]],["Dataran Struktural Jalur Bogor - Kendeng - Rembang",0,["#E8BEFF",null,0.04,0,0]],["Dataran Struktural Jalur Bukit Barisan",0,["#E8BEFF",null,0.04,0,0]],["Dataran Struktural Jalur Jayawijaya",0,["#E8BEFF",null,0.04,0,0]],["Dataran Struktural Jalur Utara",0,["#E8BEFF",null,0.04,0,0]],["Dataran Struktural Kompleks Meratus",0,["#E8BEFF",null,0.04,0,0]],["Dataran Struktural Maluku",0,["#E8BEFF",null,0.04,0,0]],["Dataran Vulkanik Bali Nusa Tenggara",0,["#F6D9DF",null,0.04,0,0]],["Dataran Vulkanik Jalur Bukit Barisan",0,["#F6D9DF",null,0.04,0,0]],["Dataran Vulkanik Jalur Gunung Karang - Merapi - Raung",0,["#F6D9DF",null,0.04,0,0]],["Dataran Vulkanik Maluku",0,["#F6D9DF",null,0.04,0,0]],["Pegunungan Denudasional Bali Nusa Tenggara",0,["#FFEBAF",null,0.14,0,0]],["Pegunungan Denudasional Kalimantan",0,["#FFEBAF",null,0.14,0,0]],["Pegunungan Denudasional Maluku",0,["#FFEBAF",null,0.14,0,0]],["Pegunungan Glasial Puncak Jaya",0,["#686868",null,0.04,0,0]],["Pegunungan Intrusif Batuan Beku Tua Kalimantan",0,["#BD4464","#6E6E6E",0.14,0,0]],["Pegunungan Struktural Bali Nusa Tenggara",0,["#AA66CD",null,0.04,0,0]],["Pegunungan Struktural Blok Selatan Jawa",0,["#AA66CD",null,0.04,0,0]],["Pegunungan Struktural Jalur Bogor - Kendeng - Rembang",0,["#AA66CD",null,0.04,0,0]],["Pegunungan Struktural Jalur Bukit Barisan",0,["#AA66CD",null,0.04,0,0]],["Pegunungan Struktural Jalur Jayawijaya",0,["#AA66CD",null,0.04,0,0]],["Pegunungan Struktural Jalur Utara",0,["#AA66CD",null,0.04,0,0]],["Pegunungan Struktural Kompleks Meratus",0,["#AA66CD",null,0.04,0,0]],["Pegunungan Struktural Maluku",0,["#AA66CD",null,0.04,0,0]],["Pegunungan Struktural Sulawesi",0,["#AA66CD",null,0.04,0,0]],["Pegunungan Vulkanik Bali Nusa Tenggara",0,["#FF7F7F",null,0.04,0,0]],["Pegunungan Vulkanik Jalur Bukit Barisan",0,["#FF7F7F",null,0.04,0,0]],["Pegunungan Vulkanik Jalur Gunung Karang - Merapi - Raung",0,["#FF7F7F",null,0.04,0,0]],["Pegunungan Vulkanik Maluku",0,["#FF7F7F",null,0.04,0,0]],["Pegunungan Vulkanik Sulawesi",0,["#FF7F7F",null,0.04,0,0]],["Perbukitan Denudasional Bali Nusa Tenggara",0,["#FFD37F",null,0.04,0,0]],["Perbukitan Denudasional Jawa",0,["#FFD37F",null,0.04,0,0]],["Perbukitan Denudasional Kalimantan",0,["#FFD37F",null,0.04,0,0]],["Perbukitan Denudasional Kompleks Bangka Belitung - Natuna",0,["#FFD37F",null,0.04,0,0]],["Perbukitan Denudasional Maluku",0,["#FFD37F",null,0.04,0,0]],["Perbukitan Denudasional Sulawesi",0,["#FFD37F",null,0.04,0,0]],["Perbukitan Karst Bali Nusa Tenggara",0,["#B2B2B2",null,0.04,0,0]],["Perbukitan Karst Jalur Bogor - Kendeng - Rembang",0,["#B2B2B2",null,0.04,0,0]],["Perbukitan Karst Jalur Pangandaran - Karangbolong - Gunungsewu - Blambangan",0,["#B2B2B2",null,0.04,0,0]],["Perbukitan Karst Kalimantan",0,["#B2B2B2",null,0.04,0,0]],["Perbukitan Karst Maluku",0,["#B2B2B2",null,0.04,0,0]],["Perbukitan Karst Papua",0,["#B2B2B2",null,0.04,0,0]],["Perbukitan Karst Sulawesi",0,["#B2B2B2",null,0.04,0,0]],["Perbukitan Karst Sumatera",0,["#B2B2B2",null,0.04,0,0]],["Perbukitan Struktural Bali Nusa Tenggara",0,["#CA7AF5",null,0.04,0,0]],["Perbukitan Struktural Blok Selatan Jawa",0,["#CA7AF5",null,0.04,0,0]],["Perbukitan Struktural Jalur Bogor - Kendeng - Rembang",0,["#CA7AF5",null,0.04,0,0]],["Perbukitan Struktural Jalur Bukit Barisan",0,["#CA7AF5",null,0.04,0,0]],["Perbukitan Struktural Jalur Jayawijaya",0,["#CA7AF5",null,0.04,0,0]],["Perbukitan Struktural Jalur Utara",0,["#CA7AF5",null,0.04,0,0]],["Perbukitan Struktural Kompleks Kepulauan Riau",0,["#CA7AF5",null,0.04,0,0]],["Perbukitan Struktural Kompleks Mentawai",0,["#CA7AF5",null,0.04,0,0]],["Perbukitan Struktural Kompleks Meratus",0,["#CA7AF5",null,0.04,0,0]],["Perbukitan Struktural Maluku",0,["#CA7AF5",null,0.04,0,0]],["Perbukitan Struktural Sulawesi",0,["#CA7AF5",null,0.04,0,0]],["Perbukitan Vulkanik Bali Nusa Tenggara",0,["#FFBEBE",null,0.04,0,0]],["Perbukitan Vulkanik Jalur Bukit Barisan",0,["#FFBEBE",null,0.04,0,0]],["Perbukitan Vulkanik Jalur Gunung Karang - Merapi - Raung",0,["#FFBEBE",null,0.04,0,0]],["Perbukitan Vulkanik Maluku",0,["#FFBEBE",null,0.04,0,0]],["Perbukitan Vulkanik Sulawesi",0,["#FFBEBE",null,0.04,0,0]]]],["PKTL","PDLKWS","KVA_AR_250K","polygon","KVA_250",null,[["Vegetasi hutan batuan ultrabasa",0,["#FF96FF","#6E6E6E",0,0,0]],["Vegetasi hutan batuan ultrabasa pamah",0,["#FF96FF","#6E6E6E",0,0,0]],["Vegetasi hutan batuan ultrabasa pamah monsun",0,["#FF96FF","#6E6E6E",0,0,0]],["Vegetasi hutan batuan ultrabasa pamah monsun malar hijau",0,["#FF96FF","#6E6E6E",0,0,0]],["Vegetasi hutan batuan ultrabasa pamah monsun merangas",0,["#FF96FF","#6E6E6E",0,0,0]],["Vegetasi hutan batuan ultrabasa pegunungan",0,["#FF96FF","#6E6E6E",0,0,0]],["Vegetasi hutan batuan ultrabasa pegunungan alpin",0,["#FF96FF","#6E6E6E",0,0,0]],["Vegetasi hutan batuan ultrabasa pegunungan alpin monsun",0,["#FF96FF","#6E6E6E",0,0,0]],["Vegetasi hutan batuan ultrabasa pegunungan atas",0,["#FF96FF","#6E6E6E",0,0,0]],["Vegetasi hutan batuan ultrabasa pegunungan atas monsun",0,["#FF96FF","#6E6E6E",0,0,0]],["Vegetasi hutan batuan ultrabasa pegunungan bawah",0,["#FF96FF","#6E6E6E",0,0,0]],["Vegetasi hutan batuan ultrabasa pegunungan bawah monsun",0,["#FF96FF","#6E6E6E",0,0,0]],["Vegetasi hutan batuan ultrabasa pegunungan subalpin",0,["#FF96FF","#6E6E6E",0,0,0]],["Vegetasi hutan batuan ultrabasa pegunungan subalpin monsun",0,["#FF96FF","#6E6E6E",0,0,0]],["Vegetasi hutan batugamping monsun pamah pada bentang alam karst",0,["#FFD2FF","#6E6E6E",0,1,0]],["Vegetasi hutan batugamping monsun pegunungan atas pada bentang alam karst",0,["#FFD2FF","#6E6E6E",0,1,0]],["Vegetasi hutan batugamping monsun pegunungan bawah pada bentang alam karst",0,["#FFD2FF","#6E6E6E",0,1,0]],["Vegetasi hutan batugamping monsun pegunungan pada bentang alam karst",0,["#FFD2FF","#6E6E6E",0,1,0]],["Vegetasi hutan batugamping monsun pegunungan subalpin pada bentang alam karst",0,["#FFD2FF","#6E6E6E",0,1,0]],["Vegetasi hutan batugamping pamah",0,["#FFD2FF","#6E6E6E",0,0,0]],["Vegetasi hutan batugamping pamah monsun",0,["#FFD2FF","#6E6E6E",0,0,0]],["Vegetasi hutan batugamping pamah monsun malar hijau",0,["#FFD2FF","#6E6E6E",0,0,0]],["Vegetasi hutan batugamping pamah monsun merangas",0,["#FFD2FF","#6E6E6E",0,0,0]],["Vegetasi hutan batugamping pamah monsun merangas pada bentang alam karst",0,["#FFD2FF","#6E6E6E",0,1,0]],["Vegetasi hutan batugamping pamah pada bentang alam karst",0,["#FFD2FF","#6E6E6E",0,1,0]],["Vegetasi hutan batugamping pegunungan alpin",0,["#FFD2FF","#6E6E6E",0,0,0]],["Vegetasi hutan batugamping pegunungan alpin monsun",0,["#FFD2FF","#6E6E6E",0,0,0]],["Vegetasi hutan batugamping pegunungan atas",0,["#FFD2FF","#6E6E6E",0,0,0]],["Vegetasi hutan batugamping pegunungan atas monsun",0,["#FFD2FF","#6E6E6E",0,0,0]],["Vegetasi hutan batugamping pegunungan atas pada bentang alam karst",0,["#FFD2FF","#6E6E6E",0,1,0]],["Vegetasi hutan batugamping pegunungan bawah",0,["#FFD2FF","#6E6E6E",0,0,0]],["Vegetasi hutan batugamping pegunungan bawah monsun",0,["#FFD2FF","#6E6E6E",0,0,0]],["Vegetasi hutan batugamping pegunungan bawah pada bentang alam karst",0,["#FFD2FF","#6E6E6E",0,1,0]],["Vegetasi hutan batugamping pegunungan pada bentang alam karst",0,["#FFD2FF","#6E6E6E",0,1,0]],["Vegetasi hutan batugamping pegunungan subalpin",0,["#FFD2FF","#6E6E6E",0,0,0]],["Vegetasi hutan batugamping pegunungan subalpin monsun",0,["#FFD2FF","#6E6E6E",0,0,0]],["Vegetasi hutan batugamping pegunungan subalpin pada bentang alam karst",0,["#FFD2FF","#6E6E6E",0,1,0]],["Vegetasi hutan danau",0,["#267300","#6E6E6E",0,0,0]],["Vegetasi hutan danau gambut",0,["#267300","#6E6E6E",0,0,0]],["Vegetasi hutan danau gambut pegunungan",0,["#267300","#6E6E6E",0,0,0]],["Vegetasi hutan dipterokarpa pamah",0,["#66C2A4","#6E6E6E",0,0,0]],["Vegetasi hutan dipterokarpa pamah\r\nVegetasi hutan dipterokarpa pamah\r\n",0,["#66C2A4","#6E6E6E",0,0,0]],["Vegetasi hutan gambut",0,["#A80000","#6E6E6E",0,0,0]],["Vegetasi hutan kerangas pamah",0,["#FCF4A3","#6E6E6E",0,0,0]],["Vegetasi hutan kerangas pamah monsun",0,["#FCF4A3","#6E6E6E",0,0,0]],["Vegetasi hutan monsun tepian sungai malar hijau",0,["#267300","#6E6E6E",0,0,0]],["Vegetasi hutan pamah (non dipterokarpa)",0,["#A1D99B","#6E6E6E",0,0,0]],["Vegetasi hutan pamah monsun malar hijau",0,["#267300","#6E6E6E",0,0,0]],["Vegetasi hutan pamah monsun merangas",0,["#267300","#6E6E6E",0,0,0]],["Vegetasi hutan pantai",0,["#267300","#6E6E6E",0,0,0]],["Vegetasi hutan pantai monsun",0,["#267300","#6E6E6E",0,0,0]],["Vegetasi hutan pegunungan atas",0,["#267300","#6E6E6E",0,0,0]],["Vegetasi hutan pegunungan atas monsun",0,["#267300","#6E6E6E",0,0,0]],["Vegetasi hutan pegunungan bawah",0,["#267300","#6E6E6E",0,0,0]],["Vegetasi hutan pegunungan bawah monsun (monsoon lower mountain forest)",0,["#267300","#6E6E6E",0,0,0]],["Vegetasi hutan pegunungan meranggas pada bukit tinggi (deciduous forest on higher hills)",0,["#267300","#6E6E6E",0,0,0]],["Vegetasi hutan pegunungan subalpin",0,["#267300","#6E6E6E",0,0,0]],["Vegetasi hutan pegunungan subalpin monsun",0,["#267300","#6E6E6E",0,0,0]],["Vegetasi hutan rawa air payau",0,["#267300","#6E6E6E",0,0,0]],["Vegetasi hutan rawa air payau monsun pada bentang alam karst",0,["#267300","#6E6E6E",0,1,0]],["Vegetasi hutan rawa air payau pada bentang alam karst",0,["#267300","#6E6E6E",0,1,0]],["Vegetasi hutan rawa air tawar",0,["#267300","#6E6E6E",0,0,0]],["Vegetasi hutan rawa air tawar monsun",0,["#267300","#6E6E6E",0,0,0]],["Vegetasi hutan rawa air tawar monsun pada bentang alam karst",0,["#267300","#6E6E6E",0,1,0]],["Vegetasi hutan rawa air tawar pada bentang alam karst",0,["#267300","#6E6E6E",0,1,0]],["Vegetasi hutan savana sekitar danau",0,["#DDFF00","#6E6E6E",0,0,0]],["Vegetasi hutan tepian sungai",0,["#267300","#6E6E6E",0,0,0]],["Vegetasi hutan tepian sungai malar hijau",0,["#267300","#6E6E6E",0,0,0]],["Vegetasi hutan tepian sungai payau",0,["#267300","#6E6E6E",0,0,0]],["Vegetasi hutan terna rawa air tawar",0,["#D3A032","#6E6E6E",0,0,0]],["Vegetasi litoral",0,["#9BC2E6","#6E6E6E",0,0,0]],["Vegetasi mangrove",0,["#86C400","#86C400",0,1,0]],["Vegetasi mangrove monsun",0,["#86C400","#86C400",0,1,0]],["Vegetasi nipah",0,["#D3FFBE","#6E6E6E",0,0,0]],["Vegetasi nipah monsun",0,["#D3FFBE","#6E6E6E",0,0,0]],["Vegetasi padang rumput lahan kering pamah",0,["#FFA500","#6E6E6E",0,0,0]],["Vegetasi padang rumput monsun pamah",0,["#FFA500","#6E6E6E",0,0,0]],["Vegetasi padang rumput monsun pegunungan",0,["#FFA500","#6E6E6E",0,0,0]],["Vegetasi padang rumput rawa air payau",0,["#FFA500","#6E6E6E",0,0,0]],["Vegetasi padang rumput rawa air payau monsun",0,["#FFA500","#6E6E6E",0,0,0]],["Vegetasi padang rumput rawa air tawar",0,["#FFA500","#6E6E6E",0,0,0]],["Vegetasi padang rumput rawa air tawar monsun",0,["#FFA500","#6E6E6E",0,0,0]],["Vegetasi padang rumput rawa gambut pamah",0,["#FFA500","#6E6E6E",0,0,0]],["Vegetasi padang rumput tepian sungai payau",0,["#FFA500","#6E6E6E",0,0,0]],["Vegetasi sagu",0,["#D3FFBE","#6E6E6E",0,0,0]],["Vegetasi sagu monsun",0,["#D3FFBE","#6E6E6E",0,0,0]],["Vegetasi salju batugamping pegunungan alpin",0,["#B2B2B2","#6E6E6E",0,0,0]],["Vegetasi salju batugamping pegunungan alpin monsun",0,["#B2B2B2","#6E6E6E",0,0,0]],["Vegetasi savana lahan kering pamah",0,["#DDFF00","#6E6E6E",0,0,0]],["Vegetasi savana monsun pamah",0,["#DDFF00","#6E6E6E",0,0,0]],["Vegetasi savana pegunungan monsun",0,["#DDFF00","#6E6E6E",0,0,0]],["Vegetasi savana rawa air payau",0,["#DDFF00","#6E6E6E",0,0,0]],["Vegetasi savana rawa air tawar",0,["#DDFF00","#6E6E6E",0,0,0]],["Vegetasi savana rawa gambut pamah",0,["#DDFF00","#6E6E6E",0,0,0]],["Vegetasi terna danau gambut pegunungan",0,["#D3A032","#6E6E6E",0,0,0]],["Vegetasi terna rawa air payau",0,["#D3A032","#6E6E6E",0,0,0]],["Vegetasi terna rawa air payau monsun pada bentang alam karst",0,["#D3A032","#6E6E6E",0,1,0]],["Vegetasi terna rawa air payau pada bentang alam karst",0,["#D3A032","#6E6E6E",0,1,0]],["Vegetasi terna rawa air tawar",0,["#D3A032","#6E6E6E",0,0,0]],["Vegetasi terna rawa air tawar monsun",0,["#D3A032","#6E6E6E",0,0,0]],["Vegetasi terna rawa air tawar monsun pada bentang alam karst",0,["#D3A032","#6E6E6E",0,1,0]],["Vegetasi terna rawa air tawar pada bentang alam karst",0,["#D3A032","#6E6E6E",0,1,0]],["Vegetasi terna rawa gambut",0,["#D3A032","#6E6E6E",0,0,0]],["Vegetasi terna rawa monsun",0,["#D3A032","#6E6E6E",0,0,0]],["Vegetasi terna rawa payau monsun",0,["#D3A032","#6E6E6E",0,0,0]],["Vegetasi terna savana rawa gambut",0,["#D3BE78","#6E6E6E",0,0,0]],["Vegetasi terna tepian danau",0,["#D3A032","#6E6E6E",0,0,0]],["Vegetasi terna tepian danau pegunungan",0,["#D3A032","#6E6E6E",0,0,0]],["Vegetasi terna tepian sungai",0,["#D3A032","#6E6E6E",0,0,0]],["Vegetasi terna tepian sungai payau",0,["#D3A032","#6E6E6E",0,0,0]]]],["PKTL","PDLUK","Batas Biologi","polygon","",[null,"#FFCD78",0.71,0,0],[]],["PKTL","PDLUK","Batas Ekologi","polygon","",[null,"#A87000",0.71,0,0],[]],["PKTL","PDLUK","Batas Geofisik Kimia","polygon","",[null,"#EBDF00",0.71,0,0],[]],["PKTL","PDLUK","Batas Kesehatan Masyarakat","polygon","",[null,"#00C5FF",0.71,0,0],[]],["PKTL","PDLUK","Batas Sosial Ekonomi Budaya","polygon","",[null,"#73B2FF",0.71,0,0],[]],["PKTL","PDLUK","Batas Sosial","polygon","",[null,"#004C73",0.71,0,0],[]],["PKTL","PDLUK","Batas Wilayah Studi","polygon","",[null,"#FF00FF",0.71,0,0],[]],["PKTL","PDLUK","Lokasi Pemantauan Amdal Addendum","polygon","",[null,"#98E600",0.71,0,0],[]],["PKTL","PDLUK","Lokasi Pemantauan UKL-UPL","polygon","",[null,"#8400A8",0.71,0,0],[]],["PKTL","PDLUK","Lokasi Pengelolaan Amdal Addendum","polygon","",["#FF0000","#FF0000",0.14,1,0],[]],["PKTL","PDLUK","Lokasi Pengelolaan UKL-UPL","polygon","",[null,"#A87000",0.71,0,0],[]],["PKTL","PDLUK","Tapak Proyek Addendum","polygon","",["#734C00","#734C00",0.14,1,0],[]],["PKTL","PDLUK","Tapak Proyek Amdal","polygon","",[null,"#C80000",0.71,0,0],[]],["PKTL","PDLUK","Tapak Proyek UKL-UPL","polygon","",["#E64C00","#E64C00",0.14,1,0],[]],["PKTL","PDLUK","Titik Pemantauan Amdal Addendum","polygon","",["#FF0000",null,0,0,4.23],[]],["PKTL","PDLUK","Titik Pemantauan UKL-UPL","polygon","",["#00A9E6",null,0,0,4.23],[]],["PKTL","PDLUK","Titik Pengelolaan Amdal Addendum","polygon","",["#000000",null,0,0,6.35],[]],["PKTL","PDLUK","Titik Pengelolaan UKL-UPL","polygon","",["#FF00C5",null,0,0,6.35],[]],["PKTL","PDLUK","Titik Tapak Proyek Addendum","polygon","",["#734C00",null,0,0,6.35],[]],["PKTL","PDLUK","Titik Tapak Proyek Amdal","polygon","",["#C80000",null,0,0,6.35],[]],["PKTL","PDLUK","Titik Tapak Proyek UKL-UPL","polygon","",["#4C0073",null,0,0,6.35],[]],["PKTL","PPKH","KWSHUTAN_AR_250K","polygon","FUNGSIKWS",null,[["0",0,[null,null,0.14,0,0]],["100000",0,["#AD3FFF",null,0.14,0,0]],["100100",0,["#00AD00",null,0.14,0,0]],["100200",0,["#AD3FFF",null,0.14,0,0]],["100201",0,[null,"#C500FF",0.42,0,0]],["100210",0,["#AD3FFF",null,0.14,0,0]],["100211",0,[null,"#C500FF",0.42,0,0]],["100220",0,["#AD3FFF",null,0.14,0,0]],["100221",0,[null,"#C500FF",0.42,0,0]],["100230",0,["#AD3FFF",null,0.14,0,0]],["100240",0,["#AD3FFF",null,0.14,0,0]],["100241",0,[null,"#C500FF",0.42,0,0]],["100250",0,["#AD3FFF",null,0.14,0,0]],["100251",0,[null,"#C500FF",0.42,0,0]],["100260",0,["#AD3FFF",null,0.14,0,0]],["100300",0,["#FFFF00",null,0.14,0,0]],["100400",0,["#8AF200",null,0.14,0,0]],["100500",0,["#FF5EFF",null,0.14,0,0]],["100700",0,["#FFFFFF","#FFFFFF",0.14,0,0]],["500100",0,["#CCFFFF",null,0.14,0,0]],["500300",0,["#CCFFFF",null,0.14,0,0]]]],["PKTL","PPKH","PLSKWSHUTAN_AR_50K","polygon","jnspls",null,[["1","Kebun",["#E69800","#E69800",0.35,1,0]],["2","Transmigrasi",["#005CE6","#000000",0,1,0]]]],["PKTL","PPKH","PNTPNKWSHUTAN_AR_50K","polygon","fungsitap",null,[["100000,100200,100210,100220,100230,100240,100250,100260","Kawasan Konservasi",["#C500FF",null,0.14,0,0]],["100201,100211,100221,100241,100251","Kawasan Konservasi Laut",[null,"#AD3FFF",0.42,0,0]],["100100","Hutan Lindung",["#00AD00",null,0.14,0,0]],["100300","Hutan Produksi Tetap",["#FFFF00",null,0.14,0,0]],["100400","Hutan Produksi Terbatas",["#8AF200",null,0.14,0,0]],["100500","Hutan Produksi yang dapat di Konversi",["#FF5EFF",null,0.14,0,0]],["100700","Area Penggunaan Lain",["#FFFFFF",null,0.35,0,0]],["500100,500300","Tubuh Air",["#CCFFFF",null,0.14,0,0]],["0","Tidak Terdefinisi",["#FF0000",null,0.35,0,0]]]],["PKTL","PPKH","PPTPKH_AR_250K","polygon","KRITERIA_PPTPKH",null,[["Alokasi TORA dari 20% Pelepasan Kawasan Hutan untuk perkebunan",0,["#38A800","#000000",0,1,0]],["Kawasan HPK tidak produktif",0,["#FFBEE8","#FFBEE8",0.14,0,0]],["Lahan Garapan pertanian, perkebunan dan tambak",0,["#FFAA00","#FF0000",0,0,0]],["Permukiman transmigrasi beserta fasilitas sosial dan fasilitas umum yang sudah memperoleh persetujuan prinsip Pelepasan Kawasan Hutan untuk transmigrasi",0,["#730000","#6E6E6E",0,0,0]],["Permukiman, fasilitas sosial dan fasilitas umum",0,["#FF5500","#6E6E6E",0,0,0]],["Program pemerintah untuk pencadangan sawah baru",0,["#005CE6","#6E6E6E",0,0,0]]]],["PKTL","PPKH","REKALKULASIBTSKWSHUTAN_LN_50K","polygon","",null,[]],["PKTL","RPKHPWPH","KHDPK_AR_50K","polygon","",[null,"#E64C00",0.35,0,0],[]],["PKTL","RPKHPWPH","KHDTK_AR_50K","polygon","",[null,"#A8A800",0.35,0,0],[]],["PKTL","RPKHPWPH","KHKP_AR_50K","polygon","",["#C9D900","#6E6E6E",0.35,0,0],[]],["PKTL","RPKHPWPH","KPHP_KPHL_KPHK_AR_250K","polygon","JENIS_KPH",null,[["3000","KPH Konservasi",["#C389FE","#DF73FF",0.04,1,0]],["2000","KPH Lindung",["#7BFB00","#55FF00",0.04,1,0]],["1000","KPH Produksi",["#FEFEAA","#FFFF73",0.04,1,0]]]],["PKTL","RPKHPWPH","PERUM_AR_50K","polygon","",[null,"#267300",0.35,0,0],[]],["PKTL","RPKHPWPH","PIAPS_REV_VII_AR_250K","polygon","KETERANGAN",null,[["Pencadangan",0,["#000000","#000000",0.14,1,0]],["Potensi",0,["#000000","#000000",0.14,1,0]]]],["PKTL","RPKHPWPH","PKSPKH_AR_50K","polygon","",["#FF50C8","#FF50C8",0.71,1,0],[]],["PKTL","RPKHPWPH","PPKH_AR_50K","polygon","",[null,"#FF50C8",0.35,0,0],[]],["PKTL","RPKHPWPH","PPKH_EKSPLORASI_AR_50K","polygon","",[null,"#FF50C8",0.35,0,0],[]],["PKTL","RPKHPWPH","PPKSPKH_AR_50K","polygon","",[null,"#FF50C8",0.71,0,0],[]],["PKTL","RPKHPWPH","RKTN_AR_250K","polygon","rktn",null,[["Arahan Konservasi,Arahan untuk Konservasi,Ärahan Untuk Konservasi","Kawasan Konservasi",["#C500FF",null,0.14,0,0]],["Arahan HA & Gambut,Arahan HA dan Gambut,Ärahan HA dan gambut","Kawasan Hutan Alam dan Gambut",["#267300",null,0.04,0,0]],["Arahan Rehabilitasi,Arahan untuk Rehabilitasi,Ärahan Untuk Rehabilitasi","Kawasan Untuk Rehabilitasi",["#FFFF00",null,0.14,0,0]],["Arahan Usaha Skala Besar,Arahan Usaha Skala Besari,Ärahan Usaha Skala Besar*","Kawasan Pengusahaan Skala Besar (HA/HT)",["#7BFB00",null,0.04,0,0]],["Arahan Usaha Skala Kecil,Ärahan Usaha Skala Kecil","Kawasan Pengusahaan Skala Kecil (Masyarakat)",["#FF5500",null,0.14,0,0]],["Arahan Non Kehutanan","Kawasan Untuk Non Kehutanan",["#FFFFFF",null,0.04,0,0]]]],["PHLHK","PSLH","PSLH_LUAR_PENGADILAN_PNT_50K ","point","Tipologi",null,[["Kerusakan",0,["#FF0000",null,0,0,6.35]],["Pencemaran",0,["#0070FF",null,0,0,6.35]],["Pencemaran Kerusakan",0,["#FFFF00",null,0,0,6.35]]]],["PHLHK","PSLH","PSLH_MELALUI_PENGADILAN_PNT_50K ","point","Tipologi",null,[["Kerusakan",0,["#FF0000",null,0,0,6.35]],["Pencemaran",0,["#0070FF",null,0,0,6.35]],["Pencemaran Kerusakan",0,["#FFFF00",null,0,0,6.35]]]],["TIM KERJA INDONESIA_S FOLU NET SINK 2030","","LOK_PRIORITAS_FOLU_2030_AR_250K","polygon","RO12",null,[["1,2","1; 2",["#FF0000",null,0.04,0,0]]]],["TIM KERJA INDONESIA_S FOLU NET SINK 2030","","LOK_PRIORITAS_FOLU_2030_AR_250K","polygon","RO11",null,[["1",0,["#734C00",null,0.04,0,0]]]],["TIM KERJA INDONESIA_S FOLU NET SINK 2030","","LOK_PRIORITAS_FOLU_2030_AR_250K","polygon","RO10",null,[["1,2,3,4","1; 2; 3; 4",["#F57AB6",null,0.04,0,0]]]],["TIM KERJA INDONESIA_S FOLU NET SINK 2030","","LOK_PRIORITAS_FOLU_2030_AR_250K","polygon","RO9",null,[["1,2","1; 2",["#005CE6",null,0.04,0,0]]]],["TIM KERJA INDONESIA_S FOLU NET SINK 2030","","LOK_PRIORITAS_FOLU_2030_AR_250K","polygon","RO8",null,[["1,2,3,4,5,6","1; 2; 3; 4; 5; 6",["#DF73FF",null,0.04,0,0]]]],["TIM KERJA INDONESIA_S FOLU NET SINK 2030","","LOK_PRIORITAS_FOLU_2030_AR_250K","polygon","RO7",null,[["1,2,3,4","1; 2; 3; 4",["#FFBEBE","#6E6E6E",0,0,0]]]],["TIM KERJA INDONESIA_S FOLU NET SINK 2030","","LOK_PRIORITAS_FOLU_2030_AR_250K","polygon","RO6",null,[["1",0,["#D1FF73",null,0.04,0,0]]]],["TIM KERJA INDONESIA_S FOLU NET SINK 2030","","LOK_PRIORITAS_FOLU_2030_AR_250K","polygon","RO5",null,[["1,2","1; 2",["#FFD37F",null,0,0,0]]]],["TIM KERJA INDONESIA_S FOLU NET SINK 2030","","LOK_PRIORITAS_FOLU_2030_AR_250K","polygon","RO4",null,[["1",0,["#73FFDF",null,0.04,0,0]]]],["TIM KERJA INDONESIA_S FOLU NET SINK 2030","","LOK_PRIORITAS_FOLU_2030_AR_250K","polygon","RO3",null,[["11,21","11; 21",["#73DFFF",null,0.04,0,0]]]],["TIM KERJA INDONESIA_S FOLU NET SINK 2030","","LOK_PRIORITAS_FOLU_2030_AR_250K","polygon","RO2",null,[["11,12,13,21,22,23","11; 12; 13; 21; 22; 23",["#267300","#6E6E6E",0,0,0]]]],["TIM KERJA INDONESIA_S FOLU NET SINK 2030","","LOK_PRIORITAS_FOLU_2030_AR_250K","polygon","RO1",null,[["11,12,13,21,22,23","11; 12; 13; 21; 22; 23",["#55FF00",null,0.04,0,0]]]],["TIM KERJA INDONESIA_S FOLU NET SINK 2030","","TIPOLOGI_LEMBAGA_AR_250K","polygon","Tipologi",null,[["A1","1",["#9C38B5","#6E6E6E",0,0,0]],["A2","2",["#CA33E8","#6E6E6E",0,0,0]],["A3","3",["#D26FE3","#6E6E6E",0,0,0]],["A4","4",["#C5A3CC","#6E6E6E",0,0,0]]]],["TIM KERJA INDONESIA_S FOLU NET SINK 2030","","TIPOLOGI_LEMBAGA_AR_250K","polygon","Tipologi",null,[["B1","1",["#267300","#6E6E6E",0,0,0]],["B2","2",["#38A800","#6E6E6E",0,0,0]],["B3","3",["#4CE600","#6E6E6E",0,0,0]],["B4","4",["#A3FF73","#6E6E6E",0,0,0]]]],["TIM KERJA INDONESIA_S FOLU NET SINK 2030","","TIPOLOGI_LEMBAGA_AR_250K","polygon","Tipologi",null,[["C1","1",["#A87000","#6E6E6E",0,0,0]],["C2","2",["#E69800","#6E6E6E",0,0,0]],["C3","3",["#FFAA00","#6E6E6E",0,0,0]],["C4","4",["#FFD37F","#6E6E6E",0,0,0]]]],["TIM KERJA INDONESIA_S FOLU NET SINK 2030","","TIPOLOGI_LEMBAGA_AR_250K","polygon","Tipologi",null,[["D1","1",["#A8A800","#6E6E6E",0,0,0]],["D2","2",["#E6E600","#6E6E6E",0,0,0]],["D3","3",["#FFFF73","#6E6E6E",0,0,0]],["D4","4",["#FFFFBE","#6E6E6E",0,0,0]]]],["TIM KERJA INDONESIA_S FOLU NET SINK 2030","","IPL_AR_250K","polygon","INDEKS",null,[["1","1 (Ekstrim Rendah)",["#2892C7","#6E6E6E",0,0,0]],["2","2 (Sangat Rendah)",["#6DA9B3","#6E6E6E",0,0,0]],["3","3 (Rendah)",["#A0C29B","#6E6E6E",0,0,0]],["4","4 (Agak Rendah)",["#CEDE81","#6E6E6E",0,0,0]],["5","5 (Sedang)",["#FAFA64","#6E6E6E",0,0,0]],["6","6 (Agak Tinggi)",["#FCC44C","#6E6E6E",0,0,0]],["7","7 (Tinggi)",["#FA8D34","#6E6E6E",0,0,0]],["8","8 (Sangat Tinggi)",["#F25922","#6E6E6E",0,0,0]],["9","9 (Sangat Ekstrim)",["#E81014","#6E6E6E",0,0,0]]]],["TIM KERJA INDONESIA_S FOLU NET SINK 2030","","LOK_PRIORITAS_FOLU_2030_AR_250K","polygon","RO12",null,[["1,2","1; 2",["#FF0000",null,0.04,0,0]]]],["TIM KERJA INDONESIA_S FOLU NET SINK 2030","","LOK_PRIORITAS_FOLU_2030_AR_250K","polygon","RO11",null,[["1",0,["#734C00",null,0.04,0,0]]]],["TIM KERJA INDONESIA_S FOLU NET SINK 2030","","LOK_PRIORITAS_FOLU_2030_AR_250K","polygon","RO10",null,[["1,2,3,4","1; 2; 3; 4",["#F57AB6",null,0.04,0,0]]]],["TIM KERJA INDONESIA_S FOLU NET SINK 2030","","LOK_PRIORITAS_FOLU_2030_AR_250K","polygon","RO9",null,[["1,2","1; 2",["#005CE6",null,0.04,0,0]]]],["TIM KERJA INDONESIA_S FOLU NET SINK 2030","","LOK_PRIORITAS_FOLU_2030_AR_250K","polygon","RO8",null,[["1,2,3,4,5,6","1; 2; 3; 4; 5; 6",["#DF73FF",null,0.04,0,0]]]],["TIM KERJA INDONESIA_S FOLU NET SINK 2030","","LOK_PRIORITAS_FOLU_2030_AR_250K","polygon","RO7",null,[["1,2,3,4","1; 2; 3; 4",["#FFBEBE","#6E6E6E",0,0,0]]]],["TIM KERJA INDONESIA_S FOLU NET SINK 2030","","LOK_PRIORITAS_FOLU_2030_AR_250K","polygon","RO6",null,[["1",0,["#D1FF73",null,0.04,0,0]]]],["TIM KERJA INDONESIA_S FOLU NET SINK 2030","","LOK_PRIORITAS_FOLU_2030_AR_250K","polygon","RO5",null,[["1,2","1; 2",["#FFD37F",null,0,0,0]]]],["TIM KERJA INDONESIA_S FOLU NET SINK 2030","","LOK_PRIORITAS_FOLU_2030_AR_250K","polygon","RO4",null,[["1",0,["#73FFDF",null,0.04,0,0]]]],["TIM KERJA INDONESIA_S FOLU NET SINK 2030","","LOK_PRIORITAS_FOLU_2030_AR_250K","polygon","RO3",null,[["11,21","11; 21",["#73DFFF",null,0.04,0,0]]]],["TIM KERJA INDONESIA_S FOLU NET SINK 2030","","LOK_PRIORITAS_FOLU_2030_AR_250K","polygon","RO2",null,[["11,12,13,21,22,23","11; 12; 13; 21; 22; 23",["#267300","#6E6E6E",0,0,0]]]],["TIM KERJA INDONESIA_S FOLU NET SINK 2030","","LOK_PRIORITAS_FOLU_2030_AR_250K","polygon","RO1",null,[["11,12,13,21,22,23","11; 12; 13; 21; 22; 23",["#55FF00",null,0.04,0,0]]]],["KSDAE","BPPE","CAPAIAN_PE_AR_25K","polygon","PERLAKUAN",null,[["MA","Mekanisme Alam",[null,"#E60000",0.14,1,0]],["RES","Restorasi",[null,"#E60000",0.14,1,0]],["RH","Rehabilitasi",[null,"#E60000",0.14,1,0]]]],["KSDAE","BPPE","Keanekaragaman Hayat","polygon","KATEGORI",null,[["Rendah",0,["#FFAA00",null,0.14,0,0]],["Sedang",0,["#A3FF73",null,0.14,0,0]],["Tinggi",0,["#267300",null,0,0,0]]]],["KSDAE","BPPE","Kawasan Potensial Keanekaragaman Hayati Tinggi yang Belum Terverifikasi   ","polygon","",["#FFBEBE",null,0.14,0,0],[]],["KSDAE","BPPE","KEE_AR_50K","polygon","type_kee",null,[["ABKT",0,[null,"#FF0000",0.14,1,0]],["Hutan Mangrove",0,[null,"#E64600",0.35,1,0]],["Karst",0,[null,"#E64600",0.35,1,0]],["Koridor Satwa Liar",0,["#FF0000","#FF0000",0.35,1,0]],["Lahan Basah",0,[null,"#FF0000",0.35,1,0]],["Taman Kehati",0,[null,"#E64600",0.35,1,0]]]],["KSDAE","KKHSG","KONFLIK_SATWA_DAN_MANUSIA_PNT_50K","point","",["#E60000","#000000",0.35,0,1.41],[]],["KSDAE","KKHSG","PERJUMPAAN_TUMBUHAN_ALAM_PADA_KK_PNT_50K","point","",["#38A800","#000000",0.35,0,1.41],[]],["KSDAE","KKHSG","Orangutan_Tapanuli","polygon","",["#882600",null,0.14,1,0],[]],["KSDAE","KKHSG","Orangutan_Sumatera","polygon","",["#D8B322",null,0.14,1,0],[]],["KSDAE","KKHSG","Orangutan_Kalimantan","polygon","",["#00C8FF",null,0.14,1,0],[]],["KSDAE","KKHSG","Macan_Tutul_Jawa","polygon","",["#E6E600",null,0.14,1,0],[]],["KSDAE","KKHSG","Komodo","polygon","",["#FABD00",null,0.14,1,0],[]],["KSDAE","KKHSG","Julang_Sumba","polygon","",["#FF7393",null,0.14,1,0],[]],["KSDAE","KKHSG","Harimau_Sumatera","polygon","",["#FF0000",null,0.14,1,0],[]],["KSDAE","KKHSG","Gajah_Sumatera","polygon","",["#00FFC5",null,0.14,1,0],[]],["KSDAE","KKHSG","Gajah_Kalimantan","polygon","",["#002673",null,0.14,1,0],[]],["KSDAE","KKHSG","Elang_Jawa","polygon","",["#7F8F0D",null,0.14,1,0],[]],["KSDAE","KKHSG","Bekantan","polygon","",["#732600",null,0.14,1,0],[]],["KSDAE","KKHSG","Badak_Sumatera","polygon","",["#4E4E4E",null,0.14,1,0],[]],["KSDAE","KKHSG","Babirusa","polygon","",["#FFBEE8",null,0.14,1,0],[]],["KSDAE","KKHSG","Anoa","polygon","",["#A80000",null,0.14,1,0],[]],["KSDAE","PJLKK","DSNTAPAK_AR_25K","polygon","",["#005CE6",null,0.14,0,0],[]],["KSDAE","PJLKK","DSNTAPAK_AR_25K","polygon","",["#386C00",null,0.14,0,0],[]],["KSDAE","PJLKK","JLKARBON_AR_50K","polygon","",["#267300","#267300",0.14,1,0],[]],["KSDAE","PJLKK","PAPA_AR_25K","polygon","",["#17A8E8","#17A8E8",0.14,1,0],[]],["KSDAE","PJLKK","PBPSWA_AR_25K","polygon","",["#000000","#000000",0.14,1,0],[]],["KSDAE","PJLKK","PMFTNAIR_AR_25K","polygon","",["#FFFFFF","#17A8E8",0.14,1,0],[]],["KSDAE","PJLKK","PMFTNJLPBAKEU_AR_50K","polygon","",["#730000","#000000",0,1,0],[]],["KSDAE","PJLKK","PTNAIRE_PNT_25K","point","",["#9091EE",null,0,0,6.35],[]],["KSDAE","PKK","DAERAH_PENYANGGA_KK_ AR_50K","polygon","",[null,"#C7516A",0.14,0,0],[]],["KSDAE","PKK","KEMITRAAN_KONSERVASI_KK_AR_50K","polygon","",["#FFFA00","#000000",0.14,1,0],[]],["KSDAE","RKK","BLOK_KK_AR_50K","polygon","KODEBLOK",null,[["101","Perlindungan",["#FF0000",null,0.35,0,0]],["102","Pemanfaatan",["#94C800",null,0.35,0,0]],["103","Perlindungan Bahari",["#005CE6",null,0.35,0,0]],["104","Tradisional",["#993300",null,0.35,0,0]],["105","Rehabilitasi",["#00FFFF",null,0.35,0,0]],["106","Religi, Budaya dan Sejarah",["#6600CC",null,0.35,0,0]],["107","Khusus",["#969696",null,0.35,0,0]],["108","Koleksi",["#E7E200",null,0.35,0,0]]]],["KSDAE","RKK","PROFIL_KK_AR_50K","polygon","",["#C500FF",null,0.14,0,0],[]],["KSDAE","RKK","ZONA_TN_AR_50K","polygon","REMARK",null,[["Inti",0,["#FF0000",null,0.35,0,0]],["Rimba",0,["#E7E200",null,0.35,0,0]],["Perlindungan Bahari",0,["#005CE6",null,0.35,0,0]],["Pemanfaatan",0,["#94C800",null,0.35,0,0]],["Rehabilitasi",0,["#00FFFF",null,0.35,0,0]],["Religi, Budaya dan Sejarah",0,["#6600CC",null,0.35,0,0]],["Tradisional",0,["#993300",null,0.35,0,0]],["Khusus",0,["#969696",null,0.35,0,0]]]],["PDASRH","KTA","PENERAPAN_TEKNIK_KTA_PNT_25K","point","JENIS_TKTA",null,[["Bangunan Terjunan Air",0,[null,null,0,0,4.23]],["Budi Daya Tanaman Lorong",0,[null,null,0,0,4.23]],["Dam Penahan (DPn)",0,[null,null,0,0,4.23]],["Dam Pengendali (Dpi)",0,[null,null,0,0,4.23]],["Gully Plug (GP)",0,[null,null,0,0,4.23]],["Instalasi Pemanenan Air Hujan (IPAH)",0,[null,null,0,0,4.23]],["Kolam Retensi/Embung",0,[null,null,0,0,4.23]],["Lubang Resapan Biopori (LRB)",0,[null,null,0,0,4.23]],["Penguat Tebing secara Ekohidrolika",0,[null,null,0,0,4.23]],["Perlindungan Kanan-Kiri/Tebing Sungai",0,[null,null,0,0,4.23]],["Rorak (Saluran Buntu)",0,[null,null,0,0,4.23]],["Saluran Pembuangan Air (SPA)",0,[null,null,0,0,4.23]],["Strip Rumput",0,[null,null,0,0,4.23]],["Sumur Resapan Air (SRA)",0,[null,null,0,0,4.23]],["Tanaman Penutup Tanah Lainnya",0,[null,null,0,0,4.23]],["Teras",0,[null,null,0,0,4.23]]]],["PDASRH","KTA","REHAB_DAS_AR_50K","polygon","",["#000000","#000000",0.35,1,0],[]],["PDASRH","PPPDAS","DAS_AR_50K","polygon","",[null,"#73B2FF",0.53,0,0],[]],["PDASRH","PPPDAS","KLASIFIKASI_DAS_AR_50K ","polygon","KLSFKS",null,[["DIPERTAHANKAN",0,["#A3FF73","#4065EB",0,0,0]],["DIPULIHKAN",0,["#FF7F7F","#9BB2FF",0,0,0]]]],["PDASRH","PPPDAS","LAHAN_KRITIS_AR_50K","polygon","KRITIS",null,[["Tidak Kritis",0,["#4F0000","#6E6E6E",0,0,0]],["Potensial Kritis",0,["#A85200","#6E6E6E",0,0,0]],["Agak Kritis",0,["#CD8966","#6E6E6E",0,0,0]],["Kritis",0,["#F5CA7A","#6E6E6E",0,0,0]],["Sangat Kritis",0,["#FFFFBE","#6E6E6E",0,0,0]]]],["PDASRH","PPPDAS","RAWAN_EROSI_AR_50K","polygon","KLAS_EROSI",null,[["<= 15 Ton/Ha/Tahun",0,["#FFEBAF","#6E6E6E",0,0,0]],["> 15 - 60 Ton/Ha/Tahun",0,["#FFD37F","#6E6E6E",0,0,0]],["> 180 - 480 Ton/Ha/Tahun",0,["#A87000","#6E6E6E",0,0,0]],["> 60 - 180 Ton/Ha/Tahun",0,["#FFAA00","#6E6E6E",0,0,0]],["> 480 Ton/Ha/Tahun",0,["#734C00","#6E6E6E",0,0,0]]]],["PDASRH","PPPDAS","RAWAN_LIMPASAN_AR_50K","polygon","KLAS_CN",null,[["0-20",0,["#FFFFBE","#6E6E6E",0,0,0]],["21-40",0,["#FFFF73","#6E6E6E",0,0,0]],["41-60",0,["#E6E600","#6E6E6E",0,0,0]],["61-80",0,["#A8A800","#6E6E6E",0,0,0]],["81-99",0,["#737300","#6E6E6E",0,0,0]]]],["PDASRH","PTH","PERSEMAIAN_PNT_250K","point","",["#000000",null,0,0,3.53],[]],["PDASRH","PTH","SUMBER_BENIH_PNT_250K","point","",["#FF00C5",null,0,0,4.23],[]],["PDASRH","PTH","ZONA_BENIH_AR_250K","polygon","ZONA_BENIH",null,[[" ",0,[null,null,0.14,0,0]],["Alpine",0,["#EAFC9F",null,0.14,0,0]],["Batu Kapur",0,["#FFD2FF",null,0.14,0,0]],["Danau",0,["#CCFFFF",null,0.04,0,0]],["Gambut",0,["#A80000",null,0.14,0,0]],["Hujan Dataran Rendah",0,["#558705",null,0.14,0,0]],["Hujan Pegunungan",0,["#C5FFC4",null,0.14,0,0]],["Hujan Sub Pegunungan",0,["#76FC00",null,0.14,0,0]],["Kerangas",0,["#FCF4A3",null,0.14,0,0]],["Mangrove",0,["#86C400",null,0.14,0,0]],["Musim Dataran Rendah",0,["#FFCD42",null,0.14,0,0]],["Musim Pegunungan",0,["#FCA000",null,0.14,0,0]],["Pantai",0,["#5BAB75",null,0.14,0,0]],["Rawa",0,["#93AB2B",null,0.14,0,0]],["Savana",0,["#DDFF00",null,0.14,0,0]],["Sub Alpine",0,["#B89F00",null,0.14,0,0]],["Tubuh Air",0,["#CCFFFF",null,0.14,0,0]],["Ultrabasa",0,["#FF96FF",null,0.14,0,0]]]],["PDASRH","RH","RHL_YYYY_AR_10K","polygon","",["#FCE8CF","#6E6E6E",0.14,0,0],[]],["PDASRH","RPDM","DTA_DANAU_AR_50K","polygon","",[null,"#73DFFF",0.04,1,0],[]],["PDASRH","RPDM","MANGROVE_AR_25K","polygon","KTTJ",null,[["Mangrove Jarang",0,["#FFBEE8","#FFBEE8",0.71,1,0]],["Mangrove Sedang",0,["#FF00C5","#FF00C5",0.71,1,0]],["Mangrove Lebat",0,["#E600A9","#E600A9",0.71,1,0]]]],["PDASRH","RPDM","MATA_AIR_PNT_250K","point","",["#00C5FF",null,0,0,2.47],[]],["PHL","BRPH","PAPH_AR_250K","polygon","",["#000000","#000000",0.14,1,0],[]],["PHL","BRPH","TATA_HUTAN_KPH_AR_50K","polygon","BLOK_KPH_B",null,[[" ",0,[null,"#6E6E6E",0,0,0]],["HL - Blok Inti",0,["#147832","#6E6E6E",0,0,0]],["HL - Blok Khusus",0,["#148CAA","#6E6E6E",0,0,0]],["HL - Blok Pemanfaatan",0,["#C8FF00","#6E6E6E",0,0,0]],["HP - Blok Khusus",0,["#F0BE14","#6E6E6E",0,0,0]],["HP - Blok Pemanfaatan",0,["#E19696","#6E6E6E",0,0,0]],["HP - Blok Perlindungan",0,["#FF6E00","#6E6E6E",0,0,0]]]],["PHL","BUPH","PBPH_AR_50K","polygon","",[null,"#FF5500",0.71,0,0],[]],["PHL","PUPH","RKUPH_AR_50K","polygon","Penataan",null,[["Kawasan Lindung",0,["#FC1C00",null,0.35,0,0]],["Areal Budidaya",0,["#FFFF00","#DFDA00",0.35,0,0]]]],["PHL","PUPH","TBPBPH_LN_50K","line","PROGRES",null,[["Definitif","Tata Batas Definitif Areal Kerja",["#000000",null,0.14,0,0]],["Proses","Proses Tata Batas Areal Kerja",["#000000",null,0.71,0,0]]]],["PPKL","PKEG","FEG_AR_50K","polygon","feg_50k",null,[["Fungsi Lindung E.G.",0,["#38A800","#000000",0.35,0,0]],["Fungsi Budidaya E.G.",0,["#FFFF73","#000000",0.35,0,0]]]],["PPKL","PKEG","KHG_AR_50K","polygon","STATUS_KHG",null,[["Kabupaten/Kota",0,["#A3FF73","#38A800",0.35,0,0]],["Lintas Kabupaten/Kota",0,["#FFD37F","#E69800",0.35,0,0]],["Lintas Provinsi",0,["#DF73FF","#A900E6",0.35,0,0]]]],["PPKL","PKEG","SKEG_AR_250K","polygon","P_SKEG",null,[["Areal Konservasi",0,["#C500FF","#6E6E6E",0,0,0]],["Kondisi Alamiah",0,["#C500FF","#6E6E6E",0,0,0]],["Prioritas I",0,["#FF0000",null,0,0,0]],["Prioritas II",0,["#FFAA00","#A87000",0,0,0]],["Prioritas III",0,["#FFFF00","#A8A800",0,0,0]],["Prioritas IV",0,["#267300",null,0,0,0]]]],["PPKL","PKEG","SKEG_AR_250K","polygon","SKEG",null,[["Rusak Berat",0,["#FFAA00","#A87000",0,0,0]],["Rusak Ringan",0,["#55FF00","#005E24",0,0,0]],["Rusak Sangat Berat",0,["#FF0000",null,0,0,0]],["Rusak Sedang",0,["#FFFF00","#A8A800",0,0,0]],["Tidak Rusak",0,["#267300",null,0,0,0]]]],["PPKL","PKL","KL_AR_250K","polygon","",["#E61700","#A70000",0.35,0,0],[]],["PPKL","PPA","STATUS_MUTU_AIR_PNT_250K","point","STATUS_MUT",null,[["CEMAR RINGAN",0,["#007AE1","#000000",0.35,0,1.41]],["CEMAR SEDANG",0,["#FFFF00","#000000",0.35,0,1.41]],["MEMENUHI BAKU MUTU",0,["#55FF00","#000000",0.35,0,1.41]]]],["PPKL","PPKPL","INDEKS_KUALITAS_AIR_LAUT_PNT_250K","point","",["#FF0000",null,0,0,3.53],[]],["PPKL","PPKPL","PANTAU_SAMPAH_LAUT_PNT_250K ","point","",["#00FF00",null,0,0,6.35],[]],["PPKL","PPU","IKU_AR_250K","polygon","KRIT_2017",null,[["SANGAT BAIK",0,["#38A800","#4E4E4E",0.14,0,0]],["BAIK",0,["#94F700","#4E4E4E",0.14,0,0]],["SEDANG",0,["#0070FF","#000000",0.14,0,0]],["KURANG",0,["#FFFF00","#6E6E6E",0.07,0,0]],["SANGAT KURANG",0,["#F50000","#6E6E6E",0.07,0,0]]]],["PSLB3","PBBB","PMT_MERKURI_PNT_50K","point","Jenis_sampel",null,[["1","Air bersih (diatas BML)",["#FD2300",null,0,0,3.53]],["2","Air bersih (dibawah BML)",["#00FF00",null,0,0,3.53]],["3","Air permukaan (diatas BML)",["#FD2300",null,0,0,3.53]],["4","Air permukaan (dibawah BML)",["#08F712",null,0,0,3.53]],["9","Biota (diatas BML)",["#FD2300",null,0,0,4.94]],["10","Biota (dibawah BML)",["#08F712",null,0,0,4.94]],["7","Sedimen (diatas BML)",["#FD2300",null,0,0,4.23]],["8","Sedimen (dibawah BML)",["#08F700",null,0,0,4.23]],["5","Tanah (diatas BML)",["#FD2300",null,0,0,4.23]],["6","Tanah (dibawah BML)",["#08F712",null,0,0,4.23]],["11","Tanaman (diatas BML)",["#FD2300",null,0,0,4.94]],["12","Tanaman (dibawah BML)",["#08F712",null,0,0,4.94]],["13","Udara (diatas BML)",["#FD2300",null,0,0,4.94]],["14","Udara (dibawah BML)",["#08F712",null,0,0,4.94]]]],["PSLB3","PS","PENGELOLAANSAMPAH_YYYY_AR_50K","polygon","KLS_KELOLA",null,[["NO DATA",0,["#FFFFFF","#6E6E6E",0.14,0,0]],[">0 - <50",0,["#FFFF00","#6E6E6E",0.14,0,0]],["50 - <70",0,["#FFAA00","#6E6E6E",0.14,0,0]],["70 - 100",0,["#70A800","#6E6E6E",0.14,0,0]],["PERLU KLARIFIKASI",0,["#FF0000","#6E6E6E",0.14,0,0]]]],["PPI","API","KERENTANAN_PERUBAHAN_IKLIM_AR_250K","polygon","Kerentanan",null,[["0",0,[null,"#B2B2B2",0,0,0]],["1",0,["#005CE6","#CCCCCC",0,0,0]],["2",0,["#73B273","#B2B2B2",0,0,0]],["3",0,["#FFFFBE","#B2B2B2",0,0,0]],["4",0,["#F77A2D","#B2B2B2",0,0,0]],["5",0,["#E81515","#B2B2B2",0,0,0]]]],["PPI","API","LokasiProKlim","point","",["#E60000","#000000",0.05,0,1.06],[]],["PPI","IGRKMPV","REDD_AR_250K","polygon","redd_type",null,[["HA","Natural Forest",["#60E663",null,0,0,0]],["Peat","Peatland",["#E64C00",null,0.14,0,0]],["Peat_HA",0,[null,null,0.14,0,0]]]],["PPI","PKHL","AREAL_KARHUTLA_AR_250K","polygon","",["#730000","#730000",0.14,0,0],[]],["PPI","PKHL","RAWAN_KARHUTLA_AR_250K","polygon","KELAS",null,[["Rendah",0,["#0000FF",null,0.14,0,0]],["Sedang",0,["#00FF00",null,0.14,0,0]],["Tinggi",0,["#FFFF00",null,0.14,0,0]],["Sangat Tinggi",0,["#FF0000",null,0.14,0,0]]]],["PPI","PKHL","SEBARAN_HOTSPOT_PNT_250K","point","",["#FF0000",null,0,0,3.53],[]],["PSKL","PKPS","IPHPS_AR_50K","polygon","",[null,"#E69800",0.71,0,0],[]],["PSKL","PKPS","PKK_AR_50K","polygon","",[null,"#A80000",0.71,0,0],[]],["PSKL","PKPS","PPHD_AR_50K","polygon","",[null,"#00C8FF",0.71,0,0],[]],["PSKL","PKPS","PPHKm_AR_50K","polygon","",[null,"#004DA8",0.71,0,0],[]],["PSKL","PKPS","PPHTR_AR_50K","polygon","",[null,"#FF3264",0.71,0,0],[]],["PSKL","PKTHA","HUTAN_ADAT_AR_50K","polygon","",["#A83800","#A83800",0.53,1,0],[]],["PSKL","PKTHA","HUTAN_HAK_AR_50K","polygon","",["#4E4E4E","#4E4E4E",0.53,1,0],[]],["BSILHK","PSIPHB","PETAK_UKUR_PERMANEN_AR_25K","polygon","",["#CFE2F3","#000000",0.71,0,0],[]],["BSILHK","SekBSILHK","HUTAN_PENELITIAN_AR_250K","polygon","",["#F99700","#1C4587",0.71,0,0],[]]];


const lsHex = (h) => (/^#[0-9a-f]{6}$/i.test(h || "") ? h.toLowerCase() : "#888888");
const lsRgb = (h, a = 1) => {
  const x = lsHex(h);
  return `${parseInt(x.slice(1, 3), 16)},${parseInt(x.slice(3, 5), 16)},${parseInt(x.slice(5, 7), 16)},${Math.round(a * 255)}`;
};
const lsXml = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function lsRamp(name, n) {
  if (n <= 0) return [];
  const stops = LS_RAMPS[name];
  if (!stops) {
    return Array.from({ length: n }, (_, i) => {
      const h = (i * 137.508) % 360;
      return lsHslHex(h, 0.55, 0.58);
    });
  }
  return Array.from({ length: n }, (_, i) => {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const p = t * (stops.length - 1);
    const a = stops[Math.floor(p)];
    const b = stops[Math.min(stops.length - 1, Math.floor(p) + 1)];
    const f = p - Math.floor(p);
    const mix = (k) => Math.round(parseInt(a.slice(k, k + 2), 16) * (1 - f) + parseInt(b.slice(k, k + 2), 16) * f);
    return `#${[1, 3, 5].map((k) => mix(k).toString(16).padStart(2, "0")).join("")}`;
  });
}

function lsHslHex(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return `#${[0, 8, 4].map((n) => Math.round(f(n) * 255).toString(16).padStart(2, "0")).join("")}`;
}

/** Class breaks (n+1 edges) for the QGIS graduated modes. */
function lsBreaks(values, n, mode) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return [];
  const min = v[0];
  const max = v[v.length - 1];
  if (min === max) return [min, max];
  if (mode === "quantile") {
    return Array.from({ length: n + 1 }, (_, i) => (i === n ? max : v[Math.floor((i / n) * (v.length - 1))]));
  }
  if (mode === "stddev") {
    const mean = v.reduce((s, x) => s + x, 0) / v.length;
    const sd = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / v.length) || 1;
    const half = Math.floor(n / 2);
    const edges = [min];
    for (let i = -half + 1; i < n - half; i++) edges.push(mean + i * sd);
    edges.push(max);
    return [...new Set(edges.filter((e) => e >= min && e <= max))].sort((a, b) => a - b);
  }
  if (mode === "pretty") {
    const raw = (max - min) / n;
    const p = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) || raw;
    const start = Math.floor(min / step) * step;
    const edges = [];
    for (let x = start; x < max + step / 2; x += step) edges.push(Number(x.toPrecision(12)));
    return edges;
  }
  if (mode === "jenks") return lsJenks(v.length > 3000 ? v.filter((_, i) => i % Math.ceil(v.length / 3000) === 0) : v, n);
  return Array.from({ length: n + 1 }, (_, i) => min + ((max - min) * i) / n);
}

/** Fisher-Jenks natural breaks on sorted values. */
function lsJenks(data, n) {
  const m = data.length;
  n = Math.min(n, m);
  const lower = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  const vari = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(Infinity));
  for (let j = 1; j <= n; j++) {
    lower[1][j] = 1;
    vari[1][j] = 0;
  }
  for (let l = 2; l <= m; l++) {
    let s1 = 0;
    let s2 = 0;
    let w = 0;
    let va = 0;
    for (let k = 1; k <= l; k++) {
      const i3 = l - k + 1;
      const val = data[i3 - 1];
      s2 += val * val;
      s1 += val;
      w += 1;
      va = s2 - (s1 * s1) / w;
      const i4 = i3 - 1;
      if (i4 !== 0) {
        for (let j = 2; j <= n; j++) {
          if (vari[l][j] >= va + vari[i4][j - 1]) {
            lower[l][j] = i3;
            vari[l][j] = va + vari[i4][j - 1];
          }
        }
      }
    }
    lower[l][1] = 1;
    vari[l][1] = va;
  }
  const breaks = new Array(n + 1);
  breaks[n] = data[m - 1];
  breaks[0] = data[0];
  let k = m;
  for (let j = n; j >= 2; j--) {
    const id = lower[k][j] - 2;
    breaks[j - 1] = data[id];
    k = lower[k][j] - 1;
  }
  return breaks;
}

const lsFmt = (x) => (Math.abs(x) >= 1000 ? Math.round(x).toLocaleString("en-US") : Number(x.toPrecision(4)).toString());

// ---- reading the layer ------------------------------------------------------

function lsLayers() {
  try {
    return (state.app?.listLayers?.() ?? []).filter((l) => l && l.id);
  } catch {
    return [];
  }
}

function lsIsRaster(layer) {
  return /raster|cog|tile|wms|wmts|xyz|zarr|image/i.test(String(layer?.type ?? "")) && !/vector/i.test(String(layer?.type ?? ""));
}

/** Current GeoLibre style of a layer, from the project snapshot. */
function lsStoredStyle(layerId) {
  try {
    const snap = state.app?.getProjectSnapshot?.();
    const layer = (snap?.layers ?? snap?.project?.layers ?? []).find((l) => l.id === layerId);
    return layer?.style ?? {};
  } catch {
    return {};
  }
}

/** Fields (name -> numeric?) and a value sample from the layer's features. */
function lsFields(layerId) {
  let feats = [];
  try {
    const r = state.app?.getLayerFeatures?.(layerId) ?? [];
    feats = (Array.isArray(r) ? r : r?.features ?? []).slice(0, 3000);
  } catch {
    feats = [];
  }
  const fields = new Map();
  let geom = "fill";
  for (const f of feats) {
    const t = f?.geometry?.type || "";
    if (t) geom = /Point/.test(t) ? "marker" : /Line/.test(t) ? "line" : "fill";
    for (const [k, v] of Object.entries(f?.properties ?? {})) {
      const e = fields.get(k) ?? { numeric: true, values: [] };
      if (v !== null && v !== undefined && v !== "") {
        if (typeof v !== "number" && !Number.isFinite(Number(v))) e.numeric = false;
        if (e.values.length < 3000) e.values.push(v);
      }
      fields.set(k, e);
    }
  }
  return { fields, geom, count: feats.length };
}

/** QGIS-style expression for a simple MapLibre filter (for the rule editor). */
function lsFilterToExpr(json) {
  try {
    const f = typeof json === "string" ? JSON.parse(json) : json;
    const val = (x) => (typeof x === "number" ? String(x) : `'${String(x).replace(/'/g, "''")}'`);
    const one = (e) => {
      if (!Array.isArray(e)) return null;
      const [op, a, b] = e;
      const field = Array.isArray(a) && a[0] === "get" ? `"${a[1]}"` : null;
      if (["==", "!=", ">", ">=", "<", "<="].includes(op) && field) return `${field} ${op === "==" ? "=" : op === "!=" ? "<>" : op} ${val(b)}`;
      if ((op === "all" || op === "any") && e.length > 1) {
        const parts = e.slice(1).map(one);
        return parts.every(Boolean) ? parts.map((p) => `(${p})`).join(op === "all" ? " AND " : " OR ") : null;
      }
      return null;
    };
    return one(f) ?? "";
  } catch {
    return "";
  }
}

/** Panel state from the layer's current GeoLibre style. */
function lsStateFromStyle(layerId) {
  const s = lsStoredStyle(layerId);
  const info = lsFields(layerId);
  const stops = Array.isArray(s.vectorStyleStops) ? s.vectorStyleStops : [];
  const mode = ["categorized", "graduated", "rule-based"].includes(s.vectorStyleMode) ? s.vectorStyleMode : "single";
  const labels = s.labels ?? {};
  return {
    kind: "vector",
    geom: info.geom,
    renderer: mode,
    fill: lsHex(s.fillColor || "#3388ff"),
    stroke: lsHex(s.strokeColor || "#232323"),
    strokeWidth: Number.isFinite(s.strokeWidth) ? s.strokeWidth : 1,
    size: Number.isFinite(s.circleRadius) ? s.circleRadius * 2 : 8,
    opacity: Number.isFinite(s.fillOpacity) ? s.fillOpacity : 1,
    field: s.vectorStyleProperty || "",
    ramp: "random",
    gradMode: "jenks",
    classes: Math.max(2, mode === "graduated" ? stops.length : 5),
    categories:
      mode === "categorized"
        ? stops.map((st) => ({ on: true, value: String(st.value), label: st.label ?? String(st.value), color: lsHex(st.color) }))
        : [],
    ranges:
      mode === "graduated"
        ? stops.map((st, i) => ({ on: true, lower: Number(st.value), upper: Number(stops[i + 1]?.value ?? st.value), color: lsHex(st.color) }))
        : [],
    rules:
      mode === "rule-based" && Array.isArray(s.vectorRules)
        ? s.vectorRules.map((r) => ({ on: r.enabled !== false, label: r.label ?? "", expr: lsFilterToExpr(r.filter), color: lsHex(r.color) }))
        : [],
    labelsOn: !!labels.enabled,
    labelField: labels.field || "",
    labelSize: Number.isFinite(labels.size) ? labels.size : 10,
    labelColor: lsHex(labels.color || "#000000"),
    bufferOn: (labels.haloWidth ?? 0) > 0,
    bufferSize: Number.isFinite(labels.haloWidth) && labels.haloWidth > 0 ? labels.haloWidth : 1,
    bufferColor: lsHex(labels.haloColor || "#ffffff"),
    labelLine: labels.placement === "line",
    fieldInfo: info,
  };
}

// ---- writing QML ----------------------------------------------------------------

function lsSymbolXml(st, name, color) {
  const type = st.geom;
  const opt = (k, v) => `<Option name="${k}" type="QString" value="${lsXml(v)}"/>`;
  let layer;
  if (type === "line") {
    layer = `<layer class="SimpleLine" enabled="1" locked="0" pass="0"><Option type="Map">${opt("line_color", lsRgb(color, st.opacity))}${opt("line_width", st.strokeWidth)}${opt("line_width_unit", "Pixel")}${opt("line_style", "solid")}</Option></layer>`;
  } else if (type === "marker") {
    layer = `<layer class="SimpleMarker" enabled="1" locked="0" pass="0"><Option type="Map">${opt("name", "circle")}${opt("color", lsRgb(color, st.opacity))}${opt("outline_color", lsRgb(st.stroke))}${opt("outline_width", st.strokeWidth)}${opt("outline_width_unit", "Pixel")}${opt("size", st.size)}${opt("size_unit", "Pixel")}</Option></layer>`;
  } else {
    layer = `<layer class="SimpleFill" enabled="1" locked="0" pass="0"><Option type="Map">${opt("color", lsRgb(color, st.opacity))}${opt("outline_color", lsRgb(st.stroke))}${opt("outline_width", st.strokeWidth)}${opt("outline_width_unit", "Pixel")}${opt("style", "solid")}${opt("outline_style", "solid")}</Option></layer>`;
  }
  return `<symbol type="${type}" name="${name}" alpha="1" clip_to_extent="1" force_rhr="0">${layer}</symbol>`;
}

function lsQml(st) {
  let renderer;
  if (st.renderer === "categorized" && st.field && st.categories.length) {
    const cats = st.categories.filter((c) => c.on);
    renderer = `<renderer-v2 type="categorizedSymbol" attr="${lsXml(st.field)}" symbollevels="0" enableorderby="0" forceraster="0"><categories>${cats
      .map((c, i) => `<category value="${lsXml(c.value)}" symbol="${i}" label="${lsXml(c.label)}" render="true"/>`)
      .join("")}</categories><symbols>${cats.map((c, i) => lsSymbolXml(st, i, c.color)).join("")}</symbols></renderer-v2>`;
  } else if (st.renderer === "graduated" && st.field && st.ranges.length) {
    const rs = st.ranges.filter((r) => r.on);
    renderer = `<renderer-v2 type="graduatedSymbol" attr="${lsXml(st.field)}" graduatedMethod="GraduatedColor" symbollevels="0" enableorderby="0" forceraster="0"><ranges>${rs
      .map((r, i) => `<range lower="${r.lower}" upper="${r.upper}" symbol="${i}" label="${lsFmt(r.lower)} - ${lsFmt(r.upper)}" render="true"/>`)
      .join("")}</ranges><symbols>${rs.map((r, i) => lsSymbolXml(st, i, r.color)).join("")}</symbols></renderer-v2>`;
  } else if (st.renderer === "rule-based" && st.rules.length) {
    renderer = `<renderer-v2 type="RuleRenderer" symbollevels="0" enableorderby="0" forceraster="0"><rules key="root">${st.rules
      .map((r, i) => `<rule key="r${i}" symbol="${i}" label="${lsXml(r.label)}" filter="${lsXml(r.expr || "ELSE")}"${r.on ? "" : ' checkstate="0"'}/>`)
      .join("")}</rules><symbols>${st.rules.map((r, i) => lsSymbolXml(st, i, r.color)).join("")}</symbols></renderer-v2>`;
  } else {
    renderer = `<renderer-v2 type="singleSymbol" symbollevels="0" enableorderby="0" forceraster="0"><symbols>${lsSymbolXml(st, 0, st.fill)}</symbols></renderer-v2>`;
  }
  const labeling =
    st.labelsOn && st.labelField
      ? `<labeling type="simple"><settings fieldName="${lsXml(st.labelField)}" isExpression="0"><text-style fieldName="${lsXml(st.labelField)}" fontSize="${st.labelSize}" textColor="${lsRgb(st.labelColor)}"><text-buffer bufferDraw="${st.bufferOn ? 1 : 0}" bufferSize="${st.bufferSize}" bufferColor="${lsRgb(st.bufferColor)}"/></text-style><placement placement="${st.labelLine ? 2 : 0}"/></settings></labeling>`
      : "";
  return `<!DOCTYPE qgis PUBLIC 'http://mrcc.com/qgis.dtd' 'SYSTEM'><qgis version="3.40" styleCategories="Symbology|Labeling">${renderer}${labeling}</qgis>`;
}

// ---- raster: QGIS "Layer Rendering" / "Resampling" / "Transparency" ------------

function lsRasterStyleLayers(layerId) {
  const map = currentMap();
  const style = map?.getStyle?.();
  return (style?.layers ?? []).filter((l) => l.type === "raster" && (l.id === layerId || l.id.includes(layerId) || String(l.source).includes(layerId)));
}

function lsRasterState(layerId) {
  const ids = lsRasterStyleLayers(layerId);
  const map = currentMap();
  const get = (p, d) => {
    try {
      const v = ids[0] && map.getPaintProperty(ids[0].id, p);
      return v ?? d;
    } catch {
      return d;
    }
  };
  const bmin = get("raster-brightness-min", 0);
  const bmax = get("raster-brightness-max", 1);
  return {
    kind: "raster",
    found: ids.length,
    opacity: get("raster-opacity", 1),
    invert: bmin > bmax,
    brightness: Math.round(((bmin > bmax ? 1 - bmin : bmin) - (bmin > bmax ? 1 - bmax : 1 - bmax)) * 100) || 0,
    contrast: Math.round(get("raster-contrast", 0) * 100),
    saturation: Math.round(get("raster-saturation", 0) * 100),
    grayscale: get("raster-saturation", 0) <= -1 ? "lightness" : "off",
    hue: get("raster-hue-rotate", 0),
    resampling: get("raster-resampling", "linear"),
  };
}

function lsApplyRaster(st) {
  const map = currentMap();
  const ids = lsRasterStyleLayers(LS.layerId);
  if (!map || !ids.length) return { ok: false, reason: "no raster draw layer" };
  const b = Math.max(-100, Math.min(100, st.brightness)) / 100;
  let lo = Math.max(0, b);
  let hi = Math.min(1, 1 + b);
  if (st.invert) [lo, hi] = [hi, lo];
  for (const { id } of ids) {
    const set = (p, v) => {
      try {
        map.setPaintProperty(id, p, v);
      } catch {
        /* a property this layer does not take */
      }
    };
    set("raster-opacity", st.opacity);
    set("raster-brightness-min", lo);
    set("raster-brightness-max", hi);
    set("raster-contrast", Math.max(-1, Math.min(1, st.contrast / 100)));
    set("raster-saturation", st.grayscale !== "off" ? -1 : Math.max(-1, Math.min(1, st.saturation / 100)));
    set("raster-hue-rotate", Number(st.hue) || 0);
    set("raster-resampling", st.resampling === "nearest" ? "nearest" : "linear");
  }
  return { ok: true };
}

// ---- style files: Load (.qml .sld .json .lyrx) / Save (.qml) -------------------------

/** CIM colour ([r,g,b,a] in RGB / HSV / CMYK colour objects) as #rrggbb, or null. */
function lsCimColor(c) {
  const v = c?.values;
  if (!Array.isArray(v)) return null;
  if (/HSV/.test(c.type || "")) return lsHslHex(v[0], (v[1] || 0) / 100, ((v[2] || 0) / 100) * (1 - (v[1] || 0) / 200));
  if (/CMYK/.test(c.type || "")) {
    const [cc, m, y, k] = v.map((x) => (x || 0) / 100);
    return `#${[cc, m, y].map((x) => Math.round(255 * (1 - x) * (1 - k)).toString(16).padStart(2, "0")).join("")}`;
  }
  return `#${v.slice(0, 3).map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0")).join("")}`;
}

/** The fill (or line) colour, outline colour and width of a CIM symbol reference. */
function lsCimSymbol(ref) {
  const layers = ref?.symbol?.symbolLayers ?? [];
  const fill = layers.find((l) => /SolidFill|HatchFill/.test(l.type || ""));
  const stroke = layers.find((l) => /SolidStroke/.test(l.type || ""));
  const marker = layers.find((l) => /Marker/.test(l.type || ""));
  return {
    color: lsCimColor(fill?.color) ?? lsCimColor(fill?.lineSymbol?.symbolLayers?.[0]?.color) ?? lsCimColor(marker?.markerGraphics?.[0]?.symbol?.symbolLayers?.[0]?.color) ?? lsCimColor(stroke?.color),
    stroke: lsCimColor(stroke?.color),
    width: Number.isFinite(stroke?.width) ? Math.round(stroke.width * 1.333 * 10) / 10 : null, // pt to px
  };
}

/** An ArcGIS Pro .lyrx (CIM JSON) as panel-state patch: simple, unique values or class breaks. */
function lsFromLyrx(json) {
  const def = (json.layerDefinitions ?? []).find((d) => d.renderer) ?? json.layerDefinitions?.[0];
  const r = def?.renderer;
  if (!r) throw new Error("The .lyrx has no feature renderer.");
  if (/UniqueValueRenderer/.test(r.type)) {
    const field = r.fields?.[0] ?? "";
    const categories = [];
    for (const g of r.groups ?? []) {
      for (const c of g.classes ?? []) {
        const s = lsCimSymbol(c.symbol);
        for (const v of c.values ?? []) categories.push({ on: c.visible !== false, value: String(v.fieldValues?.[0] ?? ""), label: c.label ?? String(v.fieldValues?.[0] ?? ""), color: lsHex(s.color || "#bdbdbd") });
      }
    }
    const first = lsCimSymbol(r.groups?.[0]?.classes?.[0]?.symbol);
    return { renderer: "categorized", field, categories, ...(first.stroke ? { stroke: first.stroke } : {}), ...(first.width ? { strokeWidth: first.width } : {}) };
  }
  if (/ClassBreaksRenderer/.test(r.type)) {
    let lower = Number(r.minimumBreak ?? 0);
    const ranges = (r.breaks ?? []).map((b) => {
      const s = lsCimSymbol(b.symbol);
      const range = { on: true, lower, upper: Number(b.upperBound), color: lsHex(s.color || "#bdbdbd") };
      lower = Number(b.upperBound);
      return range;
    });
    return { renderer: "graduated", field: r.field ?? "", ranges, classes: ranges.length };
  }
  const s = lsCimSymbol(r.symbol);
  return { renderer: "single", fill: lsHex(s.color || "#888888"), ...(s.stroke ? { stroke: s.stroke } : {}), ...(s.width ? { strokeWidth: s.width } : {}) };
}

/** Load a style file into the selected layer. */
async function lsLoadStyleFile() {
  const pick = el("input", { type: "file", accept: ".qml,.sld,.xml,.json,.lyrx,.style.json" });
  pick.addEventListener("change", async () => {
    const file = pick.files?.[0];
    if (!file || !LS.layerId || LS.state?.kind !== "vector") return;
    const text = await file.text();
    try {
      if (/\.lyrx$/i.test(file.name) || /"CIMLayerDocument"/.test(text)) {
        Object.assign(LS.state, lsFromLyrx(JSON.parse(text)));
        lsRenderPage();
        lsApply();
        LS.status = `Loaded ${file.name} (ArcGIS Pro layer file)`;
      } else {
        const res = state.app?.importLayerStyle?.(LS.layerId, text);
        if (!res?.ok) throw new Error(res?.reason || "not a style GeoLibre can read");
        // read the result back so the panel shows what the file set
        const info = LS.state.fieldInfo;
        LS.state = { ...lsStateFromStyle(LS.layerId), fieldInfo: info };
        lsRenderPage();
        LS.undo.push(JSON.stringify({ ...LS.state, fieldInfo: undefined }));
        LS.history.unshift({ time: nowHM(), label: `Loaded ${file.name}`, snap: LS.undo[LS.undo.length - 1] });
        LS.status = `Loaded ${file.name}${res.warnings?.length ? ` · ${res.warnings.length} note(s)` : ""}`;
      }
    } catch (err) {
      LS.status = `Could not load ${file.name}: ${err?.message ?? err}`;
    }
    lsRenderFoot();
  });
  pick.click();
}

/** Save the panel's current style as a QGIS .qml file. */
function lsSaveStyleFile() {
  if (!LS.state || LS.state.kind !== "vector") return;
  const name = (lsLayers().find((l) => l.id === LS.layerId)?.name || "style").replace(/[^\w.-]+/g, "_");
  const blob = new Blob([lsQml(LS.state)], { type: "application/xml" });
  const a = el("a", { href: URL.createObjectURL(blob), download: `${name}.qml` });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  LS.status = `Saved ${name}.qml`;
  lsRenderFoot();
}

// ---- apply / undo / history -----------------------------------------------------

function lsApply({ record = true } = {}) {
  const st = LS.state;
  if (!st || !LS.layerId) return;
  let res;
  if (st.kind === "raster") res = lsApplyRaster(st);
  else {
    try {
      res = state.app?.importLayerStyle?.(LS.layerId, lsQml(st)) ?? { ok: false, reason: "no importLayerStyle" };
    } catch (err) {
      res = { ok: false, reason: String(err?.message ?? err) };
    }
  }
  if (record) {
    const snap = JSON.stringify({ ...st, fieldInfo: undefined });
    if (LS.undo[LS.undo.length - 1] !== snap) {
      LS.undo.push(snap);
      LS.redo = [];
      LS.history.unshift({ time: nowHM(), label: lsDescribe(st), snap });
      LS.history.length = Math.min(LS.history.length, 30);
    }
  }
  LS.status = res?.ok ? (res.warnings?.length ? `Applied · ${res.warnings.length} note(s): ${res.warnings[0]}` : "Applied") : `Not applied: ${res?.reason ?? "?"}`;
  lsRenderFoot();
}

function lsDescribe(st) {
  if (st.kind === "raster") return "Raster rendering";
  const r = LS_RENDERERS.find(([k]) => k === st.renderer)?.[1] ?? st.renderer;
  return st.field && st.renderer !== "single" && st.renderer !== "rule-based" ? `${r} · ${st.field}` : r;
}

function lsChanged() {
  if (!LS.live) {
    LS.status = "Not applied yet";
    lsRenderFoot();
    return;
  }
  clearTimeout(LS.timer);
  LS.timer = setTimeout(() => lsApply(), 260);
}

function lsRestore(snap) {
  const info = LS.state?.fieldInfo;
  LS.state = { ...JSON.parse(snap), fieldInfo: info };
  lsRenderPage();
  lsApply({ record: false });
}

// ---- UI -------------------------------------------------------------------------

const LS_ICONS = {
  symbology: '<path d="M3 13c3 0 4-2 4-4s2-3 4-3M11 3l2 2-6 6H5V9z" fill="none" stroke="currentColor" stroke-width="1.3"/>',
  labels: '<path d="M2.5 12.5 5.5 4h1l3 8.5M3.6 9.5h4.8M11 12.5V6.5M11 9.2c0-1.6 2.5-1.6 2.5 0v3.3" fill="none" stroke="currentColor" stroke-width="1.3"/>',
  transparency: '<rect x="2.5" y="2.5" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M2.5 2.5h5.5v5.5H2.5zM8 8h5.5v5.5H8z" fill="currentColor" opacity=".55"/>',
  styles: '<rect x="2" y="2" width="5" height="5" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x="9" y="2" width="5" height="5" fill="currentColor" opacity=".6"/><rect x="2" y="9" width="5" height="5" fill="currentColor" opacity=".35"/><rect x="9" y="9" width="5" height="5" fill="none" stroke="currentColor" stroke-width="1.2"/>',
  history: '<circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 4.8V8l2.2 1.4" fill="none" stroke="currentColor" stroke-width="1.3"/>',
};

function lsIcon(name) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = LS_ICONS[name] ?? "";
  return svg;
}

function lsRow(label, control) {
  return el("label", { className: "glb-ls-row" }, [el("span", { textContent: label }), control]);
}

function lsInput(type, value, on, extra = {}) {
  const i = el("input", { type, value: String(value ?? ""), ...extra });
  i.addEventListener(type === "range" || type === "color" ? "input" : "change", () => on(type === "number" || type === "range" ? Number(i.value) : i.value));
  i.addEventListener("keydown", (e) => e.stopPropagation());
  return i;
}

function lsSelect(options, value, on) {
  const s = el("select", {}, options.map(([v, t]) => el("option", { value: v, textContent: t, selected: v === value })));
  s.addEventListener("change", () => on(s.value));
  s.addEventListener("keydown", (e) => e.stopPropagation());
  return s;
}

function lsCheck(checked, on, text = "") {
  const c = el("input", { type: "checkbox", checked: !!checked });
  c.addEventListener("change", () => on(c.checked));
  return text ? el("label", { className: "glb-ls-check" }, [c, el("span", { textContent: text })]) : c;
}

function lsGroup(title, children, open = true) {
  const d = el("details", { className: "glb-ls-group", open }, [el("summary", { textContent: title }), ...children]);
  return d;
}

function lsBtn(text, on, title = "") {
  const b = el("button", { type: "button", className: "glb-ls-btn", textContent: text, title });
  b.addEventListener("click", on);
  return b;
}

function lsSet(patch, rerender = false) {
  Object.assign(LS.state, patch);
  if (rerender) lsRenderPage();
  lsChanged();
}

function lsSymbolBox(st) {
  const kids = [];
  if (st.renderer === "single") {
    // the single symbol's colour, through the same Color / Style picker as a class
    const proxy = {
      get color() { return st.geom === "line" ? st.stroke : st.fill; },
      set color(v) { if (st.geom === "line") st.stroke = v; st.fill = v; },
    };
    kids.push(lsRow(st.geom === "line" ? "Color" : "Fill", lsSymbolCell(proxy, lsChanged)));
  }
  if (st.geom !== "line") kids.push(lsRow("Stroke color", lsInput("color", st.stroke, (v) => lsSet({ stroke: v }))));
  kids.push(lsRow(st.geom === "line" ? "Width" : "Stroke width", lsInput("number", st.strokeWidth, (v) => lsSet({ strokeWidth: v }), { min: 0, max: 20, step: 0.1 })));
  if (st.geom === "marker") kids.push(lsRow("Size", lsInput("number", st.size, (v) => lsSet({ size: v }), { min: 1, max: 60, step: 0.5 })));
  return el("div", { className: "glb-ls-symbol" }, kids);
}

function lsFieldSelect(st, numericOnly) {
  const names = [...st.fieldInfo.fields.entries()].filter(([, e]) => !numericOnly || e.numeric).map(([k]) => [k, k]);
  return lsSelect([["", "—"], ...names], st.field, (v) => lsSet({ field: v }, true));
}

function lsClassify(st) {
  const e = st.fieldInfo.fields.get(st.field);
  if (!e) return;
  if (st.renderer === "categorized") {
    const vals = [...new Set(e.values.map(String))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const colors = lsRamp(st.ramp, vals.length);
    st.categories = vals.map((v, i) => ({ on: true, value: v, label: v, color: colors[i] }));
  } else if (st.renderer === "graduated") {
    const edges = lsBreaks(e.values.map(Number), st.classes, st.gradMode);
    const colors = lsRamp(st.ramp === "random" ? "Viridis" : st.ramp, Math.max(1, edges.length - 1));
    st.ranges = edges.slice(0, -1).map((lo, i) => ({ on: true, lower: lo, upper: edges[i + 1], color: colors[i] }));
  }
}

function lsClassTable(rows, cols) {
  const head = el("tr", {}, cols.map((c) => el("th", { textContent: c.title })));
  const body = rows.map((r, i) => el("tr", {}, cols.map((c) => el("td", {}, [c.cell(r, i)]))));
  return el("div", { className: "glb-ls-tablewrap" }, [el("table", { className: "glb-ls-table" }, [el("thead", {}, [head]), el("tbody", {}, body)])]);
}

function lsPageSymbology() {
  const st = LS.state;
  if (st.kind === "raster") return lsPageRasterSymbology();
  const kids = [lsRow("Renderer", lsSelect(LS_RENDERERS, st.renderer, (v) => lsSet({ renderer: v }, true)))];
  kids.push(lsGroup("Symbol", [lsSymbolBox(st)]));
  if (st.renderer === "categorized" || st.renderer === "graduated") {
    const grad = st.renderer === "graduated";
    kids.push(lsRow("Value", lsFieldSelect(st, grad)));
    kids.push(lsRow("Color ramp", lsRampPicker(st.ramp, (v) => lsSet({ ramp: v }))));
    if (grad) {
      kids.push(lsRow("Mode", lsSelect(LS_MODES, st.gradMode, (v) => lsSet({ gradMode: v }))));
      kids.push(lsRow("Classes", lsInput("number", st.classes, (v) => lsSet({ classes: Math.max(2, Math.min(20, v | 0)) }), { min: 2, max: 20, step: 1 })));
    }
    const list = grad ? st.ranges : st.categories;
    const colorCell = (r) => lsSymbolCell(r, lsChanged);
    const onCell = (r) => lsCheck(r.on, (v) => { r.on = v; lsChanged(); });
    kids.push(
      lsClassTable(
        list,
        grad
          ? [
              { title: "", cell: onCell },
              { title: "Symbol", cell: colorCell },
              { title: "Values", cell: (r) => el("span", { textContent: `${lsFmt(r.lower)} – ${lsFmt(r.upper)}` }) },
            ]
          : [
              { title: "", cell: onCell },
              { title: "Symbol", cell: colorCell },
              { title: "Value", cell: (r) => el("span", { textContent: r.value }) },
              { title: "Legend", cell: (r) => lsInput("text", r.label, (v) => { r.label = v; lsChanged(); }) },
            ],
      ),
    );
    kids.push(
      el("div", { className: "glb-ls-actions" }, [
        lsBtn("Classify", () => { lsClassify(st); lsRenderPage(); lsChanged(); }),
        lsBtn("+", () => { list.push(grad ? { on: true, lower: 0, upper: 0, color: "#888888" } : { on: true, value: "", label: "", color: "#888888" }); lsRenderPage(); }, "Add class"),
        lsBtn("−", () => { list.pop(); lsRenderPage(); lsChanged(); }, "Delete class"),
        lsBtn("Delete All", () => { list.length = 0; lsRenderPage(); lsChanged(); }),
      ]),
    );
  }
  if (st.renderer === "rule-based") {
    kids.push(
      lsClassTable(st.rules, [
        { title: "", cell: (r) => lsCheck(r.on, (v) => { r.on = v; lsChanged(); }) },
        { title: "Symbol", cell: (r) => lsSymbolCell(r, lsChanged) },
        { title: "Label", cell: (r) => lsInput("text", r.label, (v) => { r.label = v; lsChanged(); }) },
        { title: "Rule", cell: (r) => lsInput("text", r.expr, (v) => { r.expr = v; lsChanged(); }, { placeholder: "\"field\" = 'value'  ·  ELSE" }) },
      ]),
    );
    kids.push(
      el("div", { className: "glb-ls-actions" }, [
        lsBtn("+ Rule", () => { st.rules.push({ on: true, label: `Rule ${st.rules.length + 1}`, expr: "", color: lsRamp("random", st.rules.length + 1).pop() }); lsRenderPage(); }),
        lsBtn("−", () => { st.rules.pop(); lsRenderPage(); lsChanged(); }, "Remove rule"),
      ]),
    );
  }
  kids.push(
    lsGroup("Layer Rendering", [
      lsRow("Opacity", lsInput("range", Math.round(st.opacity * 100), (v) => lsSet({ opacity: v / 100 }), { min: 0, max: 100, step: 1 })),
      el("button", { type: "button", className: "glb-ls-link", textContent: "Advanced styling (markers, patterns, 3D) …", onclick: lsOpenNativeStyle }),
    ], false),
  );
  return kids;
}

function lsPageLabels() {
  const st = LS.state;
  const names = [...st.fieldInfo.fields.keys()].map((k) => [k, k]);
  const kids = [lsRow("Mode", lsSelect([["off", "No Labels"], ["single", "Single Labels"]], st.labelsOn ? "single" : "off", (v) => lsSet({ labelsOn: v === "single" }, true)))];
  if (st.labelsOn) {
    kids.push(lsRow("Value", lsSelect([["", "—"], ...names], st.labelField, (v) => lsSet({ labelField: v }))));
    kids.push(lsGroup("Text", [
      lsRow("Size", lsInput("number", st.labelSize, (v) => lsSet({ labelSize: v }), { min: 4, max: 72, step: 0.5 })),
      lsRow("Color", lsInput("color", st.labelColor, (v) => lsSet({ labelColor: v }))),
    ]));
    kids.push(lsGroup("Buffer", [
      lsCheck(st.bufferOn, (v) => lsSet({ bufferOn: v }), "Draw text buffer"),
      lsRow("Size", lsInput("number", st.bufferSize, (v) => lsSet({ bufferSize: v }), { min: 0, max: 10, step: 0.1 })),
      lsRow("Color", lsInput("color", st.bufferColor, (v) => lsSet({ bufferColor: v }))),
    ]));
    if (st.geom === "line") kids.push(lsGroup("Placement", [lsCheck(st.labelLine, (v) => lsSet({ labelLine: v }), "Parallel to the line")]));
  }
  return kids;
}

function lsPageRasterSymbology() {
  const st = LS.state;
  const kids = [];
  if (!st.found) kids.push(el("p", { className: "glb-ls-note", textContent: "This raster is drawn by a custom renderer; render type, bands and colour ramp stay in GeoLibre's raster panel." }));
  kids.push(lsGroup("Layer Rendering", [
    lsRow("Brightness", lsInput("range", st.brightness, (v) => lsSet({ brightness: v }), { min: -100, max: 100 })),
    lsRow("Contrast", lsInput("range", st.contrast, (v) => lsSet({ contrast: v }), { min: -100, max: 100 })),
    lsRow("Saturation", lsInput("range", st.saturation, (v) => lsSet({ saturation: v }), { min: -100, max: 100 })),
    lsRow("Grayscale", lsSelect([["off", "Off"], ["lightness", "By lightness"]], st.grayscale, (v) => lsSet({ grayscale: v }))),
    lsRow("Hue", lsInput("range", st.hue, (v) => lsSet({ hue: v }), { min: -180, max: 180 })),
    lsCheck(st.invert, (v) => lsSet({ invert: v }), "Invert colors"),
    lsBtn("Reset", () => lsSet({ brightness: 0, contrast: 0, saturation: 0, grayscale: "off", hue: 0, invert: false }, true)),
  ]));
  kids.push(lsGroup("Resampling", [
    lsRow("Zoomed in / out", lsSelect([["linear", "Bilinear"], ["nearest", "Nearest Neighbour"]], st.resampling, (v) => lsSet({ resampling: v }))),
  ]));
  return kids;
}

function lsPageTransparency() {
  const st = LS.state;
  return [lsGroup("Global Opacity", [lsRow("Opacity", lsInput("range", Math.round(st.opacity * 100), (v) => lsSet({ opacity: v / 100 }), { min: 0, max: 100 }))])];
}

function lsPageHistory() {
  if (!LS.history.length) return [el("p", { className: "glb-ls-note", textContent: "No style changes yet in this session." })];
  return [
    el("ul", { className: "glb-ls-history" }, LS.history.map((h) => {
      const li = el("li", {}, [el("span", { className: "glb-ls-time", textContent: h.time }), el("span", { textContent: h.label })]);
      li.addEventListener("click", () => lsRestore(h.snap));
      return li;
    })),
  ];
}

// ---- popovers: searchable ramp picker and Color / Style symbol picker -----------

function lsPopover(anchor, build) {
  lsClosePopover();
  const pop = el("div", { className: "glb-ls-pop" });
  build(pop);
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  const w = Math.max(240, r.width);
  pop.style.width = `${w}px`;
  pop.style.left = `${Math.min(r.left, innerWidth - w - 8)}px`;
  const below = innerHeight - r.bottom > 300;
  pop.style[below ? "top" : "bottom"] = below ? `${r.bottom + 2}px` : `${innerHeight - r.top + 2}px`;
  const off = (e) => {
    if (!pop.contains(e.target) && e.target !== anchor) lsClosePopover();
  };
  const esc = (e) => e.key === "Escape" && lsClosePopover();
  setTimeout(() => document.addEventListener("pointerdown", off, true), 0);
  document.addEventListener("keydown", esc, true);
  LS.pop = { el: pop, off: () => { document.removeEventListener("pointerdown", off, true); document.removeEventListener("keydown", esc, true); } };
  pop.querySelector("input")?.focus();
  return pop;
}

function lsClosePopover() {
  LS.pop?.off();
  LS.pop?.el.remove();
  LS.pop = null;
}

function lsGradient(name) {
  const stops = LS_RAMPS[name] ?? lsRamp("random", 8);
  return `linear-gradient(90deg, ${stops.map((c, i) => `${c} ${(i / Math.max(1, stops.length - 1)) * 100}%`).join(", ")})`;
}

function lsSearch(placeholder, onInput) {
  const s = el("input", { type: "search", className: "glb-ls-search", placeholder });
  s.addEventListener("input", () => onInput(s.value.trim().toLowerCase()));
  s.addEventListener("keydown", (e) => e.stopPropagation());
  return s;
}

/** Colour ramp chooser: a gradient button; the popover searches all 300 ramps. */
function lsRampPicker(value, on) {
  const b = el("button", { type: "button", className: "glb-ls-ramp", title: value });
  const paint = (v) => {
    b.replaceChildren(el("span", { className: "glb-ls-ramp-bar", style: `background:${lsGradient(v)}` }), el("span", { className: "glb-ls-ramp-name", textContent: v === "random" ? "Random colors" : v }));
  };
  paint(value);
  b.addEventListener("click", () => {
    lsPopover(b, (pop) => {
      const list = el("div", { className: "glb-ls-poplist" });
      const names = Object.keys(LS_RAMPS);
      const render = (q) => {
        const hits = names.filter((n) => !q || n.toLowerCase().includes(q) || (n === "random" && "random colors".includes(q)));
        list.replaceChildren(
          // "random" is not a ramp of its own, so it is not counted among the 300
          el("div", { className: "glb-ls-pophead", textContent: `${hits.filter((n) => n !== "random").length} of ${names.length - 1} color ramps` }),
          ...hits.map((n) => {
            const row = el("button", { type: "button", className: `glb-ls-popitem${n === value ? " is-on" : ""}` }, [
              el("span", { className: "glb-ls-ramp-bar", style: `background:${lsGradient(n)}` }),
              el("span", { textContent: n === "random" ? "Random colors" : n }),
            ]);
            row.addEventListener("click", () => { value = n; paint(n); lsClosePopover(); on(n); });
            return row;
          }),
        );
      };
      pop.append(lsSearch("Search 300 color ramps…", render), list);
      render("");
    });
  });
  return b;
}

/** KLHK styles flattened to pickable symbols: one entry per class (or per single-symbol theme). */
function lsStyleSymbols(geom) {
  if (LS.symbols?.geom === geom) return LS.symbols.list;
  const want = geom === "marker" ? "point" : geom === "line" ? "line" : "polygon";
  const list = [];
  for (const [unit, sub, name, g, , single, classes] of KLHK_STYLES) {
    if ((g || "polygon") !== want) continue;
    const theme = `${unit}${sub ? ` › ${sub}` : ""} › ${name}`;
    if (single?.[0]) list.push({ label: name, theme, sym: single });
    for (const [v, label, sym] of classes) if (sym?.[0]) list.push({ label: label || v, theme, sym });
  }
  LS.symbols = { geom, list };
  return list;
}

/** A class's symbol cell: swatch button; popover with a Color tab and a Style (KLHK SK 399) tab. */
function lsSymbolCell(row, onChange) {
  const b = el("button", { type: "button", className: "glb-ls-swatch", title: "Color or style" });
  b.style.background = row.color;
  b.addEventListener("click", () => {
    lsPopover(b, (pop) => {
      const tabs = el("div", { className: "glb-ls-poptabs" });
      const body = el("div");
      const show = (which) => {
        tabs.replaceChildren(
          ...["Color", "Style"].map((t) => {
            const tb = el("button", { type: "button", className: `glb-ls-poptab${t === which ? " is-on" : ""}`, textContent: t });
            tb.addEventListener("click", () => show(t));
            return tb;
          }),
        );
        if (which === "Color") {
          const c = el("input", { type: "color", value: row.color, className: "glb-ls-bigcolor" });
          c.addEventListener("input", () => { row.color = c.value; b.style.background = c.value; onChange(); });
          const hex = el("input", { type: "text", value: row.color, spellcheck: false });
          hex.addEventListener("change", () => { if (/^#[0-9a-f]{6}$/i.test(hex.value)) { row.color = hex.value.toLowerCase(); c.value = row.color; b.style.background = row.color; onChange(); } });
          hex.addEventListener("keydown", (e) => e.stopPropagation());
          body.replaceChildren(el("div", { className: "glb-ls-colorbox" }, [c, hex]));
        } else {
          const list = el("div", { className: "glb-ls-poplist" });
          const all = lsStyleSymbols(LS.state.geom);
          const render = (q) => {
            const hits = all.filter((s) => !q || s.label.toLowerCase().includes(q) || s.theme.toLowerCase().includes(q)).slice(0, 200);
            list.replaceChildren(
              el("div", { className: "glb-ls-pophead", textContent: `KLHK SK 399 · ${hits.length < 200 ? hits.length : "200+"} symbols` }),
              ...hits.map((s) => {
                const it = el("button", { type: "button", className: "glb-ls-popitem" }, [
                  el("span", { className: `glb-ls-swatch is-mini${s.sym[3] ? " is-hatch" : ""}`, style: `background:${s.sym[0]};border-color:${s.sym[1] || "transparent"}` }),
                  el("span", { className: "glb-ls-symtext" }, [el("span", { textContent: s.label }), el("small", { textContent: s.theme })]),
                ]);
                it.addEventListener("click", () => {
                  row.color = lsHex(s.sym[0].toLowerCase());
                  b.style.background = row.color;
                  lsClosePopover();
                  onChange();
                });
                return it;
              }),
            );
          };
          body.replaceChildren(lsSearch("Search KLHK styles (e.g. hutan, mangrove, HPT)…", render), list);
          render("");
        }
      };
      pop.append(tabs, body);
      show("Color");
    });
  });
  return b;
}

// ---- Style Manager page (KLHK SK 399 style library, ArcMap-style) ------------------

/** The layer field whose values best match a theme's class values. */
function lsBestField(theme, fieldInfo) {
  const values = new Set(theme[6].map(([v]) => String(v).toLowerCase()));
  let best = null;
  let bestHits = 0;
  for (const [name, e] of fieldInfo.fields) {
    if (theme[4] && name.toLowerCase() === theme[4].toLowerCase()) return name;
    const hits = new Set(e.values.map((x) => String(x).toLowerCase()).filter((x) => values.has(x))).size;
    if (hits > bestHits) [best, bestHits] = [name, hits];
  }
  return best;
}

/** "Match to symbols in a style": categories from the layer's values, coloured by the theme's classes. */
function lsMatchTheme(theme, field) {
  const st = LS.state;
  const byValue = new Map(theme[6].map(([v, label, sym]) => [String(v).toLowerCase(), { label: label || v, sym }]));
  const byLabel = new Map(theme[6].map(([v, label, sym]) => [String(label || v).toLowerCase(), { label: label || v, sym }]));
  const values = [...new Set((st.fieldInfo.fields.get(field)?.values ?? []).map(String))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  let matched = 0;
  st.categories = values.map((v) => {
    const hit = byValue.get(v.toLowerCase()) ?? byLabel.get(v.toLowerCase());
    if (hit?.sym?.[0]) matched += 1;
    return { on: true, value: v, label: hit ? String(hit.label) : v, color: lsHex(hit?.sym?.[0]?.toLowerCase() || "#bdbdbd") };
  });
  const firstSym = theme[6].find(([, , s]) => s?.[0])?.[2];
  if (firstSym?.[1]) st.stroke = lsHex(firstSym[1].toLowerCase());
  if (firstSym && Number.isFinite(firstSym[2]) && firstSym[2] > 0) st.strokeWidth = Math.round(firstSym[2] * 3.78 * 10) / 10; // mm to px at 96 dpi
  st.renderer = "categorized";
  st.field = field;
  return { matched, total: values.length };
}

function lsPageStyles() {
  const st = LS.state;
  const want = st.geom === "marker" ? "point" : st.geom === "line" ? "line" : "polygon";
  const themes = KLHK_STYLES.map((t, i) => [t, i]).filter(([t]) => (t[3] || "polygon") === want);
  const tree = el("div", { className: "glb-ls-tree" });
  const detail = el("div", { className: "glb-ls-detail" });
  const renderDetail = (t) => {
    if (!t) {
      detail.replaceChildren(el("p", { className: "glb-ls-note", textContent: "Pick a style to see its symbols." }));
      return;
    }
    const [unit, sub, name, , field, single, classes] = t;
    const kids = [el("div", { className: "glb-ls-pagetitle", textContent: name }), el("p", { className: "glb-ls-note", textContent: `${unit}${sub ? ` › ${sub}` : ""} · SK MENLHK 399/2024${field ? ` · field ${field}` : ""}` })];
    if (classes.length) {
      kids.push(
        lsClassTable(classes, [
          { title: "Symbol", cell: ([, , s]) => el("span", { className: `glb-ls-swatch is-mini${s?.[3] ? " is-hatch" : ""}`, style: `background:${s?.[0] || "transparent"};border-color:${s?.[1] || "transparent"}` }) },
          { title: "Value", cell: ([v]) => el("span", { textContent: v }) },
          { title: "Label", cell: ([v, l]) => el("span", { textContent: l || v }) },
        ]),
      );
      const fieldSel = lsSelect([["", "— field —"], ...[...st.fieldInfo.fields.keys()].map((k) => [k, k])], lsBestField(t, st.fieldInfo) ?? "", () => {});
      const result = el("span", { className: "glb-ls-note" });
      kids.push(lsRow("Match field", fieldSel));
      kids.push(
        el("div", { className: "glb-ls-actions" }, [
          lsBtn("Match to symbols", () => {
            if (!fieldSel.value) { result.textContent = "Choose the layer field that holds the class values."; return; }
            const { matched, total } = lsMatchTheme(t, fieldSel.value);
            result.textContent = `${matched} of ${total} values matched a style symbol.`;
            lsChanged();
          }),
          result,
        ]),
      );
    } else if (single) {
      kids.push(el("div", { className: "glb-ls-actions" }, [
        el("span", { className: `glb-ls-swatch${single[3] ? " is-hatch" : ""}`, style: `background:${single[0] || "transparent"};border-color:${single[1] || "transparent"}` }),
        lsBtn("Apply as single symbol", () => {
          Object.assign(st, { renderer: "single", fill: lsHex(single[0]?.toLowerCase()), stroke: lsHex((single[1] || st.stroke).toLowerCase()) });
          if (single[2] > 0) st.strokeWidth = Math.round(single[2] * 3.78 * 10) / 10;
          lsChanged();
        }),
      ]));
    }
    detail.replaceChildren(...kids);
  };
  const renderTree = (q) => {
    const groups = new Map();
    for (const [t, i] of themes) {
      const hay = `${t[0]} ${t[1]} ${t[2]} ${t[6].map((c) => `${c[0]} ${c[1] || ""}`).join(" ")}`.toLowerCase();
      if (q && !hay.includes(q)) continue;
      const key = `${t[0]}${t[1] ? ` › ${t[1]}` : ""}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push([t, i]);
    }
    tree.replaceChildren(
      ...[...groups].map(([key, items]) =>
        el("details", { className: "glb-ls-treegroup", open: !!q }, [
          el("summary", { textContent: `${key} (${items.length})` }),
          ...items.map(([t, i]) => {
            const b = el("button", { type: "button", className: `glb-ls-treeitem${LS.styleSel === i ? " is-on" : ""}`, textContent: t[2] });
            b.addEventListener("click", () => {
              LS.styleSel = i;
              tree.querySelectorAll(".glb-ls-treeitem.is-on").forEach((n) => n.classList.remove("is-on"));
              b.classList.add("is-on");
              renderDetail(t);
            });
            return b;
          }),
        ]),
      ),
    );
    if (!groups.size) tree.replaceChildren(el("p", { className: "glb-ls-note", textContent: "No style matches." }));
  };
  renderTree("");
  renderDetail(LS.styleSel != null ? KLHK_STYLES[LS.styleSel] : null);
  return [
    el("p", { className: "glb-ls-note", textContent: `KLHK SK MENLHK 399/2024 · ${themes.length} ${want} styles` }),
    lsSearch("Search styles or classes (hutan, HPT, mangrove)…", renderTree),
    tree,
    detail,
  ];
}

const LS_PAGES = {
  vector: [["symbology", "Symbology", lsPageSymbology], ["labels", "Labels", lsPageLabels], ["styles", "Style Manager", lsPageStyles], ["history", "History", lsPageHistory]],
  raster: [["symbology", "Symbology", lsPageSymbology], ["transparency", "Transparency", lsPageTransparency], ["history", "History", lsPageHistory]],
};

function lsRenderPage() {
  const r = LS.root;
  if (!r || !LS.state) return;
  const pages = LS_PAGES[LS.state.kind];
  if (!pages.some(([k]) => k === LS.page)) LS.page = "symbology";
  r.tabs.replaceChildren(
    ...pages.map(([k, title]) => {
      const b = el("button", { type: "button", className: `glb-ls-tab${k === LS.page ? " is-on" : ""}`, title, ariaLabel: title });
      b.append(lsIcon(k));
      b.addEventListener("click", () => { LS.page = k; lsRenderPage(); });
      return b;
    }),
  );
  const [, title, fn] = pages.find(([k]) => k === LS.page);
  r.page.replaceChildren(el("div", { className: "glb-ls-pagetitle", textContent: title }), ...fn());
}

function lsRenderFoot() {
  const r = LS.root;
  if (!r) return;
  r.undo.disabled = LS.undo.length < 2;
  r.redo.disabled = !LS.redo.length;
  r.apply.disabled = LS.live;
  r.status.textContent = LS.status || "";
}

function lsSelectLayer(id) {
  lsClosePopover();
  LS.symbols = null;
  LS.layerId = id || null;
  LS.undo = [];
  LS.redo = [];
  LS.status = "";
  const layer = lsLayers().find((l) => l.id === id);
  LS.state = !layer ? null : lsIsRaster(layer) ? lsRasterState(id) : lsStateFromStyle(id);
  if (LS.state) LS.undo.push(JSON.stringify({ ...LS.state, fieldInfo: undefined }));
  lsRenderLayers();
  if (LS.state) lsRenderPage();
  else {
    LS.root.tabs.replaceChildren();
    LS.root.page.replaceChildren(el("p", { className: "glb-ls-note", textContent: "Select a layer to style." }));
  }
  lsRenderFoot();
}

function lsRenderLayers() {
  const r = LS.root;
  if (!r) return;
  const list = lsLayers();
  r.layer.replaceChildren(el("option", { value: "", textContent: list.length ? "— choose a layer —" : "No layers" }), ...list.map((l) => el("option", { value: l.id, textContent: l.name || l.id, selected: l.id === LS.layerId })));
}

/** Open GeoLibre's own Style panel (its rail tab is hidden by the skin to avoid two styling docks). */
function lsOpenNativeStyle() {
  const b = document.querySelector('#root aside [aria-label="Expand Style"]');
  if (b) for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) uiFire(b, t);
}

function renderLayerStyling(container) {
  container.classList.add("glb-ls");
  const layer = el("select", { className: "glb-ls-layer", ariaLabel: "Layer" });
  layer.addEventListener("change", () => lsSelectLayer(layer.value));
  const tabs = el("nav", { className: "glb-ls-tabs" });
  const page = el("section", { className: "glb-ls-page" });
  const undo = el("button", { type: "button", className: "glb-ls-btn", title: "Undo", textContent: "↶" });
  const redo = el("button", { type: "button", className: "glb-ls-btn", title: "Redo", textContent: "↷" });
  const live = el("input", { type: "checkbox", checked: LS.live });
  const apply = el("button", { type: "button", className: "glb-ls-btn glb-ls-apply", textContent: "Apply" });
  const status = el("span", { className: "glb-ls-status" });
  undo.addEventListener("click", () => {
    if (LS.undo.length < 2) return;
    LS.redo.push(LS.undo.pop());
    lsRestore(LS.undo[LS.undo.length - 1]);
    lsRenderFoot();
  });
  redo.addEventListener("click", () => {
    const s = LS.redo.pop();
    if (!s) return;
    LS.undo.push(s);
    lsRestore(s);
    lsRenderFoot();
  });
  live.addEventListener("change", () => { LS.live = live.checked; lsRenderFoot(); });
  apply.addEventListener("click", () => lsApply());
  const load = el("button", { type: "button", className: "glb-ls-btn", textContent: "Load…", title: "Load a style file (.qml, .sld, .json, .lyrx)" });
  load.addEventListener("click", lsLoadStyleFile);
  const save = el("button", { type: "button", className: "glb-ls-btn", textContent: "Save…", title: "Save this style as a QGIS .qml file" });
  save.addEventListener("click", lsSaveStyleFile);
  const foot = el("footer", { className: "glb-ls-foot" }, [undo, redo, load, save, status, el("label", { className: "glb-ls-check" }, [live, el("span", { textContent: "Live update" })]), apply]);
  container.append(el("div", { className: "glb-ls-top" }, [layer]), el("div", { className: "glb-ls-body" }, [tabs, page]), foot);
  for (const evt of ["keydown", "keyup", "keypress"]) container.addEventListener(evt, (e) => e.stopPropagation());
  LS.root = { container, layer, tabs, page, undo, redo, apply, status };
  // follow the layer the user selects in the Layers panel, like QGIS's dock
  let lastSel = null;
  const follow = () => {
    lsRenderLayers();
    const sel = state.app?.getSelectedLayerId?.() ?? null;
    if (sel && sel !== lastSel) {
      lastSel = sel;
      if (sel !== LS.layerId) lsSelectLayer(sel);
    } else if (!LS.layerId) lsSelectLayer(lsLayers()[0]?.id ?? "");
  };
  const unsubLayers = state.app?.onLayersChanged?.(follow);
  const poll = setInterval(follow, 1500);
  follow();
  return () => {
    clearInterval(poll);
    if (typeof unsubLayers === "function") unsubLayers();
    LS.root = null;
  };
}

function registerLayerStyling(app) {
  if (!app.registerRightPanel || state.disposeStyling) return;
  // shares one rail with GeoLibre's own Style panel, so there are never two styling rails
  state.disposeStyling = app.registerRightPanel({ id: LS_PANEL_ID, title: "Layer Styling", defaultWidth: 360, dock: "replace-style", render: renderLayerStyling });
}

// ---------------------------------------------------------------------------
// Toolbox dock (right sidebar), laid out like ArcMap's ArcToolbox: toolboxes ›
// toolsets › tools, searchable. The catalog is read from GeoLibre's own
// Processing menu (so it always matches the installed version), cached, and
// each tool runs by walking its real menu path, which opens GeoLibre's dialog.
// ---------------------------------------------------------------------------

const TB_PANEL_ID = `${PLUGIN_ID}-toolbox`;
const TB_CACHE_KEY = `${PLUGIN_ID}:toolbox-catalog`;
const TB = { catalog: null, scanning: false, root: null, query: "", open: new Set() };
const TB_CATEGORIES = ["Conversion", "Hydrology", "LiDAR", "Network", "Projection", "Raster", "Remote Sensing", "Terrain", "Vector", "GeoLibre Toolbox"];
// Processing entries that are apps rather than single tools
const TB_UTILITIES = ["Raster Calculator", "Model Builder", "SQL Workspace", "Python Console", "Jupyter Notebook", "Whitebox Toolbox", "Object-Based Analysis", "History"];

const tbSleep = (ms) => new Promise((r) => setTimeout(r, ms));
// labels read back with the app's original name, so menu paths stay stable under the rebrand
const tbLabel = (it) => unbrand((it.innerText || "").trim().split("\n")[0]);
const tbOpenMenus = () => [...document.querySelectorAll("[role=menu]")].filter((m) => m.getBoundingClientRect().width > 0);

function tbPointer(el, type) {
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "mouse", clientX: r.left + 10, clientY: r.top + r.height / 2 }));
}

async function tbCloseMenus() {
  for (let i = 0; i < 4 && tbOpenMenus().length; i++) {
    (document.activeElement || document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tbSleep(60);
  }
}

/** Open Processing and walk `path` through its submenus; returns the last menu (or null). */
async function tbWalk(path) {
  await tbCloseMenus();
  const btn = [...document.querySelectorAll("#root header > button")].find((b) => tbLabel(b) === "Processing");
  if (!btn) return null;
  tbPointer(btn, "pointerdown");
  btn.click();
  await tbSleep(280);
  let menu = tbOpenMenus()[0];
  for (const step of path) {
    const it = menu && [...menu.querySelectorAll("[role=menuitem]")].find((x) => tbLabel(x) === step);
    if (!it) return null;
    tbPointer(it, "pointermove");
    tbPointer(it, "pointerenter");
    it.focus();
    it.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await tbSleep(260);
    const ms = tbOpenMenus();
    menu = ms[ms.length - 1];
  }
  return menu;
}

async function tbItems(path) {
  const menu = await tbWalk(path);
  const items = menu ? [...menu.querySelectorAll("[role=menuitem]")].map((x) => [tbLabel(x), x.getAttribute("aria-haspopup") === "menu"]) : [];
  await tbCloseMenus();
  return items;
}

/** Read the whole Processing menu into [{ path: [cat, group?, tool], name }]. */
async function tbScan(progress) {
  const tools = [];
  for (const [i, cat] of TB_CATEGORIES.entries()) {
    progress?.(`Reading ${cat} (${i + 1}/${TB_CATEGORIES.length})…`);
    for (const [g, sub] of await tbItems([cat])) {
      if (!sub) {
        tools.push({ path: [cat, g], name: g });
        continue;
      }
      for (const [t, deeper] of await tbItems([cat, g])) if (!deeper) tools.push({ path: [cat, g, t], name: t });
    }
  }
  return tools;
}

/** Run a tool: walk its menu path and click it. */
async function tbRun(path) {
  agentOn?.(`Toolbox “${path[path.length - 1]}”`);
  const menu = await tbWalk(path.slice(0, -1));
  const it = menu && [...menu.querySelectorAll("[role=menuitem]")].find((x) => tbLabel(x) === path[path.length - 1]);
  if (!it) {
    await tbCloseMenus();
    agentOff?.(0);
    return false;
  }
  it.click();
  agentOff?.(600);
  return true;
}

// ---- ArcToolbox-style grouping ---------------------------------------------------

const TB_MATH = /^(abs|arc\w*|ar\w*h|atan2|ceil|cos|cosh|exp2?|floor|ln|log10|log2|negate|reciprocal|round|sin|sinh|sqrt|square|tan|tanh|to degrees|to radians|truncate|integer division|modulo|power|add|subtract|multiply|divide|increment|decrement|inplace \w+|min|max|is nodata)$/i;
const TB_LOGICAL = /^(equal to|not equal to|greater than|greaterthanorequalto|less than|lessthanorequalto|bool \w+)$/i;

function tbVectorSet(n) {
  if (/buffer|near\b|thiessen|voronoi|proximity|distance band|summarize nearby/i.test(n)) return ["Analysis Tools", "Proximity"];
  if (/^clip|select|split by|subset|extract by|random extract|line polygon clip/i.test(n)) return ["Analysis Tools", "Extract"];
  if (/intersect|union|erase|identity|difference|overlap|summarize within|tabulate|spatial join|symmetrical|update|apportion|areal interpolation/i.test(n)) return ["Analysis Tools", "Overlay"];
  if (/route|events?\b|linear referenc|calibrate/i.test(n)) return ["Linear Referencing Tools", "Routes and Events"];
  if (/kriging|interpolat|variogram|semivariogram|geostat/i.test(n)) return ["Geostatistical Analyst Tools", "Interpolation"];
  if (/hot ?spot|cluster|moran|regression|getis|ripley|outlier|forecast|time series|colocation|autocorrelation|spatial weights|similarity|bivariate|dimension reduction|causal|change point|central feature|median center|directional (distribution|mean|trend)|nearest neighbou?r index|pattern|quadrat|envelope|process|eighty twenty|incident/i.test(n)) return ["Spatial Statistics Tools", "Analyzing Patterns"];
  if (/simplify|smooth|collapse|generali[sz]e|resolve|disperse|thin road|cartogram|masks?\b|cartographic|building|merge divided|edges/i.test(n)) return ["Cartography Tools", "Generalization"];
  if (/3d|\bz\b|multipatch|sight|intervisib|surface|volume|extrude|fence|voxel|sun shadow|underpass|overpass/i.test(n)) return ["3D Analyst Tools", "3D Features"];
  if (/field|attribute|pivot|transpose|table|statistics|summary|histogram|scattergram|correlation|unique values|join/i.test(n)) return ["Data Management Tools", "Fields and Tables"];
  if (/grid|hex|tin\b|contour|sampling|points? (in|along)|random points|transects|footprint|medoid|nodes|extract raster values/i.test(n)) return ["Data Management Tools", "Sampling"];
  if (/project|coordinate|utm|meridian|convergence|transform|rubbersheet|edgematch|align/i.test(n)) return ["Data Management Tools", "Projections and Transformations"];
  if (/area|perimeter|compactness|elongation|axis|shape|hole proportion|linearity|narrowness|orientation|circumscribing/i.test(n)) return ["Spatial Statistics Tools", "Measuring Geographic Distributions"];
  return ["Data Management Tools", "Features"];
}

function tbRasterSet(n) {
  if (/raster calculator|map algebra|conditional|con\b|setnull/i.test(n)) return ["Spatial Analyst Tools", "Map Algebra"];
  if (TB_LOGICAL.test(n)) return ["Spatial Analyst Tools", "Math › Logical"];
  if (TB_MATH.test(n)) return ["Spatial Analyst Tools", "Math"];
  if (/reclass|slice|rescale/i.test(n)) return ["Spatial Analyst Tools", "Reclass"];
  if (/zonal|zone/i.test(n)) return ["Spatial Analyst Tools", "Zonal"];
  if (/kriging|cokriging|bayesian|geostatistical|variogram/i.test(n)) return ["Geostatistical Analyst Tools", "Interpolation"];
  if (/interpolat|idw|tin |shepard|radial basis|natural neighbou?r|nearest neighbou?r interp|trend surface|spline|topo to raster/i.test(n)) return ["Spatial Analyst Tools", "Interpolation"];
  if (/cost|path distance|corridor|euclidean|back link|buffer raster|allocation|darcy|porous/i.test(n)) return ["Spatial Analyst Tools", "Distance"];
  if (/focal|block|neighbou?rhood|point statistics|line statistics|filter|majority/i.test(n)) return ["Spatial Analyst Tools", "Neighborhood"];
  if (/density|heat map/i.test(n)) return ["Spatial Analyst Tools", "Density"];
  if (/overlay|weighted|highest position|lowest position|percent (equal|greater|less)|pick from list|count if|fuzzy|multicriteria/i.test(n)) return ["Spatial Analyst Tools", "Overlay"];
  if (/random forest|dbscan|pca|principal|cluster|classification|maximum likelihood|presence-only/i.test(n)) return ["Spatial Analyst Tools", "Multivariate"];
  if (/sar\b|interferogram|coherence|multilook|phase|ocean|thermal noise|terrain flattening|radiometric|calibration/i.test(n)) return ["Image Analyst Tools", "SAR"];
  if (/ccdc|landtrendr|spectral|anomal|composite bands|coregister|multidimensional|time series|trend raster|change/i.test(n)) return ["Image Analyst Tools", "Multidimensional Analysis"];
  if (/reproject|warp|split raster|assign projection|subset|render|mosaic|resample|clip raster|erase polygon|geotiff/i.test(n)) return ["Data Management Tools", "Raster"];
  if (/solar|observer|surface|cut fill|contour|dem|hillshade|slope|aspect/i.test(n)) return ["Spatial Analyst Tools", "Surface"];
  if (/statistic|histogram|quantile|anova|test|kappa|correlation|regression|z scores|root mean|area|perimeter|cross tab/i.test(n)) return ["Spatial Analyst Tools", "Statistics"];
  return ["Spatial Analyst Tools", "Generalization"];
}

function tbGroup(tool) {
  const [cat, group] = tool.path;
  const n = tool.name;
  switch (cat) {
    case "Hydrology": return ["Spatial Analyst Tools", "Hydrology"];
    case "Terrain": return group === "Visibility" ? ["3D Analyst Tools", "Visibility"] : ["Spatial Analyst Tools", "Surface"];
    case "Network": return ["Network Analyst Tools", "Analysis"];
    case "Projection": return ["Data Management Tools", "Projections and Transformations"];
    case "LiDAR": return ["LAS Dataset Tools", group === "GeoLibre (WASM)" ? "Management" : group];
    case "Remote Sensing": return ["Image Analyst Tools", group];
    case "Conversion": return ["Conversion Tools", group === "GeoLibre (WASM)" ? "To / From Formats" : group];
    case "Vector":
      if (group === "Linear Referencing") return ["Linear Referencing Tools", "Routes and Events"];
      if (group === "Spatial Statistics") return ["Spatial Statistics Tools", "Analyzing Patterns"];
      if (group === "Attribute Analysis") return ["Data Management Tools", "Fields and Tables"];
      if (group === "Sampling & Gridding") return ["Data Management Tools", "Sampling"];
      if (group === "Shape Metrics") return ["Spatial Statistics Tools", "Measuring Geographic Distributions"];
      if (group === "Online Data") return ["Conversion Tools", "Online Data"];
      return tbVectorSet(n);
    case "Raster":
      if (group === "Distance & Cost") return ["Spatial Analyst Tools", "Distance"];
      if (group === "Local Neighborhood") return tbRasterSet(n)[1] === "Interpolation" ? ["Spatial Analyst Tools", "Interpolation"] : ["Spatial Analyst Tools", "Neighborhood"];
      if (group === "Reclassify & Mask") return ["Spatial Analyst Tools", n === "Conditional Evaluation" ? "Map Algebra" : "Reclass"];
      if (group === "Spatial Statistics") return ["Geostatistical Analyst Tools", "Interpolation"];
      return tbRasterSet(n);
    case "GeoLibre Toolbox":
      if (group === "Conversion") return ["Conversion Tools", "To / From Formats"];
      if (group === "Network") return ["Network Analyst Tools", "Analysis"];
      if (group === "Spatial Statistics") return ["Spatial Statistics Tools", "Analyzing Patterns"];
      if (group === "Raster") return tbRasterSet(n);
      if (group === "Vector") return tbVectorSet(n);
      if (group === "DGGS") return ["Data Management Tools", "Discrete Global Grids"];
      if (/segment|detect/i.test(n)) return ["Image Analyst Tools", "Deep Learning"];
      if (/geocode/i.test(n)) return ["Geocoding Tools", "Geocoding"];
      return ["Data Management Tools", "General"];
    default: return ["Data Management Tools", "General"];
  }
}

/** Toolbox › toolset › [tools], one entry per tool name per toolset (no duplicates). */
function tbTree(tools) {
  const tree = new Map();
  const seen = new Set();
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  // GeoLibre's own toolbox first, then the WASM ports, then the rest, so the friendliest version wins
  const rank = (t) => (t.path[0] === "GeoLibre Toolbox" ? 0 : t.path[1] === "GeoLibre (WASM)" ? 1 : 2);
  for (const t of [...tools].sort((a, b) => rank(a) - rank(b))) {
    const [box, set] = tbGroup(t);
    const key = `${box}|${set}|${norm(t.name)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!tree.has(box)) tree.set(box, new Map());
    const sets = tree.get(box);
    if (!sets.has(set)) sets.set(set, []);
    sets.get(set).push(t);
  }
  for (const sets of tree.values()) for (const list of sets.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  return new Map([...tree].sort(([a], [b]) => a.localeCompare(b)));
}

// ---- UI -------------------------------------------------------------------------------

const TB_ICONS = {
  box: '<g fill="none" stroke="#c97b76" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><rect x="1.8" y="5.5" width="12.4" height="8" rx=".8"/><path d="M5.8 5.5V3.6h4.4v1.9M1.8 9h12.4M7 8v2h2V8"/></g>',
  set: '<g fill="none" stroke="#c8a85a" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 4h5l1.2 1.5h6.8v7.5h-13z"/></g>',
  tool: '<g fill="none" stroke="#6f97c2" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 13.5 7 9M13.5 13.5 9 9M7 9c-1.2-1.2-1.5-3.2-.6-5.6l1.6-1.4 1.6 1.4c.9 2.4.6 4.4-.6 5.6"/><circle cx="8" cy="8.4" r=".7"/></g>',
  util: '<g fill="none" stroke="#5fa58a" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="2.5" width="11" height="11" rx="1.2"/><path d="M5 8h6M8 5v6"/></g>',
};

function tbIcon(name) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", "glb-tb-ico");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = TB_ICONS[name] ?? "";
  return svg;
}

function tbLoadCache() {
  try {
    const c = JSON.parse(localStorage.getItem(TB_CACHE_KEY) || "null");
    return Array.isArray(c?.tools) && c.tools.length ? c.tools : null;
  } catch {
    return null;
  }
}

async function tbEnsureCatalog(force = false) {
  if (!force && (TB.catalog ||= tbLoadCache())) return TB.catalog;
  if (TB.scanning) return null;
  TB.scanning = true;
  tbRender();
  try {
    const tools = await tbScan((msg) => { TB.status = msg; tbRender(); });
    if (tools.length) {
      TB.catalog = tools;
      try {
        localStorage.setItem(TB_CACHE_KEY, JSON.stringify({ at: Date.now(), tools }));
      } catch {
        /* storage full: keep it for this session */
      }
    }
    TB.status = `${tools.length} tools`;
  } finally {
    TB.scanning = false;
    tbRender();
  }
  return TB.catalog;
}

function tbRow(cls, icon, text, onClick, count) {
  const b = el("button", { type: "button", className: `glb-tb-row ${cls}` }, [tbIcon(icon), el("span", { className: "glb-tb-name", textContent: text }), ...(count != null ? [el("span", { className: "glb-tb-count", textContent: String(count) })] : [])]);
  b.addEventListener("click", onClick);
  return b;
}

function tbRender() {
  const r = TB.root;
  if (!r) return;
  r.status.textContent = TB.scanning ? TB.status || "Reading the Processing menu…" : TB.catalog ? `${TB.catalog.length} tools from GeoLibre's Processing menu` : "";
  r.rescan.disabled = TB.scanning;
  if (!TB.catalog) {
    r.tree.replaceChildren(el("p", { className: "glb-ls-note", textContent: TB.scanning ? "First open: reading every Processing category once (about a minute). It is cached afterwards." : "No tools yet." }));
    return;
  }
  const q = TB.query;
  const tree = tbTree(TB.catalog);
  const kids = [];
  // utilities (apps), like ArcToolbox's favourites at the top
  const utils = TB_UTILITIES.filter((u) => !q || u.toLowerCase().includes(q));
  if (utils.length) {
    kids.push(el("div", { className: "glb-tb-section", textContent: "Utilities" }));
    for (const u of utils) {
      kids.push(tbRow("is-tool", "util", u, () => {
        // Raster Calculator lives in GeoLibre's toolbox; the rest are top-level Processing entries
        if (u === "Raster Calculator") tbRun(["GeoLibre Toolbox", "Raster", "Raster calculator"]);
        else tbRun([u]);
      }));
    }
  }
  for (const [box, sets] of tree) {
    const all = [...sets].flatMap(([set, list]) => list.filter((t) => !q || `${t.name} ${set} ${box}`.toLowerCase().includes(q)).map((t) => [set, t]));
    if (!all.length) continue;
    const openBox = !!q || TB.open.has(box);
    kids.push(tbRow("is-box", "box", box, () => { TB.open.has(box) ? TB.open.delete(box) : TB.open.add(box); tbRender(); }, all.length));
    if (!openBox) continue;
    for (const [set, list] of sets) {
      const hits = list.filter((t) => !q || `${t.name} ${set} ${box}`.toLowerCase().includes(q));
      if (!hits.length) continue;
      const key = `${box}|${set}`;
      const openSet = !!q || TB.open.has(key);
      kids.push(tbRow("is-set", "set", set, () => { TB.open.has(key) ? TB.open.delete(key) : TB.open.add(key); tbRender(); }, hits.length));
      if (!openSet) continue;
      for (const t of hits) {
        const row = tbRow("is-tool", "tool", t.name, () => tbRun(t.path));
        row.title = `Processing › ${t.path.join(" › ")}`;
        kids.push(row);
      }
    }
  }
  if (!kids.length) kids.push(el("p", { className: "glb-ls-note", textContent: "No tool matches." }));
  r.tree.replaceChildren(...kids);
}

function renderToolbox(container) {
  container.classList.add("glb-tb");
  const search = el("input", { type: "search", className: "glb-ls-search", placeholder: "Search tools (buffer, slope, clip, zonal…)" });
  search.addEventListener("input", () => { TB.query = search.value.trim().toLowerCase(); tbRender(); });
  search.addEventListener("keydown", (e) => e.stopPropagation());
  const tree = el("div", { className: "glb-tb-tree" });
  const status = el("span", { className: "glb-ls-status" });
  const rescan = el("button", { type: "button", className: "glb-ls-btn", textContent: "Rescan", title: "Read the Processing menu again (after a GeoLibre update)" });
  rescan.addEventListener("click", () => tbEnsureCatalog(true));
  container.append(el("div", { className: "glb-ls-top" }, [search]), tree, el("footer", { className: "glb-ls-foot" }, [status, rescan]));
  TB.root = { container, tree, status, rescan };
  tbRender();
  tbEnsureCatalog();
  return () => {
    TB.root = null;
  };
}

function registerToolbox(app) {
  if (!app.registerRightPanel || state.disposeToolbox) return;
  state.disposeToolbox = app.registerRightPanel({ id: TB_PANEL_ID, title: "Toolbox", defaultWidth: 340, render: renderToolbox });
}

// ---------------------------------------------------------------------------
// Katalog Data: open web data in one searchable, categorised dock.
//   Forest Watch  GFW tiles decoded in the browser like globalforestwatch.org
//                 (tree cover loss by year, deforestation alerts, primary forest)
//                 plus area analysis (ha per year / month) for the view or a
//                 polygon layer, read from the same tiles, so no API key.
//   Biodiversity  GBIF and iNaturalist (density tiles, occurrences in view).
//   Hazards       BMKG and USGS earthquakes, PetaBencana reports, Open-Meteo.
//   Government    Indonesian ArcGIS REST catalogues (BIG RBI, BNPB, any URL)
//                 browsed live, plus the national portals.
//   Places        Nominatim search with boundaries, reverse lookup.
// Every endpoint answers without a key and allows CORS (checked 2026-10-26).
// ---------------------------------------------------------------------------

const DC_PANEL_ID = "glb-data-catalog";
const DC = { root: null, query: "", open: new Set(["Forest Watch", "Basemap & rupa bumi"]), expanded: new Set(), result: null, status: "" };

async function dcJson(url, init) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30000);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText || ""}`.trim());
    return await res.json();
  } catch (err) {
    throw new Error(err?.name === "AbortError" ? "waktuna béak (30 detik)" : err?.message ?? String(err));
  } finally {
    clearTimeout(timer);
  }
}

/** Visible map extent as [west, south, east, north], clamped to the web-mercator world. */
function dcView() {
  const b = currentMap()?.getBounds?.();
  if (!b) throw new Error("Peta teu acan siap.");
  const v = [Math.max(-180, b.getWest()), Math.max(-85, b.getSouth()), Math.min(180, b.getEast()), Math.min(85, b.getNorth())];
  if (!acehFocus()) return v;
  const c = [Math.max(v[0], ACEH.max[0]), Math.max(v[1], ACEH.max[1]), Math.min(v[2], ACEH.max[2]), Math.min(v[3], ACEH.max[3])];
  if (c[0] >= c[2] || c[1] >= c[3]) throw new Error("Tempoan peta aya di luar Acéh.");
  return c;
}

function dcCenter() {
  const c = currentMap()?.getCenter?.();
  if (!c) throw new Error("Peta teu acan siap.");
  return { lat: Math.round(c.lat * 1e5) / 1e5, lon: Math.round(c.lng * 1e5) / 1e5 };
}

function dcStatus(text) {
  DC.status = text;
  if (DC.root) DC.root.status.textContent = text;
}

/** Show a result card: title, rows of [label, value], optional bars and buttons. */
function dcShow(title, rows = [], { lead = "", bars = null, chart = null, actions = [] } = {}) {
  DC.disposeChart?.();
  DC.disposeChart = null;
  const plot = chart ? el("div", { className: "glb-dc-chart" }) : null;
  if (plot) DC.disposeChart = renderChartInto(plot, chart, { height: 230 });
  DC.result = el("section", { className: "glb-dc-result" }, [
    el("header", {}, [el("b", { textContent: title }), dcBtn("×", () => { DC.disposeChart?.(); DC.disposeChart = null; DC.result = null; dcRender(); }, "Tutup")]),
    ...(lead ? [el("p", { className: "glb-dc-lead", textContent: lead })] : []),
    ...rows.map(([k, v]) => el("div", { className: "glb-dc-kv" }, [el("span", { textContent: k }), el("b", { textContent: String(v) })])),
    ...(plot ? [plot] : bars ? [dcBars(bars)] : []),
    ...(actions.length ? [el("div", { className: "glb-dc-actions" }, actions)] : []),
  ]);
  dcRender();
}

function dcBars(bars) {
  const max = Math.max(...bars.map(([, v]) => v), 1e-9);
  return el("div", { className: "glb-dc-bars" }, bars.map(([k, v]) =>
    el("div", { className: "glb-dc-bar" }, [
      el("span", { textContent: k }),
      el("i", { style: `width:${Math.max(1, (v / max) * 100)}%` }),
      el("b", { textContent: dcHa(v) }),
    ])));
}

const dcHa = (v) => (v >= 100 ? Math.round(v).toLocaleString("id-ID") : v.toLocaleString("id-ID", { maximumFractionDigits: 1 }));

function dcBtn(text, onClick, title = "") {
  const b = el("button", { type: "button", className: "glb-ls-btn", textContent: text, title });
  b.addEventListener("click", async (e) => {
    e.stopPropagation();
    b.disabled = true;
    try {
      await onClick();
    } catch (err) {
      dcStatus(`Gagal: ${err?.message ?? err}`);
    } finally {
      b.disabled = false;
    }
  });
  return b;
}

function dcInput(placeholder, value = "") {
  const i = el("input", { type: "search", className: "glb-ls-search", placeholder, value });
  i.addEventListener("keydown", (e) => e.stopPropagation());
  return i;
}

function dcAddGeoJson(name, features) {
  const app = requireApp();
  if (!features.length) {
    dcStatus(`${name}: euweuh data dina wewengkon ieu.`);
    return null;
  }
  const id = app.addGeoJsonLayer(name, { type: "FeatureCollection", features });
  dcStatus(`${name}: ${features.length.toLocaleString("id-ID")} fitur diasupkeun.`);
  return id;
}

function dcAddTiles(name, url, options = {}) {
  const app = requireApp();
  if (!app.addTileLayer) throw new Error("Vérsi ieu can boga addTileLayer().");
  const id = app.addTileLayer(name, url, acehFocus() && !options.bounds ? { ...options, bounds: ACEH.max } : options);
  dcStatus(`${name} diasupkeun kana lapisan.`);
  return id;
}

function dcOpenUrl(url) {
  if (state.app?.openExternalUrl) state.app.openExternalUrl(url);
  else window.open(url, "_blank", "noopener");
}

const dcPoint = (lon, lat, properties) => ({ type: "Feature", geometry: { type: "Point", coordinates: [Number(lon), Number(lat)] }, properties });

// ---- web-mercator tile maths ---------------------------------------------------------

const dcLonPx = (lon, z, s) => ((lon + 180) / 360) * 2 ** z * s;
const dcLatPx = (lat, z, s) => {
  const r = (Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z * s;
};
const dcPxLon = (x, z, s) => (x / (2 ** z * s)) * 360 - 180;
const dcPxLat = (y, z, s) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / (2 ** z * s)))) * 180) / Math.PI;

// ---- Forest Watch (Global Forest Watch data tiles) -----------------------------------

const GFW_TILES = "https://tiles.globalforestwatch.org";
const GFW_EPOCH = Date.UTC(2014, 11, 31); // alert dates are days since this day
const GFW_DAY = 86400000;
const gfwDate = (day) => new Date(GFW_EPOCH + day * GFW_DAY);
const gfwToday = () => Math.floor((Date.now() - GFW_EPOCH) / GFW_DAY);
// alert tiles: day = R·255 + G, confidence = floor(B / 100) − 1 (decode of wri/gfw)
const gfwAlert = (r, g, b, o) => {
  const day = r * 255 + g;
  if (!day || day < gfwToday() - o.days) return null;
  return { day, high: Math.floor(b / 100) - 1 >= 1 };
};
// alerts are counted per week (Monday), split by confidence, like GFW's alert widget
const gfwWeek = (day) => {
  const d = gfwDate(day);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};
const gfwAlertBucket = (r, g, b, a, o) => {
  const x = gfwAlert(r, g, b, o);
  return x ? [gfwWeek(x.day), 1, x.high ? "Kapercayaan luhur" : "Kapercayaan handap"] : null;
};

// key → data tiles and how each pixel is drawn (`paint`) and counted (`bucket`)
const FW_LAYERS = {
  loss: {
    name: "Kahilangan tutupan tangkal (UMD/Hansen)",
    path: "umd_tree_cover_loss/latest/dynamic",
    maxZ: 12,
    size: 512,
    unit: "taun",
    color: "#dc6699",
    // R = intensity, B = loss year − 2000
    paint: (r, g, b, a, o) => (a && b >= 1 && 2000 + b >= o.from && 2000 + b <= o.to ? [220, 102, 153, Math.max(110, r)] : null),
    bucket: (r, g, b, a, o) => (a && b >= 1 && 2000 + b >= o.from && 2000 + b <= o.to ? [String(2000 + b), r / 255] : null),
  },
  integrated: {
    name: "Peringatan déforéstasi terpadu (GLAD+RADD)",
    path: "gfw_integrated_alerts/latest/default",
    maxZ: 12,
    unit: "minggu",
    color: "#ed1546",
    paint: (r, g, b, a, o) => { const x = gfwAlert(r, g, b, o); return x ? (x.high ? [237, 21, 70, 255] : [255, 150, 170, 230]) : null; },
    bucket: gfwAlertBucket,
  },
  glad: {
    name: "Peringatan GLAD-L (Landsat)",
    path: "umd_glad_landsat_alerts/latest/default",
    maxZ: 12,
    unit: "minggu",
    color: "#e85c9b",
    paint: (r, g, b, a, o) => (gfwAlert(r, g, b, o) ? [232, 92, 155, 255] : null),
    bucket: gfwAlertBucket,
  },
  radd: {
    name: "Peringatan RADD (radar Sentinel-1)",
    path: "wur_radd_alerts/latest/default",
    maxZ: 12,
    unit: "minggu",
    color: "#f2a33a",
    paint: (r, g, b, a, o) => (gfwAlert(r, g, b, o) ? [242, 163, 58, 255] : null),
    bucket: gfwAlertBucket,
  },
  primary: {
    name: "Leuweung primér 2001 (tropis lembab)",
    path: "umd_regional_primary_forest_2001/latest/dynamic",
    maxZ: 12,
    color: "#668636",
    paint: (r, g, b) => (r || g || b ? [102, 134, 54, 200] : null),
    bucket: (r, g, b) => (r || g || b ? ["Leuweung primér", 1] : null),
  },
};

// Mapzen elevation, drawn and counted by the same engine (shown under Basemap, not Forest Watch)
FW_LAYERS.elev = {
  name: "Jangkungna (Mapzen Terrain)",
  group: "terrain",
  url: (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
  source: "Mapzen Terrain Tiles (AWS Open Data)",
  maxZ: 11,
  unit: "m",
  color: "#b88a60",
  paint: (r, g, b) => { const c = trColor(trHeight(r, g, b)); return c ? [...c, 170] : null; },
  bucket: (r, g, b) => { const h = trHeight(r, g, b); if (!(h > 0)) return null; const lo = Math.floor(h / 250) * 250; return [`${lo}–${lo + 250}`, 1]; },
  sort: (a, b) => parseFloat(a) - parseFloat(b),
  barColors: (k) => { const c = trColor(parseFloat(k) + 125); return `rgb(${c.join(",")})`; },
};

// ready-made (already coloured) GFW tiles, added as normal tile layers
const FW_TILE_LAYERS = [
  ["Tambahan tutupan tangkal 2000–2020", "umd_tree_cover_gain_from_height/latest/default"],
  ["Lahan gambut", "gfw_peatlands/latest/default"],
  ["Émisi karbon kotor leuweung", "gfw_forest_carbon_gross_emissions/latest/default"],
];

const FW = { on: new Set(), opts: { from: 2001, to: new Date().getFullYear() - 1, days: 180 }, cache: new Map(), tok: 0, map: null, timer: null, last: new Map() };

/** One GFW data tile as ImageData (cached), or null where GFW has no tile. */
async function fwTile(key, z, x, y) {
  const L = FW_LAYERS[key];
  const url = L.url ? L.url(z, x, y) : `${GFW_TILES}/${L.path}/${z}/${x}/${y}.png`;
  if (FW.cache.has(url)) return FW.cache.get(url);
  let data = null;
  try {
    const res = await fetch(url);
    if (res.ok) {
      const bmp = await createImageBitmap(await res.blob(), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
      const c = el("canvas", { width: bmp.width, height: bmp.height });
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      data = ctx.getImageData(0, 0, bmp.width, bmp.height);
    }
  } catch {
    data = null;
  }
  if (FW.cache.size > 400) FW.cache.delete(FW.cache.keys().next().value);
  FW.cache.set(url, data);
  return data;
}

/** Run `work` over `items` with a few requests in flight. */
async function dcPool(items, work, n = 8) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await work(items[i++]);
  }));
}

/** Redraw every switched-on Forest Watch overlay for the current view. */
async function fwRefresh() {
  const map = currentMap();
  if (!map) return;
  fwHook(map);
  const tok = ++FW.tok;
  for (const id of Object.keys(FW_LAYERS)) if (!FW.on.has(id)) fwDrop(map, id);
  for (const key of FW.on) {
    const L = FW_LAYERS[key];
    const [w, s, e, n] = dcView();
    let z = Math.max(2, Math.min(L.maxZ, Math.round(map.getZoom())));
    let t;
    for (;;) {
      const m = 2 ** z;
      t = { x0: Math.floor(((w + 180) / 360) * m), x1: Math.floor(((e + 180) / 360) * m - 1e-9), y0: Math.floor(dcLatPx(n, z, 1)), y1: Math.floor(dcLatPx(s, z, 1) - 1e-9) };
      if ((t.x1 - t.x0 + 1) * (t.y1 - t.y0 + 1) <= 30 || z <= 2) break;
      z--;
    }
    const jobs = [];
    for (let x = t.x0; x <= t.x1; x++) for (let y = t.y0; y <= t.y1; y++) jobs.push([x, y]);
    const tiles = new Map();
    await dcPool(jobs, async ([x, y]) => tiles.set(`${x}/${y}`, await fwTile(key, z, x, y)));
    if (tok !== FW.tok) return; // the view moved on
    const S = [...tiles.values()].find(Boolean)?.width ?? 256;
    const cols = t.x1 - t.x0 + 1;
    const rows = t.y1 - t.y0 + 1;
    const canvas = el("canvas", { width: cols * S, height: rows * S });
    const ctx = canvas.getContext("2d");
    const out = ctx.createImageData(cols * S, rows * S);
    for (const [k, img] of tiles) {
      if (!img) continue;
      const [x, y] = k.split("/").map(Number);
      const ox = (x - t.x0) * S;
      const oy = (y - t.y0) * S;
      const src = img.data;
      const step = img.width / S; // tiles of another size are sampled to S
      for (let py = 0; py < S; py++) {
        for (let px = 0; px < S; px++) {
          const si = ((Math.floor(py * step) * img.width) + Math.floor(px * step)) * 4;
          const c = L.paint(src[si], src[si + 1], src[si + 2], src[si + 3], FW.opts);
          if (!c) continue;
          const di = ((oy + py) * cols * S + ox + px) * 4;
          out.data[di] = c[0]; out.data[di + 1] = c[1]; out.data[di + 2] = c[2]; out.data[di + 3] = c[3];
        }
      }
    }
    ctx.putImageData(out, 0, 0);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    if (tok !== FW.tok || !blob) return;
    const url = URL.createObjectURL(blob);
    const W = dcPxLon(t.x0, z, 1), E = dcPxLon(t.x1 + 1, z, 1), N = dcPxLat(t.y0, z, 1), Sth = dcPxLat(t.y1 + 1, z, 1);
    const coordinates = [[W, N], [E, N], [E, Sth], [W, Sth]];
    const prev = FW.last.get(key);
    FW.last.set(key, { url, coordinates });
    fwPut(map, key);
    if (prev) setTimeout(() => URL.revokeObjectURL(prev.url), 2000);
  }
}

function fwPut(map, key) {
  const id = `glb-fw-${key}`;
  const img = FW.last.get(key);
  if (!img) return;
  const src = map.getSource(id);
  if (src?.updateImage) src.updateImage(img);
  else {
    map.addSource(id, { type: "image", ...img });
    map.addLayer({ id, type: "raster", source: id, paint: { "raster-opacity": 0.9, "raster-fade-duration": 0, "raster-resampling": "nearest" } });
  }
}

function fwDrop(map, key) {
  const id = `glb-fw-${key}`;
  if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(id)) map.removeSource(id);
  const prev = FW.last.get(key);
  if (prev) URL.revokeObjectURL(prev.url);
  FW.last.delete(key);
}

/** Follow the camera, and put the overlays back after a basemap/style swap. */
function fwHook(map) {
  if (FW.map === map) return;
  FW.map = map;
  map.on("moveend", () => {
    if (!FW.on.size) return;
    clearTimeout(FW.timer);
    FW.timer = setTimeout(fwRefresh, 300);
  });
  map.on("styledata", () => {
    for (const key of FW.on) if (!map.getSource(`glb-fw-${key}`)) try { fwPut(map, key); } catch { /* style still loading */ }
  });
}

function fwOff() {
  const map = currentMap();
  if (map) for (const key of [...FW.on]) fwDrop(map, key);
  FW.on.clear();
}

// ---- areas: the view, Aceh, its kabupaten (BIG), or a polygon layer ----------------------

const BIG_KAB = "https://geoservices.big.go.id/rbi/rest/services/BATASWILAYAH/BATAS_KABKOTA_AR/MapServer/0";
let acehKabPromise = null;

/** Aceh's kabupaten/kota boundaries from BIG (simplified), fetched once. */
function acehKab() {
  acehKabPromise ??= dcJson(`${BIG_KAB}/query?where=${encodeURIComponent("WADMPR='Aceh'")}&outFields=NAMOBJ,KDPKAB&outSR=4326&maxAllowableOffset=0.002&geometryPrecision=5&returnGeometry=true&f=geojson`)
    .then((fc) => (fc.features ?? []).filter((f) => f.geometry).sort((a, b) => String(a.properties.NAMOBJ).localeCompare(String(b.properties.NAMOBJ))))
    .catch((err) => {
      acehKabPromise = null;
      throw err;
    });
  return acehKabPromise;
}

function dcRings(geoms) {
  const rings = [];
  for (const g of geoms) {
    if (g?.type === "Polygon") rings.push(...g.coordinates);
    else if (g?.type === "MultiPolygon") for (const p of g.coordinates) rings.push(...p);
  }
  return rings;
}

/** The areas to analyse: [{ label, rings }]. `where` is "", "aceh", "rank", "kab:<name>" or a layer id. */
async function fwAreas(where) {
  if (!where) {
    const [w, s, e, n] = dcView();
    return [{ label: "tempoan peta ayeuna", rings: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] }];
  }
  if (where === "aceh" || where === "rank" || where.startsWith("kab:")) {
    dcStatus("Nyandak wates kabupatén Acéh ti BIG…");
    const kab = await acehKab();
    if (where === "aceh") return [{ label: "Provinsi Acéh", rings: dcRings(kab.map((f) => f.geometry)) }];
    const list = kab.map((f) => ({ label: String(f.properties.NAMOBJ), rings: dcRings([f.geometry]) }));
    return where === "rank" ? list : list.filter((a) => `kab:${a.label}` === where);
  }
  const app = requireApp();
  const rings = dcRings(((await app.getLayerFeatures?.(where)) ?? []).map((f) => f?.geometry));
  if (!rings.length) throw new Error("Lapisan éta teu boga poligon.");
  return [{ label: (app.listLayers?.() ?? []).find((l) => l.id === where)?.name ?? "lapisan", rings }];
}

/** Scan-convert rings on the tile pixel grid: row → sorted crossing x's (even-odd spans). */
function fwSpans(rings, z, S) {
  const rows = new Map();
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      const x1 = dcLonPx(ring[i][0], z, S), y1 = dcLatPx(ring[i][1], z, S);
      const x2 = dcLonPx(ring[i + 1][0], z, S), y2 = dcLatPx(ring[i + 1][1], z, S);
      if (y1 === y2) continue;
      const lo = Math.min(y1, y2), hi = Math.max(y1, y2);
      for (let r = Math.ceil(lo - 0.5); r + 0.5 < hi; r++) {
        let xs = rows.get(r);
        if (!xs) rows.set(r, (xs = []));
        xs.push(x1 + ((r + 0.5 - y1) * (x2 - x1)) / (y2 - y1));
      }
    }
  }
  for (const xs of rows.values()) xs.sort((a, b) => a - b);
  return rows;
}

/**
 * Area (ha) of an overlay inside each area, per bucket (loss year, alert week,
 * elevation class…) and series. One pass over the tiles serves every area.
 * Each pixel weighs its web-mercator ground area at its latitude.
 */
async function fwAnalyze(key, where) {
  const L = FW_LAYERS[key];
  const areas = await fwAreas(where);
  const S = L.size ?? 256;
  let z = L.maxZ;
  let spans;
  let tiles;
  for (;;) {
    spans = areas.map((a) => fwSpans(a.rings, z, S));
    tiles = new Set();
    for (const rows of spans) {
      for (const [r, xs] of rows) {
        for (let i = 0; i + 1 < xs.length; i += 2) {
          for (let tx = Math.floor(xs[i] / S); tx <= Math.floor(xs[i + 1] / S); tx++) tiles.add(`${tx}/${Math.floor(r / S)}`);
        }
      }
    }
    if (tiles.size <= 260 || z <= 6) break;
    z--;
  }
  const sums = areas.map(() => new Map()); // per area: bucket → { series: ha }
  let done = 0;
  const list = [...tiles].map((k) => k.split("/").map(Number));
  await dcPool(list, async ([tx, ty]) => {
    const img = await fwTile(key, z, tx, ty);
    dcStatus(`Nganalisis ${L.name}: ubin ${++done}/${list.length}…`);
    if (!img) return;
    const k = img.width / S;
    for (let py = 0; py < S; py++) {
      const r = ty * S + py;
      const lat = dcPxLat(r + 0.5, z, S);
      const res = (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (2 ** z * S);
      const ha = (res * res) / 10000;
      spans.forEach((rows, ai) => {
        const xs = rows.get(r);
        if (!xs) return;
        const out = sums[ai];
        for (let i = 0; i + 1 < xs.length; i += 2) {
          const c0 = Math.max(tx * S, Math.ceil(xs[i] - 0.5));
          const c1 = Math.min(tx * S + S - 1, Math.floor(xs[i + 1] - 0.5));
          for (let c = c0; c <= c1; c++) {
            const si = (Math.floor(py * k) * img.width + Math.floor((c - tx * S) * k)) * 4;
            const hit = L.bucket(img.data[si], img.data[si + 1], img.data[si + 2], img.data[si + 3], FW.opts);
            if (!hit) continue;
            const row = out.get(hit[0]) ?? out.set(hit[0], {}).get(hit[0]);
            const series = hit[2] ?? "ha";
            row[series] = (row[series] ?? 0) + hit[1] * ha;
          }
        }
      });
    }
  });
  const pxM = Math.round(40075016.686 / (2 ** z * S));
  dcStatus(`Analisis réngsé (${list.length} ubin, piksel ±${pxM} m).`);
  const caption = `Sumber: ${L.source ?? `Global Forest Watch (${L.path.split("/")[0]})`}. Diitung tina ubin data (piksel ±${pxM} m), sanés statistik resmi.`;
  const totalOf = (m) => [...m.values()].reduce((t, row) => t + Object.values(row).reduce((a, b) => a + b, 0), 0);
  if (areas.length > 1) return fwShowRanking(L, key, areas, sums, totalOf, caption);
  return fwShowWidget(L, key, areas[0], sums[0], totalOf, caption);
}

function dcCsv(name, text) {
  const a = el("a", { href: URL.createObjectURL(new Blob([text], { type: "text/csv" })), download: `${name.replace(/[^\w-]+/g, "_")}.csv` });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/** One area: a GFW-style widget — a sentence, then the bar chart. */
function fwShowWidget(L, key, area, sums, totalOf, caption) {
  const keys = [...sums.keys()].sort(L.sort ?? undefined);
  const seriesNames = [...new Set([...sums.values()].flatMap((r) => Object.keys(r)))].sort();
  const sumOf = (k) => Object.values(sums.get(k)).reduce((t, v) => t + v, 0);
  const total = totalOf(sums);
  const unit = L.unit ?? "kelas";
  let sentence;
  if (key === "loss") {
    const peak = keys.reduce((p, k) => (sumOf(k) > sumOf(p) ? k : p), keys[0]);
    sentence = keys.length
      ? `Ti ${keys[0]} nepi ka ${keys[keys.length - 1]}, ${area.label} kaleungitan ${dcHa(total)} ha tutupan tangkal. Pangluhurna taun ${peak} (${dcHa(sumOf(peak))} ha).`
      : `Teu aya kahilangan tutupan tangkal di ${area.label} dina taun ${FW.opts.from}–${FW.opts.to}.`;
  } else if (key === "primary") {
    sentence = `${area.label} ngabogaan ${dcHa(total)} ha leuweung primér tropis lembab (taun 2001).`;
  } else if (key === "elev") {
    const peak = keys.reduce((p, k) => (sumOf(k) > sumOf(p) ? k : p), keys[0]);
    sentence = `Lega darat ${area.label} ${dcHa(total)} ha; pangloba aya dina jangkungna ${peak} m (${Math.round((sumOf(peak) / (total || 1)) * 100)}%).`;
  } else {
    const high = keys.reduce((t, k) => t + (sums.get(k)["Kapercayaan luhur"] ?? 0), 0);
    sentence = keys.length
      ? `Ti ${keys[0]} nepi ka ${keys[keys.length - 1]} aya ${dcHa(total)} ha ${L.name.toLowerCase()} di ${area.label}; ${Math.round((high / (total || 1)) * 100)}% kapercayaan luhur.`
      : `Teu aya peringatan di ${area.label} dina ${FW.opts.days} poé ka tukang.`;
  }
  const palette = { ha: L.color, "Kapercayaan luhur": "#d81e5b", "Kapercayaan handap": "#f5a4bd" };
  const figure = {
    data: seriesNames.map((s) => ({
      type: "bar",
      name: s,
      x: keys,
      y: keys.map((k) => Math.round((sums.get(k)[s] ?? 0) * 10) / 10),
      marker: { color: L.barColors ? keys.map(L.barColors) : palette[s] ?? L.color },
      hovertemplate: `%{x}<br><b>%{y:,.1f} ha</b>${seriesNames.length > 1 ? ` · ${s}` : ""}<extra></extra>`,
    })),
    layout: {
      barmode: "stack",
      bargap: 0.18,
      showlegend: seriesNames.length > 1,
      legend: { orientation: "h", y: -0.25 },
      margin: { l: 48, r: 8, t: 8, b: 40 },
      xaxis: { type: unit === "minggu" ? "date" : "category", tickangle: unit === "taun" ? -45 : 0, fixedrange: true },
      yaxis: { title: { text: "ha" }, tickformat: ",.0f", fixedrange: true, gridcolor: "rgba(128,128,128,.18)" },
    },
  };
  const csv = () => dcCsv(`${key}_${area.label}`, `${unit},${seriesNames.join(",")}\n${keys.map((k) => `${k},${seriesNames.map((s) => (sums.get(k)[s] ?? 0).toFixed(2)).join(",")}`).join("\n")}\n`);
  const toChat = () => HANDLERS.show_chart?.({ title: `${L.name} · ${area.label}`, figure, caption, message: sentence });
  dcShow(L.name, [], { lead: sentence, chart: { title: "", figure, caption }, actions: [dcBtn("Kirim ka obrolan", toChat), dcBtn("Unduh CSV", csv)] });
  return { total, keys };
}

/** Many areas (Aceh's kabupaten): a ranking, like GFW's "location of tree cover loss" widget. */
function fwShowRanking(L, key, areas, sums, totalOf, caption) {
  const totals = areas.map((a, i) => [a.label, totalOf(sums[i])]).sort((a, b) => b[1] - a[1]);
  const grand = totals.reduce((t, [, v]) => t + v, 0);
  const [top, topHa] = totals[0] ?? ["-", 0];
  const what = key === "loss" ? `kahilangan tutupan tangkal ${FW.opts.from}–${FW.opts.to}` : key === "primary" ? "leuweung primér" : key === "elev" ? "lega darat" : L.name.toLowerCase();
  const sentence = `Di Acéh, ${what} jumlahna ${dcHa(grand)} ha. Pangluhurna di ${top}: ${dcHa(topHa)} ha (${Math.round((topHa / (grand || 1)) * 100)}% ti total).`;
  const rev = [...totals].reverse();
  const figure = {
    data: [{
      type: "bar",
      orientation: "h",
      y: rev.map(([n]) => n),
      x: rev.map(([, v]) => Math.round(v)),
      marker: { color: L.color },
      hovertemplate: "%{y}<br><b>%{x:,.0f} ha</b><extra></extra>",
    }],
    layout: {
      height: Math.max(260, rev.length * 18 + 40),
      margin: { l: 120, r: 12, t: 8, b: 32 },
      xaxis: { title: { text: "ha" }, tickformat: ",.0f", fixedrange: true, gridcolor: "rgba(128,128,128,.18)" },
      yaxis: { automargin: true, fixedrange: true, tickfont: { size: 10 } },
    },
  };
  const buckets = [...new Set(sums.flatMap((m) => [...m.keys()]))].sort(L.sort ?? undefined);
  const csv = () => dcCsv(`${key}_aceh_per_kabupaten`, `kabupaten,${buckets.join(",")},jumlah\n${areas.map((a, i) => `"${a.label}",${buckets.map((b) => Object.values(sums[i].get(b) ?? {}).reduce((t, v) => t + v, 0).toFixed(2)).join(",")},${totalOf(sums[i]).toFixed(2)}`).join("\n")}\n`);
  const toChat = () => HANDLERS.show_chart?.({ title: `${L.name} · per kabupatén Acéh`, figure, caption, message: sentence });
  dcShow(`${L.name} · per kabupatén`, [], { lead: sentence, chart: { title: "", figure, caption }, actions: [dcBtn("Kirim ka obrolan", toChat), dcBtn("Unduh CSV (taun × kabupatén)", csv)] });
  return { total: grand, totals };
}

/** <select> of analysis areas; Aceh's kabupaten are filled in once BIG answers. */
function fwWhereSelect() {
  const sel = el("select", { className: "glb-ls-select" }, [
    el("option", { value: "aceh", textContent: "Provinsi Acéh" }),
    el("option", { value: "rank", textContent: "Per kabupatén Acéh (rangking)" }),
    el("option", { value: "", textContent: "Tempoan peta ayeuna" }),
  ]);
  const layers = (state.app?.listLayers?.() ?? []).filter((l) => /geojson|vector/i.test(l.type ?? ""));
  if (layers.length) sel.append(el("optgroup", { label: "Lapisan poligon" }, layers.map((l) => el("option", { value: l.id, textContent: l.name }))));
  acehKab().then((kab) => sel.append(el("optgroup", { label: "Kabupatén / kota" }, kab.map((f) => el("option", { value: `kab:${f.properties.NAMOBJ}`, textContent: f.properties.NAMOBJ }))))).catch(() => {});
  return sel;
}

function fwUi() {
  const from = el("input", { type: "number", className: "glb-ls-num", min: 2001, max: 2030, value: FW.opts.from });
  const to = el("input", { type: "number", className: "glb-ls-num", min: 2001, max: 2030, value: FW.opts.to });
  const days = el("select", { className: "glb-ls-select" }, [30, 90, 180, 365, 730, 3650].map((d) => el("option", { value: d, textContent: d >= 3650 ? "sadayana" : `${d} poé`, selected: d === FW.opts.days })));
  const sync = () => {
    FW.opts = { from: Number(from.value) || 2001, to: Number(to.value) || 2030, days: Number(days.value) || 180 };
    if (FW.on.size) fwRefresh();
  };
  for (const i of [from, to, days]) {
    i.addEventListener("change", sync);
    i.addEventListener("keydown", (e) => e.stopPropagation());
  }
  const rows = Object.entries(FW_LAYERS).filter(([, L]) => !L.group).map(([key, L]) => {
    const cb = el("input", { type: "checkbox", checked: FW.on.has(key) });
    cb.addEventListener("change", () => {
      if (cb.checked) FW.on.add(key);
      else FW.on.delete(key);
      fwRefresh().catch((err) => dcStatus(`Gagal: ${err?.message ?? err}`));
    });
    return el("label", { className: "glb-dc-check" }, [cb, el("i", { className: "glb-dc-swatch", style: `background:${L.color}` }), el("span", { textContent: L.name })]);
  });
  const where = fwWhereSelect();
  const what = el("select", { className: "glb-ls-select" }, Object.entries(FW_LAYERS).filter(([, L]) => !L.group).map(([k, L]) => el("option", { value: k, textContent: L.name })));
  return el("div", { className: "glb-dc-ui" }, [
    el("div", { className: "glb-dc-sub", textContent: "Lapisan (didekode langsung tina ubin GFW)" }),
    ...rows,
    el("div", { className: "glb-dc-line" }, [el("span", { textContent: "Taun leungit" }), from, el("span", { textContent: "–" }), to]),
    el("div", { className: "glb-dc-line" }, [el("span", { textContent: "Peringatan" }), days]),
    el("div", { className: "glb-dc-sub", textContent: "Analisis wewengkon" }),
    el("div", { className: "glb-dc-line" }, [el("span", { textContent: "Naon" }), what]),
    el("div", { className: "glb-dc-line" }, [el("span", { textContent: "Dimana" }), where]),
    el("div", { className: "glb-dc-actions" }, [
      dcBtn("Analisis", () => { sync(); return fwAnalyze(what.value, where.value); }),
      dcBtn("Buka GFW", () => { const c = dcCenter(); dcOpenUrl(`https://www.globalforestwatch.org/map/?map=${encodeURIComponent(JSON.stringify({ center: { lat: c.lat, lng: c.lon }, zoom: Math.round(currentMap()?.getZoom?.() ?? 5) }))}`); }, "Buka peta GFW di dieu"),
    ]),
    el("div", { className: "glb-dc-sub", textContent: "Lapisan GFW siap pakai" }),
    el("div", { className: "glb-dc-actions" }, FW_TILE_LAYERS.map(([name, path]) => dcBtn(name, () => dcAddTiles(`GFW · ${name}`, `${GFW_TILES}/${path}/{z}/{x}/{y}.png`, { attribution: "Global Forest Watch", maxzoom: 12 })))),
  ]);
}

// ---- biodiversity: GBIF and iNaturalist ------------------------------------------------

const BIO = { gbif: null, inat: null };

async function gbifTaxon(name) {
  if (!name.trim()) return (BIO.gbif = null);
  const m = await dcJson(`https://api.gbif.org/v1/species/match?name=${encodeURIComponent(name.trim())}`);
  if (!m.usageKey) throw new Error(`“${name}” teu kapanggih di GBIF.`);
  BIO.gbif = { key: m.usageKey, name: m.scientificName };
  return BIO.gbif;
}

async function gbifOccurrences(name) {
  const t = await gbifTaxon(name);
  const [w, s, e, n] = dcView();
  const q = `decimalLatitude=${s},${n}&decimalLongitude=${w},${e}&hasCoordinate=true&hasGeospatialIssue=false&limit=300${t ? `&taxonKey=${t.key}` : ""}`;
  const res = await dcJson(`https://api.gbif.org/v1/occurrence/search?${q}`);
  const feats = (res.results ?? []).filter((o) => Number.isFinite(o.decimalLongitude)).map((o) => dcPoint(o.decimalLongitude, o.decimalLatitude, {
    spesies: o.species ?? o.scientificName ?? "", ngaran_ilmiah: o.scientificName ?? "", kingdom: o.kingdom ?? "", famili: o.family ?? "",
    tanggal: o.eventDate ?? "", jenis_rekaman: o.basisOfRecord ?? "", dataset: o.datasetName ?? "", gbif_id: o.key, url: `https://www.gbif.org/occurrence/${o.key}`,
  }));
  dcAddGeoJson(`GBIF · ${t?.name ?? "sadaya kajadian"}`, feats);
  dcShow("GBIF", [["Taksa", t?.name ?? "sadayana"], ["Dina tempoan", `${(res.count ?? 0).toLocaleString("id-ID")} rékaman`], ["Diasupkeun", feats.length]]);
}

async function inatTaxon(name) {
  if (!name.trim()) return (BIO.inat = null);
  const r = await dcJson(`https://api.inaturalist.org/v1/taxa/autocomplete?per_page=1&q=${encodeURIComponent(name.trim())}`);
  const t = r.results?.[0];
  if (!t) throw new Error(`“${name}” teu kapanggih di iNaturalist.`);
  BIO.inat = { id: t.id, name: t.preferred_common_name ? `${t.name} (${t.preferred_common_name})` : t.name };
  return BIO.inat;
}

async function inatObservations(name) {
  const t = await inatTaxon(name);
  const [w, s, e, n] = dcView();
  const r = await dcJson(`https://api.inaturalist.org/v1/observations?swlat=${s}&swlng=${w}&nelat=${n}&nelng=${e}&geo=true&per_page=200&order_by=observed_on${t ? `&taxon_id=${t.id}` : ""}`);
  const feats = (r.results ?? []).filter((o) => o.geojson?.coordinates).map((o) => dcPoint(o.geojson.coordinates[0], o.geojson.coordinates[1], {
    spesies: o.taxon?.name ?? o.species_guess ?? "", ngaran_umum: o.taxon?.preferred_common_name ?? "", tanggal: o.observed_on ?? "",
    kualitas: o.quality_grade ?? "", pangamat: o.user?.login ?? "", tempat: o.place_guess ?? "", url: o.uri ?? "",
  }));
  dcAddGeoJson(`iNaturalist · ${t?.name ?? "obsérvasi"}`, feats);
  dcShow("iNaturalist", [["Taksa", t?.name ?? "sadayana"], ["Dina tempoan", `${(r.total_results ?? 0).toLocaleString("id-ID")} obsérvasi`], ["Diasupkeun", feats.length]]);
}

function bioUi(kind) {
  const q = dcInput(kind === "gbif" ? "Ngaran spésiés/génus (kosongkeun = sadayana)…" : "Ngaran taksa (contona: Panthera tigris)…");
  return el("div", { className: "glb-dc-ui" }, [
    q,
    el("div", { className: "glb-dc-actions" }, kind === "gbif"
      ? [
        dcBtn("Kajadian dina tempoan", () => gbifOccurrences(q.value)),
        dcBtn("Peta kapadetan", async () => { const t = await gbifTaxon(q.value); dcAddTiles(`GBIF kapadetan · ${t?.name ?? "sadayana"}`, `https://api.gbif.org/v2/map/occurrence/density/{z}/{x}/{y}@1x.png?style=classic.point${t ? `&taxonKey=${t.key}` : ""}`, { attribution: "GBIF.org", tileSize: 512 }); }),
      ]
      : [
        dcBtn("Obsérvasi dina tempoan", () => inatObservations(q.value)),
        dcBtn("Peta titik", async () => { const t = await inatTaxon(q.value); dcAddTiles(`iNaturalist titik · ${t?.name ?? "sadayana"}`, `https://api.inaturalist.org/v1/points/{z}/{x}/{y}.png${t ? `?taxon_id=${t.id}` : ""}`, { attribution: "iNaturalist" }); }),
        dcBtn("Grid", async () => { const t = await inatTaxon(q.value); dcAddTiles(`iNaturalist grid · ${t?.name ?? "sadayana"}`, `https://api.inaturalist.org/v1/grid/{z}/{x}/{y}.png${t ? `?taxon_id=${t.id}` : ""}`, { attribution: "iNaturalist" }); }),
      ]),
  ]);
}

// ---- hazards and weather ----------------------------------------------------------------

async function bmkgQuakes(file, title) {
  const r = await dcJson(`https://data.bmkg.go.id/DataMKG/TEWS/${file}`);
  const list = [r.Infogempa?.gempa ?? []].flat();
  const feats = list.map((g) => {
    const [lat, lon] = String(g.Coordinates ?? "").split(",").map(Number);
    return Number.isFinite(lat) ? dcPoint(lon, lat, { magnitudo: Number(g.Magnitude), jero: g.Kedalaman, wilayah: g.Wilayah, tanggal: g.Tanggal, jam: g.Jam, potensi: g.Potensi ?? "", dirasakan: g.Dirasakan ?? "" }) : null;
  }).filter(Boolean);
  dcAddGeoJson(`BMKG · ${title}`, acehFocus() ? feats.filter((f) => inBox(...f.geometry.coordinates, ACEH.max)) : feats);
}

async function usgsQuakes(feed, title) {
  const r = await dcJson(`https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/${feed}.geojson`);
  const feats = (r.features ?? []).map((f) => ({ ...f, properties: { magnitudo: f.properties.mag, tempat: f.properties.place, waktu: new Date(f.properties.time).toISOString(), tsunami: f.properties.tsunami, url: f.properties.url } }));
  dcAddGeoJson(`USGS · ${title}`, acehFocus() ? feats.filter((f) => inBox(f.geometry.coordinates[0], f.geometry.coordinates[1], ACEH.max)) : feats);
}

async function petaBencana() {
  const r = await dcJson("https://data.petabencana.id/reports?geoformat=geojson&timeperiod=604800").catch(() => dcJson("https://petabencana.id/api/v2/reports?geoformat=geojson"));
  const fc = r.result ?? r;
  dcAddGeoJson("PetaBencana · laporan 7 poé", (fc.features ?? []).filter((f) => !acehFocus() || (f.geometry?.type === "Point" && inBox(f.geometry.coordinates[0], f.geometry.coordinates[1], ACEH.max))).map((f) => ({ ...f, properties: { jenis: f.properties?.disaster_type, waktu: f.properties?.created_at, téks: f.properties?.text ?? "", url: f.properties?.url ?? "" } })));
}

const WMO = { 0: "cerah", 1: "rada cerah", 2: "rada méndung", 3: "méndung", 45: "halimun", 48: "halimun", 51: "girimis", 53: "girimis", 55: "girimis", 61: "hujan leutik", 63: "hujan", 65: "hujan gedé", 80: "hujan sakeudeung", 81: "hujan sakeudeung", 82: "hujan gedé", 95: "hujan guludug", 96: "hujan guludug", 99: "hujan guludug" };

async function meteoHere() {
  const { lat, lon } = dcCenter();
  const [wx, elev, aq] = await Promise.all([
    dcJson(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,weather_code&daily=precipitation_sum&forecast_days=7&timezone=auto`),
    dcJson(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`),
    dcJson(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=pm2_5,pm10`).catch(() => null),
  ]);
  const c = wx.current ?? {};
  dcShow(`Cuaca di ${lat}, ${lon}`, [
    ["Kaayaan", WMO[c.weather_code] ?? `kode ${c.weather_code}`],
    ["Suhu", `${c.temperature_2m} °C`],
    ["Kalembaban", `${c.relative_humidity_2m} %`],
    ["Angin", `${c.wind_speed_10m} km/jam`],
    ["Jangkungna", `${elev.elevation?.[0]} m dpl`],
    ...(aq?.current ? [["PM2.5 / PM10", `${aq.current.pm2_5} / ${aq.current.pm10} µg/m³`]] : []),
  ], {
    chart: {
      title: "",
      caption: "Curah hujan 7 poé (mm) · Open-Meteo",
      figure: {
        data: [{ type: "bar", x: wx.daily?.time ?? [], y: wx.daily?.precipitation_sum ?? [], marker: { color: "#4f8fc0" }, hovertemplate: "%{x}<br><b>%{y} mm</b><extra></extra>" }],
        layout: { margin: { l: 40, r: 8, t: 8, b: 32 }, xaxis: { type: "date", fixedrange: true }, yaxis: { title: { text: "mm" }, fixedrange: true } },
      },
    },
  });
}

// ---- government catalogues (ArcGIS REST, browsed live) ---------------------------------

const GOV_REST = [
  ["BIG · Rupabumi Indonésia (RBI)", "https://geoservices.big.go.id/rbi/rest/services"],
  ["BNPB · Geospasial bencana", "https://gis.bnpb.go.id/server/rest/services"],
];

const GOV_PORTALS = [
  ["Ina-Geoportal (Satu Peta)", "https://tanahair.indonesia.go.id"],
  ["Geoportal BIG", "https://geoportal.big.go.id"],
  ["SIGAP Kementerian Kehutanan", "https://sigap.kehutanan.go.id"],
  ["inaRISK BNPB", "https://inarisk.bnpb.go.id"],
  ["BHUMI ATR/BPN", "https://bhumi.atrbpn.go.id"],
  ["Satu Data Indonésia", "https://data.go.id"],
  ["BPS · Statistik", "https://www.bps.go.id"],
];

const REST = { nodes: new Map(), open: new Set() };

async function restNode(url) {
  if (!REST.nodes.has(url)) REST.nodes.set(url, await dcJson(`${url}?f=json`));
  return REST.nodes.get(url);
}

function restAddExport(name, svc) {
  dcAddTiles(name, `${svc}/export?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&f=image`, { attribution: new URL(svc).hostname });
}

async function restQuery(name, layerUrl) {
  const [w, s, e, n] = dcView();
  const q = `where=1%3D1&geometry=${w},${s},${e},${n}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&outSR=4326&returnGeometry=true&resultRecordCount=2000&f=geojson`;
  const fc = await dcJson(`${layerUrl}/query?${q}`);
  if (fc.error) throw new Error(fc.error.message ?? "query ditolak");
  dcAddGeoJson(name, fc.features ?? []);
}

/** Rows for one ArcGIS REST directory: folders, services, a service's layers. */
function restRows(url, depth, kids) {
  const node = REST.nodes.get(url);
  if (!node) return;
  const pad = (n) => `padding-inline-start:${10 + n * 14}px`;
  for (const f of node.folders ?? []) {
    const u = `${url}/${f}`;
    const row = tbRow("is-set", "set", f, async () => {
      if (REST.open.has(u)) REST.open.delete(u);
      else { REST.open.add(u); dcStatus(`Maca ${f}…`); await restNode(u).catch((err) => dcStatus(`Gagal: ${err.message}`)); dcStatus(""); }
      dcRender();
    });
    row.style.cssText = pad(depth);
    kids.push(row);
    if (REST.open.has(u)) restRows(u, depth + 1, kids);
  }
  for (const s of node.services ?? []) {
    if (!/MapServer|FeatureServer/.test(s.type)) continue;
    const base = url.replace(/\/rest\/services.*$/, "/rest/services");
    const u = `${base}/${s.name}/${s.type}`;
    const label = `${s.name.split("/").pop().replace(/_/g, " ")} · ${s.type === "MapServer" ? "peta" : "fitur"}`;
    const row = tbRow("is-tool", "tool", label, async () => {
      if (REST.open.has(u)) REST.open.delete(u);
      else { REST.open.add(u); await restNode(u).catch((err) => dcStatus(`Gagal: ${err.message}`)); }
      dcRender();
    });
    row.style.cssText = pad(depth);
    kids.push(row);
    if (!REST.open.has(u)) continue;
    const svc = REST.nodes.get(u);
    const box = el("div", { className: "glb-dc-ui", style: pad(depth + 1) }, [
      ...(svc?.serviceDescription || svc?.description ? [el("p", { className: "glb-ls-note", textContent: String(svc.serviceDescription || svc.description).replace(/<[^>]+>/g, " ").slice(0, 220) })] : []),
      ...(s.type === "MapServer" ? [el("div", { className: "glb-dc-actions" }, [dcBtn("Tambah salaku peta", () => restAddExport(label, u))])] : []),
      ...((svc?.layers ?? []).filter((l) => !l.subLayerIds).map((l) => el("div", { className: "glb-dc-line" }, [
        el("span", { className: "glb-dc-grow", textContent: l.name }),
        dcBtn("Vektor dina tempoan", () => restQuery(`${l.name}`, `${u}/${l.id}`), "Candak fitur dina tempoan peta (maks. 2000)"),
      ]))),
    ]);
    kids.push(box);
  }
}

function govUi() {
  const custom = dcInput("URL ArcGIS REST séjén (…/rest/services)…");
  const kids = [];
  for (const [name, url] of GOV_REST) {
    kids.push(tbRow("is-box", "box", name, async () => {
      if (REST.open.has(url)) REST.open.delete(url);
      else { REST.open.add(url); dcStatus(`Maca katalog ${name}…`); await restNode(url).catch((err) => dcStatus(`Gagal: ${err.message}`)); dcStatus(""); }
      dcRender();
    }));
    if (REST.open.has(url)) restRows(url, 1, kids);
  }
  for (const url of REST.open) {
    if (GOV_REST.some(([, u]) => u === url) || !/\/rest\/services$/.test(url) || [...REST.open].some((o) => o !== url && url.startsWith(`${o}/`))) continue;
    kids.push(tbRow("is-box", "box", new URL(url).hostname, () => { REST.open.delete(url); dcRender(); }));
    restRows(url, 1, kids);
  }
  return el("div", { className: "glb-dc-ui" }, [
    ...kids,
    el("div", { className: "glb-dc-line" }, [custom, dcBtn("Buka", async () => {
      const u = custom.value.trim().replace(/\/+$/, "").replace(/\?.*$/, "");
      if (!/^https:\/\/.+\/rest\/services/.test(u)) throw new Error("Kudu URL https …/rest/services");
      await restNode(u);
      REST.open.add(u);
      dcRender();
    })]),
    el("div", { className: "glb-dc-sub", textContent: "Portal nasional" }),
    el("div", { className: "glb-dc-actions" }, GOV_PORTALS.map(([n, u]) => dcBtn(n, () => dcOpenUrl(u), u))),
  ]);
}

// ---- places: Nominatim ------------------------------------------------------------------

async function placeSearch(q, list) {
  if (!q.trim()) return;
  const r = await dcJson(`https://nominatim.openstreetmap.org/search?format=jsonv2&polygon_geojson=1&polygon_threshold=0.0005&limit=8&accept-language=id${acehFocus() ? `&viewbox=${ACEH.max.join(",")}&bounded=1` : ""}&q=${encodeURIComponent(q.trim())}`);
  list.replaceChildren(...(r.length ? r : [null]).map((p) => {
    if (!p) return el("p", { className: "glb-ls-note", textContent: "Teu kapanggih." });
    const [s, n, w, e] = p.boundingbox.map(Number);
    return el("div", { className: "glb-dc-line" }, [
      el("span", { className: "glb-dc-grow", textContent: p.display_name, title: `${p.category}/${p.type}` }),
      dcBtn("Ka dieu", () => state.app?.fitBounds?.([w, s, e, n])),
      ...(/Polygon/.test(p.geojson?.type ?? "") ? [dcBtn("Wates", () => dcAddGeoJson(`Wates · ${p.name || p.display_name.split(",")[0]}`, [{ type: "Feature", geometry: p.geojson, properties: { ngaran: p.display_name, osm: `${p.osm_type}/${p.osm_id}`, jenis: p.type } }]))] : []),
    ]);
  }));
}

async function placeHere() {
  const { lat, lon } = dcCenter();
  const r = await dcJson(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&accept-language=id&zoom=14&lat=${lat}&lon=${lon}`);
  const a = r.address ?? {};
  dcShow(`Lokasi ${lat}, ${lon}`, [
    ["Désa / kelurahan", a.village ?? a.suburb ?? a.hamlet ?? "-"],
    ["Kecamatan", a.city_district ?? a.municipality ?? a.district ?? "-"],
    ["Kabupatén / kota", a.county ?? a.city ?? a.regency ?? "-"],
    ["Provinsi", a.state ?? "-"],
    ["Nagara", a.country ?? "-"],
  ]);
}

function placeUi() {
  const q = dcInput("Néangan tempat, désa, kabupatén…");
  const list = el("div", { className: "glb-dc-list" });
  q.addEventListener("keydown", (e) => { if (e.key === "Enter") placeSearch(q.value, list).catch((err) => dcStatus(`Gagal: ${err.message}`)); });
  return el("div", { className: "glb-dc-ui" }, [
    el("div", { className: "glb-dc-line" }, [q, dcBtn("Téang", () => placeSearch(q.value, list))]),
    list,
    el("div", { className: "glb-dc-actions" }, [dcBtn("Ieu teh dimana? (tengah peta)", placeHere)]),
  ]);
}

// ---- Aceh focus: the app works on Aceh, not the whole world ------------------------------

const ACEH = { bbox: [94.9, 1.9, 98.4, 6.2], max: [91.5, -0.8, 101.8, 8.8] };
const acehFocus = () => state.settings.aceh !== false;
const inBox = (lon, lat, b) => lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];

/** Keep the camera on Aceh (with room around it), or let it roam the world again. */
function acehApply() {
  const map = currentMap();
  if (!map) return;
  try {
    if (acehFocus()) {
      map.setMaxBounds([[ACEH.max[0], ACEH.max[1]], [ACEH.max[2], ACEH.max[3]]]);
      map.setMinZoom(5);
    } else {
      map.setMaxBounds(null);
      map.setMinZoom(0);
    }
  } catch {
    /* renderer without max bounds (globe) */
  }
}

/** On start: open on Aceh when the project has nothing of its own yet. */
function acehStart() {
  acehApply();
  const app = state.app;
  if (acehFocus() && !(app?.listLayers?.() ?? []).length) app?.fitBounds?.(ACEH.bbox);
}

function acehSet(on) {
  state.settings.aceh = on;
  saveSettings();
  acehApply();
  if (on) state.app?.fitBounds?.(ACEH.bbox);
  dcStatus(on ? "Fokus Acéh hurung: peta, ubin jeung query ngan di Acéh." : "Fokus Acéh pareum: sakuliah dunya.");
}

// ---- Mapzen Terrain (AWS Open Data terrain tiles) as a basemap ---------------------------

const MAPZEN = "https://s3.amazonaws.com/elevation-tiles-prod";
const TR = { mode: "off", exaggeration: 1.4, shade: "dark", map: null };
const TR_SRC = "glb-mapzen-dem";
const TR_LAYER = "glb-mapzen-hillshade";
const TR_SHADES = {
  dark: { "hillshade-shadow-color": "#000000", "hillshade-highlight-color": "#bdbdbd", "hillshade-accent-color": "#1d1d1d", "hillshade-exaggeration": 0.65 },
  light: { "hillshade-shadow-color": "#5b5b5b", "hillshade-highlight-color": "#ffffff", "hillshade-accent-color": "#8c8c8c", "hillshade-exaggeration": 0.5 },
  relief: { "hillshade-shadow-color": "#3b2f22", "hillshade-highlight-color": "#fff4dc", "hillshade-accent-color": "#6b5a3c", "hillshade-exaggeration": 0.7 },
};

/** The first style layer that belongs to the user's own layers, so the terrain sits under them. */
function trBeforeId(map) {
  const ids = (state.app?.listLayers?.() ?? []).map((l) => l.id);
  return map.getStyle()?.layers?.find((l) => ids.some((id) => l.id.includes(id)) || l.id.startsWith("glb-fw-"))?.id;
}

function trApply() {
  const map = currentMap();
  if (!map) return;
  if (TR.map !== map) {
    TR.map = map;
    map.on("styledata", () => { if (TR.mode !== "off" && !map.getLayer(TR_LAYER)) try { trApply(); } catch { /* style loading */ } });
  }
  if (TR.mode === "off") {
    try { map.setTerrain?.(null); } catch { /* none */ }
    if (map.getLayer(TR_LAYER)) map.removeLayer(TR_LAYER);
    if (map.getSource(TR_SRC)) map.removeSource(TR_SRC);
    return;
  }
  if (!map.getSource(TR_SRC)) {
    map.addSource(TR_SRC, {
      type: "raster-dem",
      tiles: [`${MAPZEN}/terrarium/{z}/{x}/{y}.png`],
      encoding: "terrarium",
      tileSize: 256,
      maxzoom: 15,
      attribution: "Mapzen Terrain Tiles (AWS Open Data)",
      ...(acehFocus() ? { bounds: ACEH.max } : {}),
    });
  }
  if (!map.getLayer(TR_LAYER)) map.addLayer({ id: TR_LAYER, type: "hillshade", source: TR_SRC, paint: TR_SHADES[TR.shade] }, trBeforeId(map));
  else for (const [k, v] of Object.entries(TR_SHADES[TR.shade])) map.setPaintProperty(TR_LAYER, k, v);
  try {
    map.setTerrain?.(TR.mode === "3d" ? { source: TR_SRC, exaggeration: TR.exaggeration } : null);
    if (TR.mode === "3d" && map.getPitch() < 30) map.easeTo({ pitch: 55, duration: 800 });
  } catch {
    /* renderer without terrain */
  }
}

// terrarium: height = R·256 + G + B/256 − 32768 metres
const trHeight = (r, g, b) => r * 256 + g + b / 256 - 32768;
const TR_RAMP = [[0, [112, 166, 99]], [100, [150, 190, 110]], [300, [205, 214, 140]], [600, [232, 214, 150]], [1000, [214, 176, 122]], [1500, [184, 138, 96]], [2000, [150, 110, 90]], [2500, [190, 180, 175]], [3200, [245, 245, 245]]];
function trColor(h) {
  if (!(h > 0)) return null;
  for (let i = 1; i < TR_RAMP.length; i++) {
    const [h1, c1] = TR_RAMP[i];
    if (h <= h1) {
      const [h0, c0] = TR_RAMP[i - 1];
      const t = Math.max(0, (h - h0) / (h1 - h0));
      return [0, 1, 2].map((j) => Math.round(c0[j] + (c1[j] - c0[j]) * t));
    }
  }
  return TR_RAMP[TR_RAMP.length - 1][1];
}

function terrainUi() {
  const mode = el("select", { className: "glb-ls-select" }, [["off", "Pareum"], ["hillshade", "Hillshade"], ["3d", "Hillshade + 3D"]].map(([v, t]) => el("option", { value: v, textContent: t, selected: TR.mode === v })));
  const shade = el("select", { className: "glb-ls-select" }, [["dark", "Poék"], ["light", "Caang"], ["relief", "Rélief coklat"]].map(([v, t]) => el("option", { value: v, textContent: t, selected: TR.shade === v })));
  const exag = el("input", { type: "range", min: 0.5, max: 4, step: 0.1, value: TR.exaggeration });
  const exagVal = el("b", { textContent: `${TR.exaggeration}×` });
  const run = () => { try { trApply(); dcStatus(TR.mode === "off" ? "Mapzen Terrain dipareuman." : `Mapzen Terrain: ${mode.selectedOptions[0].textContent}.`); } catch (err) { dcStatus(`Gagal: ${err.message}`); } };
  mode.addEventListener("change", () => { TR.mode = mode.value; run(); });
  shade.addEventListener("change", () => { TR.shade = shade.value; run(); });
  exag.addEventListener("input", () => {
    TR.exaggeration = Number(exag.value);
    exagVal.textContent = `${TR.exaggeration}×`;
    if (TR.mode === "3d") try { currentMap()?.setTerrain?.({ source: TR_SRC, exaggeration: TR.exaggeration }); } catch { /* none */ }
  });
  const hyp = el("input", { type: "checkbox", checked: FW.on.has("elev") });
  hyp.addEventListener("change", () => { hyp.checked ? FW.on.add("elev") : FW.on.delete("elev"); fwRefresh().catch((err) => dcStatus(`Gagal: ${err.message}`)); });
  return el("div", { className: "glb-dc-ui" }, [
    el("div", { className: "glb-dc-line" }, [el("span", { textContent: "Rupa" }), mode]),
    el("div", { className: "glb-dc-line" }, [el("span", { textContent: "Kalangkang" }), shade]),
    el("div", { className: "glb-dc-line" }, [el("span", { textContent: "Gedéna 3D" }), exag, exagVal]),
    el("label", { className: "glb-dc-check" }, [hyp, el("i", { className: "glb-dc-swatch", style: "background:linear-gradient(90deg,#70a663,#e8d696,#b88a60,#f5f5f5)" }), el("span", { textContent: "Warna jangkungna (hipsométri)" })]),
    el("div", { className: "glb-dc-actions" }, [
      dcBtn("Normal map", () => dcAddTiles("Mapzen · normal map", `${MAPZEN}/normal/{z}/{x}/{y}.png`, { attribution: "Mapzen Terrain Tiles", maxzoom: 15 })),
      dcBtn("Ubin terrarium (data)", () => dcAddTiles("Mapzen · terrarium (data jangkungna)", `${MAPZEN}/terrarium/{z}/{x}/{y}.png`, { attribution: "Mapzen Terrain Tiles", maxzoom: 15 })),
      dcBtn("Analisis jangkungna", () => fwAnalyze("elev", "aceh"), "Lega darat per kelas jangkungna di Acéh"),
    ]),
  ]);
}

// ---- the catalogue ------------------------------------------------------------------------

// [category, name, description, kind, payload]: kind "ui" expands a form, "run" acts at once
const DC_ITEMS = [
  ["Basemap & rupa bumi", "Mapzen Terrain", "Hillshade, 3D, warna jangkungna, normal map, analisis jangkungna", "ui", terrainUi],
  ["Forest Watch", "Forest Watch (GFW)", "Kahilangan tangkal per taun, peringatan déforéstasi, leuweung primér, analisis héktar", "ui", fwUi],
  ["Biodivérsitas", "GBIF", "Kajadian spésiés sadunya: titik dina tempoan jeung peta kapadetan", "ui", () => bioUi("gbif")],
  ["Biodivérsitas", "iNaturalist", "Obsérvasi warga: titik, grid, jeung data dina tempoan", "ui", () => bioUi("inat")],
  ["Bencana & cuaca", "BMKG · 15 gempa M5+ panganyarna", "data.bmkg.go.id", "run", () => bmkgQuakes("gempaterkini.json", "gempa M5+ panganyarna")],
  ["Bencana & cuaca", "BMKG · gempa karasa", "data.bmkg.go.id", "run", () => bmkgQuakes("gempadirasakan.json", "gempa karasa")],
  ["Bencana & cuaca", "USGS · gempa M4.5+ saminggu", "earthquake.usgs.gov", "run", () => usgsQuakes("4.5_week", "gempa M4.5+ 7 poé")],
  ["Bencana & cuaca", "USGS · gempa signifikan sabulan", "earthquake.usgs.gov", "run", () => usgsQuakes("significant_month", "gempa signifikan 30 poé")],
  ["Bencana & cuaca", "PetaBencana · laporan banjir jsb", "Laporan warga 7 poé ka tukang", "run", petaBencana],
  ["Bencana & cuaca", "Cuaca, jangkung, hawa di tengah peta", "Open-Meteo: ayeuna + hujan 7 poé, jangkungna, PM2.5", "run", meteoHere],
  ["Pamaréntah", "Katalog geospasial pamaréntah", "BIG RBI, BNPB, atawa ArcGIS REST séjén — dibuka langsung", "ui", govUi],
  ["Tempat", "Néangan tempat & wates", "Nominatim (OpenStreetMap): luncat, wates administrasi, alamat", "ui", placeUi],
];

function dcRender() {
  const r = DC.root;
  if (!r) return;
  r.status.textContent = DC.status;
  const q = DC.query;
  const kids = [];
  if (DC.result) kids.push(DC.result);
  const cats = [...new Set(DC_ITEMS.map((i) => i[0]))];
  for (const cat of cats) {
    const items = DC_ITEMS.filter((i) => i[0] === cat && (!q || `${i[0]} ${i[1]} ${i[2]}`.toLowerCase().includes(q)));
    if (!items.length) continue;
    const open = !!q || DC.open.has(cat);
    kids.push(tbRow("is-box", "box", cat, () => { DC.open.has(cat) ? DC.open.delete(cat) : DC.open.add(cat); dcRender(); }, items.length));
    if (!open) continue;
    for (const [, name, desc, kind, payload] of items) {
      const row = el("button", { type: "button", className: "glb-tb-row is-tool glb-dc-item" }, [
        tbIcon(kind === "ui" ? "set" : "tool"),
        el("span", { className: "glb-dc-text" }, [el("span", { className: "glb-tb-name", textContent: name }), el("small", { textContent: desc })]),
      ]);
      row.addEventListener("click", async () => {
        if (kind === "ui") {
          DC.expanded.has(name) ? DC.expanded.delete(name) : DC.expanded.add(name);
          dcRender();
          return;
        }
        row.disabled = true;
        dcStatus(`${name}…`);
        try {
          await payload();
        } catch (err) {
          dcStatus(`Gagal: ${err?.message ?? err}`);
        } finally {
          row.disabled = false;
        }
      });
      kids.push(row);
      if (kind === "ui" && DC.expanded.has(name)) kids.push(payload());
    }
  }
  if (!kids.length) kids.push(el("p", { className: "glb-ls-note", textContent: "Euweuh nu cocog." }));
  r.tree.replaceChildren(...kids);
}

function renderCatalog(container) {
  container.classList.add("glb-tb", "glb-dc");
  const search = el("input", { type: "search", className: "glb-ls-search", placeholder: "Téang data (leuweung, gempa, GBIF, RBI…)" });
  search.addEventListener("input", () => { DC.query = search.value.trim().toLowerCase(); dcRender(); });
  search.addEventListener("keydown", (e) => e.stopPropagation());
  const tree = el("div", { className: "glb-tb-tree" });
  const status = el("span", { className: "glb-ls-status" });
  const focus = el("input", { type: "checkbox", checked: acehFocus() });
  focus.addEventListener("change", () => acehSet(focus.checked));
  const home = dcBtn("Acéh", () => state.app?.fitBounds?.(ACEH.bbox), "Balik ka Acéh");
  container.append(el("div", { className: "glb-ls-top" }, [search]), tree, el("footer", { className: "glb-ls-foot" }, [status, el("label", { className: "glb-dc-check", title: "Peta, ubin jeung query ngan di Acéh" }, [focus, el("span", { textContent: "Fokus Acéh" })]), home]));
  DC.root = { container, tree, status };
  dcRender();
  return () => {
    DC.root = null;
  };
}

function registerCatalog(app) {
  if (!app.registerRightPanel || state.disposeCatalog) return;
  const dispose = app.registerRightPanel({ id: DC_PANEL_ID, title: "Katalog Data", defaultWidth: 360, render: renderCatalog });
  state.disposeCatalog = () => {
    fwOff();
    TR.mode = "off";
    try { trApply(); } catch { /* map gone */ }
    dispose?.();
  };
}

// ---------------------------------------------------------------------------
// Learn: Kang Defani's module library on Google Drive ("Modul Penginderaan
// Jauh Cloud"), sorted into topics and searchable. "Buka" opens a file in
// Drive; "Tanya" sends the question with the chosen files to the AI client
// that is listening (Claude or OpenCode), which reads them from Drive and
// answers in the chat. Index read from the folder on 2026-10-26.
// ---------------------------------------------------------------------------

const LEARN_PANEL_ID = "glb-learn";
const LEARN_FOLDER = "https://drive.google.com/drive/folders/1NR23hEoSSn5nkFDDkqhZcHKpGfagF0t8";
const LEARN = { root: null, query: "", open: new Set(), picked: new Map(), status: "" };

// id|file name, as listed in the two sub-folders
const LEARN_RS = `10FvvMLAj_0pxh00UVTPOgk8FQZeIMpNG|[Bhaskar_Ramachandran,_Christopher_O._Justice,_Mic(BookSee.org).pdf
1EZOQbfQu-e--Eb2xFY5r7WMn3Z8PinnY|67be85d57aab3 (1).pdf
1iVCUtJwM8C7IobQSXNG956-r2DhtlCPB|978-3-030-34489-4.pdf
1Y_aKsYfR-GjaeoK5xlGtovu0PdtWQeTg|978-3-030-98678-0.pdf
172Gd4PFqODXtWMO20I_5oVzA-WjfG6J4|978-3-030-99031-2.pdf
1Mkl-Vu_dkCjsN_9vzWGo8yhpibvHQdx2|978-3-031-05182-1.pdf
1CLM9Uau0vB6hWUm6S3-cZeELkXDWqVzm|978-3-031-26588-4 (2).pdf
1h35JMqkIU-nraIMPmKIgaTbyOY5-oh36|978-3-031-32800-8.pdf
1J8TxpudSiz-fnKcVTE5udBCoO-y6weVE|978-3-031-34037-6.pdf
13L0ylTu4SnShSRHstavkO2ZSxae-wZgL|978-3-031-52973-3.pdf
1KIrv1FMwOwr2in5EF1uIvZCC_rsIPG79|978-3-031-54464-4 (1).pdf
1SKt23G_1o--JfSkPO5z1MViOhXWOS168|978-3-031-54677-8.pdf
1yleUWMao44r6rRNT2C8otR3IZGZe_QR7|978-3-031-88365-1.pdf
10q6xE4OtjfPHGUQ7AzrMcDrNL7W9AYay|978-3-031-89338-4.pdf
19SuEpkmZ-2lGkz13HMJ1hhyWt07mSXZT|978-3-031-96372-8.pdf
1mII8r7kbU9FH43bXk7pBz3hTzsxwQ6oz|978-3-319-31903-2.pdf
1zPQXz0KO5OOPBmL3aFC98-c55R1cSMxe|2020_Materi_R_Hari1.pdf
1jj3m0VxM-6jGbsX2CJ2L4DBpx3IpD81f|2020_R_Hari2.pdf
1u1Jx1N2IDfiWCqMyItsDb8vUYppYTw0E|2020_R_Hari3.pdf
1IEk6XDbdvHLAmpk0d6j3EtX6mbFUq0yS|2022_fundamentals-of-remote-sensing.pdf
1UM_u2Zo7eTDlcvZv7aVFs--lGS3yyeQ4|1669887716.pdf
1Azn9XfUOX05D7iisMg1uM522SJtjugwa|1772808400334.pdf
18vh2Ls23-AjE53HN-o50MM5O9-aZsHtQ|1772893750249.pdf
1wk1IuPRl3qMLGDSktFKNjIaOFOBcNkSL|1773458861979.pdf
1N_kn2vUsIpaiDDy4Y1NlMtbQ0I98XdQF|1773730703709.pdf
1MdndL8H4r8uQUOoLX9U6aUAQN4tBErRf|1774792893369.pdf
1l4HSNB9gPSX2c2wdpWpE0fLtErMG0Uqg|1775431374486.pdf
1E6fmfYHS7pGzkLargICd_5LxprUxM8hV|1776100603015.pdf
1_nLcMYWgTYfsRybU_haqY4zMmfHQgVRp|1776229126922.pdf
1P9SerqFEyK5D7fic-grvcZOzQ31xPZEH|1777123984471.pdf
1JjP2-WD8riPGOclyRH4rsY1pC-OnwAsm|1777136041935.pdf
1hETOTsOvlEugz_EcVY3uuhzn0M9SXoW8|1777192616046.pdf
180rzJhPgalYJSeHGECbtmdZbFtJomDdY|1777547760988.pdf
1GuPWSxu_gypDJ18PMc7ok05oJg3IZQxb|9781003541172_previewpdf.pdf
1IEX9G15z1U27ixdQwte5BeOy71tYogei|A comparative study of impervious surface extraction using Sentinel-2 imagery.pdf
18laEdfyNHC9nVOb1boU_37kd_bJh41bj|An R Companion to Applied Regression (2019, SAGE) - libgen.li.pdf
1KjFsrOcGV1DpsPpIUbD-OjF5ev-hDYXh|An R package for conducting spatially independent evaluations and (1).pdf
1FJ8hUiGXhpIePVERvWNVW4D2-_8Utp5Z|AnalisisDataPerikanandenganRstudio-CPUEs.pdf
1G8apWRnYo3TB8Muh4X7A0bZye48v_b9O|APHA_SM_20.pdf
1DAREsMIdKYhYSNRkeirZQmZy6K2EJx4v|Applied+Geospatial+Data+Science+with+Python.pdf
1fPKWlxwSzX8e9ItTBQwE4DnPTsH5bAGO|ArcGIS for Environmental and Water Issues.pdf
1joN6QdzmQldbaxmGqkSawaix06kweG-k|ArcGIS_Training_Manual.pdf
15afd5nUUjtblkWlZsTb2ZseAwLDv9Xdd|arcgis-10.7-desktop-arcmap-functionality-matrix.pdf
1j-dHPfyGN1QkczDysxChFR4WuBQ3YNDl|Backhouse et al. - 2021 - Bioeconomy and Global Inequalities Socio-Ecologic.pdf
1gH1bmf2qgkyRaHoh8k77XIslb6-zYEUx|bioinformatics-programming-using-python-practical-programming-for-biological-data.pdf
1ChjqG09hzgM3I9vFBj2_mhb8Dx-2sdLL|book-toc (1).pdf
19dGKunfxOxfmYt2N3H6d1iR70F4Vn_ax|Castle and Hendry - 2019 - Modelling our Changing World.pdf
1Xf9Gh9D2O37bgSEvQA1qI3zw2h2ANm9d|Cavender-Bares et al. - 2020 - Remote Sensing of Plant Biodiversity.pdf
1CA5QIvobzBlHcC3WOK1d2PmPZQRx-6SW|cb9049en.pdf
13w_REBnMQJrddHnBhKYIB9-utaBP53CD|Data Visualization in Society.pdf
1uxJmcEgwzmoExBFQit2SugNKUF2xvWXt|datascience.pdf
1RBH6J5SkrCo0XyW_CVp-es6yKPfxQaXG|dcgs-a-sp-1-arcgis-pro-map-fundamentals-ebook.pdf
1G2MmQsJgqCXm4_WfIQCMUZg_hJwFcIXr|Delwart - ESA Standard Document.pdf
1hj5um5CduIaRGG1qqfWGDmU6qQuJtDND|dokumen.pub_data-science-with-julia.pdf
1hufh8fJ7gt5kk5_tLLqKwsN73UA6n8RY|dokumen.pub_geographic-data-science-with-r-visualizing-and-analyzing-environmental-change.pdf
1OceTNGyKb5AmL2uo7fD-nWfUE86fyCz5|dokumen.pub_graphical-data-analysis-with-r.pdf
1OPI-l4ty5OEo_qBoHbhbCKUeT2Kc9ZoP|dokumen.pub_habitat-suitability-and-distribution-models-with-applications-in-r.pdf
1zyqnK24C558--adzFdhcmsIIsRDJJdDi|dokumen.pub_introduction-to-quantitative-ecology-mathematical-and-statistical-modelling-for-beginners.pdf
1tSNahLrd22sQrg8e1fPbWTc3s3RMhoLz|dokumen.pub_joint-species-distribution-modelling-with-applications-in-r-ecology-biodiversity-and-conservation.pdf
1iRKumhNJv9Nk3GQKFTQq3cpEgZSOqr7X|dokumen.pub_python-for-geospatial-data-analysis.epub
143H9tjjpxuPWLhwR4sWg6VR7PRhJs-BV|dokumen.pub_remote-sensing-and-gis-for-ecologists-using-open-source-software-data-in-the-wild.pdf
1uYpw3BFsVj9OBktUNx_BxSifnAhWUcLD|dokumen.pub_spatial-sql-a-practical-approach-to-modern-gis-using-sql.pdf
1HUm68aJP7eLQ2SbOYnQMtqj5_MlZBpCe|dokumen.pub_standard-methods-for-the-examination-of-water-and-wastewater-23th.pdf
10W1R9fkGV1ti3yzM7jwdavFEMZitbBiv|dokumen.pub_statistics-for-ecologists-using-r-and-excel-data-collection-exploration-analysis-and-presentation.epub
1XqBLCiASkjHOcbhuJf0euaqaP2PXLx6R|dokumen.tips_buku-pemantauan-emisi-dan-serapan-karbon2015tosianipdf.pdf
1HG193K2rG3v8gScuixPU0AdePY-_APHy|DOWNLOAD DEM DI QGIS.pdf
1TRHW4DIrvN-jRZc6FiF7l4hmB7Xt1zYw|duckdb-docs-1.0.0.pdf
151yRZNWEpuiDDl1vQtk6HkQFpS_8zcBQ|EarthEngineMeetup2-geemap.pdf
1-hx3lmQ7_Zb1o6lYEySVogOopNOYZopa|Ebook_Inderaja_Python_GEE_Vol1_Syamani.pdf
1Kiet8UnX6v_teVbRhsxYnHZnr2IEamLz|Ecological niche modeling in Maxent  the importance of model complexity and the.pdf
1Khp97YQGmHoGI47ixZA_015K6Znh2Kxu|Ecological Niches and Geographical distributions.pdf
1KRip-vg10HqTSpY0phlTZd2LrvuzvdmW|Effects of grain size and niche breadth on species distribution modeling.pdf
17o--XHOaA7bU8Tm8rW37ft1WO12DpbeO|ElithandFranklin2017.pdf
1KU3zeiBS4iDCL4NXIec5islL9ujI5nWR|Empirical model-building and response surfaces.pdf
1We8E3HsRLUzxbJW-MHhDsvcpm1SvCr0n|ENDBSI_an_Enhanced_Normalized_Difference_Bare_Soil.pdf
1NZK0WHxfhEK7CueFtdcPRCoSDEsQMxoP|English_Blue_Carbon_LR_190306.pdf
1goJEVpTM3hQcXjOvwTSMZ93FuzJkDnQ2|Enhanced_normalized_difference_index_for_imperviou.pdf
1KUiva3HMkggHhi_tRVMm6R8YlErBDBgH|ENMeval  An R package for conducting spatially independent evaluations and.pdf
1H6ryWNgtEkJbfAoz6dyo8ar_XB6HtRQL|environmental-applications-of-remote-sensing.pdf
17WJm5Xsa9P4pU5_G2BXVD9hxqHgkcPyn|ESA Sentinel 1 Tools.pdf
13iih734VMX6LrZecOq85mB34bkS_rFP9|Estimating_Aboveground_Biomass_of_Mangrove_Forests.pdf
1Evfxr2agu99GrUtC_3DEpeqOazgL8OH4|Excel Data Analysis.pdf
10zQkhwF5-Vtzn_l6db8ur3iNa4ZYr6rD|ExperimentTeachingofRemoteSensingDigitalImageProcessingwithVisualCProgramming.pdf
1n0nkXTI-y9gZDQfqDZcJ1hiIYv3tdnEI|feb_e912b978ef52f7b431533f86a11ac4906ae8fda3_1652849497.pdf
1xkcvkajnO1MG7D694vnXpPIRG724KqBd|fenvs-13-1685279.pdf
1blva1Of-JYr1EYzAGWCwq1fBWj5uiZsE|FTP_MODUL_BayuTaruna_Modul Machine Learning DZETSAKA untuk QGIS.pdf
1RMjS6qGzWvKcgIHr1HyM4zuzywo5PLPk|García-Álvarez et al. - 2022 - Land Use Cover Datasets and Validation Tools Validation Practices with QGIS.pdf
1hiVwLWPORa73DB3I7Hgpmbt0wK5F1KLL|geokniga-assessingtheaccuracyofremotelysenseddata (1).pdf
1JeODj34Jb8iI03xyKaJ1RxMtk1pCq77M|geokniga-remote-sensing-and-image-interpretation.pdf
1agUBKZ4SmFodXRZHDKu6j39E8RfGaJjF|GeospatialAnalysisasawayofansweringquestionsaboutourworld4Send.pdf
13Cv1vUoyb4Xc6kslyM6pPXbnGZHNwf14|Getting to Know ArcGIS Pro 3_2 -- Michael Law, Amy Collins -- 2024 -- Esri Press.pdf
10D2Xuqo702ciyE1TcQmtzRu_4rNC16dW|Getting_Started_with_ArcGIS (1).pdf
12z4tkCxniPKC-E3sJfX6pFK3re2r2Zi0|GIS analyst with r
1Kpn08TEaADhVoBUqE3VSbWUrQKV8mvdg|GIS HANDBOOK FOR MUNICIPALITIES .pdf
1qkqY2r4XRMpDwPAIl2OnYOFjXtBBhiB_|Greenhouse gas emissions by sector, World_20260328_124327_0000.pdf
1lkusTj8uF2AkYj-HpUvt6cubhiyqMZE0|Gretchen N. Peterson - GIS Cartography_ A Guide to Effective Map Design (2009) - libgen.li.pdf
1zdvS_2v6_hcgCARi3U5-_GAyyH2Vo_Eb|Guo et al. - 2020 - Manual of Digital Earth.pdf
183xHWx7hLbNaZP3bB2FubDVKijNVgJmX|Hajnsek and Desnos - 2021 - Polarimetric Synthetic Aperture Radar Principles .pdf
1jcdee8ZbsxcDO4CFo4hA6CCZtf2NCYoF|Handling of Geospatial Data with QGIS.pdf
1LmfV78RD1aCWRqS3YZLgeiRhpaZNMJKo|Hetemäki et al. - 2022 - Forest Bioeconomy and Climate Change.pdf
16JWL-JcdmUU_lMemFXEMTdAXbYJ-xCky|Image Analysis, Classification and Change Detection in Remote Sensing -- Canty -- 2019 -- CRC Press.pdf
1_AJC3tk17pBhcw8vQE7dGNDPdzjhAZwX|iMeta - 2025 - Engler - Tidyplots empowers life scientists with easy code‐based data visualization (1).pdf
1bgp8YeZ3THG24ImAMyCqU-IWWMzOIq4V|International_Journal_of_Computational_E.pdf
1KaXuL5ui2ceM-p0I33Kui0ogatF3fphp|Janet Franklin - Mapping Species Distributions_ Spatial Inference and Prediction (2010) - libgen.li.pdf
1OU8-OvZO5Gy4D-6b75HeFzIOjaJJtnfR|jee-49-25.pdf
1BwjNtWkz6A6mWE_lk0_LaWlP5P764ama|Kamusoko - 2019 - Remote Sensing Image Classification in R.pdf
1B4A90nTNeb79g_LkTCxE_13iqj3mugNg|Kellndorfer et al. - 2014 - Large Scale Mapping of Forests and Land Cover with Synthetic Aperture Radar Data.pdf
1_TmZdxTX_qbwey-c-4dy8FiMiGceT6IF|Keskitalo et al. - 2023 - Monitoring biodiversity combining environmental and social data.epub
1sO8yFTy8JyY0CGt75bEiU-xMwa7anmVd|KLHK_2018_IndonesiareportonREDDperformance_B5_revisi_4_opt.pdf
1gLilS8yVQ_93FcCA8kd1CWFDUllRWBvi|Kurniawan et al. - SISTEM INFORMASI GEOGRAFIS MENGGUNAKAN PYTHON.pdf
1Fhy-DSFuzIn5cgeLC-0oETA4h9Y1MPZb|Landsat 8 (L8) Data Users Handbook.pdf
1stBMXrvT5T2nQJl30KJPsHGHI7hMQsCz|Landsat 8-9 Collection 2 Level 2 Science Product Guide.pdf
1pViwxB1rX8HfZzPuu7aNVQUqNMWXv8jj|Li - 2021 - Satellite Remote Sensing Technologies.pdf
1KbVz0bi5NNI_DPtcyNnn801kLuAOg8vg|Making better Maxent models of species distributions complexity, overfitting and evaluation.pdf
1LZ-Tl2WRKcgV-3QBe9eo0KH25KCtNFGe|Mathieu and Aubrecht - 2018 - Earth Observation Open Science and Innovation.pdf
1Kbpu0G0LmgGr2t829udxXTIeBhgRQWIG|Maxent brings comparable results when input data are being completed.pdf
1UAkI4PdtXL-Do1Dci-b-_lpZjoQobrls|Methods Ecol Evol - 2016 - Rominger - meteR  an r package for testing the maximum entropy theory of ecology.pdf
13fwKH5HeCmq8BuQDPfN-nf5swXfMTHeB|Modul ArcGIS Tingkat Lanjut.pdf
1D6sJj_8InNm_gQgxysCIbVx7Tnj9uXX5|Modul Pelatihan MaxEnt FP3.pdf
1sT_3xUdBEtfqo2yHm7R3Am19lPNHIodS|MODUL TEKNIS KRB BANJIR.pdf
14QKiAwzZRaNFFZHbJVpS6FMOuJdcCEa8|MODUL TEKNIS KRB BENCANA tanah_longsor.pdf
1w53EgN97O3JnLxTROmsepGdAmDeyxHyU|MODUL TEKNIS KRB GELOMBANG EKSTRIM DAN ABRASI.pdf
1Svfd5hVvwDVGlMBt5bZxZfAUtzgL2oEe|MODUL TEKNIS KRB GEMPABUMI.pdf
1q2MLH5U3wkl7TJmOiMzTkrVBB-Qx_KgB|MODUL TEKNIS KRB GUNUNG API.pdf
1nYPpaAkqTAW1r0qudzog62Cubyvi8bOO|MODUL TEKNIS KRB KARHUTLA.pdf
1BOujhgOP-haDdrUmpehVbZTjaXX1xsvn|MODUL TEKNIS KRB TSUNAMI.pdf
18G5QBWP7ZRnmdz_lp0EMUAKGhRP2SJn-|MODUL_TEKNIS_KRB_CUACA EKSTRIM.pdf
11AUMcuKYuOl_LfSLX18hby3rU--PeD4j|ModulKlasifikasiCitra.pdf
1pPCQCnsvl_2NzQoro-7oUeovBWICjGaU|ofr20181179.pdf
1L0fsju8pTWI1Pe0ElD2AY8yLY6-LqKZn|Okamoto et al. - 2023 - Local Governance of Peatland Restoration in Riau, .pdf
1ZL3KkIQYjxLqopHy_Y43rPlJLxW5PkHb|Olman and Schneider - 2024 - Global Forest Visualization From Green Marbles to Storyworlds.pdf
14H7UdQ4kfQ-AN489EZWEE35jcODUp_DN|Onno W. Purbo, Python untuk Pemula Menuju AI & Machine Learning, 2026.pdf
1Z6d6CXnRKd8so3uNJM9LgnhDUBbYgiEc|Onoda and Young - 2017 - Satellite Earth Observations and Their Impact on Society and Policy.pdf
1v3iOV3Rueyp8XldnN3kH3uCDHzg4iG2j|Optimal_parameters_of_random_forest_for_land_cover (1).pdf
16nui3tCmPJKm1aIU2_ZVDiACOrw9-3w-|P. et al. - 2011 - Pedoman untuk mempelajari berbagai dampak proyek REDD+ bagi mata pencarian.pdf
1rOn3iYyvk3ZqLpzDAeshL5h_1G4zXXaM|Panduan_Analisis_NDVI_GEE.pdf
1csKuAOz3CW37xWdQ7eu0tGN4PhKi2B25|PANDUAN_KODE_ANALISIS_CH_GEE.pdf
1UK1xCoIFasDkUu7lZV-GWh7JPIE8RT2c|Panduan_NDVI_GEE_Defani.pdf
1xo4gq6cNWN0mIm32Hw-nLXgtvpYv4Myt|Penginderaan Jauh untuk Kehutanan.pdf
1QB5LOfTLSPI4WMlBOHgjamG5Is7R3CLu|PETA_BANDAR UDARA.pdf
1Kix6CQSqk2a4LItKWwZGA8JDj7sbIjiO|Plants People Planet - 2023 - Malabrigo - Most of the world s largest flowers  genus Rafflesia  are now on the brink of (1).pdf
1YFRjXZ3bWbdhHAl3LB-jGR9UbeRWum6T|PP_No_8_Tahun_2013_tentang_Ketelitian_Peta.pdf
1Ed64FOO3pxEO34i0lzura29hBPftbTSf|Prasad S. Thenkabail (editor) - Remote Sensing Handbook, Volume II_ Image Processing, Change Detection, GIS, and Spatial Data Analysis (2024, CRC Press) - libgen.li.pdf
1K8ieKTXX786WapqHfr19N-8zUGx4Eio-|Predicting species distributions from small numbers of occurence records_.pdf
1CdZvIAOalFG0z8IKKFZ6x4b1AeoCymMK|Prediksi Karbon Menggunakan Machine Learning JASP.pdf
1ZSFGJhBU32z5x7RheCfEotkfqkZ4qVXG|preview-9780203497586_A23557251.pdf
1dM39jrjYs606t-7tcTG7uKv5f5A0t-Mi|pustaka_unpad_buku_ajar_sistem_informasi_geografis.pdf
1hnHWq3blBGu6aMibCaoe_0d0YS-id-EX|Python for Data Analysis .pdf
1hhQ48K2151Kk7PA65N4jzp_KraWwX9SW|Python Important one Liners.pdf
1hoAuDzoJyXsq74Y6Um2l5NvX8bTh3tP5|Python Programming .pdf
1q7oTu749CToxNGR8kM4NhimM_opxW9Pd|Python Scripting for ArcGIS Pro, 3rd Edition -- Paul A_ Zandbergen -- 2024 -- Esri Press.epub
14cG1HORyKmGt4soCKaVkaX3OFd5RJ2sc|Python-Powered-Remote-Sensing-Data (1).pdf
1mtlghHqF4uP8zVNp-UYPljhr7TGZ2qzF|QGIS-3.40-GentleGISIntroduction-en.pdf
1hdkC_ke2F1Gn3rbX78hnO3reftyqjHls|R CookBook.pdf
1yApeqYP4kImYVubmy_MbupmVZ5M_e1wA|RahmanHilmyNugroho_AplikasiArcGISModelBuilderUntukAnalisisIntensitasPemanfaatanRuang.pdf
1VY5z8ZBCr2d9AgCtwSZ4mN_XILbpyv9O|raster_SDM.pdf
1KqWmecPD3V2rOhMj6irxXKal1aVTYU8r|README.md
1hY8WYbH8YqdTFQfc-L6WDjrV_5BExi_w|Remote Sens Ecol Conserv - 2025 - D'hont - Integrating terrestrial and canopy laser scanning for comprehensive analysis of.pdf
1ht2_N2uxiZ5FY_CUWVdJMWMxzvCOCql6|Remote sensing for Forest Carbon.pdf
1otEjfnHtM3JZm_94H3TYaF0h4aUeY4C-|Remote Sensing Image Analysis with R.pdf
1Rnn5LdGxPMFowVbzbxPf0Atx_HlfEqki|remote-sensing-and-digital-image-processing-with-r-lab-manual.pdf
1whWamvtX-pPxcy9BAkrJAvtAMr9AM6Ml|remote-sensing-principles-and-applications-2nd-revised-edition.pdf
1WaZhovBDWpgWD8cRrWEUezpo0VG14Tjx|remotesensing-07-08489-v2.pdf
1ebvyl_agfWcZtmChH--8eMH5HYW-5Dco|remotesensing-10-01079-v2.pdf
1_DDJuKXErME4hDUl8xipW0SM5RzsWiju|remotesensing-11-01351.pdf
1EjMCRB1H1J1r-uI8lE6qO3g7XVttmUTc|remotesensing-11-01966-v2.pdf
1c7RBSboKe1GiLKTMkZSjAQUMT1NMeMlf|remotesensing-12-01220-v2.pdf
1SrUp4b31Im9R1rruL7Ep31JKf01xQobn|remotesensing-12-03263.pdf
1rh-hUNRgke78NlmwlbCGdjPq5LOfkngi|remotesensing-13-01446.pdf
1hexk34yYRdWVTztkFrvROflJ9GG1B9YT|remotesensing-13-03753.pdf
1Rk3cOLi8Q8BQAhW3mf85nLKeGs6i7C-B|remotesensing-14-00003.pdf
1hczCA-AE01wxPzlM5tk6wbBogwInbRrV|remotesensing-14-03112-v2.pdf
1haeHzQAB6dPcazDQxWFguZJNXczsJm-k|remotesensing-14-04868 (1).pdf
1jnqcddYwwQrTVX12Yf3kBHol_J74tYpC|remotesensing-16-00665.pdf
1heNBZ9Nhc9LnfLFfkfwzErTH-bJgZcQ2|remotesensing-16-01191-v2.pdf
1hh7k6HfQdbiNbUdcLYtjDvvJtm8e-uZ4|remotesensing-16-01400.pdf
1jvMQTSIL5YyrUZ-XKfZtiYzXg0qJ3nOQ|remotesensing-16-01958 (1).pdf
17L_ebnRMBsvskS2oqLWeeWxSOOrP96OA|remotesensing-17-01410.pdf
1FbNhGueU45xHOIIdG2pW6Ii8isYv8Ssq|remotesensing-17-02358.pdf
1hZLQx-DjIGclx7eigI9WPeGFOuXR46Sw|remotesensing-17-02935.pdf
1tBaDxG5XroEKeedzF414jEkyXct0-PHU|RJ-2012-007.pdf
1CLilVvj11WPaVRJrzQtDMHwQXjzDmCUo|Rosenstock et al. - 2016 - Methods for Measuring Greenhouse Gas Balances and Evaluating Mitigation Options in Smallholder Agric.pdf
1huQjT1Ju7OP60lOchauo6es23dttrpP7|rs (2).pdf
1hvCFIRZs1HZfELb1_ZUxAfMpGtgVu8uv|RStoolbox.pdf
1w_QRoX0Eca9OBvgvm5Wgz6m0HPR5ejVO|RTCE_2.pdf
18cye2kiW6MaRIh7xskrvDSPWmlv_CHPY|S1TBX Landcover classification with Sentinel-1 GRD.pdf
1YTbVNo3hky4qcv7NFGkyUq0Q7q1QnztC|S1TBX TOPSAR Interferometry with Sentinel-1 Tutorial_v2.pdf
1nRzel5zrm8SWTgX5VOshknl1KUUvBJ4U|s11119-024-10144-x.pdf
15LcojEBpBK-qJLvvYn_WQGqX64GBOq9W|s11356-025-36485-2 (1).pdf
1kpixkqy0nFUS5ULeojPkUNhDMSgclaLn|s40562-017-0080-9.pdf
1HubprntKnIFYDOn1i_4zx3QuKiJjIYfT|s41467-023-36477-1.pdf
1azx3DEuibdaYTGYFJ4fh4yTgT6aeyeL1|s41558-025-02486-9.pdf
1ygBCxcxOb4QDVNgJ-wYqOfo__wDbx4gr|s41586-025-09135-3 (1).pdf
1NlrhRItgs_wQIfKD1jbrVDEJdtweCqSb|s41597-025-04900-5.pdf
1eIWxxcicCEwavSX-Z4H263AxN7kgx5FN|s41597-025-06097-z.pdf
1XDREdcwQcowkrVj-0ddaNltLSAw8hl4k|s41598-025-89298-1.pdf
1P7UX56x5QpDNS-CSXutZiaVIo-_h6SMH|s41598-026-35152-x_reference.pdf
1xBwCkxl1BMtqs0VH7c3LC9qTkYytk8sI|s43621-025-01709-5.pdf
1ua28rau-RgHlnV44yTGJN9mhiEfbNiIv|s44392-025-00029-w (1).pdf
1ut2vsG9GSA4Y8UJSz4UphCt41ZC1qBil|Salinan dari Kirain Cuman Bisa Bikin Script, Ternyata Claude AI Bisa Visual_20260529_200206_0000.pdf
1fljmKtkgXDQE7es40cMIw9XWvZl4573C|Salinan_PerBIG_NO_16_THN_2019_SATUAN_HARGA_PENYELENGGARAAN_INFORMASI.pdf
1fd9m-2G2lSlc97-Zuh806jdaOVuGmyMp|SARHB_FullRes_2019.pdf
15FclXYA-lxP5yXqhjZvt_d3iFOU4dUDR|satellite.pdf
1KX66CerRLObXAxCEfmfQ0xL5lEitWwge|Satellite remote sensing techniques for mapping and estimating mangrove carbon stocks in the small island of Gili Meno West Nusa Tenggara Indonesia.pdf
1pXyXtoVEziLqqrIQTW37FO4W11JwyCX9|Sauer - 2021 - Landsat 8-9 Calibration and Validation (CalVal) Algorithm Description Document (ADD).pdf
16GvFeI5ak1eHjMUiPq_6dbY9yNJCSgFh|scikit-image_image_processing_in_Python.pdf
1KGO5NKopjuLtRFa09NIeYsaCJNJsO399|sdmr.pdf
1KE0RanIhG1vEt3y0ii06pLYR6GSHGnYv|Selecting pseudo‐absences for species distribution models  how  where and how.pdf
1swkDvwXT5uMRM6MzUfJ96u6UvHGyF1O7|Sentinel 1.pdf
1Dt-JbqsCPjlIXEIIocS4hhfE4UBr2yRO|Sentinel-2-product-specifications-document-V14-9.pdf
1-KTw2db67P318qd43ogFWfx4H-A4QNlx|SISTEM INFORMASI KEHUTANAN.pdf
1vC5V7arpH2UDMANGEhmI5KP59dlLFIPt|slik_et_al_2009_dd.pdf
19AjzeDBbJyuFOKpWYujyD5bL_bL7GfcA|SNI 19-6502.1-2000_image.pdf
1IIgSArIPLsE_I1Ud3mkvok9QyQ3LKhOs|SNI_2010_7645_Klasifikasi_penutup_lahan.pdf
1CbT67eB40uTtolmlC5qtSOBhTaJXIuO0|SNI_iRBI_SKALA 50.000.pdf
1hlBb4fZBg_fVaO76vIveJH3cP8MBazgH|SNI_PETA CURAH HUJAN.pdf
1gTNdhEHAB_GIuthyifN0nyoM_Vbuw-WK|SNI_PETA DASAR LINGKUNGAN PANTAI_50K.pdf
1UVqEy-g2vRHdo8F1bR0IFLGdowWhYx-f|SNI_PETA DASAR LINGKUNGAN PANTAI_250K.pdf
11tQYkqZmK6LUV3tfylQoh1SqIdRtToiZ|SNI_RBI_SKALA 25.000.pdf
1rY_rtxDn2xyFph7e71uPZCW2RTWSSfA-|SNI_RBI_SKALA 250.000.pdf
1EYThzUbPi3M2bcWYYiPkjJyfOJnypuBE|sni-03-1733-2004-tata-cara-perencanaan-lingkungan.pdf
11ch-4t54i6JBq0QJ0Xqet9Zo2b_LOZRa|Sommer - Deep Learning based Vehicle Detection in Aerial Imagery.pdf
1VFI4ojQGNAu8R0BRr61sBLswJ01ys4PK|Spatial Analysis With R.pdf
1hyHK1R4DirRJCI4CiQdWapadGqL07FM2|Spatial Data in R.pdf
1KA-wD6Q1nWVjxnlcRlNTLhG3ybuMb1ne|Species Distribution models_ ecological explanation and prediction across space and time.pdf
1KAe576Lyj1hlDoqcqh9YW3WXB9o4DyK9|Species-specific tuning increases robustness to sampling bias in models of species distributions.pdf
1KDuUsuzie5J0OwJQIqAK3v7KXcKjFOVp|spThin an R package for spatial thinning of species occurence records for use in ecological niche models.pdf
1MXT1Z6u92E8iDHK4RsvxP4ElF1OsmrQz|ssrn-4084684 (2).pdf
1wrCUB7U5xspICokX-5O8tYCLjY-M9gVN|ssrn-6220040.pdf
1hYcr_zNDZpC7B9KPdEvuxFln8Q9Joe0Q|StatisticsMachineLearningPython.pdf
1ZvQLfTWSKYcRGJlUe9_OqbgVx32RADtI|Sugianto_buku1.pdf
1qe7d8mSSqmop9R9CSXuUUYLd3kUcpcFB|Sundnes - 2020 - Introduction to Scientific Programming with Python.pdf
1ws5SYjNcjNDRWoMru6lzFIBrYI3xV9Ca|sustainability-17-08505-v2.pdf
1wtsmyzKfuJxsYLoG2IOSH4s6qS_KvXH5|Tambahkan subjudul_20260416_104223_0000.pdf
1htJvMUZ-O_reHB6KhIeEiDiEIgCLBXt5|terra (1).pdf
1gJydGTNNH-ESU7N9wb6HP6Qoy7c6Lw5Y|TerrSet-2020-Tutorial.pdf
118dtZd65gF7euEnXVFYzIotwcMfT1niS|Terrset-liberaGIS-Manual.pdf
1Mhnkd-Eh8Cc4UDGxbmVlGM0XrwkGSHxy|The ArcGIS Book.pdf
1ZlzwebYrv8lMpgSyg0Wyjle1QgkkY8GZ|The automated temporal burn index ATBI for accurate and scalable burned area mapping.pdf
1WNjO9mP9dRwdRee7OAiNUptWw7D3umDQ|Three_Decades_of_Forest_Biomass_Estimation_in_Sout (1).pdf
1LlNzSZTRl7rDpPOEbI7wGfG7troAR2e9|Thresholding Menggunakan SCP QGIS.pdf
11g5ta55eCxaYydJczzQRecKo5Uwty1EQ|Triyanti et al. - 2023 - Environmental Governance in Indonesia.pdf
1KAfWOilGsNGd4Jk96NXbRABoplTCCsBw|tw-6165-494 (1).pdf
1OSZygNZu6DORJan3ABlAvy_WTEgBjkLJ|urbansci-09-00042.pdf
1KLMNjNHOBWLAnVksQGvWUDZ5ff7I0lTf|Validation of 'AW3D' global DSM generated from ALOS PRISM.pdf
1KHjY3N7vGsvWo1DDXEf25uP9AK0T2ABv|Variance inflation factor as condition for the inclusion of suppressor variable in regression analysis.pdf
1KGBfrT7S4wB9aCUVFrXZZ-X1KDwOYljc|Wallace  A flexible platform for reproducible modeling of species niches and.pdf
1rLoz_Ep2nxxsOHYXRUBIN_bisFj1uFIX|wallaceecomod_github.pdf
13nYgnDnaVDHP9pvJduZtPon4fXzPW05Q|Walters and Scholes - 2017 - The GEO Handbook on Biodiversity Observation Networks.pdf
14p3dMq7wZJK14yRkNHG7_IVReA0PMQCk|White Dark Green And Orange Modern Agriculture Company Profile Booklet.pdf`;

const LEARN_OFFICE = `14LaKXKU9J60OxKxpeeG0zyLGtZuV6coB|72 rumus penting excel.pdf
14Hp-s7FlcgMikflZonAAZZaEPGlHy15a|100 shortcut excel untuk mac os.pdf
14Fq8HiDlSFm3jn-IlbWL3jn4DFSOgKaw|100 Shortcut Excel untuk windows.pdf
14Krw-NcuNjrjcnNQctxF_Eywmqm4dnKX|belajar excel dari 0.pdf
1bQsq9dlixnAL0q90zDVl2Vi56JqPAN3q|MS EXCEL.pdf
1SY7AccqGzxOGA8pk8fb0NN828w8AtnLV|MS WORD.pdf
1_4J3dtM2e36OgmSS1WnBgmrSIJvBvXe0|RUMUS _ FUNGSI EXCEL LANJUTAN.pdf`;

// topic → test on the file name; the first match wins, so the specific ones come first
const LEARN_TOPICS = [
  ["Bencana (modul KRB BNPB)", /KRB|bencana/i],
  ["Google Earth Engine", /GEE|Earth ?Engine|geemap/i],
  ["Python", /python|scikit|julia|duckdb/i],
  ["SAR & Sentinel", /Sentinel|\bSAR|SARHB|S1TBX|Polarimetric|radar/i],
  ["Landsat & olah citra", /Landsat|image|citra|interpretation|classification|change detection|DSM|thresholding/i],
  ["QGIS", /QGIS|SCP|dzetsaka/i],
  ["ArcGIS", /ArcGIS|ArcMap|ModelBuilder/i],
  ["R & statistik", /(^|[\s_(-])R([\s_.)-]|$)|RStudio|R_Hari|terra|RStoolbox|sdmr|tidyplots|RJ-2012|statistic|regression|JASP|variance|Excel Data|response surfaces|data science|datascience|visualization/i],
  ["Distribusi spésiés & ékologi", /Maxent|species|niche|SDM|habitat|ecolog|biodiversity|wallace|ENMeval|spThin|pseudo|Rafflesia|meteR/i],
  ["Leuweung, karbon & REDD+", /forest|karbon|carbon|REDD|biomass|mangrove|peat|gambut|kehutanan|bioeconomy|greenhouse|emisi|burn/i],
  ["Standar & aturan (SNI, BIG, PP)", /SNI|PP_No|PerBIG|ketelitian|APHA|standard methods/i],
  ["SIG & kartografi", /GIS|geospatial|cartograph|spatial|digital earth|TerrSet|peta/i],
  ["Penginderaan jauh", /remote.?sensing|remotely|penginderaan|inderaja|satellite|earth observation|ESA/i],
  ["Jurnal & artikel", /^(remotesensing-|s\d{5}|fenvs|sustainability|urbansci|ssrn|jee-|tw-|rs \(|International_Journal|ENDBSI|Enhanced|Optimal|Estimating|Three_Decades|A comparative|Validation|iMeta|Plants People)/i],
];

/** A readable title from a Drive file name. */
function learnTitle(name) {
  return name
    .replace(/\.(pdf|epub|md)$/i, "")
    .replace(/^(Salinan( dari)? |dokumen\.(pub|tips)_|geokniga-|FTP_MODUL_)/i, "")
    .replace(/\s*-\s*libgen\.li|_compress|_previewpdf|\s*\(\d\)$/gi, "")
    .replace(/[_+]+/g, " ")
    .replace(/(?<=[a-z])-(?=[a-z])/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

let learnItems = null;
/** Every file once (copies and "(1)" duplicates folded), with its topic. */
function learnIndex() {
  if (learnItems) return learnItems;
  const seen = new Set();
  learnItems = [];
  const add = (block, folderTopic) => {
    for (const line of block.split("\n")) {
      const [id, name] = line.split("|");
      if (!id || !name || /README|Company Profile|Tambahkan subjudul|book-toc/i.test(name)) continue;
      const title = learnTitle(name);
      const key = title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const topic = folderTopic ?? LEARN_TOPICS.find(([, re]) => re.test(name))?.[0] ?? (/^[\d\[]|^\d{13}/.test(name) ? "Buku & bab (Springer jsb)" : "Séjénna");
      learnItems.push({ id, title, name, topic, url: `https://drive.google.com/file/d/${id}/view` });
    }
  };
  add(LEARN_RS);
  add(LEARN_OFFICE, "Microsoft Office");
  learnItems.sort((a, b) => a.title.localeCompare(b.title));
  return learnItems;
}

function learnStatus(text) {
  LEARN.status = text;
  if (LEARN.root) LEARN.root.status.textContent = text;
}

function learnRender() {
  const r = LEARN.root;
  if (!r) return;
  const q = LEARN.query;
  const items = learnIndex().filter((it) => !q || `${it.title} ${it.topic} ${it.name}`.toLowerCase().includes(q));
  const topics = [...LEARN_TOPICS.map(([t]) => t), "Buku & bab (Springer jsb)", "Microsoft Office", "Séjénna"];
  const kids = [];
  for (const topic of topics) {
    const list = items.filter((it) => it.topic === topic);
    if (!list.length) continue;
    const open = !!q || LEARN.open.has(topic);
    kids.push(tbRow("is-box", "set", topic, () => { LEARN.open.has(topic) ? LEARN.open.delete(topic) : LEARN.open.add(topic); learnRender(); }, list.length));
    if (!open) continue;
    for (const it of list) {
      const pick = el("input", { type: "checkbox", checked: LEARN.picked.has(it.id), title: "Jadikeun sumber pikeun patarosan" });
      pick.addEventListener("change", () => { pick.checked ? LEARN.picked.set(it.id, it) : LEARN.picked.delete(it.id); learnRenderPicked(); });
      const openBtn = el("button", { type: "button", className: "glb-ls-btn", textContent: "Buka", title: it.name });
      openBtn.addEventListener("click", () => dcOpenUrl(it.url));
      kids.push(el("div", { className: "glb-learn-row" }, [pick, el("span", { className: "glb-dc-grow", textContent: it.title, title: it.name }), openBtn]));
    }
  }
  if (!kids.length) kids.push(el("p", { className: "glb-ls-note", textContent: "Euweuh modul nu cocog." }));
  r.tree.replaceChildren(...kids);
  r.count.textContent = `${items.length} modul`;
  learnRenderPicked();
}

function learnRenderPicked() {
  const r = LEARN.root;
  if (!r) return;
  const picked = [...LEARN.picked.values()];
  r.picked.replaceChildren(...(picked.length
    ? picked.map((it) => {
      const x = el("button", { type: "button", className: "glb-learn-chip", textContent: `${it.title.slice(0, 40)}${it.title.length > 40 ? "…" : ""} ×`, title: "Piceun tina sumber" });
      x.addEventListener("click", () => { LEARN.picked.delete(it.id); learnRender(); });
      return x;
    })
    : [el("span", { className: "glb-ls-note", textContent: "Sumber: sakabéh pustaka Drive (atawa centang modul husus)." })]));
}

/** Send the question to the listening AI client with the Drive sources. */
function learnAsk(text, modelKey) {
  const question = text.trim();
  if (!question) return;
  if (modelKey && modelKey !== state.settings.activeClient) {
    state.settings.activeClient = modelKey;
    saveSettings();
  }
  const picked = [...LEARN.picked.values()];
  const sources = picked.length
    ? picked.map(({ id, title, url }) => ({ id, title, url }))
    : learnIndex().filter((it) => question.toLowerCase().split(/\W+/).some((w) => w.length > 3 && it.title.toLowerCase().includes(w))).slice(0, 12).map(({ id, title, url }) => ({ id, title, url }));
  const res = sendUserMessage(`[Learn] ${question}`, {
    source: "learn",
    learn: { folder: LEARN_FOLDER, model: modelKey, sources, hint: "Baca file Google Drive ieu (read_file_content ku id) tuluy jawab dumasar eusina; sebutkeun judul jeung kaca sumberna." },
  });
  learnStatus(res.listening ? `Dikirim ka ${modelName(activeModel())} (${sources.length} sumber).` : `Disimpen. Hurungkeun mode dengar di ${modelName(activeModel())} (“dengar simple gis”).`);
}

function renderLearn(container) {
  container.classList.add("glb-tb", "glb-learn");
  const search = el("input", { type: "search", className: "glb-ls-search", placeholder: "Téang modul (NDVI, Maxent, SAR, QGIS, karbon…)" });
  search.addEventListener("input", () => { LEARN.query = search.value.trim().toLowerCase(); learnRender(); });
  search.addEventListener("keydown", (e) => e.stopPropagation());
  const count = el("span", { className: "glb-tb-count" });
  const tree = el("div", { className: "glb-tb-tree" });
  const picked = el("div", { className: "glb-learn-picked" });
  const ask = el("textarea", { className: "glb-learn-ask", rows: 3, placeholder: "Tanyakeun materi: “jelaskeun NDVI di GEE”, “léngkah Maxent”, “rumus Excel VLOOKUP”…" });
  ask.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) send.click();
  });
  const model = el("select", { className: "glb-ls-select", title: "Modél AI anu ngajawab" }, MODELS.filter((m) => m.key !== "gemini").map((m) => el("option", { value: m.key, textContent: `${modelName(m)} · ${m.model}`, selected: m.key === state.settings.activeClient })));
  const send = el("button", { type: "button", className: "glb-ls-btn is-primary", textContent: "Tanya" });
  send.addEventListener("click", () => { learnAsk(ask.value, model.value); ask.value = ""; });
  const folder = el("button", { type: "button", className: "glb-ls-btn", textContent: "Folder Drive", title: LEARN_FOLDER });
  folder.addEventListener("click", () => dcOpenUrl(LEARN_FOLDER));
  const status = el("span", { className: "glb-ls-status" });
  container.append(
    el("div", { className: "glb-ls-top glb-learn-top" }, [search, count]),
    tree,
    el("section", { className: "glb-learn-box" }, [picked, ask, el("div", { className: "glb-dc-line" }, [model, send])]),
    el("footer", { className: "glb-ls-foot" }, [status, folder]),
  );
  LEARN.root = { container, tree, status, count, picked };
  learnRender();
  return () => {
    LEARN.root = null;
  };
}

function registerLearn(app) {
  if (!app.registerRightPanel || state.disposeLearn) return;
  state.disposeLearn = app.registerRightPanel({ id: LEARN_PANEL_ID, title: "Learn", defaultWidth: 360, render: renderLearn });
}

// ---------------------------------------------------------------------------
// Left side: tools and data input only (the panels live on the right). A slim
// vertical toolbar like QGIS's "Manage Layers" bar; every button runs an
// existing GeoLibre menu entry, so nothing here duplicates a second workflow.
// ---------------------------------------------------------------------------

const LB = { el: null };

// [label, icon, action]: an action is a menu path from the menu bar, or a function
const LB_ITEMS = [
  ["Browser", "browser", () => lbToggle("Browser")],
  ["S3 / cloud storage", "cloud", () => lbCloudStorage()],
  "sep",
  ["Add Vector Layer", "vector", ["Add Data", "Vector Layer"]],
  ["Add Raster Layer", "raster", ["Add Data", "Raster Layer"]],
  ["Add Delimited Text (CSV)", "csv", ["Add Data", "Delimited Text Layer"]],
  ["Add GeoParquet Layer", "parquet", ["Add Data", "GeoParquet Layer"]],
  ["Add PostgreSQL Layer", "db", ["Add Data", "PostgreSQL Layer"]],
  ["Add WMS / WMTS Layer", "wms", ["Add Data", "WMS Layer"]],
  ["Add XYZ Tile Layer", "xyz", ["Add Data", "XYZ Layer"]],
  ["Add WFS Layer", "wfs", ["Add Data", "WFS Layer"]],
  "sep",
  ["Identify features", "identify", () => lbClick('[aria-label="Identify visible layers"]')],
  ["GeoEditor (digitize)", "edit", () => lbClick('[aria-label="GeoEditor"]')],
  ["SQL Workspace", "sql", ["Processing", "SQL Workspace"]],
  ["Toolbox", "toolbox", () => state.app?.openRightPanel?.(TB_PANEL_ID)],
  ["Katalog Data (GFW, GBIF, BMKG, BIG…)", "catalog", () => state.app?.openRightPanel?.(DC_PANEL_ID)],
  ["Learn (modul Drive + tanya AI)", "learn", () => state.app?.openRightPanel?.(LEARN_PANEL_ID)],
];

const LB_ICONS = {
  browser: '<g fill="none" stroke="#c8a85a" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M1.8 4h4.4l1.3 1.5h6.7v7.5H1.8z"/></g>',
  cloud: '<g fill="none" stroke="#6f97c2" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5h7a2.6 2.6 0 0 0 .3-5.2A3.6 3.6 0 0 0 4.9 6.6a2.9 2.9 0 0 0-.4 5.9z"/></g>',
  vector: '<g fill="none" stroke="#6f9f6f" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 12 6 4l4 6 3.5-5"/><circle cx="2.5" cy="12" r="1"/><circle cx="6" cy="4" r="1"/><circle cx="10" cy="10" r="1"/><circle cx="13.5" cy="5" r="1"/></g>',
  raster: '<g fill="none" stroke="#9a83c4" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="12" height="12"/><path d="M2 6h12M2 10h12M6 2v12M10 2v12"/></g>',
  csv: '<g fill="none" stroke="#a39a84" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 1.5h6l3 3v10h-9z"/><path d="M9.5 1.5v3h3M5.5 8h5M5.5 10.5h5M5.5 13h3"/></g>',
  parquet: '<g fill="none" stroke="#c48f5f" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="3" width="11" height="10" rx=".8"/><path d="M2.5 6.5h11M2.5 9.8h11M6.2 3v10"/></g>',
  db: '<g fill="none" stroke="#5f97b0" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="8" cy="4" rx="5" ry="1.8"/><path d="M3 4v8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V4M3 8c0 1 2.2 1.8 5 1.8S13 9 13 8"/></g>',
  wms: '<g fill="none" stroke="#5fa58a" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.8"/><path d="M2.2 8h11.6M8 2.2c2.4 3 2.4 8.6 0 11.6M8 2.2c-2.4 3-2.4 8.6 0 11.6"/></g>',
  xyz: '<g fill="none" stroke="#9a83c4" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 5.5 8 2.5l6 3-6 3zM2 8.5l6 3 6-3M2 11.5l6 3 6-3"/></g>',
  wfs: '<g fill="none" stroke="#c48f5f" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.8"/><path d="M5 9.5 7 6l2 3 2-2"/></g>',
  identify: '<g fill="none" stroke="#6f97c2" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.8"/><path d="M8 7.3v4"/><path d="M8 4.8v.1"/></g>',
  edit: '<g fill="none" stroke="#c8a85a" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 13l1-3.5 7-7 2.5 2.5-7 7zM9.5 4l2.5 2.5"/></g>',
  sql: '<g fill="none" stroke="#8796a6" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="8" cy="4" rx="5" ry="1.8"/><path d="M3 4v8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V4M6 8.6h4M6 11h3"/></g>',
  learn: '<g fill="none" stroke="#c8a85a" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3.5c2-.8 4-.8 6 .6 2-1.4 4-1.4 6-.6V13c-2-.8-4-.8-6 .6-2-1.4-4-1.4-6-.6z"/><path d="M8 4.1v9.5"/></g>',
  catalog: '<g fill="none" stroke="#5fa58a" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="5"/><path d="M2 7h10M7 2c1.9 2.6 1.9 7.4 0 10M7 2c-1.9 2.6-1.9 7.4 0 10M10.8 10.8 14 14"/></g>',
  toolbox: '<g fill="none" stroke="#c97b76" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><rect x="1.8" y="5.5" width="12.4" height="8" rx=".8"/><path d="M5.8 5.5V3.6h4.4v1.9M1.8 9h12.4M7 8v2h2V8"/></g>',
};

function lbClick(selector) {
  const b = document.querySelector(`#root ${selector}`);
  if (b) for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) uiFire(b, t);
  return !!b;
}

/** Expand a left-dock tab (Browser / Layers) wherever the skin has moved it. */
function lbToggle(name) {
  return lbClick(`[aria-label="Expand ${name}"]`) || lbClick(`[aria-label="Collapse ${name}"]`);
}

/** Run a menu-bar entry by its path, e.g. ["Add Data", "Vector Layer"]. */
async function lbMenu(path) {
  await tbCloseMenus();
  const btn = [...document.querySelectorAll("#root header > button")].find((b) => tbLabel(b) === path[0]);
  if (!btn) return false;
  tbPointer(btn, "pointerdown");
  btn.click();
  await tbSleep(260);
  let menu = tbOpenMenus()[0];
  for (const [i, step] of path.slice(1).entries()) {
    const it = menu && [...menu.querySelectorAll("[role=menuitem]")].find((x) => tbLabel(x) === step);
    if (!it) {
      await tbCloseMenus();
      return false;
    }
    if (i === path.length - 2) {
      it.click();
      return true;
    }
    tbPointer(it, "pointermove");
    it.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await tbSleep(240);
    const ms = tbOpenMenus();
    menu = ms[ms.length - 1];
  }
  return false;
}

/** S3 / cloud storage: GeoLibre keeps it in Settings › Cloud Storage. */
async function lbCloudStorage() {
  if (!(await lbMenu(["Settings"]))) return;
  await tbSleep(400);
  const tab = [...document.querySelectorAll('[role=dialog] button, [role=dialog] [role=tab], [role=dialog] a')].find((x) => /cloud storage/i.test(tbLabel(x)));
  tab?.click();
}

function lbIcon(name) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = LB_ICONS[name] ?? "";
  return svg;
}

function leftBarOn() {
  const shell = document.querySelector("#root header")?.nextElementSibling;
  if (!shell || LB.el?.isConnected) return;
  const bar = el("nav", { className: "glb-lb", ariaLabel: "Data and tools" });
  for (const item of LB_ITEMS) {
    if (item === "sep") {
      bar.append(el("span", { className: "glb-lb-sep" }));
      continue;
    }
    const [label, icon, action] = item;
    const b = el("button", { type: "button", className: "glb-lb-btn", title: label, ariaLabel: label });
    b.append(lbIcon(icon));
    b.addEventListener("click", () => (Array.isArray(action) ? lbMenu(action) : action()));
    bar.append(b);
  }
  // first child of the work area, so it is the far-left column
  shell.prepend(bar);
  LB.el = bar;
}

function leftBarOff() {
  LB.el?.remove();
  LB.el = null;
}

// Layout Composer through its own AI API (window.LayoutComposer.ai): a fixed
// list of actions, so print layouts can be made without enabling exec_js.
const LAYOUT_ACTIONS = new Set([
  "describe", "item", "layouts", "newLayout", "switchLayout", "add", "update", "remove", "select",
  "page", "undo", "saveVersion", "cursor", "suggest", "exportDialog", "done",
  "klhk.spec", "klhk.themes", "klhk.theme", "klhk.legend", "klhk.baseLegend", "klhk.newLayout",
]);

HANDLERS.layout = async ({ action = "describe", args = [] } = {}) => {
  const lc = window.LayoutComposer;
  if (!lc?.ai) throw new Error("Layout Composer teu acan aktip di GeoLibre (Plugins → Manage Plugins).");
  const list = Array.isArray(args) ? args : [args];
  if (action === "open" || action === "close") {
    await lc[action]?.();
    return { action, open: action === "open" };
  }
  if (!LAYOUT_ACTIONS.has(action)) throw new Error(`Aksi layout '${action}' teu dikenal. Pilihan: open, close, ${[...LAYOUT_ACTIONS].join(", ")}`);
  if (!lc._state?.open && action !== "describe" && action !== "layouts") await lc.open?.();
  const [ns, name] = action.includes(".") ? action.split(".") : [null, action];
  const target = ns ? lc.ai[ns] : lc.ai;
  if (typeof target?.[name] !== "function") throw new Error(`Layout Composer ieu teu boga '${action}'.`);
  let result = await target[name](...list);
  if (["add", "update", "remove", "select", "page", "newLayout", "klhk.newLayout"].includes(action)) await lc.ai.done?.();
  try {
    result = JSON.parse(JSON.stringify(result ?? null));
  } catch {
    result = String(result);
  }
  return { action, result };
};

HANDLERS.activate_plugin = async ({ plugin_id, active = true } = {}) => {
  const app = requireApp();
  if (!plugin_id) throw new Error("plugin_id wajib diisi.");
  if (active) {
    if (!app.activatePlugin) throw new Error("Versi GeoLibre ini belum punya activatePlugin().");
    const ok = await app.activatePlugin(plugin_id);
    return { plugin_id, active: !!ok };
  }
  if (!app.deactivatePlugin) throw new Error("Versi GeoLibre ini belum punya deactivatePlugin().");
  return { plugin_id, active: !app.deactivatePlugin(plugin_id) };
};

// ############################################################################
// ########## Charts (Plotly) #################################################
// ############################################################################
//
// `show_chart` puts a Plotly figure into the chat log, so a chart the AI makes
// appears in the robot bubble and in every other chat view (e.g. the "Tanya
// AI" tab of Kobo Connector). The figure is plain Plotly JSON
// ({data, layout, config}); anything plotly.js can draw is allowed.
//
// plotly.js is not bundled (it is ~4.5 MB). It is loaded once on first use:
//   1. window.Plotly if another plugin already loaded it,
//   2. a <script> tag from a CDN,
//   3. fetch + eval of the same file (for a CSP that blocks script-src but
//      allows connect-src), and the fetched text is kept in Cache Storage so
//      the next load works offline.
// If all of that fails (offline, first run) the chart falls back to a small
// SVG drawing of bar/line/scatter/pie traces, so the answer is never empty.

const PLOTLY_VERSION = "2.35.2";
const PLOTLY_URLS = [
  `https://cdn.jsdelivr.net/npm/plotly.js-dist-min@${PLOTLY_VERSION}/plotly.min.js`,
  `https://cdn.plot.ly/plotly-${PLOTLY_VERSION}.min.js`,
  `https://unpkg.com/plotly.js-dist-min@${PLOTLY_VERSION}/plotly.min.js`,
];
const PLOTLY_CACHE = "geolibre-live-bridge-plotly";
const CHART_MAX_POINTS = 20000; // per figure, keeps the chat store small
const PLOTLY_COLORWAY = ["#636efa", "#EF553B", "#00cc96", "#ab63fa", "#FFA15A", "#19d3f3", "#FF6692", "#B6E880", "#FF97FF", "#FECB52"];

let plotlyPromise = null;

function loadScriptTag(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = url;
    s.async = true;
    s.dataset.glbPlotly = "1";
    const timer = setTimeout(() => {
      s.remove();
      reject(new Error("timeout"));
    }, 20000);
    s.onload = () => {
      clearTimeout(timer);
      window.Plotly ? resolve(window.Plotly) : reject(new Error("Plotly tidak terdefinisi"));
    };
    s.onerror = () => {
      clearTimeout(timer);
      s.remove();
      reject(new Error(`gagal memuat ${url}`));
    };
    document.head.append(s);
  });
}

function evalPlotly(text) {
  // plotly.min.js is a UMD bundle; without module/define it sets globalThis.Plotly.
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", "define", text)(undefined, undefined, undefined);
  if (!window.Plotly) throw new Error("Plotly tidak terdefinisi setelah eval");
  return window.Plotly;
}

async function loadPlotlyFromCache() {
  if (!("caches" in window)) return null;
  try {
    const cache = await caches.open(PLOTLY_CACHE);
    for (const url of PLOTLY_URLS) {
      const hit = await cache.match(url);
      if (hit) return evalPlotly(await hit.text());
    }
  } catch {
    /* no cache available */
  }
  return null;
}

async function loadPlotlyByFetch() {
  let lastErr = null;
  for (const url of PLOTLY_URLS) {
    try {
      const res = await fetch(url, { cache: "force-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      try {
        if ("caches" in window) {
          const cache = await caches.open(PLOTLY_CACHE);
          await cache.put(url, new Response(text, { headers: { "Content-Type": "application/javascript" } }));
        }
      } catch {
        /* caching is optional */
      }
      return evalPlotly(text);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error("Plotly tidak bisa diunduh");
}

function ensurePlotly() {
  if (window.Plotly) return Promise.resolve(window.Plotly);
  if (plotlyPromise) return plotlyPromise;
  plotlyPromise = (async () => {
    const cached = await loadPlotlyFromCache();
    if (cached) return cached;
    for (const url of PLOTLY_URLS) {
      try {
        const P = await loadScriptTag(url);
        // Keep a copy for offline use (field laptops are often without signal).
        void fetch(url, { cache: "force-cache" })
          .then((res) => (res.ok ? res.text() : null))
          .then(async (text) => {
            if (!text || !("caches" in window)) return;
            const cache = await caches.open(PLOTLY_CACHE);
            await cache.put(url, new Response(text, { headers: { "Content-Type": "application/javascript" } }));
          })
          .catch(() => {});
        return P;
      } catch {
        /* try the next source */
      }
    }
    return loadPlotlyByFetch();
  })().catch((err) => {
    plotlyPromise = null; // allow a retry once the network is back
    throw err;
  });
  return plotlyPromise;
}

function isDarkUi() {
  try {
    const root = document.documentElement;
    if (root.classList.contains("dark")) return true;
    if (root.classList.contains("light")) return false;
    if (root.dataset && (root.dataset.theme === "dark" || root.dataset.theme === "light")) {
      return root.dataset.theme === "dark";
    }
    return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ?? false;
  } catch {
    return false;
  }
}

// Re-theme every mounted chart when GeoLibre's own light/dark toggle changes
// (a class/attribute flip on <html>), not just when the OS theme changes.
const themedCharts = new Set(); // {plotEl, fig, chart, height}
let themeObserverInstalled = false;
function ensureThemeObserver() {
  if (themeObserverInstalled) return;
  themeObserverInstalled = true;
  try {
    const obs = new MutationObserver(() => {
      if (!window.Plotly) return;
      for (const entry of themedCharts) {
        if (!entry.plotEl.isConnected) {
          themedCharts.delete(entry);
          continue;
        }
        try {
          window.Plotly.relayout(entry.plotEl, themedLayout(entry.fig.layout, { height: entry.height, title: entry.chart.title }));
        } catch {
          /* chart not fully mounted yet */
        }
      }
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
  } catch {
    /* MutationObserver unavailable */
  }
}

function normalizeFigure(input) {
  let fig = input;
  if (typeof fig === "string") fig = JSON.parse(fig);
  if (Array.isArray(fig)) fig = { data: fig };
  if (!fig || typeof fig !== "object") throw new Error("Figure harus objek Plotly {data, layout}.");
  if (fig.figure && !fig.data) fig = fig.figure;
  const data = Array.isArray(fig.data) ? fig.data : fig.data ? [fig.data] : [];
  if (!data.length) throw new Error("Figure butuh minimal satu trace di 'data'.");
  let points = 0;
  for (const t of data) {
    for (const key of ["x", "y", "values", "z", "lat", "lon"]) if (Array.isArray(t?.[key])) points += t[key].length;
  }
  if (points > CHART_MAX_POINTS) {
    throw new Error(`Data chart terlalu besar (${points} nilai, batas ${CHART_MAX_POINTS}). Agregasikan dulu, mis. pakai live_kobo_aggregate.`);
  }
  return { data, layout: fig.layout && typeof fig.layout === "object" ? fig.layout : {}, config: fig.config && typeof fig.config === "object" ? fig.config : {} };
}

function themedLayout(layout, { height, title } = {}) {
  const dark = isDarkUi();
  const text = dark ? "#e5e7eb" : "#2a3f5f";
  const grid = dark ? "rgba(255,255,255,0.12)" : "#e5ecf6";
  const base = {
    height,
    autosize: true,
    margin: { l: 48, r: 14, t: title || layout.title ? 40 : 14, b: 44 },
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: dark ? "rgba(255,255,255,0.03)" : "#ffffff",
    font: { family: "-apple-system, 'Segoe UI', Roboto, sans-serif", size: 11, color: text },
    colorway: PLOTLY_COLORWAY,
    hoverlabel: { font: { size: 11 } },
    legend: { orientation: "h", y: -0.22, font: { size: 10 } },
    xaxis: { gridcolor: grid, zerolinecolor: grid, automargin: true },
    yaxis: { gridcolor: grid, zerolinecolor: grid, automargin: true },
  };
  if (title && !layout.title) base.title = { text: title, font: { size: 13 }, x: 0.02, xanchor: "left" };
  const merged = { ...base, ...layout };
  for (const k of ["margin", "font", "xaxis", "yaxis", "legend"]) {
    if (layout[k] && typeof layout[k] === "object") merged[k] = { ...base[k], ...layout[k] };
  }
  if (height) merged.height = layout.height && layout.height < height ? layout.height : height;
  return merged;
}

// Minimal SVG drawing for when plotly.js cannot be loaded at all.
function fallbackSvg(fig, height) {
  const ns = "http://www.w3.org/2000/svg";
  const W = 320;
  const H = height;
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "glb-chart-svg");
  const mk = (tag, attrs, text) => {
    const n = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    if (text !== undefined) n.textContent = text;
    svg.append(n);
    return n;
  };
  const traces = fig.data;
  const pie = traces.find((t) => t.type === "pie");
  if (pie) {
    const vals = (pie.values ?? []).map(Number);
    const labels = pie.labels ?? [];
    const total = vals.reduce((a, b) => a + (b > 0 ? b : 0), 0) || 1;
    let a0 = -Math.PI / 2;
    const cx = 90;
    const cy = H / 2;
    const r = Math.min(80, H / 2 - 10);
    vals.forEach((v, i) => {
      const a1 = a0 + (Math.max(v, 0) / total) * Math.PI * 2;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      mk("path", {
        d: `M${cx},${cy} L${cx + r * Math.cos(a0)},${cy + r * Math.sin(a0)} A${r},${r} 0 ${large} 1 ${cx + r * Math.cos(a1)},${cy + r * Math.sin(a1)} Z`,
        fill: PLOTLY_COLORWAY[i % PLOTLY_COLORWAY.length],
      });
      mk("text", { x: 185, y: 16 + i * 14, "font-size": 10, fill: "currentColor" }, `${labels[i] ?? i}: ${v}`);
      a0 = a1;
    });
    return svg;
  }
  const L = 40;
  const R = 8;
  const T = 10;
  const B = 34;
  const xs = [];
  for (const t of traces) for (const x of t.x ?? (t.y ?? []).map((_, i) => i)) if (!xs.includes(String(x))) xs.push(String(x));
  let ymax = 0;
  let ymin = 0;
  for (const t of traces) for (const y of t.y ?? []) {
    const v = Number(y);
    if (Number.isFinite(v)) {
      ymax = Math.max(ymax, v);
      ymin = Math.min(ymin, v);
    }
  }
  if (ymax === ymin) ymax = ymin + 1;
  const px = (i) => L + ((i + 0.5) / Math.max(xs.length, 1)) * (W - L - R);
  const py = (v) => T + (1 - (v - ymin) / (ymax - ymin)) * (H - T - B);
  mk("line", { x1: L, y1: py(0), x2: W - R, y2: py(0), stroke: "currentColor", "stroke-opacity": 0.3 });
  mk("text", { x: L - 4, y: T + 8, "text-anchor": "end", "font-size": 9, fill: "currentColor" }, String(Math.round(ymax * 100) / 100));
  const bars = traces.filter((t) => !t.type || t.type === "bar");
  const bw = ((W - L - R) / Math.max(xs.length, 1)) * 0.8;
  traces.forEach((t, ti) => {
    const color = t.marker?.color && typeof t.marker.color === "string" ? t.marker.color : PLOTLY_COLORWAY[ti % PLOTLY_COLORWAY.length];
    const tx = (t.x ?? (t.y ?? []).map((_, i) => i)).map(String);
    const ty = (t.y ?? []).map(Number);
    if (!t.type || t.type === "bar") {
      const bi = bars.indexOf(t);
      const w = bw / Math.max(bars.length, 1);
      tx.forEach((x, i) => {
        const v = ty[i];
        if (!Number.isFinite(v)) return;
        const x0 = px(xs.indexOf(x)) - bw / 2 + bi * w;
        mk("rect", { x: x0, y: Math.min(py(v), py(0)), width: Math.max(w - 1, 1), height: Math.abs(py(0) - py(v)), fill: color });
      });
    } else {
      const pts = tx.map((x, i) => [px(xs.indexOf(x)), py(ty[i])]).filter((p) => Number.isFinite(p[1]));
      if (!String(t.mode ?? "lines").includes("markers") || String(t.mode ?? "").includes("lines")) {
        mk("polyline", { points: pts.map((p) => p.join(",")).join(" "), fill: "none", stroke: color, "stroke-width": 2 });
      }
      if (String(t.mode ?? "").includes("markers")) for (const p of pts) mk("circle", { cx: p[0], cy: p[1], r: 2.5, fill: color });
    }
  });
  const step = Math.ceil(xs.length / 8);
  xs.forEach((x, i) => {
    if (i % step) return;
    mk("text", { x: px(i), y: H - B + 12, "text-anchor": "middle", "font-size": 9, fill: "currentColor" }, x.length > 10 ? `${x.slice(0, 9)}…` : x);
  });
  return svg;
}

/**
 * Draw a chart message into `container`. Returns a disposer.
 * Used by the robot bubble and by other plugins through window.__geolibreLive.
 */
function renderChartInto(container, chart, { height = 240 } = {}) {
  container.classList.add("glb-chart");
  container.replaceChildren();
  let fig;
  try {
    fig = normalizeFigure(chart.figure ?? chart);
  } catch (err) {
    container.append(el("div", { className: "glb-chart-err", textContent: `Chart tidak valid: ${err.message}` }));
    return () => {};
  }
  const plotEl = el("div", { className: "glb-chart-plot" });
  plotEl.style.height = `${height}px`;
  const bar = el("div", { className: "glb-chart-bar" });
  const bigBtn = el("button", { type: "button", className: "glb-chart-btn", textContent: "⤢ Gedéan", title: "Buka grafik gedé" });
  const pngBtn = el("button", { type: "button", className: "glb-chart-btn", textContent: "⭳ PNG", title: "Unduh gambar grafik" });
  const jsonBtn = el("button", { type: "button", className: "glb-chart-btn", textContent: "{ } JSON", title: "Salin figur Plotly (JSON)" });
  bar.append(bigBtn, pngBtn, jsonBtn);
  container.append(plotEl);
  if (chart.caption) container.append(el("div", { className: "glb-chart-caption", textContent: chart.caption }));
  container.append(bar);

  let disposed = false;
  let usingPlotly = false;
  ensureThemeObserver();
  const themeEntry = { plotEl, fig, chart, height };
  const draw = (target, h, extraConfig = {}) =>
    ensurePlotly().then((Plotly) => {
      if (disposed) return null;
      usingPlotly = true;
      target.replaceChildren();
      return Plotly.newPlot(target, fig.data, themedLayout(fig.layout, { height: h, title: chart.title }), {
        responsive: true,
        displaylogo: false,
        displayModeBar: "hover",
        ...fig.config,
        ...extraConfig,
      });
    });

  plotEl.append(el("div", { className: "glb-chart-loading", textContent: "Keur muka Plotly…" }));
  draw(plotEl, height)
    .then(() => themedCharts.add(themeEntry))
    .catch(() => {
    if (disposed) return;
    plotEl.replaceChildren(fallbackSvg(fig, height));
    container.append(el("div", { className: "glb-chart-note", textContent: "Mode basajan: plotly.js teu bisa diunduh (offline?). Grafik interaktif muncul lamun geus online." }));
  });

  bigBtn.addEventListener("click", () => openChartModal(chart, fig));
  pngBtn.addEventListener("click", async () => {
    try {
      const Plotly = await ensurePlotly();
      const url = await Plotly.toImage(plotEl, { format: "png", width: 1200, height: 700, scale: 2 });
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(chart.title || "chart").replace(/[^\w\-]+/g, "_").slice(0, 60)}.png`;
      a.click();
    } catch (err) {
      pngBtn.textContent = "gagal";
      setTimeout(() => (pngBtn.textContent = "⭳ PNG"), 1500);
    }
  });
  jsonBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify({ data: fig.data, layout: fig.layout }, null, 2));
      jsonBtn.textContent = "tersalin";
    } catch {
      jsonBtn.textContent = "gagal";
    }
    setTimeout(() => (jsonBtn.textContent = "{ } JSON"), 1500);
  });

  return () => {
    disposed = true;
    themedCharts.delete(themeEntry);
    if (usingPlotly && window.Plotly) {
      try {
        window.Plotly.purge(plotEl);
      } catch {
        /* already gone */
      }
    }
  };
}

function openChartModal(chart, fig) {
  const overlay = el("div", { className: "glb-chart-modal" });
  const box = el("div", { className: "glb-chart-modal-box" });
  const close = el("button", { type: "button", className: "glb-chart-modal-close", textContent: "×", title: "Close" });
  const plot = el("div", { className: "glb-chart-modal-plot" });
  box.append(close, plot);
  overlay.append(box);
  document.body.append(overlay);
  const done = () => {
    try {
      window.Plotly?.purge(plot);
    } catch {
      /* ignore */
    }
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      done();
    }
  };
  document.addEventListener("keydown", onKey, true);
  close.addEventListener("click", done);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) done();
  });
  const h = Math.max(320, Math.round(window.innerHeight * 0.72));
  ensurePlotly()
    .then((Plotly) =>
      Plotly.newPlot(plot, fig.data, themedLayout(fig.layout, { height: h, title: chart.title }), {
        responsive: true,
        displaylogo: false,
        ...fig.config,
      }),
    )
    .catch(() => plot.replaceChildren(fallbackSvg(fig, 360)));
}

HANDLERS.show_chart = ({ figure, data, layout, config, title = "", caption = "", message = "" } = {}) => {
  const fig = normalizeFigure(figure ?? { data, layout, config });
  if (!assistant.bubble) {
    const map = currentMap();
    if (map) mountAssistant(map);
  }
  const chart = { title: String(title || ""), caption: String(caption || ""), figure: fig };
  const now = nowHM();
  const prev = assistant.history[assistant.history.length - 1];
  const text = String(message || "").trim();
  if (prev && prev.role === "bot" && prev.status === "working" && !prev.chart) {
    Object.assign(prev, { text: text || prev.text, status: "info", time: now, chart });
  } else {
    assistant.history.push({ role: "bot", text, status: "info", time: now, chart, via: chat.lastVia || "geolibre" });
  }
  chat.typing = false;
  assistant.history.splice(0, Math.max(0, assistant.history.length - CHAT_MAX_ITEMS));
  saveChat();
  renderChat();
  if (assistant.bubble) assistant.bubble.hidden = false;
  const traces = fig.data.map((t) => t.type || "scatter");
  return { shown: true, title: chart.title, traces, views: hub.subscribers.size + (assistant.bubble ? 1 : 0) };
};

// ############################################################################
// ########## Kobo Connector data (via window.__geolibreKobo) #################
// ############################################################################

function koboApi() {
  const api = window.__geolibreKobo;
  if (!api) {
    throw new Error("Plugin Kobo Connector (v0.2.0+) belum aktif di GeoLibre. Aktifkan lewat menu Plugins atau live_activate_plugin('geolibre-kobo-connector').");
  }
  return api;
}

HANDLERS.kobo_summary = (params = {}) => koboApi().summary(params);
HANDLERS.kobo_fields = (params = {}) => koboApi().fields(params);
HANDLERS.kobo_rows = (params = {}) => koboApi().rows(params);
HANDLERS.kobo_aggregate = (params = {}) => koboApi().aggregate(params);
HANDLERS.kobo_load = (params = {}) => koboApi().load(params);
HANDLERS.kobo_show_point = (params = {}) => koboApi().showPoint(params);
HANDLERS.kobo_route = (params = {}) => koboApi().route(params);

// ############################################################################
// ########## Hub: shared chat for other plugins ##############################
// ############################################################################
//
// window.__geolibreLive lets another plugin (Kobo Connector's "Tanya AI" tab)
// show the same conversation and send messages into the same outbox that the
// AI reads with chat_wait / chat_inbox. One chat, several windows onto it.

const hub = {
  subscribers: new Set(),
  api: null,
};

function hubSnapshot() {
  return {
    history: assistant.history.slice(),
    listening: isListening(),
    typing: chat.typing,
    queued: chat.outbox.length,
    connected: state.status === "connected",
    status: state.status,
  };
}

function hubNotify() {
  if (!hub.subscribers.size) return;
  const snap = hubSnapshot();
  for (const fn of hub.subscribers) {
    try {
      fn(snap);
    } catch {
      /* one broken view must not stop the rest */
    }
  }
}

function installHub() {
  hub.api = {
    version: PLUGIN_VERSION,
    snapshot: hubSnapshot,
    subscribe(fn) {
      hub.subscribers.add(fn);
      try {
        fn(hubSnapshot());
      } catch {
        /* ignore */
      }
      return () => hub.subscribers.delete(fn);
    },
    send(text, extraContext = {}) {
      const t = String(text ?? "").trim();
      if (!t) return null;
      return sendUserMessage(t, extraContext);
    },
    renderChart: (container, chart, opts) => renderChartInto(container, chart, opts),
    ensurePlotly,
    clear() {
      assistant.history.splice(0);
      saveChat();
      renderChat();
    },
    openBubble: () => openChat(),
    // who is talking, for chat UIs in other plugins (Layout Composer)
    profile: { user: { name: "Defani", avatar: USER_AVATAR }, bot: { name: "Claude", avatar: CLAUDE_AVATAR } },
  };
  window.__geolibreLive = hub.api;
  state.listeners.add(hubNotify);
}

function uninstallHub() {
  state.listeners.delete(hubNotify);
  if (window.__geolibreLive === hub.api) delete window.__geolibreLive;
  hub.api = null;
}

// ############################################################################
// ########## UI: map control + floating panel ################################
// ############################################################################

const STATUS_LABEL = {
  connected: "Nyambung",
  connecting: "Keur nyambungkeun…",
  disconnected: "Pegat",
  rejected: "Ditolak",
};

function createIcon() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  // plug icon
  for (const d of ["M9 2v6", "M15 2v6", "M6 8h12v3a6 6 0 0 1-12 0z", "M12 17v5"]) {
    const p = document.createElementNS(ns, "path");
    p.setAttribute("d", d);
    svg.appendChild(p);
  }
  return svg;
}

const control = {
  _container: null,
  _dot: null,
  _unsub: null,
  onAdd() {
    const container = document.createElement("div");
    container.className = "maplibregl-ctrl maplibregl-ctrl-group glb-live-control";
    const button = document.createElement("button");
    button.type = "button";
    button.title = PLUGIN_NAME;
    button.setAttribute("aria-label", "Buka panel Live MCP Bridge");
    button.appendChild(createIcon());
    const dot = document.createElement("span");
    dot.className = "glb-live-dot";
    button.appendChild(dot);
    button.addEventListener("click", () => {
      if (state.app?.openFloatingPanel?.(PANEL_ID)) return;
      // Hosts without floating panels: the button just toggles the link.
      if (state.status === "connected" || state.status === "connecting") disconnect();
      else connect();
    });
    container.appendChild(button);
    this._container = container;
    this._dot = dot;
    const update = () => {
      dot.dataset.status = state.status;
      button.title = `${PLUGIN_NAME}: ${STATUS_LABEL[state.status] ?? state.status}`;
    };
    state.listeners.add(update);
    this._unsub = () => state.listeners.delete(update);
    update();
    return container;
  },
  onRemove() {
    this._unsub?.();
    this._container?.remove();
    this._container = null;
  },
};

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  // `dataset` must not go through Object.assign: it is a getter-only accessor.
  const ds = props.dataset;
  if (ds) {
    const rest = { ...props };
    delete rest.dataset;
    Object.assign(node, rest);
    for (const [k, v] of Object.entries(ds)) node.dataset[k] = v;
  } else {
    Object.assign(node, props);
  }
  for (const c of children) node.append(c);
  return node;
}

// MCP clients that can switch — `/model` names the active one.
const MODELS = [
  { key: "opencode", label: "⚡ OpenCode", model: "GLM-5.3-Flash-Free", detail: "fallback :free only" },
  { key: "gemini", label: "✦ Gemini API", model: "gemini-2.5-flash (free)", detail: "free tier" },
  { key: "claude", label: "◈ Claude", model: "claude-opus-5-5", detail: "Claude Code / Claude Desktop" },
];

const modelName = (m) => m.label.replace(/^\S+\s/, "");
const activeModel = () => MODELS.find((m) => m.key === state.settings.activeClient) ?? MODELS[0];

// Slash commands handled by the panel itself.
const CLI_COMMANDS = [
  ["/help", "", "daptar paréntah"],
  ["/status", "", "sambungan, ngadéngé, prosés"],
  ["/connect", "", "nyambung ka server MCP"],
  ["/disconnect", "", "megatkeun sambungan"],
  ["/model", "[ngaran]", "tingali / ganti modél"],
  ["/port", "<n>", "ganti port WebSocket"],
  ["/token", "<t|->", "pasang / hapus token"],
  ["/auto", "on|off", "nyambung sorangan pas dibuka"],
  ["/exec", "on|off", "idinan exec_js ti AI"],
  ["/autoclose", "on|off", "tutup panel nu dibuka AI pas beres"],
  ["/skin", "on|off", "tata perenah ala QGIS, monokrom"],
  ["/server", "<path>", "lokasi geolibre-live.exe"],
  ["/setup", "[klien]", "config klien MCP + salin"],
  ["/log", "", "kagiatan WebSocket"],
  ["/clear", "", "beresihan layar"],
];

// Processing commands: sent to the AI as a request, with the map context.
const CLI_PROCESSING = [
  ["/buffer", "<jarak>", "buffer lapisan nu dipilih"],
  ["/clip", "<lapisan>", "potong ku lapisan séjén"],
  ["/intersect", "<lapisan>", "irisan jeung lapisan séjén"],
  ["/dissolve", "[kolom]", "gabungkeun fitur dumasar kolom"],
  ["/area", "[satuan]", "legana unggal fitur (ha, km²)"],
  ["/centroid", "", "titik tengah fitur"],
  ["/reproject", "<epsg>", "ganti proyéksi lapisan"],
  ["/zonal", "<raster>", "statistik zonal tina raster"],
  ["/landcover", "[taun]", "tutupan lahan per kelas (ha, %)"],
  ["/summary", "", "ringkesan lapisan nu dipilih"],
  ["/chart", "<kolom>", "grafik tina kolom lapisan"],
];
const PROCESSING_NAMES = new Set(CLI_PROCESSING.map(([c]) => c));

// 5-row pixel font for the banner; each "#" is one solid square cell.
const BANNER_FONT = {
  G: [" ### ", "#    ", "# ###", "#   #", " ### "],
  E: ["#####", "#    ", "#### ", "#    ", "#####"],
  O: [" ### ", "#   #", "#   #", "#   #", " ### "],
  L: ["#    ", "#    ", "#    ", "#    ", "#####"],
  I: ["###", " # ", " # ", " # ", "###"],
  B: ["#### ", "#   #", "#### ", "#   #", "#### "],
  R: ["#### ", "#   #", "#### ", "#  # ", "#   #"],
  D: ["#### ", "#   #", "#   #", "#   #", "#### "],
  F: ["#####", "#    ", "#### ", "#    ", "#    "],
  A: [" ### ", "#   #", "#####", "#   #", "#   #"],
  N: ["#   #", "##  #", "# # #", "#  ##", "#   #"],
  M: ["#   #", "## ##", "# # #", "#   #", "#   #"],
  C: [" ####", "#    ", "#    ", "#    ", " ####"],
  P: ["#### ", "#   #", "#### ", "#    ", "#    "],
  S: [" ####", "#    ", " ### ", "    #", "#### "],
  " ": ["  ", "  ", "  ", "  ", "  "],
};

/** CSS size of one pixel-art cell, rounded to whole device pixels (crisp at 125 %, 150 % …). */
function pixelCell(css) {
  const dpr = window.devicePixelRatio || 1;
  return Math.max(1, Math.round(css * dpr)) / dpr;
}

/** Size a banner SVG so each cell is `css` px, snapped to whole device pixels. */
function sizePixelArt(svg, css) {
  const cell = pixelCell(css);
  svg.setAttribute("width", String(Number(svg.dataset.cols) * cell));
  svg.setAttribute("height", String(Number(svg.dataset.rows) * cell));
}

/** The largest whole-device-pixel cell that fits `cols` cells in `room` CSS px. */
function fitCell(room, cols) {
  const dpr = window.devicePixelRatio || 1;
  return Math.max(1, Math.floor((room * dpr) / cols)) / dpr;
}

/**
 * The banner as a pixel-block SVG (Claude Code logo style), one word per row.
 * Solid square cells, so it stays crisp at any panel width.
 */
function bannerSvg(...words) {
  const ns = "http://www.w3.org/2000/svg";
  const rows = BANNER_FONT.G.length;
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "glb-cli-banner");
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", words.join(" "));
  let width = 0;
  words.forEach((word, w) => {
    let x = 0;
    [...word].forEach((ch) => {
      const glyph = BANNER_FONT[ch] ?? BANNER_FONT[" "];
      glyph.forEach((line, y) => {
        [...line].forEach((c, dx) => {
          if (c !== "#") return;
          const r = document.createElementNS(ns, "rect");
          for (const [k, v] of Object.entries({ x: x + dx, y: w * (rows + 2) + y, width: 1, height: 1 })) r.setAttribute(k, String(v));
          svg.append(r);
        });
      });
      x += glyph[0].length + 1;
    });
    width = Math.max(width, x - 1);
  });
  const height = words.length * (rows + 2) - 2;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.dataset.cols = String(width);
  svg.dataset.rows = String(height);
  sizePixelArt(svg, 3);
  return svg;
}

/** The pixel mascot (16×13 grid): body, arms, eyes, four legs; CSS animates it. */
function mascotSvg() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 13");
  svg.setAttribute("width", String(16 * pixelCell(3)));
  svg.setAttribute("height", String(13 * pixelCell(3)));
  svg.setAttribute("class", "glb-cli-mascot");
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("aria-hidden", "true");
  const group = (cls) => {
    const g = document.createElementNS(ns, "g");
    g.setAttribute("class", cls);
    svg.append(g);
    return g;
  };
  const rect = (parent, x, y, w, h, cls = "") => {
    const r = document.createElementNS(ns, "rect");
    for (const [k, v] of Object.entries({ x, y, width: w, height: h })) r.setAttribute(k, String(v));
    if (cls) r.setAttribute("class", cls);
    parent.append(r);
  };
  const legsA = group("glb-m-legs-a");
  const legsB = group("glb-m-legs-b");
  rect(legsA, 3, 11, 1, 2);
  rect(legsA, 10, 11, 1, 2);
  rect(legsB, 5, 11, 1, 2);
  rect(legsB, 12, 11, 1, 2);
  const body = group("glb-m-body");
  rect(body, 2, 3, 12, 8);
  rect(body, 0, 7, 16, 2);
  rect(body, 4, 5, 1, 2, "glb-m-eye");
  rect(body, 11, 5, 1, 2, "glb-m-eye");
  return svg;
}

// 9×9 pixel GIS icons that take turns under the mascot (CSS cycles them).
const GIS_ICONS = {
  pin: ["..#####..", ".##...##.", ".##...##.", ".##...##.", "..#####..", "...###...", "....#....", ".........", "..#####.."],
  globe: ["..#####..", ".#..#..#.", "#...#...#", "#...#...#", "#########", "#...#...#", "#...#...#", ".#..#..#.", "..#####.."],
  layers: ["....#....", "..##.##..", "##.....##", "..##.##..", "##..#..##", "..##.##..", "##..#..##", "..##.##..", "....#...."],
  polygon: ["##.......", "##.......", "#.#......", "#..#.....", "#...#....", "#....#...", "#.....#..", "##.....##", "#########"],
};

/** The GIS icon cycle: one pixel SVG per icon, stacked; CSS fades them in turn. */
function gisIconsEl() {
  const ns = "http://www.w3.org/2000/svg";
  const wrap = el("div", { className: "glb-cli-gis", title: "pin · globe · layers · polygon" });
  wrap.style.width = wrap.style.height = `${9 * pixelCell(3)}px`;
  Object.entries(GIS_ICONS).forEach(([name, grid], i) => {
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 9 9");
    svg.setAttribute("shape-rendering", "crispEdges");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", `glb-cli-gis-icon is-${name}`);
    svg.style.animationDelay = `${i * 2}s`;
    grid.forEach((row, y) =>
      [...row].forEach((c, x) => {
        if (c !== "#") return;
        const r = document.createElementNS(ns, "rect");
        for (const [k, v] of Object.entries({ x, y, width: 1, height: 1 })) r.setAttribute(k, String(v));
        svg.append(r);
      }),
    );
    wrap.append(svg);
  });
  return wrap;
}

// Claude Code's asterisk spinner, played forward then back.
const SPINNER = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];

/** What the busy line says: the running task, else the running tool, else "Thinking". */
function activityLabel() {
  const lastBot = [...assistant.history].reverse().find((m) => m.role === "bot");
  if (lastBot?.status === "working") {
    const task = (lastBot.tasks ?? []).find((t) => typeof t !== "string" && !t.done);
    if (task) return task.label;
  }
  const step = [...activity.steps].reverse().find((s) => s.status === "run");
  if (step) return step.label;
  return chat.typing ? "Keur maca pesen" : "Keur mikir";
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const fmtSecs = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

function renderPanel(container) {
  container.classList.add("glb-live-panel", "glb-cli");
  const out = el("div", { className: "glb-cli-out" });
  // Intro at the top of the scrollback: banner, tips, a notice box while offline.
  const banner = bannerSvg("DEFANI", "SIMPLE GIS", "MCP");
  const tips = el("div", { className: "glb-cli-tips" }, [
    el("div", { textContent: "Tips keur ngamimitian:" }),
    el("div", { textContent: "1. Tanyakeun peta, lapisan, atawa ménta analisis." }),
    el("div", {}, ["2. Ketik ", el("b", { textContent: "/" }), " pikeun paréntah jeung alat olah data."]),
    el("div", {}, ["3. Ketik ", el("b", { textContent: "dengar geolibre" }), " di klien MCP sangkan obrolan ieu dibaca."]),
    el("div", {}, ["4. ", el("b", { textContent: "/help" }), " pikeun info leuwih lengkep."]),
  ]);
  const notice = el("div", { className: "glb-cli-notice" });
  const mascot = mascotSvg();
  const welcomeSub = el("div", { className: "glb-cli-dim" });
  // the mascot stands beside the banner; name, model and status go underneath
  const welcome = el("div", { className: "glb-cli-welcome" }, [
    el("div", {}, [el("b", { textContent: "GeoLibre Live MCP" }), el("span", { className: "glb-cli-dim", textContent: ` v${PLUGIN_VERSION}` })]),
    welcomeSub,
  ]);
  const brandX = el("div", { className: "glb-cli-brand-x" }, [banner, welcome]);
  const brand = el("div", { className: "glb-cli-brand" }, [el("div", { className: "glb-cli-badge" }, [mascot, gisIconsEl()]), brandX]);
  // the banner fills the space right of the badge, in whole-pixel cells
  const fitBanner = () => {
    if (!brandX.clientWidth) return;
    const cell = fitCell(brandX.clientWidth, Number(banner.dataset.cols));
    banner.setAttribute("width", String(Number(banner.dataset.cols) * cell));
    banner.setAttribute("height", String(Number(banner.dataset.rows) * cell));
  };
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(fitBanner) : null;
  ro?.observe(brandX);
  const intro = el("div", { className: "glb-cli-intro" }, [brand, tips, notice]);
  const busy = el("div", { className: "glb-cli-busy" });
  const servers = el("div", { className: "glb-cli-servers" });
  const suggest = el("div", { className: "glb-cli-suggest", hidden: true });
  const input = el("input", {
    type: "text",
    className: "glb-cli-input",
    placeholder: "Ketik pesen atawa /paréntah",
    spellcheck: false,
    autocomplete: "off",
  });
  const prompt = el("div", { className: "glb-cli-prompt" }, [el("span", { className: "glb-cli-caret", textContent: ">" }), input]);
  const foot = el("div", { className: "glb-cli-foot" });
  container.append(out, busy, servers, suggest, prompt, foot);

  const charts = new WeakMap();
  // Command output stays in this terminal only, pinned after the history item it followed.
  let local = [];
  const cleared = new WeakSet();
  const past = [];
  let pastIdx = 0;
  let lastProc = null;

  const renderNotice = () => {
    const port = Number(state.settings.port) || DEFAULT_PORT;
    const offline = state.status !== "connected";
    notice.hidden = !offline;
    if (offline) {
      notice.replaceChildren(
        el("div", { textContent: `Live MCP ${(STATUS_LABEL[state.status] ?? state.status).toLowerCase()} — ws://127.0.0.1:${port}` }),
        el("div", { textContent: state.statusDetail || "Hurungkeun klien MCP, terus ketik /connect" }),
      );
    }
  };

  const renderServers = () => {
    const m = activeModel();
    welcomeSub.textContent = `${modelName(m)} · ${STATUS_LABEL[state.status] ?? state.status}`;
    servers.replaceChildren(
      `Make ${modelName(m)} ngaliwatan geolibre-live (`,
      el("span", { className: "glb-cli-hl", textContent: "/model" }),
      " pikeun ngaganti)",
    );
  };

  const renderFoot = () => {
    const on = isListening();
    const queued = chat.outbox.length;
    const m = activeModel();
    foot.replaceChildren(
      el("span", { className: "glb-cli-cwd", textContent: "~/geolibre" }),
      el("span", {
        className: `glb-cli-listen${on ? " is-on" : ""}`,
        textContent: on ? "ngadéngékeun" : `teu ngadéngékeun${queued ? ` · ${queued} ngantri` : ""}`,
      }),
      el("span", { className: "glb-cli-model", textContent: m.model }),
    );
  };

  // Animated busy line (spinner, label, elapsed, model) above the prompt.
  let frame = 0;
  let ticker = null;
  const renderBusy = () => {
    const on = activity.since > 0;
    busy.hidden = !on;
    mascot.classList.toggle("is-busy", on);
    if (!on) {
      clearInterval(ticker);
      ticker = null;
      return;
    }
    const step = [...activity.steps].reverse().find((s) => s.status === "run");
    busy.replaceChildren(
      el("div", {}, [
        el("span", { className: "glb-cli-spin", textContent: SPINNER[frame % SPINNER.length] }),
        " ",
        el("span", { className: "glb-cli-busy-x", textContent: `${cap(activityLabel())}…` }),
        el("span", { className: "glb-cli-dim", textContent: ` (${fmtSecs(Date.now() - activity.since)} · ${activeModel().model})` }),
      ]),
      el("div", { className: "glb-cli-dim glb-cli-busy-sub" }, [
        "⎿ ",
        step ? `ngajalankeun ${step.method}` : `${activity.steps.length} parabot geus dipaké`,
      ]),
    );
    if (!ticker) {
      ticker = setInterval(() => {
        frame += 1;
        activityTimeout();
        renderBusy();
      }, 120);
    }
  };

  const renderOut = () => {
    const stick = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
    const visible = assistant.history.filter(
      (m) => !cleared.has(m) && (m.role === "system" || (m.via || "geolibre") !== "kobo-connector"),
    );
    const shown = new Set(visible);
    const orphans = [];
    const byAfter = new Map();
    for (const l of local) {
      if (l.after && shown.has(l.after)) {
        if (!byAfter.has(l.after)) byAfter.set(l.after, []);
        byAfter.get(l.after).push(...l.nodes);
      } else orphans.push(...l.nodes);
    }
    const nodes = [intro, ...orphans];
    for (const m of visible) nodes.push(...cliMessage(m, charts), ...(byAfter.get(m) ?? []));
    out.replaceChildren(...nodes);
    if (stick) out.scrollTop = out.scrollHeight;
    renderBusy();
  };

  const print = (...nodes) => {
    local.push({ after: assistant.history[assistant.history.length - 1] ?? null, nodes });
    local.splice(0, Math.max(0, local.length - 60));
    renderOut();
    out.scrollTop = out.scrollHeight;
  };
  const result = (lines, cls = "glb-cli-res") => lines.map((t, i) => cliLine(cls, i ? "" : "⎿", t));
  const onOff = (arg) => (/^(on|yes|1|true)$/i.test(arg) ? true : /^(off|no|0|false)$/i.test(arg) ? false : null);
  const usage = (list) => list.map(([c, a, d]) => `${`${c} ${a}`.trim().padEnd(19)}${d}`);

  const run = (raw) => {
    const [cmd, ...rest] = raw.split(/\s+/);
    const arg = rest.join(" ").trim();
    const name = cmd.toLowerCase();
    if (PROCESSING_NAMES.has(name)) {
      sendUserMessage(raw, { processing: name.slice(1), args: arg });
      return;
    }
    if (name === "/clear") {
      for (const m of assistant.history) cleared.add(m);
      local = [];
      renderOut();
      return;
    }
    // never echo a token back to the screen
    const echo = el("div", { className: "glb-cli-user is-cmd" }, [
      el("span", { className: "glb-cli-g", textContent: ">" }),
      el("span", { className: "glb-cli-x", textContent: name === "/token" && arg && arg !== "-" ? "/token ••••" : raw }),
    ]);
    const reply = (lines, cls) => print(echo, ...result(lines, cls));
    const set = (key, value) => {
      state.settings[key] = value;
      saveSettings();
      notify();
    };
    switch (name) {
      case "/help":
      case "/?":
        return reply(["Paréntah", ...usage(CLI_COMMANDS), "", "Olah data (dikirim ka AI)", ...usage(CLI_PROCESSING)]);
      case "/status": {
        const s = state.settings;
        return reply([
          `sambungan   ${STATUS_LABEL[state.status] ?? state.status} · ws://127.0.0.1:${Number(s.port) || DEFAULT_PORT}`,
          `ngadéngé    ${isListening() ? "enya" : "henteu"} · ${chat.outbox.length} ngantri`,
          `prosés      ${state.proc.kind.toUpperCase()} — ${state.proc.text}`,
          `model       ${modelName(activeModel())} · ${activeModel().model}`,
          `exec_js     ${s.allowExec ? "diidinan" : "pareum"} · auto ${s.autoConnect ? "on" : "off"} · token ${s.token ? "aya" : "euweuh"}`,
          `server      ${s.command || DEFAULT_COMMAND}`,
        ]);
      }
      case "/connect":
        state.reconnectDelay = RECONNECT_MIN_MS;
        connect();
        return reply(["keur nyambungkeun…"]);
      case "/disconnect":
        disconnect();
        return reply(["sambungan dipegatkeun"]);
      case "/model": {
        if (arg) {
          const q = arg.toLowerCase();
          const hit = MODELS.find((m) => m.key === q) ?? MODELS.find((m) => modelName(m).toLowerCase().includes(q));
          if (!hit) return reply([`modél teu dikenal: ${arg}`], "glb-cli-err");
          set("activeClient", hit.key);
          return reply([`modél aktip → ${modelName(hit)} · ${hit.model}`]);
        }
        return reply(MODELS.map((m) => `${m.key === state.settings.activeClient ? "❯" : " "} ${m.key.padEnd(9)}${modelName(m)} · ${m.model}`));
      }
      case "/port": {
        const n = Number(arg);
        if (!Number.isInteger(n) || n < 1024 || n > 65535) return reply(["cara make: /port 1024–65535"], "glb-cli-err");
        set("port", n);
        if (state.status === "connected" || state.status === "connecting") {
          disconnect();
          connect();
        }
        return reply([`port → ${n}`]);
      }
      case "/token":
        if (!arg) return reply(["cara make: /token <token>   atawa   /token -   pikeun ngahapus"], "glb-cli-err");
        set("token", arg === "-" ? "" : arg);
        return reply([arg === "-" ? "token dihapus" : "token disimpen"]);
      case "/auto":
      case "/exec":
      case "/autoclose": {
        const v = onOff(arg);
        if (v === null) return reply([`cara make: ${name} on|off`], "glb-cli-err");
        const key = { "/auto": "autoConnect", "/exec": "allowExec", "/autoclose": "autoClose" }[name];
        set(key, v);
        return reply([`${{ "/auto": "nyambung sorangan", "/exec": "exec_js", "/autoclose": "nutup sorangan" }[name]} → ${v ? "on" : "off"}`]);
      }
      case "/skin": {
        const v = onOff(arg);
        if (v === null) return reply(["cara make: /skin on|off"], "glb-cli-err");
        set("skin", v);
        if (v) workbenchOn(state.app);
        else workbenchOff();
        return reply([`tata perenah ala QGIS → ${v ? "on" : "off"}`]);
      }
      case "/server":
        if (!arg) return reply([`server  ${state.settings.command || DEFAULT_COMMAND}`]);
        set("command", arg);
        return reply([`server → ${arg}`]);
      case "/setup": {
        if (!arg) {
          return reply([
            "Aplikasi MCP desktop naon waé (stdio) bisa, teu butuh API key.",
            ...MCP_CLIENTS.map((c) => `/setup ${c.name.split(/\s/)[0].toLowerCase().padEnd(9)}${c.name}`),
            "Témpél config, hurungkeun deui aplikasina, terus ketik “dengar geolibre”.",
          ]);
        }
        const q = arg.toLowerCase();
        const client = MCP_CLIENTS.find((c) => c.name.toLowerCase().includes(q));
        if (!client) return reply([`klien teu dikenal: ${arg}`], "glb-cli-err");
        const text = clientConfig(client.shape);
        const note = cliLine("glb-cli-res", "", "keur nyalin…");
        print(echo, ...result([client.name, client.file]), el("pre", { className: "glb-cli-code", textContent: text }), note);
        navigator.clipboard.writeText(text).then(
          () => (note.lastChild.textContent = "geus disalin ka clipboard"),
          () => (note.lastChild.textContent = "gagal nyalin — blok terus salin sorangan"),
        );
        return;
      }
      case "/log":
        return reply(state.log.length ? state.log.slice(0, 15).reverse() : ["(kosong)"]);
      default:
        return reply([`paréntah teu dikenal: ${cmd} — ketik /help`], "glb-cli-err");
    }
  };

  // Suggestion menu: opens on "/", filters as you type, arrows + Tab/Enter pick.
  let picks = [];
  let pickIdx = 0;
  const renderSuggest = () => {
    const v = input.value;
    const open = v.startsWith("/") && !v.includes(" ");
    if (!open) {
      suggest.hidden = true;
      picks = [];
      return;
    }
    const q = v.toLowerCase();
    const match = (list, group) =>
      list.filter(([c, , d]) => c.startsWith(q) || (q.length > 1 && d.toLowerCase().includes(q.slice(1)))).map((r) => [...r, group]);
    picks = [...match(CLI_COMMANDS, "command"), ...match(CLI_PROCESSING, "processing")];
    pickIdx = Math.min(pickIdx, Math.max(0, picks.length - 1));
    suggest.hidden = picks.length === 0;
    let lastGroup = "";
    const rows = [];
    picks.forEach(([c, a, d, group], i) => {
      if (group !== lastGroup) {
        rows.push(el("div", { className: "glb-cli-sg-head", textContent: group === "command" ? "Paréntah" : "Olah data · dikirim ka AI" }));
        lastGroup = group;
      }
      const row = el("div", { className: `glb-cli-sg${i === pickIdx ? " is-active" : ""}${group === "processing" ? " is-proc" : ""}` }, [
        el("span", { className: "glb-cli-sg-c", textContent: c }),
        el("span", { className: "glb-cli-sg-a", textContent: a }),
        el("span", { className: "glb-cli-sg-d", textContent: d }),
      ]);
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        accept(i);
      });
      rows.push(row);
    });
    suggest.replaceChildren(...rows);
    suggest.querySelector(".is-active")?.scrollIntoView({ block: "nearest" });
  };
  const accept = (i) => {
    const pick = picks[i];
    if (!pick) return;
    input.value = `${pick[0]} `;
    pickIdx = 0;
    renderSuggest();
    input.focus();
  };

  const submit = () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    renderSuggest();
    if (past[past.length - 1] !== text) past.push(text);
    past.splice(0, Math.max(0, past.length - 50));
    pastIdx = past.length;
    if (text.startsWith("/")) run(text);
    else sendUserMessage(text);
    out.scrollTop = out.scrollHeight;
  };

  input.addEventListener("input", () => {
    pickIdx = 0;
    renderSuggest();
  });
  input.addEventListener("keydown", (e) => {
    e.stopPropagation(); // keep map/app shortcuts from eating keystrokes
    const menu = !suggest.hidden && picks.length > 0;
    if (menu && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      pickIdx = (pickIdx + (e.key === "ArrowUp" ? -1 : 1) + picks.length) % picks.length;
      renderSuggest();
    } else if (menu && (e.key === "Tab" || (e.key === "Enter" && picks[pickIdx][0] !== input.value.trim().toLowerCase()))) {
      e.preventDefault();
      accept(pickIdx);
    } else if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      submit();
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      if (!past.length) return;
      e.preventDefault();
      pastIdx = Math.max(0, Math.min(past.length, pastIdx + (e.key === "ArrowUp" ? -1 : 1)));
      input.value = past[pastIdx] ?? "";
    } else if (e.key === "Escape") {
      if (menu) suggest.hidden = true;
      else input.value = "";
    }
  });
  for (const evt of ["keyup", "keypress"]) input.addEventListener(evt, (e) => e.stopPropagation());
  input.addEventListener("blur", () => setTimeout(() => (suggest.hidden = true), 120));
  // click anywhere in the terminal to type, unless text is being selected
  container.addEventListener("mouseup", () => {
    if (!String(window.getSelection?.() ?? "")) input.focus();
  });

  const view = { renderOut, renderFoot };
  cliViews.add(view);
  assistant.cliInput = input;
  const update = () => {
    renderNotice();
    renderServers();
    renderFoot();
    if (state.proc !== lastProc) {
      lastProc = state.proc;
      renderOut();
    }
  };
  state.listeners.add(update);
  update();
  return () => {
    state.listeners.delete(update);
    cliViews.delete(view);
    clearInterval(ticker);
    ro?.disconnect();
    if (assistant.cliInput === input) assistant.cliInput = null;
  };
}

// Desktop MCP clients that launch a local stdio server (no API key needed).
// `shape` picks the config layout: most use `mcpServers`, VS Code `servers`.
const MCP_CLIENTS = [
  { name: "Gemini (API / Gemini CLI)", file: "%USERPROFILE%\\.gemini\\settings.json (bagian mcpServers)", shape: "mcpServers" },
  { name: "Claude Desktop", file: "%APPDATA%\\Claude\\claude_desktop_config.json", shape: "mcpServers" },
  { name: "OpenCode", file: "%USERPROFILE%\\.config\\opencode\\opencode.json (bagian mcp.servers)", shape: "opencode" },
];

function clientConfig(shape) {
  const command = state.settings.command || DEFAULT_COMMAND;
  const args = ["--port", String(Number(state.settings.port) || DEFAULT_PORT)];
  if (state.settings.token) args.push("--token", state.settings.token);
  if (shape === "cli-claude") {
    return `claude mcp add geolibre-live --scope user -- "${command}" ${args.join(" ")}`;
  }
  if (shape === "opencode") {
    return JSON.stringify(
      { mcp: { servers: { "geolibre-live": { type: "local", command, args } } } },
      null,
      2,
    );
  }
  const server = shape === "servers" ? { type: "stdio", command, args } : { command, args };
  return JSON.stringify({ [shape]: { "geolibre-live": server } }, null, 2);
}

// ############################################################################
// ########## Plugin entry point ##############################################
// ############################################################################

export const plugin = {
  id: PLUGIN_ID,
  name: PLUGIN_NAME,
  version: PLUGIN_VERSION,
  engines: ["maplibre"],

  activate(app) {
    state.app = app;
    state.map = app.getMap?.() ?? null;
    installHub();
    state.onDockHost = () => {
      if (state.map) mountAssistant(state.map);
    };
    window.addEventListener("glb-dock-host", state.onDockHost);
    if (app.registerRightPanel) {
      // One plain sidebar panel (Koneksi, chat, client guide), no map button.
      // The panel body becomes the dock host the assistant mounts into.
      state.sidebar = true;
      window.__glbOpenDock = () => app.openRightPanel?.(PANEL_ID);
      state.disposePanel = app.registerRightPanel({
        id: PANEL_ID,
        title: "Live MCP",
        defaultWidth: 380,
        render(container) {
          container.style.cssText = "display:flex;flex-direction:column;height:100%;min-height:0;";
          window.__glbDockHost = container;
          window.dispatchEvent(new Event("glb-dock-host"));
          return () => {
            if (window.__glbDockHost === container) delete window.__glbDockHost;
            window.dispatchEvent(new Event("glb-dock-host"));
          };
        },
      });
      app.openRightPanel?.(PANEL_ID);
    } else {
      // Older hosts: map button + floating settings panel, as before.
      app.addMapControl(control, "top-right");
      state.disposePanel =
        app.registerFloatingPanel?.({
          id: PANEL_ID,
          title: PLUGIN_NAME,
          defaultWidth: 340,
          defaultHeight: 420,
          position: "top-right",
          render: (container) => renderPanel(container),
        }) ?? null;
    }
    mountAssistant(state.map);
    if (state.settings.autoConnect) connect();
    // the app's own UI stays as it is; the workbench (skin, rename, left bar,
    // replacement Layer Styling, Toolbox) only comes with `/skin on`
    if (state.settings.skin === true) workbenchOn(app);
    registerCatalog(app);
    registerLearn(app);
    setTimeout(acehStart, 1500);
  },

  deactivate(app) {
    skinOff();
    state.disposeStyling?.();
    state.disposeStyling = null;
    state.disposeToolbox?.();
    state.disposeToolbox = null;
    state.disposeCatalog?.();
    state.disposeCatalog = null;
    state.disposeLearn?.();
    state.disposeLearn = null;
    leftBarOff();
    rebrandOff();
    disconnect();
    uninstallHub();
    unmountAssistant();
    if (state.onDockHost) window.removeEventListener("glb-dock-host", state.onDockHost);
    if (state.sidebar) {
      app.closeRightPanel?.(PANEL_ID);
      delete window.__glbOpenDock;
      delete window.__glbDockHost;
    } else {
      app.removeMapControl(control);
    }
    state.disposePanel?.();
    state.disposePanel = null;
    state.sidebar = false;
    state.app = null;
    state.map = null;
  },
};

export default plugin;
