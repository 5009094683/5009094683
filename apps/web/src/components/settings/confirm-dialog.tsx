'use client';

import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/misc';
import { useAction } from '@/lib/hooks';

/**
 * Asks before an action that takes something away. Stays open with the
 * server's message when the action fails; the caller closes it on success.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
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
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="confirm-form" variant="danger" loading={confirm.busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form
        id="confirm-form"
        onSubmit={(event) => {
          event.preventDefault();
          void confirm.run();
        }}
        className="flex flex-col gap-3"
      >
        {confirm.error && <Notice tone="danger">{confirm.error}</Notice>}
        <div className="text-sm text-ink-soft">{children}</div>
      </form>
    </Dialog>
  );
}
