import { runDuckdbPostgresQuery } from "@geolibre/processing";
import { isDesktopRuntime } from "./is-mobile";
import { ignoreSidecarStartError, startGeoLibreSidecar } from "./sidecar";
import type { SqlQueryResult } from "./sql-workspace";

/**
 * Run a SQL Workspace statement through the sidecar's native DuckDB with a
 * saved PostgreSQL/Supabase connection attached as `db`. DuckDB-WASM cannot
 * load the postgres extension, so this path is desktop-only.
 */
export async function runDuckdbPostgresWorkspaceQuery(
  connection: string,
  sql: string,
): Promise<SqlQueryResult> {
  if (!isDesktopRuntime()) {
    throw new Error("Querying a PostgreSQL connection with DuckDB requires GeoLibre Desktop.");
  }
  // The sidecar starts on demand; a failed start still lets the request
  // surface the real error (mirrors the Browser panel's PostGIS loader).
  await startGeoLibreSidecar().catch(ignoreSidecarStartError);
  const result = await runDuckdbPostgresQuery(connection, sql);
  return {
    columns: result.columns,
    rows: result.rows,
    rowCount: result.rowCount,
    geometryColumn: result.geojson ? "geom" : null,
    geojson: result.geojson,
  };
}
