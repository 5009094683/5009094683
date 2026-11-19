'use client';

import { cn } from '@/lib/cn';
import { useWidth } from './chart-parts';

export interface Share {
  key: string;
  name: string;
  /** Its part of the whole, in basis points. */
  basisPoints: number;
  /** The same as it is written: `42.6%`. */
  text: string;
  /** A `fill-…` class. */
  fill: string;
}

/** The colours booking sites have on the calendar, so that a site looks the same everywhere. */
const SITE_FILLS: Record<string, string> = {
  BDC: 'fill-src-bdc',
  ABB: 'fill-src-abb',
  EXP: 'fill-src-exp',
  AGO: 'fill-src-ago',
  MMT: 'fill-src-mmt',
  GOI: 'fill-src-mmt',
};

/** For bookings that did not come through a site: shades of one colour, dark and light by turns. */
const OWN_FILLS = [
  'fill-brand-700',
  'fill-brand-400',
  'fill-brand-900',
  'fill-brand-300',
  'fill-brand-600',
  'fill-brand-200',
  'fill-brand-800',
  'fill-brand-500',
];

/** A colour for each source, in the order given. */
export function sourceFills(
  sources: { key: string; channelCode: string | null }[],
): Map<string, string> {
  const fills = new Map<string, string>();
  let own = 0;
  for (const source of sources) {
    fills.set(
      source.key,
      source.channelCode
        ? (SITE_FILLS[source.channelCode.toUpperCase()] ?? 'fill-src-other')
        : OWN_FILLS[own++ % OWN_FILLS.length]!,
    );
  }
  return fills;
}

/** The dot that stands for a source beside its name. */
export function SourceDot({ fill, className }: { fill: string; className?: string }) {
  return (
    <svg width="10" height="10" aria-hidden className={cn('shrink-0', className)}>
      <circle cx="5" cy="5" r="5" className={fill} />
    </svg>
  );
}

const HEIGHT = 18;
const GAP = 2;

/** One bar divided by share, with the name and share of each part beneath it. */
export function ShareBar({ label, shares }: { label: string; shares: Share[] }) {
  const [ref, width] = useWidth();
  const drawn = shares.filter((share) => share.basisPoints > 0);
  const whole = drawn.reduce((sum, share) => sum + share.basisPoints, 0);
  const room = Math.max(0, width - GAP * (drawn.length - 1));
  let x = 0;
  const parts = drawn.map((share) => {
    const part = { share, x, width: Math.max(1, (share.basisPoints / whole) * room) };
    x += part.width + GAP;
    return part;
  });

  return (
    <div>
      <div ref={ref} style={{ height: HEIGHT }}>
        {width > 0 && (
          <svg
            role="img"
            aria-label={`${label}: ${drawn.map((share) => `${share.name} ${share.text}`).join(', ')}`}
            width={width}
            height={HEIGHT}
            viewBox={`0 0 ${width} ${HEIGHT}`}
            className="block"
          >
            {parts.map((part) => (
              <rect
                key={part.share.key}
                x={part.x}
                y={0}
                width={part.width}
                height={HEIGHT}
                rx={Math.min(3, part.width / 2)}
                className={part.share.fill}
              >
                <title>{`${part.share.name}: ${part.share.text}`}</title>
              </rect>
            ))}
          </svg>
        )}
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[13px] text-ink-soft">
        {drawn.map((share) => (
          <li key={share.key} className="flex items-center gap-1.5">
            <SourceDot fill={share.fill} />
            {share.name}
            <span className="tabular font-medium text-ink">{share.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
