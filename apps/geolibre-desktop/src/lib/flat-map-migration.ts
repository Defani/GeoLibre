// One-time switch from the old globe default (Defani edition). A project the
// old GeoLibre build restored on startup still carries `projection: "globe"`;
// on the first launch after the update it is turned into the flat map once.
// Later choices (the 3D / globe buttons, a saved globe project) are kept.

import { useAppStore } from "@geolibre/core";
import { useEffect } from "react";

const KEY = "the-funny-gis:flat-project-v1";

export function useFlatMapMigration(): void {
  useEffect(() => {
    try {
      if (localStorage.getItem(KEY) === "1") return;
    } catch {
      return;
    }
    // After the startup project has been restored.
    const timer = window.setTimeout(() => {
      const s = useAppStore.getState();
      if (s.preferences.map.projection === "globe") {
        s.setPreferences({ ...s.preferences, map: { ...s.preferences.map, projection: "mercator" } });
      }
      try {
        localStorage.setItem(KEY, "1");
      } catch {
        // ignore
      }
    }, 4000);
    return () => window.clearTimeout(timer);
  }, []);
}
