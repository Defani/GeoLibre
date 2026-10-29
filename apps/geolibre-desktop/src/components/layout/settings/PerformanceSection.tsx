import { Cpu, Gauge, Layers } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { isTauri } from "../../../lib/tauri-io";
import {
  graphicsAdapter,
  webglInfo,
  usePerformanceSettings,
  type RenderQuality,
  type VectorSimplify,
} from "../../../lib/performance-settings";

type GpuPreference = "high" | "low" | "auto" | "software";

function Choice<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ id: T; label: string; detail: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="grid gap-1.5">
      {options.map((option) => (
        <label
          key={option.id}
          className={`flex cursor-pointer items-start gap-2 rounded-md border p-2 hover:bg-accent/50 ${
            value === option.id ? "border-primary/50 bg-primary/5" : ""
          }`}
        >
          <input
            type="radio"
            className="mt-0.5"
            checked={value === option.id}
            onChange={() => onChange(option.id)}
          />
          <span>
            <span className="block text-sm font-medium">{option.label}</span>
            <span className="block text-xs text-muted-foreground">{option.detail}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

function Group({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        {icon}
        {title}
      </h3>
      {children}
    </section>
  );
}

/** Settings › Performance (Defani edition). */
export function PerformanceSection() {
  const { renderQuality, vectorSimplify, update } = usePerformanceSettings();
  const adapter = useMemo(graphicsAdapter, []);
  const gl = useMemo(webglInfo, []);
  const discrete = /nvidia|geforce|rtx|gtx|radeon rx|quadro|arc a/i.test(adapter);
  const [gpu, setGpu] = useState<GpuPreference | null>(null);
  const [gpuSaved, setGpuSaved] = useState(false);
  useEffect(() => {
    if (!isTauri()) return;
    void import("@tauri-apps/api/core").then(({ invoke }) => invoke<GpuPreference>("get_gpu_preference")).then(setGpu).catch(() => setGpu("high"));
  }, []);
  const chooseGpu = async (value: GpuPreference) => {
    setGpu(value);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("set_gpu_preference", { preference: value });
      setGpuSaved(true);
    } catch (error) {
      console.error("[GeoLibre] Could not save the GPU preference", error);
    }
  };
  return (
    <div className="space-y-6">
      <Group icon={<Cpu className="h-4 w-4 text-[#2f7fd6]" />} title="Graphics">
        <div className="rounded-md border bg-muted/40 p-3 text-sm">
          <div className="text-xs text-muted-foreground">The map is drawn with</div>
          <div className="font-medium">{adapter}</div>
          <p className="mt-1 text-xs text-muted-foreground">
            {discrete
              ? "The high-performance graphics card is in use."
              : "The desktop app asks Windows for the high-performance GPU; if this shows the integrated GPU, set The Funny GIS to “High performance” in Windows Settings › System › Display › Graphics."}
          </p>
          <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
            <div><span className="text-muted-foreground">WebGL</span><div className="font-medium">{gl.version}</div></div>
            <div><span className="text-muted-foreground">Max texture</span><div className="font-medium">{gl.maxTexture}</div></div>
            <div><span className="text-muted-foreground">Screen density</span><div className="font-medium">{(window.devicePixelRatio || 1).toFixed(2)}×</div></div>
          </div>
        </div>
        {gpu ? (
          <>
            <Choice<GpuPreference>
              value={gpu}
              onChange={(value) => void chooseGpu(value)}
              options={[
                { id: "high", label: "High-performance GPU (recommended)", detail: "Uses the dedicated graphics card (NVIDIA / AMD) for the map, 3D and large layers." },
                { id: "low", label: "Power saving", detail: "Uses the integrated GPU. Cooler and longer battery life, slower with heavy layers." },
                { id: "auto", label: "Let Windows decide", detail: "Follows Windows Settings › System › Display › Graphics." },
                { id: "software", label: "No GPU (compatibility)", detail: "Draws without hardware acceleration. Only if the map stays blank or flickers." },
              ]}
            />
            {gpuSaved ? <p className="text-xs font-medium text-[#ef7d22]">Saved. Restart The Funny GIS to switch the graphics adapter.</p> : null}
          </>
        ) : null}
      </Group>

      <Group icon={<Gauge className="h-4 w-4 text-[#3ea044]" />} title="Map rendering">
        <Choice<RenderQuality>
          value={renderQuality}
          onChange={(value) => update({ renderQuality: value })}
          options={[
            { id: "auto", label: "Sharp (automatic)", detail: "Full screen density. Best looking, heaviest on high-DPI screens." },
            { id: "balanced", label: "Balanced", detail: "Caps the density at 1.5×: nearly as sharp, noticeably smoother on 4K / 200% screens." },
            { id: "fast", label: "Fast", detail: "Draws at 1×. Smoothest panning and zooming for heavy layers." },
          ]}
        />
      </Group>

      <Group icon={<Layers className="h-4 w-4 text-[#ef7d22]" />} title="Large vector files">
        <Choice<VectorSimplify>
          value={vectorSimplify}
          onChange={(value) => update({ vectorSimplify: value })}
          options={[
            { id: "auto", label: "Simplify heavy files (recommended)", detail: "Files from 40 MB are simplified while loading (~5–50 m), like QGIS's render simplification. A 435 MB boundary shapefile opens in seconds." },
            { id: "strong", label: "Simplify more", detail: "From 10 MB, coarser (~30–100 m). For national overviews on modest laptops." },
            { id: "off", label: "Full detail", detail: "Every vertex is loaded. Use for precise analysis; large files load slowly." },
          ]}
        />
      </Group>
    </div>
  );
}
