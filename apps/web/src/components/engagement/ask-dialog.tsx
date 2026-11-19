'use client';

import { useId, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/misc';
import { useAction } from '@/lib/hooks';

/**
 * Asks before something that cannot be taken back. Stays open with the server's message when
 * it fails; the caller closes it on success.
 */
export function AskDialog({
  title,
  children,
  confirmLabel,
  dismissLabel = 'Cancel',
  onConfirm,
  onClose,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  /** What the way out is called. "Cancel" would be ambiguous when the action itself cancels something. */
  dismissLabel?: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const formId = useId();
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
          <Button type="submit" form={formId} variant="danger" loading={confirm.busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form
        id={formId}
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
