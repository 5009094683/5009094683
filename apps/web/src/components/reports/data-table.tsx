import type { ReactNode } from 'react';
import { Card } from '@/components/ui/misc';
import { cn } from '@/lib/cn';

export interface Column<Row, Total> {
  key: string;
  header: string;
  /** Neighbouring columns with the same group stand under one shared heading. */
  group?: string;
  /** Figures line up on the right. The first column is the name of the row and stays left. */
  align?: 'left' | 'right';
  cell: (row: Row) => ReactNode;
  /** What stands in the totals row. The first column says "Total" unless it gives something else. */
  total?: (total: Total) => ReactNode;
  /** For the heading and every cell of the column: a width, or leave to wrap. */
  className?: string;
}

/** A figure with a second, quieter one beneath it: room nights with their revenue, say. */
export function Pair({ main, sub }: { main: ReactNode; sub: ReactNode }) {
  return (
    <>
      <span className="block">{main}</span>
      <span className="block text-xs font-normal text-ink-faint">{sub}</span>
    </>
  );
}

const HEAD = 'sticky z-20 bg-sunken text-xs font-medium text-ink-faint';
const ALIGN = { left: 'text-left', right: 'text-right' };
/** The first column stays in place while the figures scroll sideways beneath a narrow screen. */
const FIRST = 'sticky left-0 border-r border-line';
/** The height of the row of shared headings, which the row of headings beneath it sticks under. */
const GROUP_ROW = 'h-8';
const UNDER_GROUP_ROW = 'top-8';

/**
 * A table of figures. It scrolls inside its own frame, both ways, so the page never scrolls
 * sideways; the headings, the name of each row and the totals stay in view while it does.
 */
export function DataTable<Row, Total>({
  label,
  columns,
  rows,
  rowKey,
  total,
  dense = false,
}: {
  /** Names the table for a screen reader, and the frame it scrolls in. */
  label: string;
  columns: Column<Row, Total>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  total?: Total;
  /** For a table of many columns: closer set, so that more of it is in view at once. */
  dense?: boolean;
}) {
  const grouped = columns.some((column) => column.group);
  const groups: { name: string | undefined; span: number; start: number }[] = [];
  columns.forEach((column, index) => {
    const last = groups[groups.length - 1];
    // The first column stands alone: it is the one that stays in place.
    if (last && last.name === column.group && index > 1) last.span += 1;
    else groups.push({ name: column.group, span: 1, start: index });
  });
  const pad = dense ? 'px-2.5' : 'px-3';
  const align = (column: Column<Row, Total>, index: number) =>
    ALIGN[column.align ?? (index === 0 ? 'left' : 'right')];
  /** A rule down the table where one group of columns ends and the next begins. */
  const edge = (index: number) =>
    grouped && index > 1 && columns[index]!.group !== columns[index - 1]!.group
      ? 'border-l border-line'
      : undefined;

  return (
    <Card className="overflow-hidden">
      <div
        role="region"
        aria-label={label}
        tabIndex={0}
        className="scrollbar-thin max-h-[70dvh] overflow-auto focus-visible:outline-offset-[-2px]"
      >
        <table
          className={cn(
            'w-full border-separate border-spacing-0',
            dense ? 'text-[13px]' : 'text-sm',
          )}
        >
          <caption className="sr-only">{label}</caption>
          <thead>
            {grouped && (
              <tr>
                {groups.map((group) => {
                  // Columns outside every group have nothing above them: a cell, not a heading.
                  const Cell = group.name ? 'th' : 'td';
                  return (
                    <Cell
                      key={group.start}
                      scope={group.name ? 'colgroup' : undefined}
                      colSpan={group.span}
                      className={cn(
                        HEAD,
                        GROUP_ROW,
                        pad,
                        'top-0 text-left whitespace-nowrap',
                        group.start === 0 && cn(FIRST, 'z-30'),
                        group.name && 'border-b border-line text-ink-soft',
                        edge(group.start),
                      )}
                    >
                      {group.name}
                    </Cell>
                  );
                })}
              </tr>
            )}
            <tr>
              {columns.map((column, index) => (
                <th
                  key={column.key}
                  scope="col"
                  className={cn(
                    HEAD,
                    pad,
                    'border-b border-line py-2.5 align-bottom',
                    grouped ? UNDER_GROUP_ROW : 'top-0',
                    align(column, index),
                    index === 0 && cn(FIRST, 'z-30'),
                    edge(index),
                    column.className,
                  )}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={rowKey(row)} className="group">
                {columns.map((column, index) =>
                  index === 0 ? (
                    <th
                      key={column.key}
                      scope="row"
                      className={cn(
                        FIRST,
                        pad,
                        'z-10 border-b bg-surface py-2.5 text-left font-medium text-ink group-hover:bg-sunken',
                        column.className,
                      )}
                    >
                      {column.cell(row)}
                    </th>
                  ) : (
                    <td
                      key={column.key}
                      className={cn(
                        pad,
                        'tabular border-b border-line py-2.5 whitespace-nowrap text-ink group-hover:bg-sunken',
                        align(column, index),
                        edge(index),
                        column.className,
                      )}
                    >
                      {column.cell(row)}
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
          {total !== undefined && (
            <tfoot>
              <tr>
                {columns.map((column, index) => {
                  const className = cn(
                    pad,
                    'tabular sticky bottom-0 z-20 border-t border-line-strong bg-sunken py-2.5 font-semibold whitespace-nowrap text-ink',
                    align(column, index),
                    index === 0 && cn(FIRST, 'z-30'),
                    edge(index),
                    column.className,
                  );
                  return index === 0 ? (
                    <th key={column.key} scope="row" className={className}>
                      {column.total ? column.total(total) : 'Total'}
                    </th>
                  ) : (
                    <td key={column.key} className={className}>
                      {column.total?.(total)}
                    </td>
                  );
                })}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </Card>
  );
}
