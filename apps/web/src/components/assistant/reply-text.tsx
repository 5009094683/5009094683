import { Fragment, type ReactNode } from 'react';

export type ReplyBlock =
  | { kind: 'text'; lines: string[] }
  | { kind: 'bullets'; items: string[] }
  | { kind: 'steps'; items: string[] };

/**
 * Splits a reply into paragraphs and lists. The assistant writes plain text with line breaks,
 * "- " bullets and now and then numbered steps; anything else stays as written.
 */
export function replyBlocks(text: string): ReplyBlock[] {
  const blocks: ReplyBlock[] = [];
  // A blank line ends a paragraph or a list.
  let ended = true;
  const add = (kind: ReplyBlock['kind'], content: string) => {
    const last = blocks[blocks.length - 1];
    if (!ended && last?.kind === kind) {
      if (last.kind === 'text') last.lines.push(content);
      else last.items.push(content);
      return;
    }
    blocks.push(kind === 'text' ? { kind, lines: [content] } : { kind, items: [content] });
    ended = false;
  };
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) {
      ended = true;
      continue;
    }
    const bullet = /^[-*\u2022]\s+(.+)$/.exec(line);
    const step = /^\d{1,3}[.)]\s+(.+)$/.exec(line);
    if (bullet) add('bullets', bullet[1]!);
    else if (step) add('steps', step[1]!);
    else add('text', line);
  }
  return blocks;
}

/** `**words**` as emphasis, the one piece of markup a language model reliably adds. */
function inline(text: string): ReactNode {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  if (parts.length === 1) return text;
  return parts.map((part, index) =>
    index % 2 === 1 ? (
      <strong key={index} className="font-semibold">
        {part}
      </strong>
    ) : (
      <Fragment key={index}>{part}</Fragment>
    ),
  );
}

/** A reply shown as text: nothing in it is ever treated as HTML. */
export function ReplyText({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-2 text-sm text-ink [overflow-wrap:anywhere]">
      {replyBlocks(text).map((block, index) => {
        if (block.kind === 'text') {
          return (
            <p key={index}>
              {block.lines.map((line, at) => (
                <Fragment key={at}>
                  {at > 0 && <br />}
                  {inline(line)}
                </Fragment>
              ))}
            </p>
          );
        }
        const items = block.items.map((item, at) => <li key={at}>{inline(item)}</li>);
        return block.kind === 'bullets' ? (
          <ul key={index} className="flex list-disc flex-col gap-0.5 pl-5 marker:text-ink-faint">
            {items}
          </ul>
        ) : (
          <ol key={index} className="flex list-decimal flex-col gap-0.5 pl-5 marker:text-ink-faint">
            {items}
          </ol>
        );
      })}
    </div>
  );
}
