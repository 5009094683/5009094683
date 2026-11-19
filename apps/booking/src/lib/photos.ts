/** Photo addresses are typed in by the property's staff: only web addresses are shown. */
export function usablePhotos(photos: readonly string[]): string[] {
  return photos.filter((url) => /^https?:\/\/\S+$/i.test(url) || /^\/[^/\s]\S*$/.test(url));
}
