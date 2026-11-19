'use client';

import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { CopyField } from './fields';

/** Shows a single-use link (an invitation, a password reset) for the admin to hand over. */
export function LinkDialog({
  title,
  label,
  link,
  children,
  onClose,
}: {
  title: string;
  label: string;
  link: string;
  /** What the link is for and how it reaches the user. */
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        {children}
        <CopyField label={label} value={link} />
      </div>
    </Dialog>
  );
}
