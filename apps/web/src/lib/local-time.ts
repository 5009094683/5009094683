const pad = (value: number) => String(value).padStart(2, '0');

/** A moment as a `datetime-local` input wants it: `2026-12-01T09:30`, in the viewer's own time zone. */
export function toLocalInput(value: string | Date | null): string {
  if (!value) return '';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** What a `datetime-local` input holds, as the moment it means in the viewer's own time zone. */
export function fromLocalInput(text: string): string | null {
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
