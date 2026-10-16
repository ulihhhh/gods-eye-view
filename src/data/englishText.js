/**
 * @module englishText
 * @description The English stand-ins for t() and tn() (src/i18n/index.js),
 * for fork card builders the server also imports: they must not load the
 * catalogs, so the UI passes its own `{t, tn, locale}` and everything else
 * gets English. Same {placeholder} and plural rules as the real ones.
 */

const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;

/** English {placeholder} interpolation. */
export function englishText(text, values) {
  if (!values) return text;
  return text.replace(PLACEHOLDER, (literal, name) =>
    Object.hasOwn(values, name) ? String(values[name]) : literal,
  );
}

/** English plural: `one` for 1, `other` otherwise, `{count}` filled in. */
export function englishPlural(count, one, other, values) {
  return englishText(count === 1 ? one : other, { count, ...values });
}

/** The i18n a card builder uses when the caller passes none. */
export const ENGLISH = Object.freeze({
  t: englishText,
  tn: englishPlural,
  locale: 'en',
});
