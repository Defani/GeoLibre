import { useEffect } from "react";
import { useAppStore } from "@geolibre/core";
import {
  closeRightPanel,
  openRightPanel,
  registerRightPanel,
} from "@geolibre/plugins/right-panel-registry";
import i18n from "../i18n";

/** Stable id of the SQL Workspace right panel (Defani edition). */
export const SQL_PANEL_ID = "sql-workspace";

/**
 * Register the SQL Workspace as a dockable panel on the left of the map (SQL
 * left, map right), so it opens beside the map instead of the bottom dock. Every existing entry point
 * (Processing menu, command palette, the layer menu's "Query with SQL") still
 * flips `ui.sqlWorkspaceOpen`; this hook turns that flag into opening the panel
 * and clears it again, so the bottom dock never mounts. The React body is
 * portalled into a dedicated host by the shell, so `render` is a no-op.
 */
export function useRegisterSqlPanel(): void {
  useEffect(
    () =>
      registerRightPanel({
        id: SQL_PANEL_ID,
        title: () => i18n.t("toolbar.sqlWorkspace.title"),
        dock: "left-of-layers",
        defaultWidth: 640,
        render: () => {},
      }),
    [],
  );
  const open = useAppStore((s) => s.ui.sqlWorkspaceOpen);
  useEffect(() => {
    if (!open) return;
    openRightPanel(SQL_PANEL_ID);
    useAppStore.getState().setSqlWorkspaceOpen(false);
  }, [open]);
}

/** Close the SQL Workspace sidebar panel. */
export function closeSqlPanel(): void {
  closeRightPanel(SQL_PANEL_ID);
}
