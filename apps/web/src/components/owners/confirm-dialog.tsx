'use client';

import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/misc';
import { useAction } from '@/lib/hooks';

/**
 * Asks before something that cannot be taken back. Stays open with the
 * server's own words when the action is refused; the caller closes it on
 * success.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  dismissLabel = 'Cancel',
  tone = 'danger',
  onConfirm,
  onClose,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  /** For when the thing being confirmed is itself a cancellation, and "Cancel" would be unclear. */
  dismissLabel?: string;
  /** `danger` when the action takes something away, `primary` when it moves things forward. */
  tone?: 'danger' | 'primary';
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const confirm = useAction(onConfirm);

  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={title}
      footer={
        <>
          <Button onClick={onClose}>{dismissLabel}</Button>
          <Button type="submit" form="owners-confirm-form" variant={tone} loading={confirm.busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form
        id="owners-confirm-form"
        onSubmit={(event) => {
          event.preventDefault();
          void confirm.run();
        }}
        className="flex flex-col gap-3"
      >
        {confirm.error && <Notice tone="danger">{confirm.error}</Notice>}
        <div className="flex flex-col gap-2 text-sm text-ink-soft">{children}</div>
      </form>
    </Dialog>
  );
}
