// Settings › Performance (Defani edition): device-local speed choices, kept in
// localStorage and applied live where the engine allows it.

import { create } from "zustand";

export type RenderQuality = "auto" | "balanced" | "fast";
export type VectorSimplify = "auto" | "off" | "strong";

export interface PerformanceSettings {
  /** Map pixel ratio: full screen density, capped at 1.5, or 1. */
  renderQuality: RenderQuality;
  /** Simplify heavy vector files while they load (desktop). */
  vectorSimplify: VectorSimplify;
}

const KEY = "the-funny-gis:performance";
const DEFAULTS: PerformanceSettings = { renderQuality: "auto", vectorSimplify: "auto" };

function load(): PerformanceSettings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<PerformanceSettings>) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

export const usePerformanceSettings = create<
  PerformanceSettings & { update: (patch: Partial<PerformanceSettings>) => void }
>((set, get) => ({
  ...load(),
  update: (patch) => {
    set(patch);
    try {
      const { renderQuality, vectorSimplify } = get();
      localStorage.setItem(KEY, JSON.stringify({ renderQuality, vectorSimplify }));
    } catch {
      // Private mode: the choice lasts for this session.
    }
  },
}));

export function getPerformanceSettings(): PerformanceSettings {
  return usePerformanceSettings.getState();
}

/**
 * Simplification tolerance (degrees) for a vector file of `bytes`, or null to
 * load it at full detail — the same thresholds as the native loader.
 */
export function simplifyToleranceFor(bytes: number, mode: VectorSimplify = getPerformanceSettings().vectorSimplify): number | null {
  const MB = 1024 * 1024;
  if (mode === "off") return null;
  if (mode === "strong") return bytes >= 100 * MB ? 0.001 : bytes >= 10 * MB ? 0.0003 : null;
  if (bytes >= 300 * MB) return 0.0005;
  if (bytes >= 100 * MB) return 0.0002;
  if (bytes >= 40 * MB) return 0.00005;
  return null;
}

/** The map pixel ratio a render quality asks for on this screen. */
export function pixelRatioFor(quality: RenderQuality): number {
  const device = window.devicePixelRatio || 1;
  if (quality === "fast") return 1;
  if (quality === "balanced") return Math.min(device, 1.5);
  return device;
}

/** The graphics adapter WebGL draws the map with (e.g. "NVIDIA GeForce ..."). */
export function graphicsAdapter(): string {
  try {
    const canvas = document.createElement("canvas");
    const gl = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as WebGLRenderingContext | null;
    if (!gl) return "WebGL unavailable";
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    return String(renderer)
      .replace(/^ANGLE \((.*)\)$/, "$1")
      .replace(/,?\s*Direct3D.*$/i, "")
      .trim();
  } catch {
    return "Unknown";
  }
}

/** WebGL version and the largest texture the GPU accepts. */
export function webglInfo(): { version: string; maxTexture: string } {
  try {
    const canvas = document.createElement("canvas");
    const gl2 = canvas.getContext("webgl2");
    const gl = (gl2 ?? canvas.getContext("webgl")) as WebGLRenderingContext | null;
    if (!gl) return { version: "unavailable", maxTexture: "-" };
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    return { version: gl2 ? "2.0" : "1.0", maxTexture: `${max} px` };
  } catch {
    return { version: "unknown", maxTexture: "-" };
  }
}
