import { cn } from '@/lib/cn';

interface Palette {
  skyTop: string;
  skyBottom: string;
  sun: string;
  far: string;
  middle: string;
  near: string;
}

const PALETTES: [Palette, ...Palette[]] = [
  {
    skyTop: '#fdf3e3',
    skyBottom: '#f8dcc0',
    sun: '#f3b27f',
    far: '#93c7bd',
    middle: '#5ea69a',
    near: '#eedcbf',
  },
  {
    skyTop: '#f2f6f3',
    skyBottom: '#d9ebe5',
    sun: '#f5dc9b',
    far: '#a3cbc1',
    middle: '#6aa69a',
    near: '#f1e6cf',
  },
  {
    skyTop: '#faece6',
    skyBottom: '#f1d0c2',
    sun: '#ee9c7a',
    far: '#aebccd',
    middle: '#8195ae',
    near: '#efdcc6',
  },
  {
    skyTop: '#f6f3e4',
    skyBottom: '#e3eacf',
    sun: '#f1cd80',
    far: '#abc8a0',
    middle: '#7da874',
    near: '#eddcba',
  },
];

function seedOf(text: string): number {
  let seed = 0;
  for (let i = 0; i < text.length; i += 1) seed = (seed * 31 + text.charCodeAt(i)) >>> 0;
  return seed;
}

export interface PlaceholderArtProps {
  /** What the picture stands for. Its colours are drawn from the name. */
  name: string;
  /** Writes the name across the sky: for a property, whose name belongs on its picture. */
  caption?: boolean;
  className?: string;
}

/**
 * What stands in for a photo that is missing or does not load: a quiet shore
 * at an hour of its own. The same name always gets the same picture.
 */
export function PlaceholderArt({ name, caption = false, className }: PlaceholderArtProps) {
  const seed = seedOf(name);
  const palette = PALETTES[seed % PALETTES.length] ?? PALETTES[0];
  // Low on the horizon and off to one side, clear of the name in the middle of the sky.
  const side = (seed >>> 3) % 2 === 0 ? -1 : 1;
  const sunX = 200 + side * (84 + ((seed >>> 4) % 4) * 18);

  return (
    <div
      aria-hidden
      className={cn('@container relative h-full w-full overflow-hidden select-none', className)}
      style={{
        background: `linear-gradient(180deg, ${palette.skyTop} 0%, ${palette.skyBottom} 78%)`,
      }}
    >
      <svg
        viewBox="0 0 400 300"
        preserveAspectRatio="xMidYMax slice"
        className="absolute inset-0 h-full w-full"
        focusable="false"
      >
        <circle cx={sunX} cy="200" r="58" fill={palette.sun} opacity="0.16" />
        <circle cx={sunX} cy="200" r="36" fill={palette.sun} opacity="0.6" />
        <path
          d="M0 204 C 56 186, 122 220, 204 200 S 334 184, 400 204 V300 H0 Z"
          fill={palette.far}
          opacity="0.75"
        />
        <path
          d="M0 232 C 84 212, 148 250, 232 230 S 352 218, 400 236 V300 H0 Z"
          fill={palette.middle}
          opacity="0.6"
        />
        <path
          d="M0 266 C 72 250, 162 280, 252 262 S 362 256, 400 268 V300 H0 Z"
          fill={palette.near}
        />
      </svg>
      {caption ? (
        <p className="absolute inset-x-0 top-[12%] px-[6cqw] text-center font-display text-[clamp(1rem,6.4cqw,2.75rem)] leading-tight text-ink/70">
          {name}
        </p>
      ) : null}
    </div>
  );
}
