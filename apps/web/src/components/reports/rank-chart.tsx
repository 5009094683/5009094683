'use client';

import { fitText, textWidth, useWidth } from './chart-parts';

export interface RankRow {
  key: string;
  name: string;
  value: number;
  /** The value as it is written beside the bar. */
  valueLabel: string;
}

const ROW = 28;
/** A row with the name on a line of its own, above the bar. */
const TALL_ROW = 42;
const BAR = 12;
/** More rows than this make a chart nobody reads; the table has them all. */
const MOST_ROWS = 12;
const LETTERS = 12;

/**
 * One bar for each property or room type, longest first: things with no order in time, where
 * what matters is which is ahead.
 */
export function RankChart({
  label,
  rows,
  max,
  measure,
}: {
  /** What the chart shows, in words, for someone who cannot see it. */
  label: string;
  rows: RankRow[];
  /** The value a bar across the whole width stands for. */
  max: number;
  /** What the bars measure, as it reads after "the 12 with the highest". */
  measure: string;
}) {
  const [ref, width] = useWidth();
  const ranked = [...rows].sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
  const shown = ranked.slice(0, MOST_ROWS);

  const longest = Math.max(0, ...shown.map((row) => textWidth(row.name, LETTERS))) + 4;
  const valueWidth = Math.max(0, ...shown.map((row) => textWidth(row.valueLabel, LETTERS))) + 4;
  // Names too long to stand beside the bars, as on a phone, go above them instead of being cut.
  const stacked = longest > width * 0.4;
  const row = stacked ? TALL_ROW : ROW;
  const barLeft = stacked ? 0 : longest + 10;
  const barWidth = Math.max(0, width - barLeft - valueWidth - 8);
  const height = shown.length * row;

  return (
    <div>
      <div ref={ref} style={{ height }}>
        {width > 0 && (
          <svg
            role="img"
            aria-label={label}
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            className="block"
            fontSize={LETTERS}
          >
            {shown.map((entry, index) => {
              const top = index * row;
              const middle = stacked ? top + 28 : top + ROW / 2;
              const filled =
                max > 0 ? (Math.min(Math.max(entry.value, 0), max) / max) * barWidth : 0;
              return (
                <g key={entry.key}>
                  <title>{`${entry.name}: ${entry.valueLabel}`}</title>
                  <text x={0} y={stacked ? top + 14 : middle + 4} className="fill-ink-soft">
                    {fitText(entry.name, stacked ? width : longest, LETTERS)}
                  </text>
                  <rect
                    x={barLeft}
                    y={middle - BAR / 2}
                    width={barWidth}
                    height={BAR}
                    rx={3}
                    className="fill-sunken"
                  />
                  <rect
                    x={barLeft}
                    y={middle - BAR / 2}
                    width={filled}
                    height={BAR}
                    rx={Math.min(3, filled / 2)}
                    className="fill-brand-500"
                  />
                  <text
                    x={width}
                    y={middle + 4}
                    textAnchor="end"
                    className="tabular fill-ink font-medium"
                  >
                    {entry.valueLabel}
                  </text>
                </g>
              );
            })}
          </svg>
        )}
      </div>
      {ranked.length > shown.length && (
        <p className="mt-2 text-xs text-ink-faint">
          The {shown.length} with the highest {measure} are drawn, of {ranked.length}. The table has
          them all.
        </p>
      )}
    </div>
  );
}
