/**
 * @module transitAlertText
 * @description One line of card text for a service alert: the alert's text
 * in the reader's best language (the UI's, then English, Spanish, Catalan,
 * then whatever the operator gave), Renfe's leading hashtags (`#MadC3`) dropped,
 * cut at a word. Shared by the Transit train card and the Rail network
 * cards. Pure, no dependencies.
 */

/** Card characters per alert. */
export const TRANSIT_ALERT_CARD_CHARS = 140;
const LANGUAGES = Object.freeze(['en', 'es', 'ca', '']);

/**
 * @param {Readonly<Record<string, string>>|null|undefined} header
 *   `{language: text}`
 * @param {number} [max]
 * @param {string} [locale] The UI language, tried first.
 * @returns {string|null}
 */
export function transitAlertText(
  header,
  max = TRANSIT_ALERT_CARD_CHARS,
  locale = 'en',
) {
  if (!header || typeof header !== 'object') return null;
  const language =
    [locale, ...LANGUAGES].find((key) => typeof header[key] === 'string') ??
    Object.keys(header).find((key) => typeof header[key] === 'string');
  if (language === undefined) return null;
  const text = header[language]
    .replace(/^(?:#\S+\s+)+/u, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
