// ArcGIS Pro-style toolbar icons (Defani edition). Original artwork in the
// two-tone ribbon style: a dark outline that follows the theme (currentColor)
// with flat colour accents, drawn on a 24 px grid.
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { className?: string };

const base = (props: IconProps) => ({
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinejoin: "round" as const,
  strokeLinecap: "round" as const,
  "aria-hidden": true,
  ...props,
});

const BLUE = "#2f7fd6";
const LIGHT_BLUE = "#9cc8f2";
const GREEN = "#3ea044";
const YELLOW = "#f2b630";
const ORANGE = "#ef7d22";
const RED = "#d64545";
const GRAY = "#8b95a3";

/** Project: a manila folder with a map sheet. */
export function ProProjectIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M2.5 6.5V18a1.5 1.5 0 0 0 1.5 1.5h16a1.5 1.5 0 0 0 1.5-1.5V8.5A1.5 1.5 0 0 0 20 7h-8.2L9.6 4.5H4A1.5 1.5 0 0 0 2.5 6Z" fill={YELLOW} />
      <path d="M6 11.5l3.5-1.5 4 1.5 4-1.5V17l-4 1.5-4-1.5L6 18.5Z" fill="#fff" />
      <path d="M9.5 10v7M13.5 11.5v7" stroke={BLUE} />
    </svg>
  );
}

/** Edit: a pencil over a blue polygon with vertices. */
export function ProEditIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M3 20.5l2-8 7-3 3 7-6 4Z" fill={LIGHT_BLUE} stroke={BLUE} />
      {[[3, 20.5], [5, 12.5], [12, 9.5], [15, 16.5], [9, 20.5]].map(([x, y]) => (
        <rect key={`${x}-${y}`} x={x - 1} y={y - 1} width="2" height="2" fill="#fff" stroke={BLUE} strokeWidth="0.9" />
      ))}
      <path d="M14.5 13.5 20.8 7.2a1.6 1.6 0 0 0 0-2.3l-.2-.2a1.6 1.6 0 0 0-2.3 0L12 11Z" fill={YELLOW} />
      <path d="M12 11l-.8 3.3 3.3-.8" fill={ORANGE} />
    </svg>
  );
}

/** View: a window showing a map and an eye. */
export function ProViewIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="2.5" y="4" width="19" height="15" rx="1.5" fill="#fff" />
      <path d="M2.5 7.5h19" />
      <path d="M4.5 17l4-5 3 3 2.5-3 5.5 5Z" fill={GREEN} stroke={GREEN} />
      <circle cx="16.5" cy="10.5" r="1.4" fill={YELLOW} stroke="none" />
      <circle cx="4.5" cy="5.8" r="0.6" fill={RED} stroke="none" />
    </svg>
  );
}

/** Add Data: stacked layers with a green plus. */
export function ProAddDataIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M11 4.5 2.5 9 11 13.5 19.5 9Z" fill={LIGHT_BLUE} stroke={BLUE} />
      <path d="M2.5 12.5 11 17l3.2-1.7M2.5 16 11 20.5l2.8-1.5" stroke={BLUE} />
      <circle cx="18.5" cy="17.5" r="4" fill={GREEN} stroke="none" />
      <path d="M18.5 15.3v4.4M16.3 17.5h4.4" stroke="#fff" strokeWidth="1.6" />
    </svg>
  );
}

/** Processing: the red geoprocessing toolbox. */
export function ProProcessingIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7" />
      <rect x="2.5" y="7" width="19" height="13" rx="1.5" fill={RED} stroke="currentColor" />
      <path d="M2.5 12h19" stroke="#fff" />
      <rect x="10" y="10.5" width="4" height="3" rx="0.6" fill={YELLOW} stroke="currentColor" />
    </svg>
  );
}

/** Controls: sliders with coloured knobs. */
export function ProControlsIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M3 6h18M3 12h18M3 18h18" stroke={GRAY} />
      <circle cx="8" cy="6" r="2.2" fill={BLUE} />
      <circle cx="15.5" cy="12" r="2.2" fill={GREEN} />
      <circle cx="10.5" cy="18" r="2.2" fill={ORANGE} />
    </svg>
  );
}

/** Plugins: a green puzzle piece. */
export function ProPluginsIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path
        d="M4 8.5h3.2a2.3 2.3 0 1 1 4.6 0H15v3.3a2.3 2.3 0 1 1 0 4.6V20H4v-3.6a2.3 2.3 0 1 0 0-4.6Z"
        fill={GREEN}
      />
      <path d="M15 8.5h3.5V5" stroke={GRAY} />
    </svg>
  );
}

/** Settings: a gear with a blue hub. */
export function ProSettingsIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path
        d="M10.3 2.8h3.4l.5 2.4 1.7.9 2.3-.9 1.7 2.9-1.8 1.6v2l1.8 1.6-1.7 2.9-2.3-.9-1.7.9-.5 2.4h-3.4l-.5-2.4-1.7-.9-2.3.9-1.7-2.9 1.8-1.6v-2L3.7 8.1l1.7-2.9 2.3.9 1.7-.9Z"
        fill="#d9dee5"
      />
      <circle cx="12" cy="12" r="3" fill={BLUE} />
    </svg>
  );
}

/** Help: a blue circle with a question mark. */
export function ProHelpIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="9.5" fill={BLUE} stroke={BLUE} />
      <path d="M9.4 9.4a2.7 2.7 0 1 1 3.6 2.5c-.6.3-1 .8-1 1.5v.6" stroke="#fff" strokeWidth="1.8" />
      <circle cx="12" cy="17.2" r="1.1" fill="#fff" stroke="none" />
    </svg>
  );
}

/** Layout: a page with a map frame and a legend. */
export function ProLayoutIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="3.5" y="2.5" width="17" height="19" rx="1" fill="#fff" />
      <rect x="5.5" y="4.5" width="13" height="9" fill={LIGHT_BLUE} stroke={BLUE} />
      <path d="M6 13l3.5-4 2.5 2.5 2-2 4.5 3.5" stroke={GREEN} />
      <rect x="5.5" y="15.5" width="2" height="1.6" fill={ORANGE} stroke="none" />
      <path d="M9 16.3h5M5.5 19h9" stroke={GRAY} />
    </svg>
  );
}

/** Data View: a globe. */
export function ProGlobeIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="9.5" fill={LIGHT_BLUE} stroke={BLUE} />
      <path d="M7 6.5c2 1 1.5 3 3.5 3.5s2 2.5 1 4-1 3 .5 4.5M14.5 3.5c-.5 1.5.5 2.5 2 3s3 1 3.5 3M4 15c1.5-.5 3 0 3.5 1.5" stroke={GREEN} strokeWidth="1.8" />
    </svg>
  );
}
