# GeoLibre Defani Edition: personal modifications

Personal build of GeoLibre (not for publishing). Status: [x] done, [~] in progress, [ ] to do.

## Done
- [x] Layout Composer canvas zooms with the plain mouse wheel (Shift + wheel scrolls sideways)
- [x] Whitebox toolbox removed from the Processing menu and the command palette (`src/lib/custom-build.ts`)
- [x] Default opacity 100 %: new vector layers, style presets, PMTiles and Zarr layers
- [x] 100 color palettes (20 built-in + 80: ColorBrewer, cmocean, Crameri, matplotlib, remote sensing)

- [x] Layout: Office-style ribbon under the top bar replaces the floating toolbar (text, shapes, map + grid, page, multi-select)
- [x] Layout text like Canva: a new text box is ready to type, double-click on the empty page types there, transparent inline editor, bullets/numbering, line and paragraph spacing
- [x] Layout: drag to draw map frames, insets, legends, color bars, shapes, scale bars, north arrows (click = default size)
- [x] Layout: Layers list reorders by drag (top row in front), like ArcGIS
- [x] Layout: legend option "Only show classes visible in the map frame" (updates when the frame moves)
- [x] QGIS-style vertical Manage Layers toolbar (one-click Add Vector/Raster/CSV/PostGIS/WMS/WFS/XYZ/...)
- [x] ArcToolbox look for the Processing Toolbox (red toolboxes, hammer tools, dotted tree)
- [x] Header: scale box 1:n, Geoprocessing menu (Buffer, Clip, Intersect, Union, Merge, Dissolve, ...), Editor menu; GeoLibre logo and project-name box removed
- [x] Digitizing toolbar docked in the header while editing (menus shrink to icons so it fits at 1366 px)
- [x] Contents (TOC) like ArcMap: thin rows, symbol patch, classes with show/hide checkboxes, drag to reorder (no arrows); docked on the right with the Browser
- [x] No floating controls on the Data View map; Layout View hides the Data View panels
- [x] Vector and raster tools open in a QGIS-style floating algorithm window (Parameters / Log tabs, help pane, progress bar)
- [x] Large shapefiles (40 MB+) are simplified while loading in the desktop app (435 MB kabupaten SHP: ~7 s, ~14 MB) — needs .exe build test
- [x] Layout View chrome matches GeoLibre (Contents + Element panes on the right, compact rows)
- [x] Attribute table: floating centred window (drag, resize from the corner, full page); Calculate gets X (longitude) / Y (latitude) in DD or DMS (`$x()`, `$y("dms")`)
- [x] Toolbox in ArcGIS toolboxes (Analysis, Cartography, Conversion, Data Management › Projections, Spatial Analyst › Surface / Reclass / Map Algebra / ..., Spatial Statistics, Network Analyst, ...) with ArcGIS tool names; renamed "Toolbox"
- [x] One icon-only dock rail on the right (Browser, Layers, Toolbox, AI, Comments, Style)
- [x] Processing notifications: running card with progress bar, finished / red error card
- [x] Context help pane in tool windows and docks (explains the field under the pointer) instead of inline descriptions
- [x] Species Distribution Modeling dock: Maxent with elapid in the sidecar Python (installed automatically on first use), elapid sample data, test AUC, response curves, suitability map — tested with the sample (test AUC 0.984)
- [x] Built in (no plugin system): iNaturalist Extractor (dock + Toolbox), Live MCP (header button), AI Assistant as a dock (no floating robot; Contents hides while it is open); Plugins menu removed
- [x] Header: Swipe button; flat Mercator map over Indonesia by default (3D pitch / terrain kept)
- [x] WebView2 prefers the high-performance GPU (GPU rasterization, zero-copy)
- [x] Help › Clear Cache (tiles, session data, optional project history)
- [x] Branding "The Funny GIS": round Earth-with-eyes logo (3 solid colours, ArcGIS Pro blue), app icons, floating startup splash with progress, start screen (new map / open / layout / recent projects)
- [x] Soft Figma-like dark mode; colour icons for menus, panels and the Layout Composer
- [x] Layout View: ArcGIS Pro-style ribbon in the header (File, History, Navigate, Map Frames, Map Surrounds, Graphics and Text, Data, Zoom, Panes, Share, Show: rulers / guides / grid / snap)
- [x] Earth Engine and AI Assistant as docks; Live MCP drives every menu (ui_click / ui_list / ui_type)
- [x] Raster Calculator like ArcMap (layers, keypad, Con / SetNull / Ln / ..., several rasters)
- [x] Settings › Performance (GPU in use, render quality, large-file simplification); QGIS Options-style category icons
- [x] Large shapefiles simplified on load in the WASM path too (the 435 MB SHP still needs the native DuckDB build: WASM runs out of memory)

## In progress
- [x] SQL Workspace opens in the right sidebar instead of the bottom dock (needs build test)
- [x] Processing Toolbox in the right sidebar: searchable tree, category icons; the Processing button opens it (needs build test)
- [x] Layout Composer built in: Data View / Layout View switch at the bottom-left of the map (needs build test)

## To do
1. Tool forms (buffer, clip, ...) open in the right sidebar instead of floating dialogs
2. Layers panel like the ArcMap Table of Contents: each layer shows its symbol and classes, Layer Styling panel beside it
3. Layer Styling panel like QGIS (renderer drop-down: Single symbol, Categorized, Graduated, Rule-based; class table; Classify)
4. Menu bar like QGIS (Project, Edit, View, Layer, Settings, Plugins, Vector, Raster, Processing, Help) with an icon toolbar row
5. Header toolbar like ArcMap: scale box 1:n, zoom/pan/identify/measure tools
6. Remove GeoLibre's old Print Layout entry points in favour of Layout View
7. Attribute table like ArcMap: Add Field, Calculate Geometry (area, length, x/y), Field Calculator, Start/Stop Editing
8. Digitizing like ArcMap / ArcGIS Pro: snapping, vertex editing, split, merge, reshape, cut, trace, copy parallel, rotate, scale
9. Apply ArcMap styles (.lyr via conversion, .lyrx, .style)
10. Aerialod-style terrain renderer: path-traced soft shadows + ambient occlusion from a DEM (light direction, sky, exaggeration), output usable in Layout View
12. Google Drive: sign in with a Google account, browse and open files
13. Open shapefiles as easily as QGIS: pick the .shp, sidecars (.dbf, .shx, .prj, .cpg) load automatically; Browser double-click
14. Professional UI and icon pass across menus and panels
15. Build the Windows desktop installer (.exe)

16. Layout Composer: colour icons in its menus
17. Branding: "The Funny GIS" logo, tagline "Personal GIS tool by Defani Arman", start screen with recent projects / new map
18. Colab-like notebook whose results appear as layers
19. Earth Engine as a mature native panel
20. Open ArcMap / QGIS projects and styles (.mxd, .style, .qgs/.qgz, .qml, .qmd)
21. Restyle the remaining generic dialogs (Settings, Add Data, Network / Statistics tools)
22. Land-cover classification with training samples drawn on the map; Composite Bands tool

## Deferred
- Instagram slides: Basic SQL DuckDB in GeoLibre (20 portrait PNG)

## ArcGIS Pro ribbon (Data View) — done
- Tabs: Map, Insert, Analysis, View, Edit, Imagery, Share, plus contextual Feature Layer (Data) / Raster Layer (Appearance) tabs (`components/layout/ProRibbon.tsx`).
- Map: Explore, Full Extent, Fixed Zoom, Previous/Next Extent, Bookmarks, Go To XY (DD/DMS), North Up; Select rectangle/polygon/lasso/circle (Shift adds), By Attributes, By Location, Clear, Zoom To Selection; Measure, Locate, Command Search; quick labeling.
- Insert: New Map, New Layout, Import, Notebook, point/line/polygon layer templates, map elements.
- Analysis: History, Tools, ModelBuilder, Python, Notebook, Batch, SQL, AI Assistant, tool gallery.
- View: Convert 2D/3D (terrain), Link Views, Windows (Contents, Catalog, Geoprocessing, Attributes, History), Reset Panes.
- Edit: Start/Save/Discard, Undo/Redo, Snapping, Create, Modify, Rotate, Scale, Split, Merge, Copy, Delete.
- Imagery: Band Combination (Composite Bands tool), Indices (Band Index tool), Raster Functions, Classification Wizard (RF), training samples, accuracy.
- Share: Export Map PNG/JPG/PDF/GeoTIFF (EPSG:3857), Project Package (.zip with data files).
- Feature Layer: transparency, visible zoom range, labeling, Definition Query (=, <>, >, <, IN, LIKE, AND/OR), Attribute Table, Joins, Export Features (SHP/GeoJSON/GPKG/KML/CSV/GeoParquet).
- Command registry (`lib/command-registry.ts`) shared by ribbon and Command Search.

## Ribbon only (no separate menu bar) — done
- The old top menu bar (Project, Edit, View, Add Data, Processing, Geoprocessing, Editor, Live MCP, Swipe, Controls, Settings, Help) is folded into the ribbon: every item sits in the relevant tab (Project tab: project/options/help; Insert: all Add Data sources; Analysis: all processing tools; View: controls, widgets, swipe, color vision; Edit: editor + data quality; Imagery: raster tools; Share: conversions).
- The menu bar still renders hidden (`lib/header-host.ts`) so its dialogs keep working; only the digitizing toolbar shows (end of the ribbon) while editing.
- Groups that do not fit fold right-to-left into drop-down buttons (ArcGIS Pro behaviour).
- Scale box and light/dark switch on the tab row.

## Digitizing tools — done (`lib/edit-tools.ts`, Edit tab)
Explode, Merge, Buffer, Generalize, Smooth, Densify, Flip Line, Remove Holes, Repair Geometry, Move By, Rotate By, Scale By, Parallel Copy, Clip Selected, Erase Selected, Line To Polygon, Polygon To Line, Feature To Point, Vertices To Points, Calculate Geometry (area_ha, perim_m/length_m, x, y), Create From XY, Copy To New Layer, Delete Selected. Results stay selected for chaining; Undo reverts each step.

## Vision (Defani, 2026-10-16)
A hybrid GIS: QGIS's data engine (GDAL, spatial indexes, processing), GeoLibre's GPU map and modern
formats, ArcMap / ArcGIS Pro workflow and UI, plus custom Indonesian forestry features. Used for real
future projects: as capable, efficient and pleasant as possible, UI included.

## Native vector tiles for huge files — in test
- `src-tauri/src/native_duckdb/tiles.rs`: one-time DuckDB cache (EPSG:3857 + R-tree + 1 km / 100 m
  simplified copies), tiles over `tfgtile://`, attribute query / GeoJSON export commands, registry
  with cleanup (caches of never-saved projects are deleted on the next start; saved ones capped at 30 GB).
- `lib/tiled-vector.ts`: files >= 50 MB open as tiles (Add Vector picker, drag-drop, Catalog), restore
  with projects, progress cards. Cache folder: D:\The Funny GIS\cache\vector.
- Prototype (kabupaten 435 MB): load 7.4 s, index 1.1 s, simplify 4 s, tiles 17-420 ms.

## Queue (asked by Defani)
1. Unsaved projects leave no cache: tile caches (done) + autosave snapshots of never-saved projects.
2. Bug sweep of every feature: nothing covered, every button works; errors auto-sent to the AI when MCP is connected.
3. UI to ArcGIS Pro everywhere, nothing that looks like GeoLibre:
   - Project tab as ArcGIS Pro's Project backstage (New, Open, Save, Recent, Package, Options, About The Funny GIS).
   - Layer right-click > Properties: ArcGIS-style window with a vertical tab bar (General, Source,
     Symbology, Labels, Definition Query, Fields, Joins, Display).
   - Full symbology (single, unique values, graduated colors / symbols, proportional, heatmap, rules, dot density).
   - Official logos for integrations (Google Earth Engine, DuckDB, Planetary Computer, Kobo, iNaturalist, ...). Mandatory.
   - Animated logo on the splash.
   - Drawing tools must feel light: the shape follows the cursor immediately while dragging.
4. Machine learning tools (classification / regression / clustering, model training and prediction).
5. Attribute table and identify for tile layers (query_tiled_vector).


## Progress 2026-10-16 (checkpoint build)
Done and tested:
- Native vector tiles for huge files: kabupaten 435 MB indexed in ~18 s, kecamatan 780 MB in 35 s (once); tiles 15-120 ms at every
  zoom (materialized-CTE query; the earlier subquery form took 69 s per tile). Drag-drop / Add Vector / Catalog open as tiles.
- Caches of never-saved projects deleted on the next start (verified).
- Fixed: window.confirm ACL error (native dialogs restored), striped GeoTIFF auto-converted to COG, autosave limit 10 -> 64 MB.
- Settings opened directly (was a hidden menu); Performance & GPU with GPU choice (high-performance / power saving / Windows / none).
- Layout ribbon Map Frame group: Activate, Fit All, Data View, zoom, prev/next, north up, lock scale, zoom to layer, scale 1:n.
- Project tab rebuilt like ArcGIS Pro (Recent, Output, Options, About The Funny GIS); GeoLibre leftovers removed.
- Animated splash logo. Right-click layer > Properties (vertical tabs: General, Source, Symbology, Advanced, Labels,
  Definition Query, Fields, Joins).
- ArcMap-style Symbology: Single / Unique Values (random or 200+ palettes, counts, add all, reverse, all-symbols bar) /
  Graduated (Jenks, equal, quantile, std dev, geometric, manual) / Proportional / Heat map / Clusters; Advanced keeps every option.
- Colour picker: 120-swatch palette, round wheel + brightness, HEX/RGB/HSV, recent colours, No Color.
- Symbol Selector with ~180 symbols (points, cartographic icons, line types incl. BIG/KLHK boundaries, fills, patterns,
  26 textures), SVG upload, font glyphs (Wingdings, ESRI fonts...), My symbols. Line dash + casing support.

Still queued (from Defani):
1. Start screen redesign (developer name, version, nicer).
2. Styles from MapBiomas Col 4.1 (legend extracted), KLHK 100 .lyr catalog, D: templates (QGIS XML, RDTR/RTRW, desa).
3. Layer catalog of government tile services by category: BMKG, SIGAP Kemenhut, Hansen, tata ruang (GISTARU), BPS, ...
4. Basemaps: BIG RBI as default, Mapzen Global Terrain; map effects (drop shadow, glow).
5. Layout: north arrow letter size/font; text along a drawn path and circular text.
6. Official logos for integrations (GEE, DuckDB, ...).
7. Drawing tools lighter (shape follows the cursor immediately).
8. Machine learning tools.
9. Errors auto-sent to the AI when MCP is connected.
10. Bug sweep: open/close windows (Esc closes two windows at once), everything clickable, nothing covered.
11. Attribute table and identify for tile layers (query_tiled_vector ready in Rust).
12. Blend modes: only normal/multiply/screen/lighten/add are safe in WebGL; more needs offscreen compositing.
