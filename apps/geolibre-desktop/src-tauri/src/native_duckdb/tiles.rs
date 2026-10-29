//! Native vector tiles (Defani edition): open shapefiles of hundreds of MB to
//! tens of GB the way QGIS does — without loading them into the webview.
//!
//! The first open copies the layer once into a DuckDB cache file (geometry in
//! EPSG:3857 with an R-tree index, plus simplified copies for small scales).
//! The map then asks for vector tiles over the `tfgtile` protocol and each
//! tile is cut from the index in milliseconds; only what is on screen reaches
//! the GPU. Re-opening the same file (unchanged size / date) reuses the cache.
//! Caches of layers that never end up in a saved project are deleted on the
//! next start, so they do not pile up.

use super::{
    describe_source_columns, detect_geometry_column, ensure_spatial_extension, geometry_expr,
    contains_epsg_4326, is_parquet_extension, native_options, parse_geoparquet_metadata, quote_identifier,
    quote_sql_string, read_geoparquet_metadata_json, read_source_crs, source_sql,
    NativeVectorOptions,
};
use duckdb::Connection;
use serde_json::json;
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

const HALF_WORLD: f64 = 20_037_508.342_789_244;
const PROGRESS_EVENT: &str = "tiled-vector-progress";
/// Bump when the cache layout changes so old caches are rebuilt.
const CACHE_VERSION: &str = "2";

const STAGE_BUILDING: u8 = 0;
const STAGE_READY: u8 = 1;
const STAGE_SIMPLIFIED: u8 = 2;
const STAGE_FAILED: u8 = 3;

struct Entry {
    conn: Mutex<Connection>,
    stage: AtomicU8,
    props: Mutex<Vec<String>>,
    info: Mutex<serde_json::Value>,
}

fn entries() -> &'static Mutex<HashMap<String, Arc<Entry>>> {
    static ENTRIES: OnceLock<Mutex<HashMap<String, Arc<Entry>>>> = OnceLock::new();
    ENTRIES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// `D:\The Funny GIS\cache\vector` when a D: drive exists (more room, next to
/// the data), else `%LOCALAPPDATA%\TheFunnyGIS\cache\vector`.
fn cache_dir() -> PathBuf {
    let d = Path::new("D:\\");
    let base = if cfg!(target_os = "windows") && d.exists() {
        d.join("The Funny GIS").join("cache").join("vector")
    } else {
        let local = std::env::var_os("LOCALAPPDATA")
            .or_else(|| std::env::var_os("XDG_CACHE_HOME"))
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        local.join("TheFunnyGIS").join("cache").join("vector")
    };
    let _ = std::fs::create_dir_all(&base);
    base
}

fn mtime(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Cache key: the file (and a shapefile's .dbf) plus its size and date, so an
/// edited or replaced file gets a fresh cache.
fn cache_key(options: &NativeVectorOptions) -> String {
    let mut hasher = DefaultHasher::new();
    CACHE_VERSION.hash(&mut hasher);
    options.path.to_lowercase().hash(&mut hasher);
    options.layer.hash(&mut hasher);
    options.override_source_crs.hash(&mut hasher);
    let main = Path::new(&options.path);
    std::fs::metadata(main).map(|m| m.len()).unwrap_or(0).hash(&mut hasher);
    mtime(main).hash(&mut hasher);
    let dbf = main.with_extension("dbf");
    if dbf.exists() {
        std::fs::metadata(&dbf).map(|m| m.len()).unwrap_or(0).hash(&mut hasher);
        mtime(&dbf).hash(&mut hasher);
    }
    format!("{:016x}", hasher.finish())
}

// ---------------------------------------------------------------- registry
// registry.json: { key: { source, saved, lastUsed, bytes } }. A cache whose
// layer was never part of a saved project is removed on the next start.

fn registry_path() -> PathBuf {
    cache_dir().join("registry.json")
}

fn read_registry() -> serde_json::Map<String, serde_json::Value> {
    std::fs::read_to_string(registry_path())
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

fn write_registry(map: &serde_json::Map<String, serde_json::Value>) {
    let _ = std::fs::write(registry_path(), serde_json::Value::Object(map.clone()).to_string());
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn touch_registry(key: &str, source: &str) {
    static LOCK: Mutex<()> = Mutex::new(());
    let _guard = LOCK.lock();
    let mut map = read_registry();
    let entry = map
        .entry(key.to_string())
        .or_insert_with(|| json!({ "source": source, "saved": false }));
    if let Some(obj) = entry.as_object_mut() {
        obj.insert("lastUsed".into(), json!(now()));
        obj.insert("source".into(), json!(source));
    }
    write_registry(&map);
}

fn remove_cache_files(key: &str) {
    let dir = cache_dir();
    for suffix in [".duckdb", ".duckdb.wal", ".duckdb.tmp"] {
        let _ = std::fs::remove_file(dir.join(format!("{key}{suffix}")));
    }
}

// ---------------------------------------------------------------- opening

fn emit(app: &AppHandle, id: &str, stage: &str, message: &str, extra: serde_json::Value) {
    let mut payload = json!({ "id": id, "stage": stage, "message": message });
    if let (Some(obj), Some(more)) = (payload.as_object_mut(), extra.as_object()) {
        for (k, v) in more {
            obj.insert(k.clone(), v.clone());
        }
    }
    let _ = app.emit(PROGRESS_EVENT, payload);
}

fn read_meta(conn: &Connection) -> Option<(u8, serde_json::Value)> {
    let stage: String = conn
        .query_row("SELECT v FROM _tfg_meta WHERE k = 'stage'", [], |r| r.get(0))
        .ok()?;
    let info: String = conn
        .query_row("SELECT v FROM _tfg_meta WHERE k = 'info'", [], |r| r.get(0))
        .ok()?;
    Some((stage.parse().ok()?, serde_json::from_str(&info).ok()?))
}

fn write_meta(conn: &Connection, stage: u8, info: &serde_json::Value) -> Result<(), String> {
    conn.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS _tfg_meta (k VARCHAR PRIMARY KEY, v VARCHAR);
         INSERT OR REPLACE INTO _tfg_meta VALUES ('stage', {}), ('info', {});",
        quote_sql_string(&stage.to_string()),
        quote_sql_string(&info.to_string())
    ))
    .map_err(|e| format!("Could not write the tile cache metadata: {e}"))
}

/// Extent from a shapefile header (degrees only), so the map can zoom at once.
fn shp_header_bbox(path: &str) -> Option<[f64; 4]> {
    if !path.to_lowercase().ends_with(".shp") {
        return None;
    }
    use std::io::Read;
    let mut head = [0u8; 100];
    std::fs::File::open(path).ok()?.read_exact(&mut head).ok()?;
    let f = |o: usize| f64::from_le_bytes(head[o..o + 8].try_into().unwrap());
    let b = [f(36), f(44), f(52), f(60)];
    let geographic = b[0] >= -180.0 && b[2] <= 180.0 && b[1] >= -90.0 && b[3] <= 90.0;
    geographic.then_some(b)
}

/// Open a vector file as native tiles. Returns at once: `ready` is true when a
/// cache already exists; otherwise the cache is built in the background and
/// `tiled-vector-progress` events report it.
#[tauri::command]
pub async fn open_tiled_vector(
    app: AppHandle,
    path: String,
    layer: Option<String>,
    override_source_crs: Option<String>,
) -> Result<serde_json::Value, String> {
    let options = native_options(path, layer, override_source_crs)?;
    tauri::async_runtime::spawn_blocking(move || open_blocking(app, options))
        .await
        .map_err(|e| format!("Tile cache task failed: {e}"))?
}

fn open_blocking(app: AppHandle, options: NativeVectorOptions) -> Result<serde_json::Value, String> {
    let key = cache_key(&options);
    touch_registry(&key, &options.path);
    if let Some(entry) = entries().lock().unwrap().get(&key).cloned() {
        return Ok(status_json(&key, &entry));
    }
    let db_path = cache_dir().join(format!("{key}.duckdb"));
    let existing = db_path.exists();
    if existing {
        if let Ok(conn) = Connection::open(&db_path) {
            if ensure_spatial_extension(&conn).is_ok() {
                if let Some((stage, info)) = read_meta(&conn) {
                    if stage == STAGE_SIMPLIFIED {
                        let props = info["props"]
                            .as_array()
                            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                            .unwrap_or_default();
                        let entry = Arc::new(Entry {
                            conn: Mutex::new(conn),
                            stage: AtomicU8::new(STAGE_SIMPLIFIED),
                            props: Mutex::new(props),
                            info: Mutex::new(info),
                        });
                        entries().lock().unwrap().insert(key.clone(), entry.clone());
                        return Ok(status_json(&key, &entry));
                    }
                }
            }
        }
        // Unfinished (the app closed mid-build) or unreadable: start over.
        remove_cache_files(&key);
    }
    let conn = Connection::open(&db_path).map_err(|e| format!("Could not create the tile cache: {e}"))?;
    ensure_spatial_extension(&conn)?;
    let header = shp_header_bbox(&options.path);
    let entry = Arc::new(Entry {
        conn: Mutex::new(conn),
        stage: AtomicU8::new(STAGE_BUILDING),
        props: Mutex::new(Vec::new()),
        info: Mutex::new(json!({ "bbox": header })),
    });
    entries().lock().unwrap().insert(key.clone(), entry.clone());
    let worker_key = key.clone();
    std::thread::spawn(move || {
        if let Err(error) = build_cache(&app, &worker_key, &entry, &options) {
            entry.stage.store(STAGE_FAILED, Ordering::SeqCst);
            emit(&app, &worker_key, "failed", &error, json!({}));
        }
    });
    let mut status = status_json(&key, entries().lock().unwrap().get(&key).unwrap());
    status["bbox"] = json!(header);
    Ok(status)
}

fn status_json(key: &str, entry: &Entry) -> serde_json::Value {
    let mut info = entry.info.lock().unwrap().clone();
    let stage = entry.stage.load(Ordering::SeqCst);
    if let Some(obj) = info.as_object_mut() {
        obj.insert("id".into(), json!(key));
        obj.insert("ready".into(), json!(stage == STAGE_READY || stage == STAGE_SIMPLIFIED));
        obj.insert("stage".into(), json!(stage));
        obj.insert("tiles".into(), json!(tile_url(key)));
    }
    info
}

fn tile_url(key: &str) -> String {
    if cfg!(target_os = "windows") || cfg!(target_os = "android") {
        format!("http://tfgtile.localhost/{key}/{{z}}/{{x}}/{{y}}.pbf")
    } else {
        format!("tfgtile://localhost/{key}/{{z}}/{{x}}/{{y}}.pbf")
    }
}

/// Columns MVT can carry as properties: numbers, text and booleans stay as
/// they are; everything else (dates, decimals, lists) becomes text.
fn property_select(name: &str, column_type: &str) -> String {
    let t = column_type.to_ascii_uppercase();
    let q = quote_identifier(name);
    let keep = ["VARCHAR", "BIGINT", "INTEGER", "SMALLINT", "TINYINT", "DOUBLE", "FLOAT", "BOOLEAN", "UBIGINT", "UINTEGER", "USMALLINT", "UTINYINT", "HUGEINT"];
    if keep.iter().any(|k| t == *k) {
        q
    } else if t.starts_with("DECIMAL") || t == "REAL" {
        format!("CAST({q} AS DOUBLE) AS {q}")
    } else {
        format!("CAST({q} AS VARCHAR) AS {q}")
    }
}

fn mercator_to_lonlat(x: f64, y: f64) -> (f64, f64) {
    let lon = x / HALF_WORLD * 180.0;
    let lat = (y / HALF_WORLD * std::f64::consts::PI).exp().atan() * 360.0 / std::f64::consts::PI - 90.0;
    (lon, lat)
}

fn build_cache(app: &AppHandle, key: &str, entry: &Arc<Entry>, options: &NativeVectorOptions) -> Result<(), String> {
    let started = std::time::Instant::now();
    let conn = entry.conn.lock().unwrap().try_clone().map_err(|e| e.to_string())?;
    ensure_spatial_extension(&conn)?;
    let _ = conn.execute_batch("SET preserve_insertion_order = false;");
    emit(app, key, "reading", "Reading the file…", json!({ "progress": 5 }));

    let sql = source_sql(options);
    let columns = describe_source_columns(&conn, &sql)?;
    let is_parquet = is_parquet_extension(&options.extension);
    let geo_metadata = if is_parquet {
        read_geoparquet_metadata_json(&conn, &options.path)
            .as_deref()
            .and_then(parse_geoparquet_metadata)
    } else {
        None
    };
    let detected = detect_geometry_column(
        &conn,
        &sql,
        &columns,
        geo_metadata.as_ref().and_then(|m| m.primary_column.as_deref()),
        is_parquet,
    )?;
    let prop_columns: Vec<(String, String)> = columns
        .iter()
        .filter(|c| c.name != detected.column)
        .filter(|c| {
            let t = c.column_type.to_ascii_uppercase();
            !t.starts_with("GEOMETRY") && !t.starts_with("BLOB") && !t.starts_with("WKB")
        })
        .map(|c| (c.name.clone(), c.column_type.clone()))
        .collect();
    let source_crs = match options.override_source_crs.clone() {
        Some(crs) => Some(crs),
        None => read_source_crs(&conn, options, geo_metadata.as_ref(), &detected.column),
    };
    // Stored in WGS84 as read: no reprojection of the whole layer (a WGS84
    // shapefile needs none) and no row_number() window (single-threaded, it
    // took 21 s of a 435 MB file); tiles reproject only clipped, simplified
    // pieces, and DuckDB's rowid identifies features.
    let geom = geometry_expr(&detected);
    let g4326 = match source_crs.as_deref() {
        Some(crs) if !contains_epsg_4326(crs) => format!("ST_Transform({geom}, {}, 'EPSG:4326', true)", quote_sql_string(crs)),
        _ => geom,
    };
    let mut select: Vec<String> = prop_columns.iter().map(|(n, t)| property_select(n, t)).collect();
    select.push(format!("{g4326} AS g"));
    conn.execute_batch(&format!(
        "CREATE TABLE f AS SELECT * FROM (SELECT {} FROM ({sql}) AS data) WHERE g IS NOT NULL AND NOT ST_IsEmpty(g);",
        select.join(", ")
    ))
    .map_err(|e| format!("Could not copy the layer into the tile cache: {e}"))?;
    emit(app, key, "indexing", "Building the spatial index…", json!({ "progress": 60 }));
    conn.execute_batch("CREATE INDEX f_rtree ON f USING RTREE (g);")
        .map_err(|e| format!("Could not index the layer: {e}"))?;

    let (minx, miny, maxx, maxy, count): (f64, f64, f64, f64, i64) = conn
        .query_row(
            "SELECT ST_XMin(e), ST_YMin(e), ST_XMax(e), ST_YMax(e), n FROM (SELECT ST_Extent_Agg(g) AS e, count(*) AS n FROM f)",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .map_err(|e| format!("Could not read the layer extent: {e}"))?;
    let (w, s, e, n) = (minx, miny, maxx, maxy);
    let geometry_type: String = conn
        .query_row("SELECT ST_GeometryType(g)::VARCHAR FROM f LIMIT 1", [], |r| r.get(0))
        .unwrap_or_else(|_| "POLYGON".into());
    let props: Vec<String> = prop_columns.iter().map(|(n, _)| n.clone()).collect();
    let fields: Vec<serde_json::Value> = prop_columns
        .iter()
        .map(|(n, t)| json!({ "name": n, "type": t }))
        .collect();
    let info = json!({
        "bbox": [w, s, e, n],
        "count": count,
        "geometryType": geometry_type,
        "props": props,
        "fields": fields,
        "source": options.path,
        "crs": source_crs,
    });
    *entry.props.lock().unwrap() = props;
    *entry.info.lock().unwrap() = info.clone();
    write_meta(&conn, STAGE_READY, &info)?;
    entry.stage.store(STAGE_READY, Ordering::SeqCst);
    emit(app, key, "ready", "Ready — refining small scales…", json!({ "progress": 75, "info": info }));

    // Simplified copies for small scales (1 km and 100 m in metres).
    conn.execute_batch(
        "CREATE TABLE lo AS SELECT rowid AS __fid, * EXCLUDE (g), ST_Simplify(g, 0.01) AS g_lo, ST_Simplify(g, 0.001) AS g_mid FROM f;
         DELETE FROM lo WHERE g_mid IS NULL OR ST_IsEmpty(g_mid);
         CREATE INDEX lo_rtree ON lo USING RTREE (g_mid);",
    )
    .map_err(|e| format!("Could not build the small-scale copies: {e}"))?;
    write_meta(&conn, STAGE_SIMPLIFIED, &info)?;
    let _ = conn.execute_batch("CHECKPOINT;");
    entry.stage.store(STAGE_SIMPLIFIED, Ordering::SeqCst);
    emit(
        app,
        key,
        "done",
        &format!("Indexed in {:.1} s", started.elapsed().as_secs_f64()),
        json!({ "progress": 100, "info": info }),
    );
    Ok(())
}

// ---------------------------------------------------------------- tiles

fn tile_bytes(key: &str, z: u32, x: u32, y: u32) -> Result<Vec<u8>, String> {
    let entry = entries()
        .lock()
        .unwrap()
        .get(key)
        .cloned()
        .ok_or_else(|| "unknown tile layer".to_string())?;
    let stage = entry.stage.load(Ordering::SeqCst);
    if stage != STAGE_READY && stage != STAGE_SIMPLIFIED {
        return Ok(Vec::new());
    }
    let conn = entry.conn.lock().unwrap().try_clone().map_err(|e| e.to_string())?;
    let size = 2.0 * HALF_WORLD / f64::from(1u32 << z.min(30));
    let minx = -HALF_WORLD + f64::from(x) * size;
    let maxy = HALF_WORLD - f64::from(y) * size;
    let (maxx, miny) = (minx + size, maxy - size);
    let pad = size * 64.0 / 4096.0;
    let env = format!("ST_MakeEnvelope({minx}, {miny}, {maxx}, {maxy})");
    // The data is stored in WGS84: query with the padded tile in lon/lat.
    let (qw, qs) = mercator_to_lonlat(minx - pad, miny - pad);
    let (qe, qn) = mercator_to_lonlat(maxx + pad, maxy + pad);
    let query_env = format!("ST_MakeEnvelope({qw}, {qs}, {qe}, {qn})");
    // Pixel size at 512 px tiles, in degrees: finer detail is invisible.
    let pixel = size / 512.0 / 111_320.0;
    let (table, geometry, filter, fid) = if stage == STAGE_SIMPLIFIED && z <= 6 {
        ("lo", "g_lo".to_string(), "g_mid", "__fid")
    } else if stage == STAGE_SIMPLIFIED && z <= 9 {
        ("lo", "g_mid".to_string(), "g_mid", "__fid")
    } else {
        ("f", "g".to_string(), "g", "rowid")
    };
    let props = entry.props.lock().unwrap().clone();
    // A materialized CTE: clip + encode each candidate once. (A subquery with an
    // outer `WHERE t.geom IS NOT NULL` made DuckDB re-evaluate the struct and
    // took 69 s for one z10 tile; this form takes ~80 ms.) Geometry is first
    // simplified to half a pixel, so huge polygons clip fast at every zoom.
    let simplified = format!("ST_Transform(ST_Simplify({geometry}, {}), 'EPSG:4326', 'EPSG:3857', true)", pixel * 0.5);
    let mut cte_cols = vec![
        format!("{fid} AS __fid"),
        format!("ST_AsMVTGeom({simplified}, ST_Extent({env}), 4096, 64, true) AS __mvt_geom"),
    ];
    let mut fields = vec!["'__geom': __mvt_geom".to_string(), "'__fid': __fid".to_string()];
    for name in &props {
        cte_cols.push(quote_identifier(name));
        fields.push(format!("{}: {}", quote_sql_string(name), quote_identifier(name)));
    }
    let sql = format!(
        "WITH c AS MATERIALIZED (SELECT {} FROM {table} WHERE ST_Intersects({filter}, {query_env}))
         SELECT ST_AsMVT({{{}}}, 'layer', 4096, '__geom') FROM c WHERE __mvt_geom IS NOT NULL",
        cte_cols.join(", "),
        fields.join(", ")
    );
    let bytes: Option<Vec<u8>> = conn
        .query_row(&sql, [], |r| r.get(0))
        .map_err(|e| format!("tile {z}/{x}/{y}: {e}"))?;
    Ok(bytes.unwrap_or_default())
}

/// Response for `tfgtile://…/{key}/{z}/{x}/{y}.pbf`.
pub fn protocol_response(path: &str) -> tauri::http::Response<Vec<u8>> {
    let parts: Vec<&str> = path.trim_matches('/').split('/').collect();
    let parsed = (parts.len() == 4)
        .then(|| {
            let y = parts[3].trim_end_matches(".pbf").trim_end_matches(".mvt");
            Some((parts[0], parts[1].parse::<u32>().ok()?, parts[2].parse::<u32>().ok()?, y.parse::<u32>().ok()?))
        })
        .flatten();
    let builder = tauri::http::Response::builder()
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", "no-store");
    match parsed.map(|(k, z, x, y)| tile_bytes(k, z, x, y)) {
        Some(Ok(bytes)) => builder
            .status(if bytes.is_empty() { 204 } else { 200 })
            .header("Content-Type", "application/x-protobuf")
            .body(bytes)
            .unwrap(),
        Some(Err(error)) => {
            eprintln!("[tfgtile] {error}");
            builder.status(500).body(error.into_bytes()).unwrap()
        }
        None => builder.status(400).body(b"bad tile path".to_vec()).unwrap(),
    }
}

// ---------------------------------------------------------------- features

/// Attribute rows of a tiled layer (attribute table, identify): an optional
/// SQL filter, paging and the feature ids to fetch.
#[tauri::command]
pub async fn query_tiled_vector(
    id: String,
    where_clause: Option<String>,
    fids: Option<Vec<i64>>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let entry = entries().lock().unwrap().get(&id).cloned().ok_or("unknown tile layer")?;
        let conn = entry.conn.lock().unwrap().try_clone().map_err(|e| e.to_string())?;
        let props = entry.props.lock().unwrap().clone();
        let mut cols = vec!["rowid AS __fid".to_string()];
        cols.extend(props.iter().map(|p| quote_identifier(p)));
        let mut conditions = Vec::new();
        if let Some(w) = where_clause.filter(|w| !w.trim().is_empty()) {
            if w.contains(';') {
                return Err("Only a single WHERE condition is allowed.".to_string());
            }
            conditions.push(format!("({w})"));
        }
        if let Some(ids) = fids.filter(|f| !f.is_empty()) {
            conditions.push(format!(
                "rowid IN ({})",
                ids.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(",")
            ));
        }
        let where_sql = if conditions.is_empty() { String::new() } else { format!("WHERE {}", conditions.join(" AND ")) };
        let total: i64 = conn
            .query_row(&format!("SELECT count(*) FROM f {where_sql}"), [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        let sql = format!(
            "SELECT {} FROM f {where_sql} ORDER BY rowid LIMIT {} OFFSET {}",
            cols.join(", "),
            limit.unwrap_or(500).min(20_000),
            offset.unwrap_or(0)
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        let mut names = vec!["__fid".to_string()];
        names.extend(props);
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let mut obj = serde_json::Map::new();
            for (i, name) in names.iter().enumerate() {
                let value: duckdb::types::Value = row.get(i).map_err(|e| e.to_string())?;
                obj.insert(name.clone(), super::duckdb_value_to_json(&value));
            }
            out.push(serde_json::Value::Object(obj));
        }
        Ok(json!({ "total": total, "rows": out }))
    })
    .await
    .map_err(|e| format!("Query task failed: {e}"))?
}

/// GeoJSON of chosen features (for editing, export or analysis of a subset).
#[tauri::command]
pub async fn tiled_vector_geojson(id: String, where_clause: Option<String>, limit: Option<u32>) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let entry = entries().lock().unwrap().get(&id).cloned().ok_or("unknown tile layer")?;
        let conn = entry.conn.lock().unwrap().try_clone().map_err(|e| e.to_string())?;
        let props = entry.props.lock().unwrap().clone();
        let where_sql = match where_clause.filter(|w| !w.trim().is_empty()) {
            Some(w) if w.contains(';') => return Err("Only a single WHERE condition is allowed.".to_string()),
            Some(w) => format!("WHERE {w}"),
            None => String::new(),
        };
        let mut cols: Vec<String> = props.iter().map(|p| quote_identifier(p)).collect();
        cols.insert(0, "rowid AS __fid".into());
        cols.push("ST_AsGeoJSON(g) AS __geom".into());
        let sql = format!("SELECT {} FROM f {where_sql} LIMIT {}", cols.join(", "), limit.unwrap_or(50_000).min(500_000));
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
        let mut features = Vec::new();
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let mut properties = serde_json::Map::new();
            let fid: i64 = row.get(0).map_err(|e| e.to_string())?;
            for (i, name) in props.iter().enumerate() {
                let value: duckdb::types::Value = row.get(i + 1).map_err(|e| e.to_string())?;
                properties.insert(name.clone(), super::duckdb_value_to_json(&value));
            }
            let geom: String = row.get(props.len() + 1).map_err(|e| e.to_string())?;
            features.push(json!({
                "type": "Feature",
                "id": fid,
                "properties": properties,
                "geometry": serde_json::from_str::<serde_json::Value>(&geom).unwrap_or(serde_json::Value::Null),
            }));
        }
        Ok(json!({ "type": "FeatureCollection", "features": features }))
    })
    .await
    .map_err(|e| format!("Export task failed: {e}"))?
}

// ---------------------------------------------------------------- cleanup

/// Mark these caches as belonging to a saved project, so they are kept.
#[tauri::command]
pub fn mark_tiled_vectors_saved(ids: Vec<String>) {
    let mut map = read_registry();
    for id in ids {
        if let Some(obj) = map.get_mut(&id).and_then(|v| v.as_object_mut()) {
            obj.insert("saved".into(), json!(true));
            obj.insert("lastUsed".into(), json!(now()));
        }
    }
    write_registry(&map);
}

/// Delete caches that never became part of a saved project (except `keep`,
/// the layers open right now), and trim saved ones beyond `max_gb` oldest
/// first. Returns the number of bytes freed.
#[tauri::command]
pub fn cleanup_tiled_vectors(keep: Vec<String>, max_gb: Option<f64>) -> u64 {
    let open: Vec<String> = entries().lock().unwrap().keys().cloned().collect();
    let mut map = read_registry();
    let dir = cache_dir();
    let size_of = |key: &str| {
        ["duckdb", "duckdb.wal"]
            .iter()
            .filter_map(|ext| std::fs::metadata(dir.join(format!("{key}.{ext}"))).ok())
            .map(|m| m.len())
            .sum::<u64>()
    };
    let mut freed = 0u64;
    let keys: Vec<String> = map.keys().cloned().collect();
    for key in &keys {
        if keep.contains(key) || open.contains(key) {
            continue;
        }
        let saved = map[key]["saved"].as_bool().unwrap_or(false);
        if !saved {
            freed += size_of(key);
            remove_cache_files(key);
            map.remove(key);
        }
    }
    // Stray files with no registry entry.
    if let Ok(read) = std::fs::read_dir(&dir) {
        for file in read.flatten() {
            let name = file.file_name().to_string_lossy().to_string();
            if let Some(key) = name.strip_suffix(".duckdb") {
                if !map.contains_key(key) && !keep.iter().any(|k| k == key) && !open.iter().any(|k| k == key) {
                    freed += size_of(key);
                    remove_cache_files(key);
                }
            }
        }
    }
    let limit = (max_gb.unwrap_or(30.0) * 1024.0 * 1024.0 * 1024.0) as u64;
    let mut saved: Vec<(String, u64, u64)> = map
        .iter()
        .map(|(k, v)| (k.clone(), v["lastUsed"].as_u64().unwrap_or(0), size_of(k)))
        .collect();
    let mut total: u64 = saved.iter().map(|s| s.2).sum();
    saved.sort_by_key(|s| s.1);
    for (key, _, bytes) in saved {
        if total <= limit {
            break;
        }
        if keep.contains(&key) || open.contains(&key) {
            continue;
        }
        remove_cache_files(&key);
        map.remove(&key);
        total -= bytes;
        freed += bytes;
    }
    write_registry(&map);
    freed
}

/// Where the caches live and how much room they take.
#[tauri::command]
pub fn tiled_vector_cache_info() -> serde_json::Value {
    let dir = cache_dir();
    let map = read_registry();
    let bytes: u64 = std::fs::read_dir(&dir)
        .map(|r| r.flatten().filter_map(|f| f.metadata().ok()).map(|m| m.len()).sum())
        .unwrap_or(0);
    json!({ "dir": dir.to_string_lossy(), "bytes": bytes, "count": map.len() })
}

/// Unique values of a field with their feature counts (Unique Values renderer),
/// or, with `numeric`, a sample of up to 20 000 numbers (class breaks).
#[tauri::command]
pub async fn tiled_vector_field_stats(id: String, field: String, numeric: Option<bool>) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let entry = entries().lock().unwrap().get(&id).cloned().ok_or("unknown tile layer")?;
        if !entry.props.lock().unwrap().contains(&field) {
            return Err(format!("Unknown field \"{field}\""));
        }
        let conn = entry.conn.lock().unwrap().try_clone().map_err(|e| e.to_string())?;
        let col = quote_identifier(&field);
        if numeric.unwrap_or(false) {
            let sql = format!("SELECT v FROM (SELECT TRY_CAST({col} AS DOUBLE) AS v FROM f) WHERE v IS NOT NULL USING SAMPLE reservoir(20000 ROWS)");
            let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
            let values: Vec<f64> = stmt
                .query_map([], |r| r.get::<_, f64>(0))
                .map_err(|e| e.to_string())?
                .filter_map(Result::ok)
                .collect();
            return Ok(json!({ "values": values }));
        }
        let sql = format!("SELECT CAST({col} AS VARCHAR) AS v, count(*) AS n FROM f GROUP BY 1 ORDER BY 1 NULLS LAST LIMIT 5000");
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows: Vec<serde_json::Value> = stmt
            .query_map([], |r| Ok(json!({ "value": r.get::<_, Option<String>>(0)?, "count": r.get::<_, i64>(1)? })))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        Ok(json!({ "values": rows }))
    })
    .await
    .map_err(|e| format!("Field statistics task failed: {e}"))?
}
