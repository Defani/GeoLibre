import type { LabelStyle } from "./types";

/** The label settings that add text around a feature's label value. */
export type LabelAffixes = Pick<
  LabelStyle,
  "prefix" | "suffix" | "prefixOwnLine" | "suffixOwnLine"
>;

/**
 * The text a label puts before and after its value: the prefix and suffix,
 * each followed or preceded by a line break when it sits on its own line
 * ("Desa" above "Cigugur").
 */
function affixText(labels: Partial<LabelAffixes>): { before: string; after: string } {
  const prefix = typeof labels.prefix === "string" ? labels.prefix : "";
  const suffix = typeof labels.suffix === "string" ? labels.suffix : "";
  return {
    before: prefix && labels.prefixOwnLine ? `${prefix}\n` : prefix,
    after: suffix && labels.suffixOwnLine ? `\n${suffix}` : suffix,
  };
}

/**
 * Wrap a label's `text-field` with its prefix and suffix
 * ({@link LabelStyle.prefix}, {@link LabelStyle.suffix}).
 *
 * A feature whose own value is empty keeps no label, rather than showing the
 * prefix alone. A `format` expression gets the affixes as extra sections, since
 * `concat` cannot take formatted text. With no affixes the value is returned
 * as is, so existing styles compile unchanged.
 *
 * @param textField The label value: a style-spec expression, or `""` for none.
 * @param labels The label settings carrying the affixes.
 * @returns The decorated `text-field`, or `""` when there is nothing to label.
 */
export function decorateLabelTextField(textField: unknown, labels: Partial<LabelAffixes>): unknown {
  if (textField === "" || textField == null) return textField;
  const { before, after } = affixText(labels);
  if (!before && !after) return textField;
  if (Array.isArray(textField) && textField[0] === "format") {
    return [
      "format",
      ...(before ? [before, {}] : []),
      ...textField.slice(1),
      ...(after ? [after, {}] : []),
    ];
  }
  if (typeof textField === "string") return `${before}${textField}${after}`;
  return ["case", ["==", ["to-string", textField], ""], "", ["concat", before, textField, after]];
}

/**
 * {@link decorateLabelTextField} for an already evaluated label, for the
 * renderers that build label text in JavaScript (ArcGIS, the Cesium globe).
 *
 * @param text The feature's label text.
 * @param labels The label settings carrying the affixes.
 * @returns The text with its prefix and suffix, or `""` for an empty label.
 */
export function decorateLabelString(text: string, labels: Partial<LabelAffixes>): string {
  if (!text) return text;
  const { before, after } = affixText(labels);
  return `${before}${text}${after}`;
}
