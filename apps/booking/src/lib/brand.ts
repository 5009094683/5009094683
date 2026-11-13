import type { CSSProperties } from 'react';

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

const INK = '#1d2327';

function channels(hex: string): [number, number, number] {
  const digits = hex.slice(1);
  const full =
    digits.length === 3
      ? digits
          .split('')
          .map((digit) => digit + digit)
          .join('')
      : digits;
  const value = Number.parseInt(full, 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** Relative luminance as WCAG defines it: 0 is black, 1 is white. */
function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((channel) => {
    const share = channel / 255;
    return share <= 0.03928 ? share / 12.92 : ((share + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const contrast = (a: number, b: number): number =>
  (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/**
 * A property's own colour for the primary action, set as CSS variables on a
 * wrapper so that everything inside picks it up. Anything that is not a plain
 * hex colour is ignored and the site's own colour stays.
 *
 * The text on the button and the focus ring are chosen for contrast, so that a
 * pale brand colour cannot make either of them hard to see.
 */
export function brandStyle(color: string | null | undefined): CSSProperties | undefined {
  if (!color || !HEX.test(color)) return undefined;
  const mix = (share: number, other: 'white' | 'black') =>
    `color-mix(in srgb, ${color} ${share}%, ${other})`;
  const light = luminance(color);
  const onWhite = contrast(light, 1);
  const variables: Record<`--${string}`, string> = {
    '--color-brand-50': mix(8, 'white'),
    '--color-brand-100': mix(16, 'white'),
    '--color-brand-200': mix(34, 'white'),
    '--color-brand-500': mix(86, 'white'),
    '--color-brand-600': color,
    '--color-brand-700': mix(86, 'black'),
    '--color-brand-800': mix(72, 'black'),
    '--color-on-brand':
      onWhite >= 4.5 || onWhite >= contrast(light, luminance(INK)) ? '#ffffff' : INK,
    '--color-focus': onWhite >= 3 ? color : INK,
  };
  return variables as CSSProperties;
}
