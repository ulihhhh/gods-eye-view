/**
 * Minimal CSV reader for GTFS text files (stops.txt, routes.txt, …), shared
 * by the AMB arrivals proxy and the Spain transit network build script.
 * Pure, no dependencies.
 */

/**
 * Parse RFC 4180 CSV (quoted fields, doubled quotes, CRLF) into objects
 * keyed by the header row. Small and strict enough for GTFS text files.
 * @param {string} text
 * @returns {Array<Record<string, string>>}
 */
export function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let quoted = false;
  const source = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows.filter(
    (cells) => cells.length > 1 || cells[0] !== '',
  );
  if (!header) return [];
  const keys = header.map((key) => key.trim());
  return body.map((cells) =>
    Object.fromEntries(keys.map((key, index) => [key, cells[index] ?? ''])),
  );
}
