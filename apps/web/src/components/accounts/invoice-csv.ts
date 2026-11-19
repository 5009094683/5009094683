import { minorToDecimal } from '@pms/domain/shared';
import type { Invoice } from './types';

/** The order tax returns list them in; any other component follows by name. */
const KNOWN_TAXES = ['CGST', 'SGST', 'IGST'];

/** The tax components that appear on any of the invoices, in column order. */
export function taxCodes(invoices: Invoice[]): string[] {
  const codes = new Set(invoices.flatMap((invoice) => Object.keys(invoice.totals.taxes)));
  return [
    ...KNOWN_TAXES.filter((code) => codes.has(code)),
    ...[...codes].filter((code) => !KNOWN_TAXES.includes(code)).sort(),
  ];
}

/**
 * One cell of text. A spreadsheet runs a cell that starts with `=`, `+`, `-`
 * or `@` as a formula, so text that does is given a leading apostrophe.
 */
function text(value: string | null | undefined): string {
  const clean = value ?? '';
  const safe = /^[=+\-@\t\r]/.test(clean) ? `'${clean}` : clean;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * The listed invoices as CSV for the accountant: one row each, amounts as
 * plain decimals (credit notes negative), one column per tax component.
 */
export function invoicesCsv(invoices: Invoice[], propertyNames: Map<string, string>): string {
  const codes = taxCodes(invoices);
  const header = [
    'Number',
    'Date',
    'Type',
    'Property',
    'Made out to',
    'GSTIN',
    'Currency',
    'Taxable amount',
    ...codes.map(text),
    'Total',
    'Corrects invoice',
  ];
  const rows = invoices.map((invoice) => [
    text(invoice.number),
    invoice.issuedOn,
    invoice.type === 'credit_note' ? 'Credit note' : 'Invoice',
    text(propertyNames.get(invoice.propertyId) ?? invoice.seller.name),
    text(invoice.buyer.name),
    text(invoice.buyer.gstin),
    invoice.currency,
    minorToDecimal(invoice.totals.taxable, invoice.currency),
    ...codes.map((code) => minorToDecimal(invoice.totals.taxes[code] ?? 0, invoice.currency)),
    minorToDecimal(invoice.totals.total, invoice.currency),
    text(invoice.type === 'credit_note' ? invoice.reference.invoice : ''),
  ]);
  // The byte order mark makes a spreadsheet read the file as UTF-8.
  return `\uFEFF${[header, ...rows].map((row) => row.join(',')).join('\r\n')}\r\n`;
}

/** Hands a file made in the browser to the user as a download. */
export function downloadCsv(filename: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
