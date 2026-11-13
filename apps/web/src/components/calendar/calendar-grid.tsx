'use client';

import { AlertTriangle, ChevronDown, ChevronRight, Lock, Wrench } from 'lucide-react';
import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { BLOCK_KIND_LABELS, addDays, dayOfWeek, diffDays } from '@pms/domain/shared';
import { cn } from '@/lib/cn';
import {
  formatAmount,
  formatMonth,
  formatStay,
  formatWeekdayName,
  sourceLabel,
} from '@/lib/format';
import type { CalBlock, CalProperty, CalRoomType, CalStay, CalUnit, Calendar } from '@/lib/types';

const ROW_H = 34;
const TYPE_ROW_H = 40;
const BAR_H = 26;

export interface RowTarget {
  property: CalProperty;
  roomType: CalRoomType;
  /** Null for the room type's "not yet assigned" row. */
  unit: CalUnit | null;
}

export interface RangeSelection extends RowTarget {
  from: string;
  to: string;
  /** Screen position to anchor the action menu at. */
  anchor: { x: number; y: number };
}

export interface StayChange {
  checkIn: string;
  checkOut: string;
  /** Present when the stay was dropped on another row. */
  target?: RowTarget;
}

export interface CalendarGridProps {
  calendar: Calendar;
  cellWidth: number;
  labelWidth: number;
  today: string;
  collapsed: ReadonlySet<string>;
  onToggle(id: string): void;
  canWrite(propertyId: string): boolean;
  onOpenStay(stay: CalStay): void;
  onOpenBlock(block: CalBlock, property: CalProperty): void;
  onSelectRange(selection: RangeSelection): void;
  /**
   * Take a number of rooms of a type off sale without choosing which. Absent
   * for a property where the user may not block dates.
   */
  onBlockRoomType?(property: CalProperty, roomType: CalRoomType): void;
  canBlock?(propertyId: string): boolean;
  onChangeStay(stay: CalStay, property: CalProperty, change: StayChange): void;
  onChangeBlock(
    block: CalBlock,
    property: CalProperty,
    change: { startDate: string; endDate: string },
  ): void;
}

type DragMode = 'move' | 'start' | 'end';

interface BarDrag {
  kind: 'stay' | 'block';
  id: string;
  mode: DragMode;
  originX: number;
  originY: number;
  from: string;
  to: string;
  rowKey: string;
  moved: boolean;
  /** Current preview. */
  previewFrom: string;
  previewTo: string;
  previewRow: string;
}

interface SelectDrag {
  rowKey: string;
  startIndex: number;
  endIndex: number;
}

const SOURCE_CLASS: Record<string, string> = {
  BDC: 'bg-src-bdc',
  ABB: 'bg-src-abb',
  EXP: 'bg-src-exp',
  AGO: 'bg-src-ago',
  MMT: 'bg-src-mmt',
  GOI: 'bg-src-mmt',
};

function stayColor(stay: CalStay): string {
  if (stay.status === 'checked_out') return 'bg-ink-faint';
  if (stay.channelCode) return SOURCE_CLASS[stay.channelCode.toUpperCase()] ?? 'bg-src-other';
  return 'bg-src-direct';
}

const BLOCK_CLASS: Record<string, string> = {
  block: 'bg-ink-soft',
  maintenance: 'bg-warning-700',
  owner_stay: 'bg-info-700',
  hold: 'bg-brand-800',
};

/** Places overlapping items in the fewest lanes, each lane holding non-overlapping items. */
function assignLanes<T extends { from: string; to: string }>(
  items: T[],
): { item: T; lane: number }[] {
  const lanes: string[] = [];
  return [...items]
    .sort((a, b) => a.from.localeCompare(b.from))
    .map((item) => {
      let lane = lanes.findIndex((end) => end <= item.from);
      if (lane === -1) lane = lanes.length;
      lanes[lane] = item.to;
      return { item, lane };
    });
}

function rowKeyOf(roomTypeId: string, unitId: string | null): string {
  return unitId ? `unit:${unitId}` : `type:${roomTypeId}`;
}

/** Pixel geometry of a [from, to) span. Stays run from midday to midday, so back-to-back stays meet mid-cell. */
function spanGeometry(
  from: string,
  to: string,
  rangeFrom: string,
  rangeTo: string,
  cellWidth: number,
) {
  const totalDays = diffDays(rangeFrom, rangeTo);
  const startsBefore = from < rangeFrom;
  const endsAfter = to > rangeTo;
  const startIndex = Math.max(0, diffDays(rangeFrom, from));
  const endIndex = Math.min(totalDays, diffDays(rangeFrom, to));
  const left = startsBefore ? 0 : startIndex * cellWidth + cellWidth / 2 + 1;
  const right = endsAfter ? totalDays * cellWidth : endIndex * cellWidth + cellWidth / 2 - 1;
  return { left, width: Math.max(right - left, 6), startsBefore, endsAfter };
}

const DayHeader = memo(function DayHeader({
  dates,
  cellWidth,
  labelWidth,
  today,
}: {
  dates: string[];
  cellWidth: number;
  labelWidth: number;
  today: string;
}) {
  const months = useMemo(() => {
    const out: { key: string; label: string; days: number }[] = [];
    for (const date of dates) {
      const key = date.slice(0, 7);
      const last = out[out.length - 1];
      if (last && last.key === key) last.days++;
      else out.push({ key, label: formatMonth(date), days: 1 });
    }
    return out;
  }, [dates]);

  return (
    <div className="sticky top-0 z-30 flex border-b border-line-strong bg-surface">
      <div
        className="sticky left-0 z-10 shrink-0 border-r border-line-strong bg-surface"
        style={{ width: labelWidth }}
      />
      <div>
        <div className="flex h-6 border-b border-line">
          {months.map((month) => (
            <div
              key={month.key}
              className="overflow-hidden border-r border-line px-2 text-xs leading-6 font-semibold whitespace-nowrap text-ink-soft"
              style={{ width: month.days * cellWidth }}
            >
              {/* Keeps the month name in view while its days scroll past. */}
              <span className="sticky" style={{ left: labelWidth + 8 }}>
                {month.days * cellWidth > 70 ? month.label : ''}
              </span>
            </div>
          ))}
        </div>
        <div className="flex h-9">
          {dates.map((date) => {
            const dow = dayOfWeek(date);
            const weekend = dow === 0 || dow === 6;
            const isToday = date === today;
            return (
              <div
                key={date}
                className={cn(
                  'flex shrink-0 flex-col items-center justify-center border-r border-line text-[10px] leading-none',
                  weekend ? 'bg-sunken text-ink-soft' : 'text-ink-faint',
                )}
                style={{ width: cellWidth }}
                data-date={date}
                aria-current={isToday ? 'date' : undefined}
              >
                <span className="uppercase">
                  {formatWeekdayName(date).slice(0, cellWidth < 36 ? 1 : 3)}
                </span>
                <span
                  className={cn(
                    'tabular mt-0.5 flex size-5 items-center justify-center rounded-full text-xs font-semibold',
                    isToday ? 'bg-brand-600 text-white' : 'text-ink',
                  )}
                >
                  {Number(date.slice(8))}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});

export function CalendarGrid(props: CalendarGridProps) {
  const { calendar, cellWidth, labelWidth, today, collapsed, canWrite } = props;
  const { dates, range } = calendar;
  const trackWidth = dates.length * cellWidth;
  const bodyRef = useRef<HTMLDivElement>(null);

  const [barDrag, setBarDrag] = useState<BarDrag | null>(null);
  const [selectDrag, setSelectDrag] = useState<SelectDrag | null>(null);
  const barDragRef = useRef<BarDrag | null>(null);
  const selectRef = useRef<SelectDrag | null>(null);

  /** Every droppable row, by key. */
  const rows = useMemo(() => {
    const map = new Map<string, RowTarget>();
    for (const property of calendar.properties) {
      for (const roomType of property.roomTypes) {
        map.set(rowKeyOf(roomType.id, null), { property, roomType, unit: null });
        for (const unit of roomType.units)
          map.set(rowKeyOf(roomType.id, unit.id), { property, roomType, unit });
      }
    }
    return map;
  }, [calendar.properties]);

  const rowAt = useCallback((x: number, y: number): string | null => {
    for (const element of document.elementsFromPoint(x, y)) {
      const key = (element as HTMLElement).dataset?.row;
      if (key) return key;
    }
    return null;
  }, []);

  // --- Dragging a stay or block -------------------------------------------

  const startBarDrag = (
    event: ReactPointerEvent<HTMLElement>,
    kind: 'stay' | 'block',
    id: string,
    mode: DragMode,
    from: string,
    to: string,
    rowKey: string,
  ) => {
    // Touch scrolls the grid; dragging is a mouse and pen gesture.
    if (event.button !== 0 || event.pointerType === 'touch') return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const drag: BarDrag = {
      kind,
      id,
      mode,
      originX: event.clientX,
      originY: event.clientY,
      from,
      to,
      rowKey,
      moved: false,
      previewFrom: from,
      previewTo: to,
      previewRow: rowKey,
    };
    barDragRef.current = drag;
    setBarDrag(drag);
  };

  const moveBarDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = barDragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.originX;
    const dy = event.clientY - drag.originY;
    if (!drag.moved && Math.abs(dx) < 4 && Math.abs(dy) < 6) return;
    const delta = Math.round(dx / cellWidth);
    let previewFrom = drag.from;
    let previewTo = drag.to;
    let previewRow = drag.rowKey;
    if (drag.mode === 'move') {
      previewFrom = addDays(drag.from, delta);
      previewTo = addDays(drag.to, delta);
      // Blocks stay on their unit; stays can be dropped on another row.
      if (drag.kind === 'stay') previewRow = rowAt(event.clientX, event.clientY) ?? drag.rowKey;
    } else if (drag.mode === 'start') {
      previewFrom = addDays(drag.from, delta);
      if (previewFrom >= drag.to) previewFrom = addDays(drag.to, -1);
    } else {
      previewTo = addDays(drag.to, delta);
      if (previewTo <= drag.from) previewTo = addDays(drag.from, 1);
    }
    const next = { ...drag, moved: true, previewFrom, previewTo, previewRow };
    barDragRef.current = next;
    setBarDrag(next);
  };

  const endBarDrag = (
    event: ReactPointerEvent<HTMLElement>,
    onClick: () => void,
    commit: (drag: BarDrag) => void,
  ) => {
    const drag = barDragRef.current;
    if (!drag) return;
    barDragRef.current = null;
    setBarDrag(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (!drag.moved) {
      onClick();
      return;
    }
    const unchanged =
      drag.previewFrom === drag.from &&
      drag.previewTo === drag.to &&
      drag.previewRow === drag.rowKey;
    if (!unchanged) commit(drag);
  };

  // --- Selecting empty dates ----------------------------------------------

  const indexAt = (event: ReactPointerEvent<HTMLElement>): number => {
    const rect = event.currentTarget.getBoundingClientRect();
    return Math.min(
      dates.length - 1,
      Math.max(0, Math.floor((event.clientX - rect.left) / cellWidth)),
    );
  };

  const startSelect = (event: ReactPointerEvent<HTMLElement>, rowKey: string) => {
    if (event.button !== 0) return;
    const index = indexAt(event);
    if (event.pointerType !== 'touch') event.currentTarget.setPointerCapture(event.pointerId);
    const drag = { rowKey, startIndex: index, endIndex: index };
    selectRef.current = drag;
    setSelectDrag(drag);
  };

  const moveSelect = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = selectRef.current;
    if (!drag || event.pointerType === 'touch') return;
    const endIndex = indexAt(event);
    if (endIndex !== drag.endIndex) {
      const next = { ...drag, endIndex };
      selectRef.current = next;
      setSelectDrag(next);
    }
  };

  const endSelect = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = selectRef.current;
    if (!drag) return;
    selectRef.current = null;
    setSelectDrag(null);
    const target = rows.get(drag.rowKey);
    if (!target) return;
    const first = Math.min(drag.startIndex, drag.endIndex);
    const last = Math.max(drag.startIndex, drag.endIndex);
    props.onSelectRange({
      ...target,
      from: dates[first]!,
      to: addDays(dates[last]!, 1),
      anchor: { x: event.clientX, y: event.clientY },
    });
  };

  // --- Rendering helpers ---------------------------------------------------

  const renderStay = (stay: CalStay, property: CalProperty, rowKey: string, lane: number) => {
    const dragging = barDrag?.kind === 'stay' && barDrag.id === stay.id && barDrag.moved;
    const g = spanGeometry(stay.checkIn, stay.checkOut, range.from, range.to, cellWidth);
    const writable = canWrite(property.id) && stay.status !== 'checked_out';
    const label = `${stay.guestName}, ${formatStay(stay.checkIn, stay.checkOut)}, ${sourceLabel(stay.source, stay.channelCode)}, reservation ${stay.code}`;
    const commit = (drag: BarDrag) =>
      props.onChangeStay(stay, property, {
        checkIn: drag.previewFrom,
        checkOut: drag.previewTo,
        target: drag.previewRow !== drag.rowKey ? rows.get(drag.previewRow) : undefined,
      });
    const handlers = (mode: DragMode) =>
      writable
        ? {
            onPointerDown: (e: ReactPointerEvent<HTMLElement>) =>
              startBarDrag(e, 'stay', stay.id, mode, stay.checkIn, stay.checkOut, rowKey),
            onPointerMove: moveBarDrag,
            onPointerUp: (e: ReactPointerEvent<HTMLElement>) =>
              endBarDrag(e, () => props.onOpenStay(stay), commit),
            onPointerCancel: () => {
              barDragRef.current = null;
              setBarDrag(null);
            },
          }
        : {};
    return (
      <div
        key={stay.id}
        className={cn('absolute z-10', dragging && 'opacity-35')}
        style={{
          left: g.left,
          width: g.width,
          top: lane * ROW_H + (ROW_H - BAR_H) / 2,
          height: BAR_H,
        }}
      >
        <button
          type="button"
          title={label}
          aria-label={label}
          data-stay={stay.id}
          {...handlers('move')}
          onClick={writable ? undefined : () => props.onOpenStay(stay)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              props.onOpenStay(stay);
            }
          }}
          className={cn(
            'flex size-full items-center gap-1 overflow-hidden px-2 text-left text-xs font-medium text-white shadow-sm transition-[filter] hover:brightness-110',
            stayColor(stay),
            g.startsBefore ? 'rounded-l-none' : 'rounded-l-md',
            g.endsAfter ? 'rounded-r-none' : 'rounded-r-md',
            stay.status === 'tentative' && 'stripes opacity-80',
            stay.overbooked && 'ring-2 ring-danger-500 ring-offset-1',
            !stay.overbooked && stay.needsReview && 'ring-2 ring-warning-500 ring-offset-1',
            writable
              ? 'cursor-grab touch-pan-x touch-pan-y active:cursor-grabbing'
              : 'cursor-pointer',
          )}
        >
          {stay.overbooked && <AlertTriangle className="size-3 shrink-0" aria-hidden />}
          {stay.status === 'in_house' && (
            <span className="size-1.5 shrink-0 rounded-full bg-white" aria-hidden />
          )}
          <span className="truncate">{stay.guestName}</span>
        </button>
        {writable && !g.startsBefore && stay.status !== 'in_house' && (
          <span
            aria-hidden
            {...handlers('start')}
            className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize rounded-l-md hover:bg-white/40"
          />
        )}
        {writable && !g.endsAfter && (
          <span
            aria-hidden
            {...handlers('end')}
            className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize rounded-r-md hover:bg-white/40"
          />
        )}
      </div>
    );
  };

  const renderBlock = (block: CalBlock, property: CalProperty, rowKey: string, lane: number) => {
    const dragging = barDrag?.kind === 'block' && barDrag.id === block.id && barDrag.moved;
    const g = spanGeometry(block.startDate, block.endDate, range.from, range.to, cellWidth);
    // Blocks created by a calendar feed or the system are managed there, not by dragging.
    const writable = canWrite(property.id) && block.source === 'manual';
    const kind = BLOCK_KIND_LABELS[block.kind];
    const text = block.unitId
      ? (block.reason ?? kind)
      : `${kind} × ${block.quantity}${block.reason ? ` · ${block.reason}` : ''}`;
    const label = `${kind}${block.reason ? `: ${block.reason}` : ''}, ${formatStay(block.startDate, block.endDate)}`;
    const commit = (drag: BarDrag) =>
      props.onChangeBlock(block, property, {
        startDate: drag.previewFrom,
        endDate: drag.previewTo,
      });
    const handlers = (mode: DragMode) =>
      writable
        ? {
            onPointerDown: (e: ReactPointerEvent<HTMLElement>) =>
              startBarDrag(e, 'block', block.id, mode, block.startDate, block.endDate, rowKey),
            onPointerMove: moveBarDrag,
            onPointerUp: (e: ReactPointerEvent<HTMLElement>) =>
              endBarDrag(e, () => props.onOpenBlock(block, property), commit),
            onPointerCancel: () => {
              barDragRef.current = null;
              setBarDrag(null);
            },
          }
        : {};
    const Icon = block.kind === 'maintenance' ? Wrench : Lock;
    return (
      <div
        key={block.id}
        className={cn('absolute z-10', dragging && 'opacity-35')}
        style={{
          left: g.left,
          width: g.width,
          top: lane * ROW_H + (ROW_H - BAR_H) / 2,
          height: BAR_H,
        }}
      >
        <button
          type="button"
          title={label}
          aria-label={label}
          data-block={block.id}
          {...handlers('move')}
          onClick={writable ? undefined : () => props.onOpenBlock(block, property)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              props.onOpenBlock(block, property);
            }
          }}
          className={cn(
            'stripes flex size-full items-center gap-1.5 overflow-hidden px-2 text-left text-xs font-medium text-white shadow-sm',
            BLOCK_CLASS[block.kind],
            g.startsBefore ? 'rounded-l-none' : 'rounded-l-md',
            g.endsAfter ? 'rounded-r-none' : 'rounded-r-md',
            writable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer',
          )}
        >
          <Icon className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{text}</span>
        </button>
        {writable && !g.startsBefore && (
          <span
            aria-hidden
            {...handlers('start')}
            className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize hover:bg-white/40"
          />
        )}
        {writable && !g.endsAfter && (
          <span
            aria-hidden
            {...handlers('end')}
            className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize hover:bg-white/40"
          />
        )}
      </div>
    );
  };

  /** The outline shown where a dragged bar would land. */
  const renderPreview = (rowKey: string) => {
    if (!barDrag?.moved || barDrag.previewRow !== rowKey) return null;
    const g = spanGeometry(barDrag.previewFrom, barDrag.previewTo, range.from, range.to, cellWidth);
    return (
      <div
        className="pointer-events-none absolute z-20 rounded-md border-2 border-dashed border-brand-600 bg-brand-200/50"
        style={{ left: g.left, width: g.width, top: (ROW_H - BAR_H) / 2, height: BAR_H }}
      >
        <span className="absolute -top-5 left-0 rounded bg-ink px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap text-white">
          {formatStay(barDrag.previewFrom, barDrag.previewTo)}
        </span>
      </div>
    );
  };

  const renderSelection = (rowKey: string) => {
    if (!selectDrag || selectDrag.rowKey !== rowKey) return null;
    const first = Math.min(selectDrag.startIndex, selectDrag.endIndex);
    const last = Math.max(selectDrag.startIndex, selectDrag.endIndex);
    return (
      <div
        className="pointer-events-none absolute inset-y-1 z-[5] rounded-md border-2 border-brand-500 bg-brand-100/70"
        style={{ left: first * cellWidth + 1, width: (last - first + 1) * cellWidth - 2 }}
      />
    );
  };

  /** One row of the grid that bars can sit on: a unit, or a room type's unassigned stays. */
  const renderTrackRow = (
    property: CalProperty,
    roomType: CalRoomType,
    unit: CalUnit | null,
    stays: CalStay[],
    blocks: CalBlock[],
    ghosts: { from: string; to: string; label: string }[],
  ) => {
    const rowKey = rowKeyOf(roomType.id, unit?.id ?? null);
    const laid = assignLanes([
      ...stays.map((s) => ({ kind: 'stay' as const, from: s.checkIn, to: s.checkOut, stay: s })),
      ...blocks.map((b) => ({
        kind: 'block' as const,
        from: b.startDate,
        to: b.endDate,
        block: b,
      })),
    ]);
    const lanes = Math.max(1, ...laid.map((l) => l.lane + 1));
    const writable = canWrite(property.id);
    return (
      <div
        key={rowKey}
        className="group/row relative z-10 flex border-b border-line"
        style={{ height: lanes * ROW_H }}
      >
        <div
          className="sticky left-0 z-20 flex shrink-0 items-center gap-2 border-r border-line-strong bg-surface pr-2 pl-8 text-[13px] text-ink group-hover/row:bg-brand-50"
          style={{ width: labelWidth }}
        >
          {unit ? (
            <>
              <span
                aria-hidden
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  unit.housekeepingStatus === 'clean' || unit.housekeepingStatus === 'inspected'
                    ? 'bg-success-500'
                    : unit.housekeepingStatus === 'dirty'
                      ? 'bg-warning-500'
                      : 'bg-danger-500',
                )}
              />
              <span
                className="truncate"
                title={`${unit.name} (${unit.housekeepingStatus.replace('_', ' ')})`}
              >
                {unit.name}
              </span>
            </>
          ) : (
            <span className="truncate text-ink-faint italic">Not assigned</span>
          )}
        </div>
        <div
          data-row={rowKey}
          className={cn('relative', writable && 'cursor-cell')}
          style={{ width: trackWidth }}
          onPointerDown={
            writable ? (e) => e.target === e.currentTarget && startSelect(e, rowKey) : undefined
          }
          onPointerMove={writable ? moveSelect : undefined}
          onPointerUp={writable ? endSelect : undefined}
          onPointerCancel={() => {
            selectRef.current = null;
            setSelectDrag(null);
          }}
        >
          {ghosts.map((ghost, i) => {
            const g = spanGeometry(ghost.from, ghost.to, range.from, range.to, cellWidth);
            return (
              <div
                key={i}
                title={ghost.label}
                className="stripes pointer-events-none absolute inset-y-1.5 rounded bg-line-strong/70 px-1.5 text-[10px] leading-5 text-ink-soft"
                style={{ left: g.left, width: g.width }}
              >
                <span className="block truncate">{ghost.label}</span>
              </div>
            );
          })}
          {laid.map(({ item, lane }) =>
            item.kind === 'stay'
              ? renderStay(item.stay, property, rowKey, lane)
              : renderBlock(item.block, property, rowKey, lane),
          )}
          {renderSelection(rowKey)}
          {renderPreview(rowKey)}
        </div>
      </div>
    );
  };

  const renderRoomType = (property: CalProperty, roomType: CalRoomType) => {
    const isCollapsed = collapsed.has(roomType.id);
    const unassignedStays = property.stays.filter(
      (s) => s.roomTypeId === roomType.id && s.unitId === null,
    );
    const typeBlocks = property.blocks.filter(
      (b) => b.roomTypeId === roomType.id && b.unitId === null,
    );
    // The "not assigned" row appears only while something sits in it. Showing it
    // during a drag would shift every row below the pointer mid-gesture; a room
    // assignment is cleared from the reservation panel instead.
    const showUnassigned = unassignedStays.length > 0 || typeBlocks.length > 0;
    const unitsById = new Map(property.roomTypes.flatMap((t) => t.units).map((u) => [u.id, u]));

    return (
      <div key={roomType.id}>
        <div
          className="relative z-10 flex border-b border-line bg-sunken/80"
          style={{ height: TYPE_ROW_H }}
        >
          <div
            className="group/type sticky left-0 z-20 flex shrink-0 items-stretch border-r border-line-strong bg-sunken"
            style={{ width: labelWidth }}
          >
            <button
              type="button"
              onClick={() => props.onToggle(roomType.id)}
              aria-expanded={!isCollapsed}
              className="flex min-w-0 flex-1 items-center gap-1.5 px-3 text-left"
            >
              {isCollapsed ? (
                <ChevronRight className="size-3.5 shrink-0 text-ink-faint" aria-hidden />
              ) : (
                <ChevronDown className="size-3.5 shrink-0 text-ink-faint" aria-hidden />
              )}
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-semibold text-ink">
                  {roomType.name}
                </span>
              </span>
              <span className="ml-auto shrink-0 text-[11px] text-ink-faint">
                {roomType.units.length}
              </span>
            </button>
            {/* A hotel sells rooms by type: some can be held back without saying which ones. */}
            {props.onBlockRoomType &&
              roomType.units.length > 1 &&
              props.canBlock?.(property.id) && (
                <button
                  type="button"
                  title={`Take rooms of ${roomType.name} off sale`}
                  aria-label={`Take rooms of ${roomType.name} off sale`}
                  onClick={() => props.onBlockRoomType?.(property, roomType)}
                  className="mr-1 flex w-7 shrink-0 items-center justify-center self-center rounded text-ink-faint opacity-0 transition-opacity group-hover/type:opacity-100 hover:bg-line hover:text-ink focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
                  style={{ height: 24 }}
                >
                  <Lock className="size-3.5" aria-hidden />
                </button>
              )}
          </div>
          <div className="flex" style={{ width: trackWidth }}>
            {roomType.days.map((day) => (
              <div
                key={day.date}
                data-availability={`${roomType.id}:${day.date}`}
                data-available={day.available}
                title={`${roomType.name}, ${day.date}: ${day.available} of ${day.total} available${
                  day.overbooked > 0 ? `, ${day.overbooked} overbooked` : ''
                }${day.stopSell ? ', closed for sale' : ''}`}
                className={cn(
                  'tabular flex shrink-0 flex-col items-center justify-center border-r border-line text-xs leading-tight',
                  day.overbooked > 0
                    ? 'bg-danger-100 font-semibold text-danger-700'
                    : day.available <= 0
                      ? 'bg-danger-50 text-danger-700'
                      : day.total > 2 && day.available / day.total <= 0.25
                        ? 'bg-warning-50 text-warning-700'
                        : 'text-ink',
                )}
                style={{ width: cellWidth }}
              >
                <span className="font-semibold">
                  {day.overbooked > 0 ? `-${day.overbooked}` : day.available}
                </span>
                {cellWidth >= 40 && day.rate !== null && (
                  <span
                    className={cn('text-[10px] text-ink-faint', day.stopSell && 'line-through')}
                  >
                    {formatAmount(day.rate, property.currency)}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
        {!isCollapsed && (
          <>
            {showUnassigned &&
              renderTrackRow(property, roomType, null, unassignedStays, typeBlocks, [])}
            {roomType.units.map((unit) => {
              // Linked inventory: show what makes this unit unavailable through its parent or its parts.
              const linkedIds = new Set<string>();
              if (unit.parentUnitId) linkedIds.add(unit.parentUnitId);
              for (const other of unitsById.values())
                if (other.parentUnitId === unit.id) linkedIds.add(other.id);
              const ghosts = linkedIds.size
                ? [
                    ...property.stays
                      .filter((s) => s.unitId && linkedIds.has(s.unitId))
                      .map((s) => ({
                        from: s.checkIn,
                        to: s.checkOut,
                        label: `${unitsById.get(s.unitId!)?.name ?? 'Linked unit'}: ${s.guestName}`,
                      })),
                    ...property.blocks
                      .filter((b) => b.unitId && linkedIds.has(b.unitId))
                      .map((b) => ({
                        from: b.startDate,
                        to: b.endDate,
                        label: `${unitsById.get(b.unitId!)?.name ?? 'Linked unit'}: ${BLOCK_KIND_LABELS[b.kind].toLowerCase()}`,
                      })),
                  ]
                : [];
              return renderTrackRow(
                property,
                roomType,
                unit,
                property.stays.filter((s) => s.unitId === unit.id),
                property.blocks.filter((b) => b.unitId === unit.id),
                ghosts,
              );
            })}
          </>
        )}
      </div>
    );
  };

  return (
    <div
      className={cn(
        'relative w-max min-w-full select-none',
        (barDrag?.moved || selectDrag) && 'cursor-grabbing',
      )}
      role="grid"
      aria-label="Reservations calendar"
    >
      <DayHeader dates={dates} cellWidth={cellWidth} labelWidth={labelWidth} today={today} />
      <div ref={bodyRef} className="relative">
        {/* Column shading for weekends and today, drawn once behind every row. */}
        <div
          className="pointer-events-none absolute inset-y-0 z-0 flex"
          style={{ left: labelWidth }}
          aria-hidden
        >
          {dates.map((date) => {
            const dow = dayOfWeek(date);
            return (
              <div
                key={date}
                className={cn(
                  'shrink-0 border-r border-line/60',
                  date === today ? 'bg-brand-100/50' : dow === 0 || dow === 6 ? 'bg-sunken/70' : '',
                )}
                style={{ width: cellWidth }}
              />
            );
          })}
        </div>
        {calendar.properties.map((property) => {
          const isCollapsed = collapsed.has(property.id);
          return (
            <section key={property.id} aria-label={property.name}>
              <div className="relative z-10 flex h-9 border-b border-line-strong bg-surface">
                <button
                  type="button"
                  onClick={() => props.onToggle(property.id)}
                  aria-expanded={!isCollapsed}
                  className="sticky left-0 z-20 flex items-center gap-1.5 bg-surface px-3 text-left"
                >
                  {isCollapsed ? (
                    <ChevronRight className="size-4 text-ink-faint" aria-hidden />
                  ) : (
                    <ChevronDown className="size-4 text-ink-faint" aria-hidden />
                  )}
                  <span className="text-sm font-semibold whitespace-nowrap text-ink">
                    {property.name}
                  </span>
                  <span className="rounded bg-sunken px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-ink-faint uppercase">
                    {property.kind}
                  </span>
                </button>
              </div>
              {!isCollapsed &&
                (property.roomTypes.length === 0 ? (
                  <p className="sticky left-0 z-10 w-max px-4 py-3 text-[13px] text-ink-faint">
                    No room types yet. Add them under Settings.
                  </p>
                ) : (
                  property.roomTypes.map((roomType) => renderRoomType(property, roomType))
                ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}
