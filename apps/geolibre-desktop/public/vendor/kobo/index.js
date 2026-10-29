//#region src/lib/kobo/api.ts
var GEO_TYPES = /* @__PURE__ */ new Set([
	"geopoint",
	"geoshape",
	"geotrace"
]);
var KoboApiError = class extends Error {
	status;
	constructor(message, status) {
		super(message);
		this.name = "KoboApiError";
		this.status = status;
	}
};
function baseUrl(apiUrl) {
	const trimmed = apiUrl.trim().replace(/\/+$/, "");
	return trimmed.startsWith("http") ? trimmed : `https://${trimmed}`;
}
function authHeader(username, password) {
	const raw = `${username}:${password}`;
	let encoded;
	try {
		encoded = btoa(raw);
	} catch {
		encoded = btoa(unescape(encodeURIComponent(raw)));
	}
	return `Basic ${encoded}`;
}
/**
* Picks a fetch implementation for talking to the Kobo server.
*
* Regular browser `fetch()` is subject to CORS, and KoboToolbox's servers
* (both the public kf.kobotoolbox.org / humanitarianresponse.info hosts and
* most self-hosted instances) do not send Access-Control-Allow-Origin for a
* Tauri webview origin like `tauri.localhost`, so plain fetch fails there.
*
* If the host app has `@tauri-apps/plugin-http` (Rust: `tauri-plugin-http`)
* registered with `withGlobalTauri: true`, its `fetch` is exposed on
* `window.__TAURI__.http.fetch`. That implementation runs the request from
* the Rust side, not the webview, so it is not subject to browser CORS at
* all. We prefer it when available and silently fall back to normal
* `fetch()` otherwise (e.g. when running this plugin outside GeoLibre/Tauri,
* such as in a browser-based host).
*/
function resolveFetch() {
	const tauriFetch = typeof window !== "undefined" && window.__TAURI__?.http?.fetch;
	if (typeof tauriFetch === "function") return tauriFetch;
	return typeof fetch !== "undefined" ? fetch : null;
}
async function koboFetch(url, creds) {
	const doFetch = resolveFetch();
	if (!doFetch) throw new KoboApiError("No HTTP client is available in this environment.");
	const usingTauriHttp = doFetch !== fetch;
	let response;
	try {
		response = await doFetch(url, { headers: {
			Authorization: authHeader(creds.username, creds.password),
			Accept: "application/json"
		} });
	} catch (err) {
		const hint = usingTauriHttp ? "This is usually because the Tauri http plugin's permission scope (capabilities) doesn't include this host yet." : "This is usually a CORS or connectivity issue - if you're running inside a Tauri app, enabling the Tauri HTTP plugin on the host will fix it.";
		throw new KoboApiError(`Network error reaching ${url}. ${hint} Detail: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (!response.ok) {
		if (response.status === 401 || response.status === 403) throw new KoboApiError("Authentication failed. Check the username/password and server URL.", response.status);
		throw new KoboApiError(`Kobo server returned an error (HTTP ${response.status}).`, response.status);
	}
	return response.json();
}
/**
* List the user's Kobo assets (forms) that carry geo data
* (`summary.geo` is true in the assets listing).
*/
async function fetchKoboGeoAssets(creds) {
	return ((await koboFetch(`${baseUrl(creds.apiUrl)}/api/v2/assets.json`, creds))?.results ?? []).filter((asset) => asset?.summary?.geo).map((asset) => ({
		uid: asset.uid,
		name: asset.name || asset.uid,
		dateCreated: asset.date_created
	}));
}
/**
* Read an asset's survey definition and return the geopoint/geoshape/geotrace
* fields available for mapping, plus the asset's creation date (used as a
* sensible default lower bound for the date-range filter).
*/
async function fetchKoboGeoFields(creds, assetUid) {
	const data = await koboFetch(`${baseUrl(creds.apiUrl)}/api/v2/assets/${assetUid}.json?metadata=on`, creds);
	const fields = (data?.content?.survey ?? []).filter((field) => GEO_TYPES.has(field?.type)).map((field) => ({
		name: field.$autoname || field.name,
		type: field.type
	}));
	return {
		dateCreated: data?.date_created ?? null,
		fields
	};
}
/**
* Fetch the most recent submission's timestamp for an asset, used to default
* the "to" date when first connecting to a form.
*/
async function fetchLatestSubmissionDate(creds, assetUid) {
	const url = new URL(`${baseUrl(creds.apiUrl)}/api/v2/assets/${assetUid}/data.json`);
	url.searchParams.set("sort", JSON.stringify({ _submission_time: -1 }));
	url.searchParams.set("start", "0");
	url.searchParams.set("limit", "1");
	return ((await koboFetch(url.toString(), creds))?.results ?? [])[0]?._submission_time ?? null;
}
/**
* Page through every submission for an asset within an optional date range on
* `_submission_time`, mirroring the QGIS plugin's paging loop
* (sort by `_submission_time` desc, `start`/`limit` paging).
*/
async function fetchAllKoboSubmissions(creds, assetUid, options) {
	const { pageSize, fromDate, toDate, onProgress, signal } = options;
	const results = [];
	let start = 0;
	let total = null;
	const query = {};
	if (fromDate) query["_submission_time"] = {
		...query["_submission_time"] ?? {},
		$gte: `${fromDate}T00:00:00`
	};
	if (toDate) query["_submission_time"] = {
		...query["_submission_time"] ?? {},
		$lte: `${toDate}T23:59:59`
	};
	while (true) {
		if (signal?.aborted) break;
		const url = new URL(`${baseUrl(creds.apiUrl)}/api/v2/assets/${assetUid}/data.json`);
		url.searchParams.set("sort", JSON.stringify({ _submission_time: -1 }));
		url.searchParams.set("limit", String(pageSize));
		url.searchParams.set("start", String(start));
		if (Object.keys(query).length > 0) url.searchParams.set("query", JSON.stringify(query));
		const data = await koboFetch(url.toString(), creds);
		if (typeof data?.count === "number") total = data.count;
		const page = data?.results ?? [];
		if (page.length === 0) break;
		results.push(...page);
		onProgress?.(results.length, total);
		start += pageSize;
		if (total !== null && results.length >= total) break;
	}
	return results;
}
/**
* Recursively flatten a submission object. Nested objects use `/` as a
* separator; list items are suffixed `[n]` (1-indexed), matching the QGIS
* plugin's `flatten_dict` so repeat-group geo fields (e.g.
* `group[1]/location`) are found the same way.
*/
function flattenSubmission(data, parentKey = "", sep = "/") {
	const flattened = {};
	for (const [key, value] of Object.entries(data)) {
		const newKey = parentKey ? `${parentKey}${sep}${key}` : key;
		if (value !== null && typeof value === "object" && !Array.isArray(value)) Object.assign(flattened, flattenSubmission(value, newKey, sep));
		else if (Array.isArray(value)) value.forEach((item, i) => {
			if (item !== null && typeof item === "object") Object.assign(flattened, flattenSubmission(item, `${newKey}[${i + 1}]`, sep));
			else flattened[`${newKey}[${i + 1}]`] = item;
		});
		else flattened[newKey] = value;
	}
	return flattened;
}
/**
* Parse a Kobo geometry string. Kobo encodes each vertex as
* "lat lon altitude accuracy", space-separated, with vertices joined by `;`
* for geotrace/geoshape fields. `geomType` (taken from the survey definition)
* picks LineString vs Polygon for multi-vertex fields; the QGIS plugin lacked
* this distinction and always treated multi-vertex geometry as a polygon.
*/
function parseKoboGeometry(geomString, geomType) {
	if (!geomString || typeof geomString !== "string") return null;
	const trimmed = geomString.trim();
	if (!trimmed) return null;
	const vertices = trimmed.split(";").map((v) => v.trim()).filter(Boolean).map((v) => {
		const [lat, lon] = v.split(/\s+/).map(Number);
		if (Number.isNaN(lat) || Number.isNaN(lon)) return null;
		return [lon, lat];
	}).filter((v) => v !== null);
	if (vertices.length === 0) return null;
	if (vertices.length === 1) return {
		type: "Point",
		coordinates: vertices[0]
	};
	if (geomType === "geotrace") return {
		type: "LineString",
		coordinates: vertices
	};
	const ring = [...vertices];
	const [firstLon, firstLat] = ring[0];
	const [lastLon, lastLat] = ring[ring.length - 1];
	if (firstLon !== lastLon || firstLat !== lastLat) ring.push(ring[0]);
	return {
		type: "Polygon",
		coordinates: [ring]
	};
}
/**
* Build a GeoJSON FeatureCollection from raw Kobo submissions, given the
* chosen geo field. Handles the field living inside a repeat group the same
* way the QGIS plugin does: search the flattened keys for any segment
* matching the geo field name.
*/
function buildFeatureCollection(submissions, geoField, geomType) {
	const features = [];
	const rows = [];
	let skipped = 0;
	for (const submission of submissions) {
		const flattened = flattenSubmission(submission);
		rows.push(flattened);
		let matchedKeys;
		if (geoField in submission) matchedKeys = [geoField];
		else matchedKeys = Object.keys(flattened).filter((key) => key.split("/").includes(geoField));
		if (matchedKeys.length === 0) {
			skipped += 1;
			continue;
		}
		for (const key of matchedKeys) {
			const geomString = flattened[key];
			const geometry = parseKoboGeometry(geomString, geomType);
			if (!geometry) {
				skipped += 1;
				continue;
			}
			const properties = {};
			for (const [k, v] of Object.entries(flattened)) {
				if (k === key) continue;
				properties[k] = v;
			}
			features.push({
				type: "Feature",
				geometry,
				properties
			});
		}
	}
	return {
		featureCollection: {
			type: "FeatureCollection",
			features
		},
		rows,
		skipped
	};
}
/** Serialize flattened submission rows to CSV (union of all columns). */
function rowsToCsv(rows) {
	if (rows.length === 0) return "";
	const columns = /* @__PURE__ */ new Set();
	for (const row of rows) for (const key of Object.keys(row)) columns.add(key);
	const header = [...columns];
	const escape = (value) => {
		if (value === null || value === void 0) return "";
		const str = typeof value === "object" ? JSON.stringify(value) : String(value);
		if (/[",\n]/.test(str)) return `"${str.replace(/"/g, "\"\"")}"`;
		return str;
	};
	const lines = [header.map(escape).join(",")];
	for (const row of rows) lines.push(header.map((col) => escape(row[col])).join(","));
	return lines.join("\n");
}
/** Trigger a browser download of a text blob (used for the CSV export). */
function downloadTextFile(filename, content, mimeType) {
	const blob = new Blob([content], { type: mimeType });
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	document.body.appendChild(link);
	link.click();
	link.remove();
	URL.revokeObjectURL(url);
}
//#endregion
//#region src/lib/core/KoboConnectorControl.ts
var DEFAULT_OPTIONS = {
	collapsed: true,
	position: "top-right",
	title: "Kobo Connector",
	panelWidth: 340,
	className: "",
	defaultApiUrl: "kf.kobotoolbox.org",
	hasNativeLayerSupport: false,
	registerNativeLayer: void 0,
	unregisterNativeLayer: void 0
};
/**
* A GeoLibre / MapLibre control that connects to a KoboToolbox / KoboCollect
* server, lets the user pick a form and a geo field, fetches submissions
* within a date range, renders them as a map layer, and lets the user
* download the flattened data as CSV.
*
* This is the GeoLibre counterpart of the "Kobo" tab in the WHO AFRO
* afpolgis_data_connector QGIS plugin: same connection model (server host +
* username/password, HTTP Basic auth against `/api/v2/`), same idea of
* filtering forms to those with geo data, picking a geopoint/geoshape/
* geotrace field, an optional submission-date range, page size, and an
* auto-sync interval - just rendered as a MapLibre layer instead of a QGIS
* vector layer.
*/
var KoboConnectorControl = class {
	_map;
	_mapContainer;
	_container;
	_panel;
	_options;
	_state;
	_eventHandlers = new globalThis.Map();
	_password = "";
	_assets = [];
	_geoFields = [];
	_rows = [];
	_syncTimer = null;
	_fetchAbortController = null;
	_registeredNativeLayerId = null;
	_resizeHandler = null;
	_mapResizeHandler = null;
	_clickOutsideHandler = null;
	_els = {};
	constructor(options) {
		this._options = {
			...DEFAULT_OPTIONS,
			...options
		};
		this._state = {
			collapsed: this._options.collapsed,
			panelWidth: this._options.panelWidth,
			apiUrl: this._options.defaultApiUrl,
			username: "",
			assetUid: null,
			assetName: null,
			geoField: null,
			geoFieldType: null,
			fromDate: null,
			toDate: null,
			pageSize: 1e3,
			syncIntervalSeconds: 0
		};
	}
	onAdd(map) {
		this._map = map;
		this._mapContainer = map.getContainer();
		this._container = this._createContainer();
		this._panel = this._createPanel();
		this._mapContainer.appendChild(this._panel);
		this._setupEventListeners();
		if (!this._state.collapsed) {
			this._panel.classList.add("expanded");
			requestAnimationFrame(() => this._updatePanelPosition());
		}
		return this._container;
	}
	onRemove() {
		this._stopSync();
		this._fetchAbortController?.abort();
		if (this._resizeHandler) {
			window.removeEventListener("resize", this._resizeHandler);
			this._resizeHandler = null;
		}
		if (this._mapResizeHandler && this._map) {
			this._map.off("resize", this._mapResizeHandler);
			this._mapResizeHandler = null;
		}
		if (this._clickOutsideHandler) {
			document.removeEventListener("click", this._clickOutsideHandler);
			this._clickOutsideHandler = null;
		}
		this._clearLayer();
		this._panel?.parentNode?.removeChild(this._panel);
		this._container?.parentNode?.removeChild(this._container);
		this._map = void 0;
		this._mapContainer = void 0;
		this._container = void 0;
		this._panel = void 0;
		this._els = {};
		this._eventHandlers.clear();
	}
	getState() {
		return { ...this._state };
	}
	setState(newState) {
		this._state = {
			...this._state,
			...newState
		};
		this._emit("statechange");
	}
	toggle() {
		this._state.collapsed = !this._state.collapsed;
		if (this._panel) {
			if (this._state.collapsed) {
				this._panel.classList.remove("expanded");
				this._emit("collapse");
			} else {
				this._panel.classList.add("expanded");
				this._updatePanelPosition();
				this._emit("expand");
			}
		}
		this._emit("statechange");
	}
	expand() {
		if (this._state.collapsed) this.toggle();
	}
	collapse() {
		if (!this._state.collapsed) this.toggle();
	}
	on(event, handler) {
		if (!this._eventHandlers.has(event)) this._eventHandlers.set(event, /* @__PURE__ */ new Set());
		this._eventHandlers.get(event).add(handler);
	}
	off(event, handler) {
		this._eventHandlers.get(event)?.delete(handler);
	}
	getMap() {
		return this._map;
	}
	getContainer() {
		return this._container;
	}
	_credentials() {
		return {
			apiUrl: this._state.apiUrl,
			username: this._state.username,
			password: this._password
		};
	}
	async _handleConnect() {
		const apiUrl = this._els.apiUrl?.value.trim() ?? "";
		const username = this._els.username?.value.trim() ?? "";
		const password = this._els.password?.value ?? "";
		if (!apiUrl || !username || !password) {
			this._setStatus("Isi server, username, dan password terlebih dahulu.", true);
			return;
		}
		this.setState({
			apiUrl,
			username
		});
		this._password = password;
		this._setButtonBusy(this._els.connectBtn, true, "Menghubungkan…");
		this._setStatus("Menghubungkan ke server Kobo…");
		try {
			this._assets = await fetchKoboGeoAssets(this._credentials());
			this._populateFormSelect();
			if (this._assets.length === 0) this._setStatus("Terhubung, tapi tidak ada form dengan data geo pada akun ini.", true);
			else this._setStatus(`Terhubung. Ditemukan ${this._assets.length} form dengan data geo.`);
			this._emit("connected");
		} catch (err) {
			this._setStatus(this._describeError(err), true);
		} finally {
			this._setButtonBusy(this._els.connectBtn, false, "Connect");
		}
	}
	async _handleFormChange() {
		const uid = this._els.formSelect?.value ?? "";
		const asset = this._assets.find((a) => a.uid === uid) ?? null;
		this._geoFields = [];
		this._populateGeoFieldSelect();
		this._rows = [];
		this._setDownloadEnabled(false);
		this._clearLayer();
		if (!asset) {
			this.setState({
				assetUid: null,
				assetName: null,
				geoField: null,
				geoFieldType: null
			});
			return;
		}
		this.setState({
			assetUid: asset.uid,
			assetName: asset.name
		});
		this._setFetchEnabled(false);
		this._setStatus(`Mengambil daftar field geo untuk "${asset.name}"…`);
		try {
			const [{ fields }, latest] = await Promise.all([fetchKoboGeoFields(this._credentials(), asset.uid), fetchLatestSubmissionDate(this._credentials(), asset.uid).catch(() => null)]);
			this._geoFields = fields;
			this._populateGeoFieldSelect();
			const fromDate = asset.dateCreated ? asset.dateCreated.slice(0, 10) : null;
			const toDate = latest ? latest.slice(0, 10) : null;
			if (this._els.fromDate && fromDate) this._els.fromDate.value = fromDate;
			if (this._els.toDate && toDate) this._els.toDate.value = toDate;
			this.setState({
				fromDate,
				toDate
			});
			if (fields.length === 0) this._setStatus(`Form "${asset.name}" tidak punya field geopoint/geoshape/geotrace.`, true);
			else {
				this._setStatus(`Siap. Pilih field geo lalu klik "Ambil & Tampilkan Data".`);
				this._setFetchEnabled(true);
			}
		} catch (err) {
			this._setStatus(this._describeError(err), true);
		}
	}
	_handleGeoFieldChange() {
		const name = this._els.geoFieldSelect?.value ?? "";
		const field = this._geoFields.find((f) => f.name === name) ?? null;
		this.setState({
			geoField: field?.name ?? null,
			geoFieldType: field?.type ?? null
		});
	}
	async _handleFetchData() {
		if (!this._state.assetUid || !this._state.geoField || !this._state.geoFieldType) {
			this._setStatus("Pilih form dan field geo terlebih dahulu.", true);
			return;
		}
		const pageSize = Math.max(1, Number(this._els.pageSize?.value) || 1e3);
		const fromDate = this._els.fromDate?.value || void 0;
		const toDate = this._els.toDate?.value || void 0;
		this.setState({
			pageSize,
			fromDate: fromDate ?? null,
			toDate: toDate ?? null
		});
		this._fetchAbortController?.abort();
		const controller = new AbortController();
		this._fetchAbortController = controller;
		this._setButtonBusy(this._els.fetchBtn, true, "Mengambil…");
		this._setProgress(0, null);
		this._setStatus("Mengambil data submisi…");
		try {
			const submissions = await fetchAllKoboSubmissions(this._credentials(), this._state.assetUid, {
				pageSize,
				fromDate,
				toDate,
				signal: controller.signal,
				onProgress: (fetched, total) => this._setProgress(fetched, total)
			});
			const { featureCollection, rows, skipped } = buildFeatureCollection(submissions, this._state.geoField, this._state.geoFieldType);
			this._rows = rows;
			this._setDownloadEnabled(rows.length > 0);
			if (featureCollection.features.length === 0) {
				this._setStatus("Field geo yang dipilih tidak memiliki data geometri pada rentang tanggal ini.", true);
				this._clearLayer();
				return;
			}
			this._renderLayer(featureCollection);
			const skippedNote = skipped > 0 ? ` (${skipped} baris dilewati, tanpa geometri)` : "";
			this._setStatus(`Berhasil memuat ${featureCollection.features.length} fitur dari ${submissions.length} submisi${skippedNote}.`);
			this._emit("dataloaded");
			const syncSeconds = Math.max(0, Number(this._els.syncInterval?.value) || 0);
			this.setState({ syncIntervalSeconds: syncSeconds });
			this._restartSync(syncSeconds);
		} catch (err) {
			if (!controller.signal.aborted) {
				this._setStatus(this._describeError(err), true);
				this._emit("error");
			}
		} finally {
			this._setButtonBusy(this._els.fetchBtn, false, "Ambil & Tampilkan Data");
			this._setProgress(0, null, true);
		}
	}
	_handleDownloadCsv() {
		if (this._rows.length === 0) return;
		const csv = rowsToCsv(this._rows);
		downloadTextFile(`${this._state.assetName ? this._state.assetName.replace(/\s+/g, "_") : "kobo_data"}.csv`, csv, "text/csv;charset=utf-8;");
	}
	_restartSync(seconds) {
		this._stopSync();
		if (seconds > 0) this._syncTimer = setInterval(() => {
			this._handleFetchData();
		}, seconds * 1e3);
	}
	_stopSync() {
		if (this._syncTimer) {
			clearInterval(this._syncTimer);
			this._syncTimer = null;
		}
	}
	_describeError(err) {
		if (err instanceof KoboApiError) return err.message;
		if (err instanceof Error) return err.message;
		return "Terjadi kesalahan yang tidak diketahui.";
	}
	_sourceId() {
		return `kobo-connector-${this._state.assetUid ?? "data"}`;
	}
	_renderLayer(featureCollection) {
		const sourceId = this._sourceId();
		const layerIdPoint = `${sourceId}-point`;
		const layerIdLine = `${sourceId}-line`;
		const layerIdFillOutline = `${sourceId}-fill-outline`;
		const layerIdFill = `${sourceId}-fill`;
		if (this._options.hasNativeLayerSupport && this._options.registerNativeLayer) {
			this._clearLayer();
			const registration = {
				id: sourceId,
				name: this._state.assetName ?? "Kobo data",
				geojson: featureCollection,
				nativeLayerIds: [
					layerIdPoint,
					layerIdLine,
					layerIdFillOutline,
					layerIdFill
				],
				sourceIds: [sourceId],
				opacity: 1,
				style: {
					fillColor: "#4a90d9",
					strokeColor: "#2f6fb0",
					strokeWidth: 2,
					fillOpacity: .35,
					circleRadius: 5
				},
				metadata: {
					source: "kobo-connector",
					assetUid: this._state.assetUid
				}
			};
			try {
				this._options.registerNativeLayer(registration);
				this._registeredNativeLayerId = sourceId;
				return;
			} catch {}
		}
		const map = this._map;
		if (!map) return;
		const existingSource = map.getSource(sourceId);
		if (existingSource) {
			existingSource.setData(featureCollection);
			return;
		}
		map.addSource(sourceId, {
			type: "geojson",
			data: featureCollection
		});
		map.addLayer({
			id: layerIdFill,
			type: "fill",
			source: sourceId,
			filter: [
				"==",
				["geometry-type"],
				"Polygon"
			],
			paint: {
				"fill-color": "#4a90d9",
				"fill-opacity": .35
			}
		});
		map.addLayer({
			id: layerIdFillOutline,
			type: "line",
			source: sourceId,
			filter: [
				"==",
				["geometry-type"],
				"Polygon"
			],
			paint: {
				"line-color": "#2f6fb0",
				"line-width": 2
			}
		});
		map.addLayer({
			id: layerIdLine,
			type: "line",
			source: sourceId,
			filter: [
				"==",
				["geometry-type"],
				"LineString"
			],
			paint: {
				"line-color": "#2f6fb0",
				"line-width": 3
			}
		});
		map.addLayer({
			id: layerIdPoint,
			type: "circle",
			source: sourceId,
			filter: [
				"==",
				["geometry-type"],
				"Point"
			],
			paint: {
				"circle-radius": 5,
				"circle-color": "#4a90d9",
				"circle-stroke-color": "#2f6fb0",
				"circle-stroke-width": 1.5
			}
		});
		try {
			const bounds = this._computeBounds(featureCollection);
			if (bounds) map.fitBounds(bounds, {
				padding: 40,
				maxZoom: 16,
				duration: 500
			});
		} catch {}
	}
	_computeBounds(fc) {
		let minLon = Infinity;
		let minLat = Infinity;
		let maxLon = -Infinity;
		let maxLat = -Infinity;
		const visit = (coords) => {
			if (Array.isArray(coords) && coords.length === 2 && typeof coords[0] === "number" && typeof coords[1] === "number") {
				const [lon, lat] = coords;
				minLon = Math.min(minLon, lon);
				minLat = Math.min(minLat, lat);
				maxLon = Math.max(maxLon, lon);
				maxLat = Math.max(maxLat, lat);
			} else if (Array.isArray(coords)) coords.forEach(visit);
		};
		fc.features.forEach((f) => visit(f.geometry.coordinates));
		if (!Number.isFinite(minLon) || !Number.isFinite(minLat)) return null;
		return [[minLon, minLat], [maxLon, maxLat]];
	}
	_clearLayer() {
		if (this._registeredNativeLayerId) {
			try {
				this._options.unregisterNativeLayer?.(this._registeredNativeLayerId);
			} catch {}
			this._registeredNativeLayerId = null;
			return;
		}
		const map = this._map;
		if (!map) return;
		const sourceId = this._sourceId();
		for (const suffix of [
			"point",
			"line",
			"fill-outline",
			"fill"
		]) {
			const id = `${sourceId}-${suffix}`;
			if (map.getLayer(id)) map.removeLayer(id);
		}
		if (map.getSource(sourceId)) map.removeSource(sourceId);
	}
	_emit(event) {
		const handlers = this._eventHandlers.get(event);
		if (handlers) {
			const eventData = {
				type: event,
				state: this.getState()
			};
			handlers.forEach((handler) => handler(eventData));
		}
	}
	_setStatus(message, isError = false) {
		if (this._els.status) {
			this._els.status.textContent = message;
			this._els.status.classList.toggle("kobo-connector-status-error", isError);
		}
	}
	_setProgress(fetched, total, hide = false) {
		if (!this._els.progress || !this._els.progressBar) return;
		if (hide) {
			this._els.progress.style.display = "none";
			return;
		}
		this._els.progress.style.display = "block";
		const pct = total ? Math.min(100, Math.round(fetched / total * 100)) : fetched > 0 ? 100 : 0;
		this._els.progressBar.style.width = `${pct}%`;
		this._els.progress.setAttribute("aria-label", total ? `${fetched} / ${total}` : `${fetched} submisi`);
	}
	_setButtonBusy(btn, busy, busyLabel) {
		if (!btn) return;
		btn.disabled = busy;
		if (busy && busyLabel) {
			btn.dataset.originalLabel = btn.dataset.originalLabel ?? btn.textContent ?? "";
			btn.textContent = busyLabel;
		} else if (!busy && btn.dataset.originalLabel) btn.textContent = btn.dataset.originalLabel;
	}
	_setFetchEnabled(enabled) {
		if (this._els.fetchBtn) this._els.fetchBtn.disabled = !enabled;
	}
	_setDownloadEnabled(enabled) {
		if (this._els.downloadBtn) this._els.downloadBtn.disabled = !enabled;
	}
	_populateFormSelect() {
		const select = this._els.formSelect;
		if (!select) return;
		select.innerHTML = "";
		const placeholder = document.createElement("option");
		placeholder.value = "";
		placeholder.textContent = this._assets.length ? "Pilih form…" : "Tidak ada form";
		select.appendChild(placeholder);
		for (const asset of this._assets) {
			const opt = document.createElement("option");
			opt.value = asset.uid;
			opt.textContent = asset.name;
			select.appendChild(opt);
		}
		select.disabled = this._assets.length === 0;
	}
	_populateGeoFieldSelect() {
		const select = this._els.geoFieldSelect;
		if (!select) return;
		select.innerHTML = "";
		const placeholder = document.createElement("option");
		placeholder.value = "";
		placeholder.textContent = this._geoFields.length ? "Pilih field geo…" : "—";
		select.appendChild(placeholder);
		for (const field of this._geoFields) {
			const opt = document.createElement("option");
			opt.value = field.name;
			opt.textContent = `${field.name} (${field.type})`;
			select.appendChild(opt);
		}
		select.disabled = this._geoFields.length === 0;
	}
	_createContainer() {
		const container = document.createElement("div");
		container.className = `maplibregl-ctrl maplibregl-ctrl-group kobo-connector${this._options.className ? ` ${this._options.className}` : ""}`;
		const toggleBtn = document.createElement("button");
		toggleBtn.className = "kobo-connector-toggle";
		toggleBtn.type = "button";
		toggleBtn.setAttribute("aria-label", this._options.title);
		toggleBtn.innerHTML = `
      <span class="kobo-connector-icon">
        <svg viewBox="0 0 24 24" width="20" height="20" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none">
          <path d="M12 21c-4.5-4-7-7.5-7-11a7 7 0 1 1 14 0c0 3.5-2.5 7-7 11Z"/>
          <circle cx="12" cy="10" r="2.5"/>
        </svg>
      </span>
    `;
		toggleBtn.addEventListener("click", () => this.toggle());
		container.appendChild(toggleBtn);
		return container;
	}
	_field(labelText, inputEl) {
		const group = document.createElement("div");
		group.className = "kobo-connector-group";
		const label = document.createElement("label");
		label.className = "kobo-connector-label";
		label.textContent = labelText;
		group.appendChild(label);
		group.appendChild(inputEl);
		return group;
	}
	_createPanel() {
		const panel = document.createElement("div");
		panel.className = "kobo-connector-panel";
		panel.style.width = `${this._options.panelWidth}px`;
		const header = document.createElement("div");
		header.className = "kobo-connector-header";
		const title = document.createElement("span");
		title.className = "kobo-connector-title";
		title.textContent = this._options.title;
		const closeBtn = document.createElement("button");
		closeBtn.className = "kobo-connector-close";
		closeBtn.type = "button";
		closeBtn.setAttribute("aria-label", "Close panel");
		closeBtn.innerHTML = "&times;";
		closeBtn.addEventListener("click", () => this.collapse());
		header.appendChild(title);
		header.appendChild(closeBtn);
		const content = document.createElement("div");
		content.className = "kobo-connector-content";
		const apiUrlInput = document.createElement("input");
		apiUrlInput.type = "text";
		apiUrlInput.className = "kobo-connector-input";
		apiUrlInput.placeholder = "kf.kobotoolbox.org";
		apiUrlInput.value = this._state.apiUrl;
		this._els.apiUrl = apiUrlInput;
		const usernameInput = document.createElement("input");
		usernameInput.type = "text";
		usernameInput.className = "kobo-connector-input";
		usernameInput.autocomplete = "username";
		this._els.username = usernameInput;
		const passwordInput = document.createElement("input");
		passwordInput.type = "password";
		passwordInput.className = "kobo-connector-input";
		passwordInput.autocomplete = "current-password";
		this._els.password = passwordInput;
		const connectBtn = document.createElement("button");
		connectBtn.type = "button";
		connectBtn.className = "kobo-connector-button";
		connectBtn.textContent = "Connect";
		connectBtn.addEventListener("click", () => void this._handleConnect());
		this._els.connectBtn = connectBtn;
		content.appendChild(this._field("Server URL", apiUrlInput));
		content.appendChild(this._field("Username", usernameInput));
		content.appendChild(this._field("Password", passwordInput));
		content.appendChild(connectBtn);
		content.appendChild(this._divider());
		const formSelect = document.createElement("select");
		formSelect.className = "kobo-connector-input";
		formSelect.disabled = true;
		formSelect.addEventListener("change", () => void this._handleFormChange());
		this._els.formSelect = formSelect;
		this._populateFormSelect();
		const geoFieldSelect = document.createElement("select");
		geoFieldSelect.className = "kobo-connector-input";
		geoFieldSelect.disabled = true;
		geoFieldSelect.addEventListener("change", () => this._handleGeoFieldChange());
		this._els.geoFieldSelect = geoFieldSelect;
		this._populateGeoFieldSelect();
		content.appendChild(this._field("Form (yang punya data geo)", formSelect));
		content.appendChild(this._field("Field geo", geoFieldSelect));
		const fromDate = document.createElement("input");
		fromDate.type = "date";
		fromDate.className = "kobo-connector-input";
		this._els.fromDate = fromDate;
		const toDate = document.createElement("input");
		toDate.type = "date";
		toDate.className = "kobo-connector-input";
		this._els.toDate = toDate;
		const dateRow = document.createElement("div");
		dateRow.className = "kobo-connector-flex";
		dateRow.appendChild(this._field("Dari tanggal", fromDate));
		dateRow.appendChild(this._field("Sampai tanggal", toDate));
		content.appendChild(dateRow);
		const pageSize = document.createElement("input");
		pageSize.type = "number";
		pageSize.min = "1";
		pageSize.className = "kobo-connector-input";
		pageSize.value = String(this._state.pageSize);
		this._els.pageSize = pageSize;
		const syncInterval = document.createElement("input");
		syncInterval.type = "number";
		syncInterval.min = "0";
		syncInterval.className = "kobo-connector-input";
		syncInterval.value = "0";
		syncInterval.title = "0 = tidak sinkron otomatis";
		this._els.syncInterval = syncInterval;
		const settingsRow = document.createElement("div");
		settingsRow.className = "kobo-connector-flex";
		settingsRow.appendChild(this._field("Page size", pageSize));
		settingsRow.appendChild(this._field("Sinkron (detik)", syncInterval));
		content.appendChild(settingsRow);
		const fetchBtn = document.createElement("button");
		fetchBtn.type = "button";
		fetchBtn.className = "kobo-connector-button";
		fetchBtn.textContent = "Ambil & Tampilkan Data";
		fetchBtn.disabled = true;
		fetchBtn.addEventListener("click", () => void this._handleFetchData());
		this._els.fetchBtn = fetchBtn;
		content.appendChild(fetchBtn);
		const progress = document.createElement("div");
		progress.className = "kobo-connector-progress";
		progress.style.display = "none";
		const progressBar = document.createElement("div");
		progressBar.className = "kobo-connector-progress-bar";
		progress.appendChild(progressBar);
		this._els.progress = progress;
		this._els.progressBar = progressBar;
		content.appendChild(progress);
		const downloadBtn = document.createElement("button");
		downloadBtn.type = "button";
		downloadBtn.className = "kobo-connector-button kobo-connector-button-secondary";
		downloadBtn.textContent = "Download CSV";
		downloadBtn.disabled = true;
		downloadBtn.addEventListener("click", () => this._handleDownloadCsv());
		this._els.downloadBtn = downloadBtn;
		content.appendChild(downloadBtn);
		const status = document.createElement("div");
		status.className = "kobo-connector-status";
		this._els.status = status;
		content.appendChild(status);
		panel.appendChild(header);
		panel.appendChild(content);
		return panel;
	}
	_divider() {
		const div = document.createElement("div");
		div.className = "kobo-connector-divider";
		return div;
	}
	_setupEventListeners() {
		this._clickOutsideHandler = (e) => {
			const target = e.target;
			if (this._container && this._panel && !this._container.contains(target) && !this._panel.contains(target)) this.collapse();
		};
		document.addEventListener("click", this._clickOutsideHandler);
		this._resizeHandler = () => {
			if (!this._state.collapsed) this._updatePanelPosition();
		};
		window.addEventListener("resize", this._resizeHandler);
		this._mapResizeHandler = () => {
			if (!this._state.collapsed) this._updatePanelPosition();
		};
		this._map?.on("resize", this._mapResizeHandler);
	}
	_getControlPosition() {
		const parent = this._container?.parentElement;
		if (!parent) return "top-right";
		if (parent.classList.contains("maplibregl-ctrl-top-left")) return "top-left";
		if (parent.classList.contains("maplibregl-ctrl-top-right")) return "top-right";
		if (parent.classList.contains("maplibregl-ctrl-bottom-left")) return "bottom-left";
		if (parent.classList.contains("maplibregl-ctrl-bottom-right")) return "bottom-right";
		return "top-right";
	}
	_updatePanelPosition() {
		if (!this._container || !this._panel || !this._mapContainer) return;
		const button = this._container.querySelector(".kobo-connector-toggle");
		if (!button) return;
		const buttonRect = button.getBoundingClientRect();
		const mapRect = this._mapContainer.getBoundingClientRect();
		const position = this._getControlPosition();
		const buttonTop = buttonRect.top - mapRect.top;
		const buttonBottom = mapRect.bottom - buttonRect.bottom;
		const buttonLeft = buttonRect.left - mapRect.left;
		const buttonRight = mapRect.right - buttonRect.right;
		const gap = 5;
		this._panel.style.top = "";
		this._panel.style.bottom = "";
		this._panel.style.left = "";
		this._panel.style.right = "";
		switch (position) {
			case "top-left":
				this._panel.style.top = `${buttonTop + buttonRect.height + gap}px`;
				this._panel.style.left = `${buttonLeft}px`;
				break;
			case "top-right":
				this._panel.style.top = `${buttonTop + buttonRect.height + gap}px`;
				this._panel.style.right = `${buttonRight}px`;
				break;
			case "bottom-left":
				this._panel.style.bottom = `${buttonBottom + buttonRect.height + gap}px`;
				this._panel.style.left = `${buttonLeft}px`;
				break;
			case "bottom-right":
				this._panel.style.bottom = `${buttonBottom + buttonRect.height + gap}px`;
				this._panel.style.right = `${buttonRight}px`;
		}
	}
};
//#endregion
//#region src/geolibre.ts
var control = null;
var position = "top-right";
var pendingState = null;
function createControl(app) {
	const nextControl = new KoboConnectorControl({
		collapsed: pendingState?.collapsed ?? true,
		panelWidth: pendingState?.panelWidth ?? 340,
		title: "Kobo Connector",
		defaultApiUrl: pendingState?.apiUrl ?? "kf.kobotoolbox.org",
		hasNativeLayerSupport: typeof app.registerExternalNativeLayer === "function",
		registerNativeLayer: (layer) => app.registerExternalNativeLayer?.(layer),
		unregisterNativeLayer: (id) => app.unregisterExternalNativeLayer?.(id)
	});
	if (pendingState) nextControl.setState(pendingState);
	return nextControl;
}
function isKoboState(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value;
	if ("collapsed" in candidate && typeof candidate.collapsed !== "boolean") return false;
	if ("panelWidth" in candidate && typeof candidate.panelWidth !== "number") return false;
	if ("apiUrl" in candidate && typeof candidate.apiUrl !== "string") return false;
	return true;
}
var plugin = {
	id: "geolibre-kobo-connector",
	name: "Kobo Connector",
	version: "0.1.0",
	activate(app) {
		control = control ?? createControl(app);
		if (!app.addMapControl(control, position)) {
			control = null;
			return false;
		}
	},
	deactivate(app) {
		if (!control) return;
		pendingState = control.getState();
		app.removeMapControl(control);
		control = null;
	},
	getMapControlPosition() {
		return position;
	},
	setMapControlPosition(app, nextPosition) {
		position = nextPosition;
		if (!control) return;
		app.removeMapControl(control);
		if (!app.addMapControl(control, position)) {
			pendingState = control.getState();
			control = null;
			return false;
		}
	},
	getProjectState() {
		return control?.getState() ?? pendingState ?? void 0;
	},
	applyProjectState(_app, state) {
		if (!isKoboState(state)) return false;
		pendingState = state;
		control?.setState(state);
	}
};
//#endregion
export { plugin as default, plugin };
