'use client';

import { useCallback, useState } from 'react';
import { cn } from '@/lib/cn';
import { PlaceholderArt } from './placeholder-art';

export interface PhotoProps {
  /** Missing or failing to load, the placeholder is shown in its place. */
  src: string | undefined;
  alt: string;
  /** What the placeholder's colours are drawn from. */
  name: string;
  /** Writes the name on the placeholder. */
  caption?: boolean;
  /** Load at once: for the one photo at the top of a page. */
  eager?: boolean;
  className?: string;
}

/**
 * Fills its parent, which gives it a fixed aspect ratio so that the page does
 * not move when the photo arrives. Photos live on hosts we do not know, so
 * they are plain `<img>` tags that never send a referrer.
 */
export function Photo({ src, alt, name, caption, eager = false, className }: PhotoProps) {
  const [failed, setFailed] = useState(false);

  // A photo can fail before the page is interactive, when no handler is listening yet.
  const check = useCallback((img: HTMLImageElement | null) => {
    if (img && img.complete && img.naturalWidth === 0) setFailed(true);
  }, []);

  if (!src || failed) {
    return <PlaceholderArt name={name} caption={caption} className={className} />;
  }

  return (
    <img
      ref={check}
      src={src}
      alt={alt}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={cn('h-full w-full bg-sunken object-cover', className)}
    />
  );
}
