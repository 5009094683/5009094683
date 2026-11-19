import { Images } from 'lucide-react';
import { cn } from '@/lib/cn';
import { usablePhotos } from '@/lib/photos';
import { Photo } from './photo';
import { PlaceholderArt } from './placeholder-art';

/** How the first photos are laid out on a wide screen: the first is always the large one. */
const MOSAIC: Record<number, { grid: string; cells: string[] }> = {
  2: { grid: 'grid-cols-3 grid-rows-1', cells: ['col-span-2', ''] },
  3: { grid: 'grid-cols-3 grid-rows-2', cells: ['col-span-2 row-span-2', '', ''] },
  4: { grid: 'grid-cols-4 grid-rows-2', cells: ['col-span-2 row-span-2', 'col-span-2', '', ''] },
  5: { grid: 'grid-cols-4 grid-rows-2', cells: ['col-span-2 row-span-2', '', '', '', ''] },
};

export interface GalleryProps {
  name: string;
  photos: readonly string[];
}

/**
 * The photos at the top of a property's page. A row to swipe through on a
 * phone, a mosaic on a wide screen. Nothing moves by itself.
 */
export function Gallery({ name, photos }: GalleryProps) {
  const usable = usablePhotos(photos);
  const frame = 'aspect-[16/10] overflow-hidden rounded-2xl shadow-card sm:aspect-[21/9]';

  if (usable.length === 0) {
    return (
      <div className={frame}>
        <PlaceholderArt name={name} caption />
      </div>
    );
  }
  if (usable.length === 1) {
    return (
      <div className={frame}>
        <Photo src={usable[0]} alt={name} name={name} caption eager />
      </div>
    );
  }

  const alt = (index: number) => `${name}, photo ${index + 1} of ${usable.length}`;
  const shown = Math.min(usable.length, 5);
  const mosaic = MOSAIC[shown] ?? MOSAIC[5];
  const rest = usable.slice(shown);

  return (
    <div>
      <div
        role="group"
        aria-label={`Photos of ${name}`}
        tabIndex={0}
        className="-mx-4 flex snap-x snap-mandatory scroll-px-4 gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:-mx-6 sm:scroll-px-6 sm:px-6 lg:hidden [&::-webkit-scrollbar]:hidden"
      >
        {usable.map((src, index) => (
          <div
            key={`${index}:${src}`}
            className="aspect-[4/3] w-[88%] shrink-0 snap-start overflow-hidden rounded-2xl shadow-card sm:w-[62%]"
          >
            <Photo src={src} alt={alt(index)} name={name} caption eager={index === 0} />
          </div>
        ))}
      </div>

      <div
        className={cn(
          'hidden h-[27rem] gap-2 overflow-hidden rounded-2xl shadow-card lg:grid',
          mosaic?.grid,
        )}
      >
        {usable.slice(0, shown).map((src, index) => (
          <div key={`${index}:${src}`} className={cn('min-h-0 min-w-0', mosaic?.cells[index])}>
            <Photo src={src} alt={alt(index)} name={name} caption eager={index === 0} />
          </div>
        ))}
      </div>

      {rest.length > 0 ? (
        <details className="group mt-3 hidden lg:block">
          <summary className="inline-flex min-h-11 items-center gap-2 rounded-lg px-3 text-[15px] font-medium text-ink-soft hover:bg-sunken hover:text-ink">
            <Images className="size-4" aria-hidden />
            <span className="group-open:hidden">Show all {usable.length} photos</span>
            <span className="hidden group-open:inline">Show fewer photos</span>
          </summary>
          <div className="mt-2 grid grid-cols-3 gap-2">
            {rest.map((src, index) => (
              <div key={`${index}:${src}`} className="aspect-[4/3] overflow-hidden rounded-xl">
                <Photo src={src} alt={alt(shown + index)} name={name} />
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}
