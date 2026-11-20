import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createExpression } from "@maplibre/maplibre-gl-style-spec";
import {
  DEFAULT_LAYER_STYLE,
  decorateLabelString,
  decorateLabelTextField,
  labelFieldTextField,
  type LabelStyle,
} from "../packages/core/src/index";

const base: LabelStyle = { ...DEFAULT_LAYER_STYLE.labels, field: "NAMOBJ" };

/** Evaluate a text-field the way MapLibre's symbol layer would. */
function render(textField: unknown, properties: Record<string, unknown>): string {
  const compiled = createExpression(
    textField as never,
    {
      type: "formatted",
      "property-type": "data-driven",
      expression: { parameters: ["zoom", "feature"] },
    } as never,
  );
  assert.equal(compiled.result, "success", JSON.stringify(compiled.value));
  const value = (compiled.value as { evaluate: (...args: unknown[]) => unknown }).evaluate(
    { zoom: 10 },
    { type: "Point", properties },
  );
  if (value && typeof value === "object" && "sections" in value) {
    return (value as { sections: Array<{ text: string }> }).sections.map((s) => s.text).join("");
  }
  return String(value ?? "");
}

describe("decorateLabelTextField", () => {
  it("leaves the text-field untouched without affixes", () => {
    const field = labelFieldTextField(base);
    assert.equal(decorateLabelTextField(field, base), field);
    assert.equal(decorateLabelTextField("", { ...base, prefix: "Desa " }), "");
  });

  it("adds a prefix and suffix around the value", () => {
    const labels = { ...base, prefix: "Desa ", suffix: " (Kuningan)" };
    const field = decorateLabelTextField(labelFieldTextField(labels), labels);
    assert.equal(render(field, { NAMOBJ: "Ciwaru" }), "Desa Ciwaru (Kuningan)");
  });

  it("puts a prefix or suffix on its own line", () => {
    const labels = {
      ...base,
      prefix: "Desa",
      prefixOwnLine: true,
      suffix: "Kec. X",
      suffixOwnLine: true,
    };
    const field = decorateLabelTextField(labelFieldTextField(labels), labels);
    assert.equal(render(field, { NAMOBJ: "Cigugur" }), "Desa\nCigugur\nKec. X");
  });

  it("gives a feature with no value no label rather than the prefix alone", () => {
    const labels = { ...base, prefix: "Desa " };
    const field = decorateLabelTextField(labelFieldTextField(labels), labels);
    assert.equal(render(field, {}), "");
    assert.equal(render(field, { NAMOBJ: "" }), "");
  });

  it("wraps number-formatted values", () => {
    const labels = {
      ...base,
      field: "VALKNT",
      suffix: " m",
      numberFormatEnabled: true,
      numberDecimals: 1,
      numberLocale: "en-US",
    };
    const field = decorateLabelTextField(labelFieldTextField(labels), labels);
    assert.equal(render(field, { VALKNT: 1250 }), "1,250.0 m");
  });

  it("adds sections to a format expression", () => {
    const labels = { ...base, prefix: "Desa", prefixOwnLine: true };
    const formatted = ["format", ["get", "NAMOBJ"], { "font-scale": 1.2 }];
    const field = decorateLabelTextField(formatted, labels) as unknown[];
    assert.equal(field[0], "format");
    assert.equal(render(field, { NAMOBJ: "Cigugur" }), "Desa\nCigugur");
  });

  it("wraps a literal string label", () => {
    assert.equal(decorateLabelTextField("Ciwaru", { prefix: "Desa " }), "Desa Ciwaru");
  });
});

describe("decorateLabelString", () => {
  it("decorates evaluated text and keeps empty labels empty", () => {
    const labels = { prefix: "Desa", prefixOwnLine: true, suffix: "!" };
    assert.equal(decorateLabelString("Ciwaru", labels), "Desa\nCiwaru!");
    assert.equal(decorateLabelString("", labels), "");
    assert.equal(decorateLabelString("Ciwaru", {}), "Ciwaru");
  });
});
