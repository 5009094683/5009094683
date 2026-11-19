export type CsvCell = string | number | null;

function cell(value: CsvCell): string {
  if (value === null) return '';
  let text = String(value);
  // Text starting with one of these is run as a formula by spreadsheet programs. A plain number is not.
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) {
    text = `'${text}`;
  }
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Rows of cells as CSV text, safe to open in a spreadsheet. */
export function toCsv(rows: CsvCell[][]): string {
  return rows.map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
