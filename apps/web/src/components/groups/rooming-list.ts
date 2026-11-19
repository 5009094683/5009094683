export interface ListedGuest {
  firstName: string;
  lastName?: string;
  email?: string;
  phone?: string;
}

/**
 * Reads a rooming list as people type or paste it: one guest per line, the name first, then
 * an email address and a phone number in either order, separated by commas, semicolons or tabs.
 */
export function parseRoomingList(text: string): { guests: ListedGuest[]; unreadable: string[] } {
  const guests: ListedGuest[] = [];
  const unreadable: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const [name = '', ...rest] = line
      .split(/[,;\t]/)
      .map((part) => part.trim())
      .filter(Boolean);
    // A leading "1." or "12)" is the list's own numbering, not part of the name.
    const words = name
      .replace(/^\d+[.)]?\s+/, '')
      .split(/\s+/)
      .filter(Boolean);
    if (words.length === 0 || /@/.test(name) || !/\p{L}/u.test(name)) {
      unreadable.push(line);
      continue;
    }
    const email = rest.find((part) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(part));
    const phone = rest.find((part) => part !== email && /^\+?[\d\s().-]{6,}$/.test(part));
    guests.push({
      firstName: words[0]!,
      lastName: words.slice(1).join(' ') || undefined,
      email,
      phone,
    });
  }
  return { guests, unreadable };
}
