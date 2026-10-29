"""Species distribution modeling (Defani edition) with ``elapid``.

The desktop SDM dock fits a Maxent model (``elapid.MaxentModel``) from
occurrence points and covariate GeoTIFFs and maps habitat suitability:

- ``GET /sdm/status`` reports whether the runtime imports elapid; when it does
  not, elapid (with geopandas, rasterio and scikit-learn) is installed into the
  managed runtime in the background, so nothing has to be run in a terminal.
- ``POST /sdm/run`` runs the model as a background job polled with
  ``GET /conversion/jobs/{job_id}``. With ``use_sample`` it first downloads
  elapid's own tutorial data (Ariolimax buttoni occurrences and six California
  covariates). Results are downloaded with ``GET /sdm/jobs/{job_id}/files/{name}``.

The workflow follows elapid's "A simple Maxent model" example: sample
background points from the first covariate, stack presence and background,
annotate both with the covariates, fit Maxent, report the AUC (on a held-out
test split as well as on training), and apply the model to the rasters.
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from .conversion import (
    _RESULT_MARKER,
    _RUNTIME_SETUP_LOCK,
    _cancel_job,
    _job_state,
    _runtime_python,
    _start_job,
    _validate_input_path,
)
from .runtime import (
    RUNTIME_DISCOVERY_TIMEOUT_SECS,
    RuntimeBootstrapError,
    _clean_env,
    _subprocess_startup_kwargs,
)

router = APIRouter(prefix="/sdm", tags=["sdm"])
logger = logging.getLogger(__name__)

SDM_PACKAGES = os.environ.get(
    "GEOLIBRE_SDM_PACKAGES",
    "elapid>=1.0 geopandas>=1.0 rasterio>=1.3.0 scikit-learn>=1.3 numpy>=1.24",
).split()

SAMPLE_BASE = "https://earth-chris.github.io/images/research"
SAMPLE_VECTOR = "ariolimax-buttoni.gpkg"
SAMPLE_RASTERS = [
    "ca-cloudcover-mean.tif",
    "ca-cloudcover-stdv.tif",
    "ca-leafareaindex-mean.tif",
    "ca-leafareaindex-stdv.tif",
    "ca-surfacetemp-mean.tif",
    "ca-surfacetemp-stdv.tif",
]

_JOB_FILES = {"suitability.tif", "presence.geojson", "summary.json"}


class SdmRequest(BaseModel):
    """One Maxent run."""

    use_sample: bool = False
    # Occurrence points as a GeoJSON FeatureCollection (WGS84), or a local file.
    occurrence_geojson: dict[str, Any] | None = None
    occurrence_path: str | None = None
    raster_paths: list[str] = Field(default_factory=list)
    background_count: int = Field(10_000, ge=100, le=200_000)
    beta_multiplier: float = Field(2.0, gt=0, le=20)
    transform: Literal["cloglog", "logistic", "raw", "exponential"] = "cloglog"
    feature_types: list[Literal["linear", "quadratic", "hinge", "product", "threshold"]] = Field(
        default_factory=lambda: ["linear", "hinge", "product"]
    )
    test_fraction: float = Field(0.25, ge=0, lt=0.9)


_SCRIPT = r"""
import json
import os
import sys
import time
import urllib.request
import warnings

warnings.filterwarnings("ignore")
params = json.loads(sys.argv[1])
out_dir = params["out_dir"]
started = time.time()

import numpy as np
import geopandas as gpd
import rasterio
import elapid as ela
from sklearn import metrics
from sklearn.model_selection import train_test_split

def log(message):
    print(message, flush=True)

if params.get("use_sample"):
    base = params["sample_base"]
    data_dir = os.path.join(out_dir, "sample")
    os.makedirs(data_dir, exist_ok=True)
    names = [params["sample_vector"], *params["sample_rasters"]]
    for index, name in enumerate(names, 1):
        target = os.path.join(data_dir, name)
        if not os.path.exists(target):
            log(f"Downloading sample data {index}/{len(names)}: {name}")
            urllib.request.urlretrieve(f"{base}/{name}", target)
    occurrence_path = os.path.join(data_dir, params["sample_vector"])
    rasters = [os.path.join(data_dir, name) for name in params["sample_rasters"]]
else:
    occurrence_path = params.get("occurrence_path")
    rasters = params["raster_paths"]
if not rasters:
    raise SystemExit("Add at least one covariate raster (GeoTIFF).")

labels = [os.path.splitext(os.path.basename(path))[0] for path in rasters]
with rasterio.open(rasters[0]) as src:
    raster_crs = src.crs

if occurrence_path:
    presence = gpd.read_file(occurrence_path)
else:
    presence = gpd.GeoDataFrame.from_features(params["occurrence_geojson"]["features"], crs="EPSG:4326")
presence = presence[presence.geometry.notna()]
presence = presence[presence.geometry.geom_type == "Point"]
if presence.crs is None:
    presence = presence.set_crs("EPSG:4326")
presence = presence.to_crs(raster_crs)[["geometry"]]
log(f"Presence points: {len(presence)}")
if len(presence) < 5:
    raise SystemExit("At least 5 occurrence points are needed.")

log(f"Sampling {params['background_count']} background points")
background = ela.sample_raster(rasters[0], count=params["background_count"])
merged = ela.stack_geodataframes(presence, background, add_class_label=True)
log("Extracting covariate values (annotate)")
annotated = ela.annotate(merged, rasters, labels=labels, drop_na=True, quiet=True)
x = annotated.drop(columns=["class", "geometry"])
y = annotated["class"]
log(f"Training table: {int(y.sum())} presences, {int((y == 0).sum())} background")

model_kwargs = dict(
    transform=params["transform"],
    beta_multiplier=params["beta_multiplier"],
    feature_types=params["feature_types"],
)
test_auc = None
if params["test_fraction"] > 0:
    x_train, x_test, y_train, y_test = train_test_split(
        x, y, test_size=params["test_fraction"], stratify=y, random_state=42
    )
    holdout = ela.MaxentModel(**model_kwargs)
    holdout.fit(x_train, y_train)
    test_auc = float(metrics.roc_auc_score(y_test, holdout.predict(x_test)))
    log(f"Test AUC: {test_auc:.3f}")

log("Fitting Maxent on all points")
model = ela.MaxentModel(**model_kwargs)
model.fit(x, y)
train_auc = float(metrics.roc_auc_score(y, model.predict(x)))
log(f"Training AUC: {train_auc:.3f}")

# Response curves: vary one covariate across its range, the others at their mean.
curves = {}
means = x.mean()
for label in x.columns:
    grid = np.linspace(float(x[label].quantile(0.01)), float(x[label].quantile(0.99)), 40)
    frame = np.tile(means.values, (len(grid), 1))
    column = list(x.columns).index(label)
    frame[:, column] = grid
    import pandas as pd
    pred = model.predict(pd.DataFrame(frame, columns=x.columns))
    curves[label] = {"x": grid.round(6).tolist(), "y": np.asarray(pred).round(5).tolist()}

out_path = os.path.join(out_dir, "suitability.tif")
log("Mapping habitat suitability")
ela.apply_model_to_rasters(model, rasters, out_path, quiet=True)

presence.to_crs("EPSG:4326").to_file(os.path.join(out_dir, "presence.geojson"), driver="GeoJSON")
summary = {
    "train_auc": round(train_auc, 4),
    "test_auc": None if test_auc is None else round(test_auc, 4),
    "presences": int(y.sum()),
    "background": int((y == 0).sum()),
    "covariates": list(x.columns),
    "raster_paths": rasters,
    "curves": curves,
    "seconds": round(time.time() - started, 1),
}
with open(os.path.join(out_dir, "summary.json"), "w") as handle:
    json.dump(summary, handle)
log(f"Done in {summary['seconds']} s")
print("{marker}" + json.dumps({"suitability_path": out_path, **{k: v for k, v in summary.items() if k != 'curves'}}))
""".replace("{marker}", _RESULT_MARKER)


def _check_sdm_import(python: str) -> bool:
    """Whether the runtime imports elapid and its geospatial stack."""
    try:
        completed = subprocess.run(
            [python, "-c", "import elapid, geopandas, rasterio, sklearn"],
            check=False,
            capture_output=True,
            text=True,
            env=_clean_env(),
            timeout=RUNTIME_DISCOVERY_TIMEOUT_SECS,
            **_subprocess_startup_kwargs(),
        )
    except subprocess.TimeoutExpired:
        return False
    return completed.returncode == 0


def _ensure_sdm_runtime() -> str:
    """Return the runtime Python, installing elapid into it if missing."""
    python = _runtime_python()
    if _check_sdm_import(python):
        return python
    with _RUNTIME_SETUP_LOCK:
        if _check_sdm_import(python):
            return python
        from .runtime import _uv_executable

        completed = subprocess.run(
            [_uv_executable(), "pip", "install", "--python", python, *SDM_PACKAGES],
            check=False,
            capture_output=True,
            text=True,
            env=_clean_env(),
            timeout=1800,
            **_subprocess_startup_kwargs(),
        )
        if completed.returncode != 0 or not _check_sdm_import(python):
            detail = (completed.stderr or completed.stdout or "").strip()[-500:]
            raise RuntimeBootstrapError(f"Could not install elapid: {detail}")
    return python


_JOB_DIRS: dict[str, str] = {}
_JOB_DIRS_LOCK = threading.Lock()
_BASE_DIR: str | None = None


def _new_job_dir() -> str:
    global _BASE_DIR
    if _BASE_DIR is None or not Path(_BASE_DIR).is_dir():
        _BASE_DIR = tempfile.mkdtemp(prefix="geolibre-sdm-")
    return tempfile.mkdtemp(prefix="job-", dir=_BASE_DIR)


_INSTALL_LOCK = threading.Lock()
_INSTALL_THREAD: threading.Thread | None = None
_INSTALL_ERROR: str | None = None
_INSTALL_FAILED_AT = 0.0
INSTALL_RETRY_SECS = 300


def _start_install() -> None:
    global _INSTALL_THREAD

    def install() -> None:
        global _INSTALL_ERROR, _INSTALL_FAILED_AT
        try:
            _ensure_sdm_runtime()
            _INSTALL_ERROR = None
        except Exception as exc:  # noqa: BLE001 - reported through /status
            logger.warning("SDM runtime install failed: %s", exc)
            _INSTALL_ERROR = "Could not install elapid. Check the sidecar logs."
            _INSTALL_FAILED_AT = time.time()

    with _INSTALL_LOCK:
        if _INSTALL_THREAD is not None and _INSTALL_THREAD.is_alive():
            return
        _INSTALL_THREAD = threading.Thread(target=install, daemon=True)
        _INSTALL_THREAD.start()


@router.get("/status")
def sdm_status():
    """Whether elapid is ready; starts its install in the background if not."""
    try:
        if _check_sdm_import(_runtime_python()):
            return {"available": True, "message": "elapid is ready."}
    except RuntimeBootstrapError as exc:
        logger.warning("SDM runtime unavailable: %s", exc)
        return {"available": False, "message": "The Python runtime is unavailable."}
    running = _INSTALL_THREAD is not None and _INSTALL_THREAD.is_alive()
    if _INSTALL_ERROR and not running and time.time() - _INSTALL_FAILED_AT < INSTALL_RETRY_SECS:
        return {"available": False, "message": _INSTALL_ERROR}
    _start_install()
    return {
        "available": False,
        "installing": True,
        "message": "Installing elapid, geopandas, rasterio and scikit-learn (first use only, a few minutes).",
    }


@router.post("/run")
def sdm_run(request: SdmRequest):
    """Fit Maxent and map suitability as a background job."""
    if not request.use_sample:
        if not request.raster_paths:
            raise HTTPException(status_code=400, detail="Add at least one covariate raster")
        if request.occurrence_geojson is None and not request.occurrence_path:
            raise HTTPException(status_code=400, detail="Choose the occurrence points")
    try:
        _ensure_sdm_runtime()
    except RuntimeBootstrapError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    params = request.model_dump()
    if not request.use_sample:
        params["raster_paths"] = [_validate_input_path(path) for path in request.raster_paths]
        if request.occurrence_path:
            params["occurrence_path"] = _validate_input_path(request.occurrence_path)
    out_dir = _new_job_dir()
    params.update(
        out_dir=out_dir,
        sample_base=SAMPLE_BASE,
        sample_vector=SAMPLE_VECTOR,
        sample_rasters=SAMPLE_RASTERS,
    )
    try:
        job = _start_job("sdm-maxent", _SCRIPT, params, "suitability")
    except BaseException:
        shutil.rmtree(out_dir, ignore_errors=True)
        raise
    with _JOB_DIRS_LOCK:
        _JOB_DIRS[job.id] = out_dir
    return job


@router.get("/jobs/{job_id}/files/{name}")
def sdm_job_file(job_id: str, name: str):
    """Download one result file of an SDM job."""
    if name not in _JOB_FILES:
        raise HTTPException(status_code=404, detail="No such result file")
    with _JOB_DIRS_LOCK:
        folder = _JOB_DIRS.get(job_id)
    path = Path(folder) / name if folder else None
    if path is None or not path.is_file():
        raise HTTPException(status_code=404, detail="Result not found")
    media = {".tif": "image/tiff", ".geojson": "application/geo+json", ".json": "application/json"}
    return FileResponse(path, media_type=media[path.suffix])


@router.post("/jobs/{job_id}/cancel")
def sdm_cancel(job_id: str):
    """Stop a running SDM job."""
    with _JOB_DIRS_LOCK:
        known = job_id in _JOB_DIRS
    if not known or _job_state(job_id) is None:
        raise HTTPException(status_code=404, detail="Job not found")
    _cancel_job(job_id)
    return _job_state(job_id)
