'use client';

import { useCallback, useState } from 'react';

export interface Axis {
  /** The value at the top of the axis. */
  max: number;
  ticks: { value: number; label: string }[];
}

const ROUND_STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

/**
 * An axis from nought to a round figure at or above `highest`, marked in equal steps of a
 * round size (0, 25, 50 rather than 0, 23, 46). `whole` keeps the steps to whole numbers, for
 * things that are counted. Two axes with the same number of steps share their grid lines.
 */
export function roundAxis(
  highest: number,
  label: (value: number) => string,
  { steps = 4, whole = false }: { steps?: number; whole?: boolean } = {},
): Axis {
  const rough = highest > 0 ? highest / steps : 1;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step =
    ROUND_STEPS.map((multiple) => multiple * magnitude).find(
      (candidate) => candidate >= rough && (!whole || Number.isInteger(candidate)),
    ) ?? 10 * magnitude;
  return {
    max: step * steps,
    ticks: Array.from({ length: steps + 1 }, (_, index) => ({
      value: index * step,
      label: label(index * step),
    })),
  };
}

/**
 * The width of an element as it is laid out, kept up to date as the page is resized. A chart
 * drawn to its real width keeps its lettering readable on a phone, which a drawing scaled down
 * to fit does not. Nought until the element is on the page.
 */
export function useWidth(): [(node: HTMLElement | null) => (() => void) | undefined, number] {
  const [width, setWidth] = useState(0);
  const ref = useCallback((node: HTMLElement | null) => {
    if (!node) return undefined;
    setWidth(node.clientWidth);
    const observer = new ResizeObserver(() => setWidth(node.clientWidth));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** Roughly how wide a label is in the charts' lettering, which is 11px unless said otherwise. */
export function textWidth(text: string, size = 11): number {
  return text.length * size * 0.555;
}

/** As much of a label as fits a width, the rest cut off with an ellipsis. */
export function fitText(text: string, width: number, size = 11): string {
  const letters = Math.max(4, Math.floor(width / (size * 0.555)));
  return text.length <= letters ? text : `${text.slice(0, letters - 1).trimEnd()}…`;
}
