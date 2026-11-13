'use client';

import { cn } from '@/lib/cn';
import { textWidth, useWidth, type Axis } from './chart-parts';

export interface ChartSlot {
  key: string;
  /** Its name under the chart, where there is room for it. */
  tick: string;
  /** Shown when the pointer rests on the slot: its name with its figures. */
  title: string;
  bar: number;
  /** Written above the bar when there are few bars. */
  barLabel?: string;
  /** One value for each line, in the order the lines are given. Null leaves a gap. */
  lines?: (number | null)[];
}

export interface ChartLine {
  name: string;
  dashed?: boolean;
}

const HEIGHT = 220;
const TOP = 18;
const BOTTOM = 24;
/** Below this many pixels a bar, bars run together and are drawn as one filled outline. */
const NARROWEST_BAR = 4;
const WIDEST_BAR = 48;

function LegendMark({ line }: { line?: ChartLine }) {
  if (!line) return <span className="inline-block size-2.5 rounded-[2px] bg-brand-500" />;
  return (
    <svg width="18" height="8" aria-hidden className="shrink-0">
      <line
        x1="1"
        x2="17"
        y1="4"
        y2="4"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={line.dashed ? '3 4' : undefined}
        className={line.dashed ? 'stroke-ink-faint' : 'stroke-ink'}
      />
    </svg>
  );
}

/**
 * Bars for one measure across days, weeks or months, with up to two lines over them. The lines
 * read from the bars' scale unless they are given one of their own, which is marked on the right.
 * Drawn to the width it is given: one bar is as readable as a year of days.
 */
export function BarChart({
  label,
  slots,
  bars,
  lines = [],
  lineAxis,
}: {
  /** What the chart shows, in words, for someone who cannot see it. */
  label: string;
  slots: ChartSlot[];
  bars: { name: string; axis: Axis };
  lines?: ChartLine[];
  lineAxis?: Axis;
}) {
  const [ref, width] = useWidth();

  const left = 10 + Math.max(...bars.axis.ticks.map((tick) => textWidth(tick.label)));
  const right = lineAxis
    ? 10 + Math.max(...lineAxis.ticks.map((tick) => textWidth(tick.label)))
    : 8;
  const innerWidth = Math.max(0, width - left - right);
  const innerHeight = HEIGHT - TOP - BOTTOM;
  const floor = TOP + innerHeight;
  const slotWidth = slots.length > 0 ? innerWidth / slots.length : 0;
  const barWidth = Math.min(WIDEST_BAR, slotWidth * 0.72);
  const centre = (index: number) => left + (index + 0.5) * slotWidth;
  const height = (value: number, axis: Axis) =>
    (Math.min(Math.max(value, 0), axis.max) / axis.max) * innerHeight;

  const widestTick = Math.max(0, ...slots.map((slot) => textWidth(slot.tick))) + 12;
  const every = Math.max(1, Math.ceil(widestTick / Math.max(slotWidth, 0.01)));
  const labelled = slotWidth >= 30 && slots.length <= 16;

  const outline =
    slotWidth < NARROWEST_BAR
      ? `M${left},${floor}` +
        slots
          .map((slot, index) => {
            const y = floor - height(slot.bar, bars.axis);
            return `L${left + index * slotWidth},${y}L${left + (index + 1) * slotWidth},${y}`;
          })
          .join('') +
        `L${left + innerWidth},${floor}Z`
      : null;

  const linePaths = lines.map((_, lineIndex) => {
    const axis = lineAxis ?? bars.axis;
    let path = '';
    const alone: { x: number; y: number }[] = [];
    slots.forEach((slot, index) => {
      const value = slot.lines?.[lineIndex] ?? null;
      if (value === null) return;
      const point = { x: centre(index), y: floor - height(value, axis) };
      const joinsBefore = index > 0 && (slots[index - 1]!.lines?.[lineIndex] ?? null) !== null;
      const joinsAfter =
        index < slots.length - 1 && (slots[index + 1]!.lines?.[lineIndex] ?? null) !== null;
      path += `${joinsBefore ? 'L' : 'M'}${point.x},${point.y}`;
      // A value with a gap on both sides has no line to be part of: it is marked with a dot.
      if (!joinsBefore && !joinsAfter) alone.push(point);
    });
    return { path, alone };
  });

  return (
    <div>
      <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-soft">
        <li className="flex items-center gap-1.5">
          <LegendMark />
          {bars.name}
        </li>
        {lines.map((line) => (
          <li key={line.name} className="flex items-center gap-1.5">
            <LegendMark line={line} />
            {line.name}
            {lineAxis && ', scale on the right'}
          </li>
        ))}
      </ul>
      <div ref={ref} style={{ height: HEIGHT }}>
        {width > 0 && (
          <svg
            role="img"
            aria-label={label}
            width={width}
            height={HEIGHT}
            viewBox={`0 0 ${width} ${HEIGHT}`}
            className="block text-[11px]"
          >
            {bars.axis.ticks.map((tick, index) => {
              const y = floor - height(tick.value, bars.axis);
              return (
                <g key={tick.value}>
                  <line
                    x1={left}
                    x2={left + innerWidth}
                    y1={y}
                    y2={y}
                    className={tick.value === 0 ? 'stroke-line-strong' : 'stroke-line'}
                  />
                  <text x={left - 6} y={y + 4} textAnchor="end" className="tabular fill-ink-faint">
                    {tick.label}
                  </text>
                  {lineAxis?.ticks[index] && (
                    <text x={left + innerWidth + 6} y={y + 4} className="tabular fill-ink-faint">
                      {lineAxis.ticks[index].label}
                    </text>
                  )}
                </g>
              );
            })}

            {outline ? (
              <path d={outline} className="fill-brand-500" />
            ) : (
              slots.map((slot, index) => {
                const barHeight = height(slot.bar, bars.axis);
                return (
                  <rect
                    key={slot.key}
                    x={centre(index) - barWidth / 2}
                    y={floor - barHeight}
                    width={barWidth}
                    height={barHeight}
                    rx={Math.min(2, barWidth / 4, barHeight / 2)}
                    className="fill-brand-500"
                  />
                );
              })
            )}

            {linePaths.map(({ path, alone }, index) => {
              const line = lines[index]!;
              const stroke = line.dashed ? 'stroke-ink-faint' : 'stroke-ink';
              return (
                <g key={line.name}>
                  <path
                    d={path}
                    fill="none"
                    strokeWidth="1.75"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    strokeDasharray={line.dashed ? '3 4' : undefined}
                    className={stroke}
                  />
                  {alone.map((point) => (
                    <circle
                      key={point.x}
                      cx={point.x}
                      cy={point.y}
                      r="2.5"
                      className={cn('fill-surface', stroke)}
                      strokeWidth="1.75"
                    />
                  ))}
                </g>
              );
            })}

            {labelled &&
              !outline &&
              slots.map(
                (slot, index) =>
                  slot.barLabel && (
                    <text
                      key={slot.key}
                      x={centre(index)}
                      y={floor - height(slot.bar, bars.axis) - 5}
                      textAnchor="middle"
                      // A line may run through the figure: the surround keeps it readable.
                      paintOrder="stroke"
                      strokeWidth="3"
                      strokeLinejoin="round"
                      className="tabular fill-ink-soft stroke-surface"
                    >
                      {slot.barLabel}
                    </text>
                  ),
              )}

            {slots.map((slot, index) => {
              const shown = index % every === 0;
              const half = textWidth(slot.tick) / 2;
              return (
                <g key={slot.key}>
                  {shown && (
                    <text
                      x={Math.min(Math.max(centre(index), half + 2), width - half - 2)}
                      y={HEIGHT - 7}
                      textAnchor="middle"
                      className="fill-ink-faint"
                    >
                      {slot.tick}
                    </text>
                  )}
                  <rect
                    x={left + index * slotWidth}
                    y={TOP}
                    width={slotWidth}
                    height={innerHeight}
                    className="fill-transparent hover:fill-ink/5"
                  >
                    <title>{slot.title}</title>
                  </rect>
                </g>
              );
            })}
          </svg>
        )}
      </div>
    </div>
  );
}
