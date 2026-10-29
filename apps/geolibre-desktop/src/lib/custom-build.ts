// Personal build tweaks (Defani edition). Kept in one module so each change to
// upstream behaviour is easy to find when merging new GeoLibre releases.

/**
 * The Whitebox toolbox is removed from this build: its menu entries, category
 * submenus and command-palette rows are hidden. Tools that merely run through the
 * same dialog (for example Download Global DEM under GeoLibre Toolbox, Raster)
 * keep working.
 */
export const WHITEBOX_REMOVED = true;

/** The Processing toolbar button opens the sidebar Processing Toolbox. */
export const PROCESSING_TOOLBOX_REPLACES_MENU = true;

/** Whether a Processing menu-item id belongs to the removed Whitebox toolbox. */
export function isRemovedMenuItem(itemId: string): boolean {
  return WHITEBOX_REMOVED && (itemId === "processing.whitebox" || itemId.startsWith("processing.whitebox."));
}

/** Whether a command-palette command id belongs to the removed Whitebox toolbox. */
export function isRemovedCommand(id: string): boolean {
  return WHITEBOX_REMOVED && (id === "proc.whitebox" || id.startsWith("proc.whitebox."));
}
