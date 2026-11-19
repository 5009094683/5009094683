import type { ReactNode } from 'react';

/** A message as the guest will read it: the subject of an email, then the text. */
export function MessagePreview({
  subject,
  body,
  label = 'The message',
}: {
  /** Shown above the text. Leave out for a message that has no subject line. */
  subject?: ReactNode;
  body: string;
  label?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="rounded-lg border border-line bg-sunken/60 text-sm text-ink"
    >
      {subject && (
        <p className="border-b border-line px-3 py-2 font-medium break-words">
          <span className="font-normal text-ink-faint">Subject: </span>
          {subject}
        </p>
      )}
      <p className="px-3 py-2.5 break-words whitespace-pre-wrap">{body}</p>
    </div>
  );
}
