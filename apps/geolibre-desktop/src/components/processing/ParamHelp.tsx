import { useCallback, useState, type ReactNode, type SyntheticEvent } from "react";

export interface ParamHelpEntry {
  label: string;
  text: string;
}

/**
 * Context help like ArcGIS / QGIS tool help (Defani edition): instead of a
 * description under every field, the help pane explains the field the pointer
 * or the keyboard focus is on. A field explains itself through a `data-help`
 * attribute (with `data-help-label`), or through the `.param-desc` paragraph
 * that ParameterField renders (hidden inside help-paned forms by index.css).
 */
export function useParamHelp() {
  const [help, setHelp] = useState<ParamHelpEntry | null>(null);
  const pick = useCallback((event: SyntheticEvent<HTMLElement>) => {
    const root = event.currentTarget;
    let el = event.target as HTMLElement | null;
    while (el && el !== root) {
      const own = el.getAttribute?.("data-help");
      if (own) {
        setHelp({ label: el.getAttribute("data-help-label") ?? "", text: own });
        return;
      }
      const descs = el.querySelectorAll?.(".param-desc");
      if (descs && descs.length === 1) {
        const label = el.querySelector("label")?.textContent?.replace(/\s*\*$/, "").trim() ?? "";
        setHelp({ label, text: descs[0].textContent ?? "" });
        return;
      }
      if (descs && descs.length > 1) return;
      el = el.parentElement;
    }
  }, []);
  return {
    help,
    reset: () => setHelp(null),
    handlers: { onMouseOverCapture: pick, onFocusCapture: pick },
  };
}

/** The help pane: the tool's description, then the current field's help. */
export function ParamHelpPane({
  title,
  description,
  help,
  className = "",
}: {
  title: string;
  description: ReactNode;
  help: ParamHelpEntry | null;
  className?: string;
}) {
  return (
    <aside className={`overflow-auto bg-muted/40 p-3 text-xs leading-relaxed ${className}`} aria-live="polite">
      <h3 className="mb-1.5 text-sm font-semibold">{title}</h3>
      <div className="text-muted-foreground">{description}</div>
      {help ? (
        <div className="mt-3 border-t pt-2">
          {help.label ? <h4 className="mb-1 font-semibold text-foreground">{help.label}</h4> : null}
          <p className="text-muted-foreground">{help.text}</p>
        </div>
      ) : (
        <p className="mt-3 border-t pt-2 italic text-muted-foreground/80">
          Point at or click a parameter to see its help here.
        </p>
      )}
    </aside>
  );
}
