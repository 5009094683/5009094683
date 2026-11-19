'use client';

import { X } from 'lucide-react';
import { useEffect, useId, useRef, type MouseEvent, type ReactNode } from 'react';

export interface DialogProps {
  open: boolean;
  /** Asked for by Escape, the close button or a press outside. Refuse it by keeping `open` true. */
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** The buttons, shown below the content. */
  actions: ReactNode;
}

/**
 * A question the guest must answer before going on. Built on the native
 * `<dialog>`: the browser keeps focus inside it, hands focus back afterwards
 * and makes the rest of the page inert.
 */
export function Dialog({ open, onClose, title, children, actions }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const onBackdrop = (event: MouseEvent<HTMLDialogElement>) => {
    if (event.target === ref.current) onClose();
  };

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={onBackdrop}
      className="m-auto w-[min(30rem,calc(100vw-2rem))] rounded-2xl bg-surface p-0 text-ink shadow-pop backdrop:bg-ink/45"
    >
      <div className="flex items-start justify-between gap-4 px-5 pt-5 sm:px-6 sm:pt-6">
        <h2 id={titleId} className="font-display text-2xl leading-tight">
          {title}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="-mt-1.5 -mr-2 flex size-11 shrink-0 items-center justify-center rounded-full text-ink-soft hover:bg-sunken hover:text-ink"
        >
          <X className="size-5" aria-hidden />
        </button>
      </div>
      <div className="space-y-3 px-5 pt-3 text-[15px] text-ink-soft sm:px-6">{children}</div>
      <div className="flex flex-col-reverse gap-3 px-5 pt-6 pb-5 sm:flex-row sm:justify-end sm:px-6 sm:pb-6">
        {actions}
      </div>
    </dialog>
  );
}
