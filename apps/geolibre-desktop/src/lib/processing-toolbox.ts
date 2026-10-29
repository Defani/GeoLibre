// Processing Toolbox (Defani edition): every Processing command in one
// searchable tree docked in the right sidebar, like QGIS's Processing Toolbox.
// The toolbar publishes its gated processing commands here; the panel reads
// them, so the toolbox runs exactly what the Processing menu and the command
// palette run (same deployment, privilege, profile and consent gates).

import { create } from "zustand";
import { openRightPanel } from "@geolibre/plugins/right-panel-registry";
import type { Command } from "./commands";

/** Stable id of the Processing Toolbox right panel. */
export const PROCESSING_TOOLBOX_PANEL_ID = "processing-toolbox";

/** Show and expand the Processing Toolbox in the sidebar. */
export function openProcessingToolbox(): void {
  openRightPanel(PROCESSING_TOOLBOX_PANEL_ID);
}

interface ToolboxState {
  commands: Command[];
  setCommands: (commands: Command[]) => void;
}

/** The processing commands the toolbar currently allows. */
export const useProcessingToolboxStore = create<ToolboxState>((set) => ({
  commands: [],
  setCommands: (commands) => set({ commands }),
}));

/** Top-level toolboxes, in ArcToolbox order (Defani edition). */
export const TOOLBOX_CATEGORIES = [
  { id: "3d", label: "3D Analyst Tools" },
  { id: "analysis", label: "Analysis Tools" },
  { id: "cartography", label: "Cartography Tools" },
  { id: "conversion", label: "Conversion Tools" },
  { id: "datamgmt", label: "Data Management Tools" },
  { id: "geocoding", label: "Geocoding Tools" },
  { id: "image", label: "Image Analyst Tools" },
  { id: "network", label: "Network Analyst Tools" },
  { id: "spacetime", label: "Space Time Pattern Mining Tools" },
  { id: "spatial", label: "Spatial Analyst Tools" },
  { id: "statistics", label: "Spatial Statistics Tools" },
  { id: "data", label: "Data Catalogs" },
  { id: "workspaces", label: "Workspaces and Scripting" },
] as const;

export type ToolboxCategoryId = (typeof TOOLBOX_CATEGORIES)[number]["id"];

type Placement = { category: ToolboxCategoryId; subgroup: string; name?: string };

/**
 * ArcToolbox placement per command id (without the `proc.` prefix): toolbox,
 * toolset and, where ArcGIS uses another name, the ArcGIS tool name.
 */
const ARC_PLACEMENT: Record<string, Placement> = {
  // Analysis Tools
  "vector.clip": { category: "analysis", subgroup: "Extract", name: "Clip" },
  "vector.select-by-value": { category: "analysis", subgroup: "Extract", name: "Select (by attribute)" },
  "vector.random-extract": { category: "analysis", subgroup: "Extract", name: "Random Select" },
  "vector.intersection": { category: "analysis", subgroup: "Overlay", name: "Intersect" },
  "vector.union": { category: "analysis", subgroup: "Overlay", name: "Union" },
  "vector.difference": { category: "analysis", subgroup: "Overlay", name: "Erase" },
  "vector.spatial-join": { category: "analysis", subgroup: "Overlay", name: "Spatial Join" },
  "vector.buffer": { category: "analysis", subgroup: "Proximity", name: "Buffer" },
  "vector.voronoi": { category: "analysis", subgroup: "Proximity", name: "Create Thiessen Polygons" },
  "vector.cell-sectors": { category: "analysis", subgroup: "Proximity", name: "Cell-site Coverage" },
  "vector.aggregate": { category: "analysis", subgroup: "Statistics", name: "Summary Statistics (by attribute)" },
  // Cartography Tools
  "vector.simplify": { category: "cartography", subgroup: "Generalization", name: "Simplify Polygon / Line" },
  "vector.smooth": { category: "cartography", subgroup: "Generalization", name: "Smooth Polygon / Line" },
  // Conversion Tools
  "raster.polygonize": { category: "conversion", subgroup: "From Raster", name: "Raster to Polygon" },
  "vector.decode-polyline": { category: "conversion", subgroup: "JSON and Polyline", name: "Polyline to Features" },
  "vector.encode-polyline": { category: "conversion", subgroup: "JSON and Polyline", name: "Features to Polyline" },
  // Data Management Tools
  "vector.reproject": { category: "datamgmt", subgroup: "Projections and Transformations", name: "Project" },
  "raster.reproject": { category: "datamgmt", subgroup: "Projections and Transformations", name: "Project Raster" },
  "raster.resample": { category: "datamgmt", subgroup: "Projections and Transformations", name: "Resample" },
  georeferencer: { category: "datamgmt", subgroup: "Projections and Transformations", name: "Georeference Raster" },
  "vector.merge-layers": { category: "datamgmt", subgroup: "General", name: "Merge" },
  "vector.attribute-join": { category: "datamgmt", subgroup: "Joins and Relates", name: "Join Field" },
  "vector.dissolve": { category: "datamgmt", subgroup: "Generalization", name: "Dissolve" },
  "vector.centroids": { category: "datamgmt", subgroup: "Features", name: "Feature To Point" },
  "vector.convex-hull": { category: "datamgmt", subgroup: "Features", name: "Minimum Bounding Geometry (Convex Hull)" },
  "vector.bounding-box": { category: "datamgmt", subgroup: "Features", name: "Minimum Bounding Geometry (Envelope)" },
  "vector.explode": { category: "datamgmt", subgroup: "Features", name: "Multipart To Singlepart" },
  "vector.extract-vertices": { category: "datamgmt", subgroup: "Features", name: "Feature Vertices To Points" },
  "vector.points-along-geometry": { category: "datamgmt", subgroup: "Features", name: "Generate Points Along Lines" },
  "vector.check-validity": { category: "datamgmt", subgroup: "Features", name: "Check Geometry" },
  "vector.fix-geometries": { category: "datamgmt", subgroup: "Features", name: "Repair Geometry" },
  "vector.check-topology-rules": { category: "datamgmt", subgroup: "Topology", name: "Validate Topology" },
  "vector.fix-topology": { category: "datamgmt", subgroup: "Topology", name: "Fix Topology Errors" },
  "vector.grid": { category: "datamgmt", subgroup: "Sampling", name: "Create Fishnet" },
  "vector.dggs-grid": { category: "datamgmt", subgroup: "Sampling", name: "Generate DGGS Grid" },
  "vector.dggs-bin": { category: "datamgmt", subgroup: "Sampling", name: "DGGS Binning" },
  "vector.dggs-compact": { category: "datamgmt", subgroup: "Sampling", name: "DGGS Compact" },
  "raster.mosaic": { category: "datamgmt", subgroup: "Raster", name: "Mosaic To New Raster" },
  "raster.composite": { category: "datamgmt", subgroup: "Raster", name: "Composite Bands" },
  "raster.clip-extent": { category: "datamgmt", subgroup: "Raster", name: "Clip Raster (by extent)" },
  // Spatial Analyst Tools
  "raster.hillshade": { category: "spatial", subgroup: "Surface", name: "Hillshade" },
  "raster.slope": { category: "spatial", subgroup: "Surface", name: "Slope" },
  "raster.aspect": { category: "spatial", subgroup: "Surface", name: "Aspect" },
  "raster.contour": { category: "spatial", subgroup: "Surface", name: "Contour" },
  "raster.reclassify": { category: "spatial", subgroup: "Reclass", name: "Reclassify" },
  "raster.raster-calc": { category: "spatial", subgroup: "Map Algebra", name: "Raster Calculator" },
  "raster.zonal": { category: "spatial", subgroup: "Zonal", name: "Zonal Statistics" },
  "raster.focal": { category: "spatial", subgroup: "Neighborhood", name: "Focal Statistics" },
  "raster.clip-mask": { category: "spatial", subgroup: "Extraction", name: "Extract by Mask" },
  "raster.interpolate": { category: "spatial", subgroup: "Interpolation", name: "IDW / Kriging" },
  "statistics.kernel-density": { category: "spatial", subgroup: "Density", name: "Kernel Density" },
  "raster.spectral-index": { category: "spatial", subgroup: "Map Algebra", name: "Band Index (NDVI, NBR, ...)" },
  "raster.classify": { category: "spatial", subgroup: "Segmentation and Classification", name: "Land Cover Classification (training samples)" },
  sdm: { category: "spatial", subgroup: "Species Distribution Modeling", name: "Maxent (elapid)" },
  inaturalist: { category: "data", subgroup: "Biodiversity", name: "iNaturalist Extractor" },
  kobo: { category: "data", subgroup: "Field Survey", name: "KoboToolbox (Kobo Connector)" },
  "ax.composite": { category: "datamgmt", subgroup: "Raster", name: "Composite Bands" },
  "ax.band-index": { category: "spatial", subgroup: "Map Algebra", name: "Band Index (NDVI, NDWI, NBR, SAVI, EVI)" },
  "ax.tabulate-area": { category: "spatial", subgroup: "Zonal", name: "Tabulate Area" },
  "ax.tabulate-intersection": { category: "analysis", subgroup: "Statistics", name: "Tabulate Intersection" },
  "ax.fragmentation": { category: "spatial", subgroup: "Landscape", name: "Landscape Fragmentation (FRAGSTATS)" },
  "ax.burn-severity": { category: "spatial", subgroup: "Fire", name: "Burn Severity (dNBR)" },
  "ax.carbon-stock": { category: "spatial", subgroup: "Carbon", name: "Carbon Stock & Emissions" },
  "ax.klhk-carbon": { category: "spatial", subgroup: "Carbon", name: "Cadangan Karbon — Modul KLHK (vektor)" },
  "ax.invest-carbon": { category: "spatial", subgroup: "Carbon", name: "Karbon InVEST — Perubahan & Valuasi" },
  "ax.carbon-plot": { category: "spatial", subgroup: "Carbon", name: "Karbon Plot Lapangan (Tier 3)" },
  "ax.trend": { category: "spatial", subgroup: "Time Series", name: "Trend (Mann-Kendall / Sen's slope)" },
  "ax.rf-classify": { category: "image", subgroup: "Classification", name: "Supervised Classification (Random Forest)" },
  "ax.accuracy": { category: "image", subgroup: "Classification", name: "Accuracy Assessment" },
  "ax.sampling": { category: "datamgmt", subgroup: "Sampling", name: "Sampling Design (random / grid / stratified)" },
  "ax.hydrology": { category: "spatial", subgroup: "Hydrology", name: "Fill, Flow Direction, Accumulation & Streams" },
  "ax.watershed": { category: "spatial", subgroup: "Hydrology", name: "Watershed" },
  "ax.viewshed": { category: "3d", subgroup: "Visibility", name: "Viewshed" },
  "ax.cut-fill": { category: "3d", subgroup: "Surface", name: "Cut Fill" },
  "ax.terrain-index": { category: "spatial", subgroup: "Surface", name: "Terrain Indices (TPI, TRI, Curvature, TWI)" },
  "ax.euclidean-distance": { category: "spatial", subgroup: "Distance", name: "Euclidean Distance" },
  "ax.cost-distance": { category: "spatial", subgroup: "Distance", name: "Cost Distance & Least-Cost Path" },
  "ax.near-table": { category: "analysis", subgroup: "Proximity", name: "Near Table" },
  "ax.firms": { category: "data", subgroup: "Fire", name: "Fire Hotspots (NASA FIRMS)" },
  "ax.s1-flood": { category: "data", subgroup: "Radar", name: "Flood Map (Sentinel-1)" },
  "zonal-table": { category: "spatial", subgroup: "Zonal", name: "Zonal Statistics to Attributes" },
  "change-detection": { category: "spatial", subgroup: "Change Detection", name: "Change Detection (difference / transition matrix)" },
  "data-indonesia": { category: "data", subgroup: "Indonesia", name: "Data Indonesia (boundaries, imagery, Sentinel-2)" },
  modelBuilder: { category: "workspaces", subgroup: "Workflows", name: "Model Builder" },
  batchTools: { category: "workspaces", subgroup: "Workflows", name: "Batch Processing" },
  // 3D Analyst Tools
  lineOfSight: { category: "3d", subgroup: "Visibility", name: "Line Of Sight" },
  // Space Time Pattern Mining Tools
  "vector.trajectory-speed": { category: "spacetime", subgroup: "Movement", name: "Trajectory Speed" },
  "vector.detect-stops": { category: "spacetime", subgroup: "Movement", name: "Detect Stops" },
  "vector.space-time-proximity": { category: "spacetime", subgroup: "Movement", name: "Space Time Proximity" },
  "statistics.emerging-hot-spot": { category: "spacetime", subgroup: "Space Time Cube", name: "Emerging Hot Spot Analysis" },
  // Image Analyst Tools
  segmentation: { category: "image", subgroup: "Deep Learning", name: "Segment (AI)" },
  objectDetection: { category: "image", subgroup: "Deep Learning", name: "Detect Objects" },
  segmentEverything: { category: "image", subgroup: "Deep Learning", name: "Segment Everything" },
  obiaWorkbench: { category: "image", subgroup: "Segmentation and Classification", name: "Object-Based Classification (OBIA)" },
  // Geocoding Tools
  geocode: { category: "geocoding", subgroup: "Geocoding", name: "Geocode Addresses" },
  // Data catalogs
  "planetary-computer": { category: "data", subgroup: "Catalogs" },
  "earth-engine": { category: "data", subgroup: "Catalogs" },
};

function placementKey(command: Command): string {
  return command.id.replace(/^proc\./, "");
}

/** Which toolbox and toolset a processing command belongs to. */
export function toolboxPlacement(command: Command): { category: ToolboxCategoryId; subgroup: string } {
  const key = placementKey(command);
  const arc = ARC_PLACEMENT[key];
  if (arc) return { category: arc.category, subgroup: arc.subgroup };
  if (key.startsWith("conversion.")) return { category: "conversion", subgroup: "To Other Formats" };
  if (key.startsWith("network.")) return { category: "network", subgroup: "Analysis" };
  if (key.startsWith("statistics.")) return { category: "statistics", subgroup: "Analyzing Patterns" };
  if (key.startsWith("vector.")) return { category: "analysis", subgroup: command.subgroup ?? "General" };
  if (key.startsWith("raster.")) return { category: "spatial", subgroup: "General" };
  return { category: "workspaces", subgroup: "Workspaces" };
}

/** The tool's ArcGIS name where it differs from GeoLibre's title. */
export function toolboxToolName(command: Command): string {
  return ARC_PLACEMENT[placementKey(command)]?.name ?? command.title;
}
