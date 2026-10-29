"""DuckDB SQL over a PostgreSQL/PostGIS database (``/duckdb-postgres``).

Backs the "connection" source of the SQL Workspace's DuckDB engine: the
browser's DuckDB-WASM cannot load the ``postgres`` extension, so the query runs
in native DuckDB here with the database ``ATTACH``-ed read-only as ``db`` and
selected with ``USE``, so ``SELECT * FROM public.my_table`` works unqualified.

The DSN goes through the same host allowlist as the psycopg endpoints
(``GEOLIBRE_POSTGIS_HOSTS``). One DuckDB connection is cached per DSN so the
extension load and ``ATTACH`` are paid once; it is never logged or echoed back.
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .db_common import json_safe, scrub_secrets
from .postgis import _import_psycopg, _validate_postgis_target

router = APIRouter(prefix="/duckdb-postgres", tags=["duckdb-postgres"])
logger = logging.getLogger(__name__)

_MAX_ROWS = 100_000
# PostGIS geometry arrives through postgres_scanner either as DuckDB GEOMETRY
# (spatial loaded) or as hex EWKB text, depending on the extension versions.
_GEOMETRY_NAMES = {"geom", "geometry", "the_geom", "wkb_geometry", "shape"}

_lock = threading.Lock()
_connections: dict[str, tuple[Any, threading.Lock]] = {}


def duckdb_import_error() -> Optional[str]:
    """Return the duckdb import error message, or None if it imports cleanly."""
    try:
        import duckdb  # noqa: F401
    except Exception as exc:  # noqa: BLE001 - report any import failure
        return str(exc)
    return None


class DuckdbPostgresQueryRequest(BaseModel):
    """Request body for running one DuckDB statement against a database."""

    connection: str
    sql: str
    max_rows: int = _MAX_ROWS


class DuckdbPostgresConnectionRequest(BaseModel):
    """Request body naming a database connection."""

    connection: str


def _password(connection: str) -> list[str]:
    try:
        conninfo = _import_psycopg().conninfo.conninfo_to_dict(connection)
    except Exception:  # noqa: BLE001 - scrubbing is best effort
        return [connection]
    return [connection] + ([conninfo["password"]] if conninfo.get("password") else [])


def _key(connection: str) -> str:
    return hashlib.sha256(connection.encode("utf-8")).hexdigest()


def _connection(connection: str) -> tuple[Any, threading.Lock]:
    """Return the cached DuckDB connection for a DSN, attaching it on first use."""
    connection = connection.strip()
    if not connection:
        raise HTTPException(status_code=400, detail="connection is required")
    key = _key(connection)
    with _lock:
        cached = _connections.get(key)
        if cached is not None:
            return cached
        import duckdb

        conninfo = _import_psycopg().conninfo.conninfo_to_dict(connection)
        _validate_postgis_target(conninfo)
        con = duckdb.connect()
        try:
            con.execute("INSTALL postgres; LOAD postgres; INSTALL spatial; LOAD spatial;")
            con.execute("ATTACH ? AS db (TYPE postgres, READ_ONLY)", [connection])
            con.execute("USE db")
        except Exception as exc:  # noqa: BLE001 - surface a stable, scrubbed error
            con.close()
            raise HTTPException(
                status_code=400,
                detail=f"Could not attach PostgreSQL: {scrub_secrets(str(exc), _password(connection))}",
            ) from exc
        cached = (con, threading.Lock())
        _connections[key] = cached
        return cached


def _quote(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _geometry_expr(name: str, type_name: str) -> Optional[str]:
    """DuckDB expression turning a geometry-like column into GeoJSON text."""
    upper = type_name.upper()
    if upper.startswith("GEOMETRY"):
        return f"ST_AsGeoJSON({_quote(name)})"
    if upper == "BLOB" and name.lower() in _GEOMETRY_NAMES:
        return f"ST_AsGeoJSON(ST_GeomFromWKB({_quote(name)}))"
    if upper == "VARCHAR" and name.lower() in _GEOMETRY_NAMES:
        return f"ST_AsGeoJSON(ST_GeomFromHEXEWKB({_quote(name)}))"
    return None


def run_query(con: Any, sql: str, max_rows: int) -> dict[str, Any]:
    """Run one statement and shape it like the SQL Workspace's SqlQueryResult.

    The first geometry column becomes the GeoJSON geometry (and is left out of
    the attribute columns); further geometry columns are dropped.
    """
    rel = con.sql(sql)
    if rel is None:  # statement without a result set (SET, USE, ...)
        return {"columns": [], "rows": [], "rowCount": 0, "truncated": False, "geojson": None}

    names = list(rel.columns)
    types = [str(t) for t in rel.types]
    geom_idx: Optional[int] = None
    select = []
    keep = []
    for index, (name, type_name) in enumerate(zip(names, types)):
        expr = _geometry_expr(name, type_name)
        if expr is None:
            select.append(_quote(name))
            keep.append(name)
        elif geom_idx is None:
            geom_idx = index
            select.append(f'{expr} AS "__geojson"')

    fetched = rel.select(", ".join(select)).limit(max_rows + 1).fetchall()
    truncated = len(fetched) > max_rows
    fetched = fetched[:max_rows]

    geo_pos = None
    if geom_idx is not None:
        geo_pos = sum(1 for i in range(geom_idx) if _geometry_expr(names[i], types[i]) is None)
    rows: list[dict[str, Any]] = []
    features: list[dict[str, Any]] = []
    for record in fetched:
        values = list(record)
        geo = values.pop(geo_pos) if geo_pos is not None else None
        row = {column: json_safe(value) for column, value in zip(keep, values)}
        rows.append(row)
        if geo_pos is not None:
            features.append(
                {
                    "type": "Feature",
                    "properties": row,
                    "geometry": json.loads(geo) if geo else None,
                }
            )
    return {
        "columns": keep,
        "rows": rows,
        "rowCount": len(rows),
        "truncated": truncated,
        "geojson": (
            {"type": "FeatureCollection", "features": features} if geo_pos is not None else None
        ),
    }


@router.get("/status")
def duckdb_postgres_status() -> dict[str, Any]:
    """Return native DuckDB availability."""
    import_error = duckdb_import_error()
    if import_error is None:
        return {"available": True, "message": "Native DuckDB is available."}
    logger.info("duckdb runtime unavailable: %s", import_error)
    return {"available": False, "message": "Native DuckDB is not installed in the sidecar."}


@router.post("/query")
def duckdb_postgres_query(request: DuckdbPostgresQueryRequest) -> dict[str, Any]:
    """Run a DuckDB statement with the PostgreSQL database attached as ``db``."""
    if duckdb_import_error() is not None:
        raise HTTPException(status_code=503, detail="duckdb is not installed in the sidecar.")
    if not request.sql.strip():
        raise HTTPException(status_code=400, detail="sql is required")
    con, query_lock = _connection(request.connection)
    max_rows = max(1, min(request.max_rows, _MAX_ROWS))
    # USE/SET are per-connection state, so statements on one DSN are serialised.
    with query_lock:
        try:
            return run_query(con, request.sql, max_rows)
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001 - surface a stable, scrubbed error
            raise HTTPException(
                status_code=400,
                detail=scrub_secrets(str(exc), _password(request.connection)),
            ) from exc


@router.post("/disconnect")
def duckdb_postgres_disconnect(request: DuckdbPostgresConnectionRequest) -> dict[str, Any]:
    """Drop the cached connection so the next query re-attaches (fresh schema)."""
    with _lock:
        cached = _connections.pop(_key(request.connection.strip()), None)
    if cached is not None:
        try:
            cached[0].close()
        except Exception:  # noqa: BLE001 - closing is best effort
            pass
    return {"disconnected": cached is not None}
