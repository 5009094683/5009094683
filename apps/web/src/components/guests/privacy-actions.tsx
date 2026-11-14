'use client';

import { Download } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { useAuth } from '@/lib/auth';
import type { Guest } from '@/lib/types';
import { EraseDialog } from './erase-dialog';

const dayMonthYear = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

/**
 * What a guest may ask for about their own data: a copy of it, and to have it erased. Both
 * reach across every property, so both are for roles that do too; anyone else sees nothing
 * here. For a guest who has been erased it says so, to everyone, and offers nothing.
 */
export function PrivacyActions({
  guest,
  onErased,
}: {
  guest: Guest;
  /** Reads the profile again, and whatever else showed the guest's details. */
  onErased: () => Promise<void>;
}) {
  const auth = useAuth();
  const toast = useToast();
  const canCopy = auth.canOrgWide('guests.pii');
  const canErase = auth.canOrgWide('property.manage');
  const [erasing, setErasing] = useState(false);
  const [justErased, setJustErased] = useState(false);
  const erasedNote = useRef<HTMLDivElement>(null);

  // The button the dialog was opened from is gone once the guest is erased.
  useEffect(() => {
    if (justErased) erasedNote.current?.focus();
  }, [justErased]);

  if (!guest.anonymizedAt && !canCopy && !canErase) return null;

  return (
    <div ref={erasedNote} tabIndex={-1} className="rounded-lg border border-line p-3 outline-none">
      <p className="text-xs font-semibold tracking-wide text-ink-faint uppercase">Personal data</p>
      {guest.anonymizedAt ? (
        <>
          <p className="mt-1 text-sm text-ink">
            This guest’s personal data was erased on{' '}
            {dayMonthYear.format(new Date(guest.anonymizedAt))}.
          </p>
          <p className="mt-1 text-xs text-ink-faint">
            Their stays are kept without a name, and tax invoices as they were issued. The details
            cannot be filled in again.
          </p>
        </>
      ) : (
        <div className="mt-2 flex flex-col gap-3">
          {canCopy && (
            <div>
              <a
                href={`/api/guests/${guest.id}/export`}
                download
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line-strong bg-surface px-2.5 text-[13px] font-medium text-ink shadow-sm transition-colors select-none hover:bg-sunken active:bg-line"
              >
                <Download className="size-3.5" aria-hidden />
                Download a copy of this guest’s data
              </a>
              <p className="mt-1 text-xs text-ink-faint">
                For a guest who asks what is held about them. Each download is recorded in the audit
                trail.
              </p>
            </div>
          )}
          {canErase && (
            <div>
              <Button
                size="sm"
                variant="danger-ghost"
                className="-ml-2.5"
                onClick={() => setErasing(true)}
              >
                Erase this guest’s personal data
              </Button>
              <p className="mt-1 text-xs text-ink-faint">
                For a guest who asks to be forgotten. Their stays are kept without a name. It cannot
                be undone.
              </p>
            </div>
          )}
        </div>
      )}
      {erasing && (
        <EraseDialog
          guest={guest}
          onClose={() => setErasing(false)}
          onErased={async () => {
            await onErased();
            toast.success('Personal data erased', 'The stays are kept, without a name.');
            setJustErased(true);
            setErasing(false);
          }}
        />
      )}
    </div>
  );
}
