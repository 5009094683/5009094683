/*
  Pages are built as strings. Everything put into a page through the `html`
  tag is escaped, so that a customer's message or name can never become
  markup; only what was itself built with `html` goes in as it is.
*/

export class Html {
  constructor(readonly text: string) {}
  toString(): string {
    return this.text;
  }
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

type Piece = Html | string | number | null | undefined | false | Piece[];

function render(piece: Piece): string {
  if (piece === null || piece === undefined || piece === false) return '';
  if (piece instanceof Html) return piece.text;
  if (Array.isArray(piece)) return piece.map(render).join('');
  return escapeHtml(String(piece));
}

export function html(strings: TemplateStringsArray, ...values: Piece[]): Html {
  let out = strings[0] ?? '';
  values.forEach((value, i) => {
    out += render(value) + (strings[i + 1] ?? '');
  });
  return new Html(out);
}

/** Line breaks of a message kept as line breaks on the page. */
export function multiline(text: string): Html {
  return new Html(escapeHtml(text).replace(/\r?\n/g, '<br>'));
}
