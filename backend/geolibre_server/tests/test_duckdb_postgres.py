"""Tests for the DuckDB-over-PostgreSQL SQL Workspace endpoint."""

import pytest

duckdb = pytest.importorskip("duckdb")

from geolibre_server.app.duckdb_postgres import run_query  # noqa: E402


@pytest.fixture(scope="module")
def con():
    connection = duckdb.connect()
    try:
        connection.execute("INSTALL spatial; LOAD spatial;")
    except Exception as exc:  # noqa: BLE001 - offline CI cannot fetch extensions
        pytest.skip(f"DuckDB spatial extension unavailable: {exc}")
    yield connection
    connection.close()


def test_attribute_query_has_no_geojson(con):
    result = run_query(con, "SELECT 1 AS a, 'x' AS b", 10)
    assert result["columns"] == ["a", "b"]
    assert result["rows"] == [{"a": 1, "b": "x"}]
    assert result["geojson"] is None


def test_geometry_column_becomes_feature_geometry(con):
    result = run_query(
        con,
        "SELECT 'k' AS name, ST_Point(96.8, 4.6) AS geom, ST_Point(0, 0) AS other_geom",
        10,
    )
    assert result["columns"] == ["name"]
    feature = result["geojson"]["features"][0]
    assert feature["properties"] == {"name": "k"}
    assert feature["geometry"]["type"] == "Point"
    assert feature["geometry"]["coordinates"] == [96.8, 4.6]


def test_hex_ewkb_text_column_is_decoded(con):
    hexwkb = con.sql("SELECT ST_AsHEXWKB(ST_Point(1, 2))").fetchone()[0]
    result = run_query(con, f"SELECT 7 AS id, '{hexwkb}' AS geom", 10)
    assert result["geojson"]["features"][0]["geometry"]["coordinates"] == [1.0, 2.0]


def test_truncation(con):
    result = run_query(con, "SELECT * FROM range(5) t(i)", 3)
    assert result["rowCount"] == 3
    assert result["truncated"] is True
