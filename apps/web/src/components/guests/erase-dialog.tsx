'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import { Notice } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import type { Guest } from '@/lib/types';

/** The word that confirms an erasure as well as the guest's name does. */
const WORD = 'ERASE';

const plain = (text: string): string => text.trim().replace(/\s+/g, ' ').toLocaleLowerCase();

/**
 * Asks before a guest's personal data is erased: says what goes and what stays, and wants the
 * guest's name typed, because nothing brings the data back. Stays open with the server's
 * message when the erasure is refused, as it is while the guest has a stay under way or to come.
 */
export function EraseDialog({
  guest,
  onClose,
  onErased,
}: {
  guest: Guest;
  onClose: () => void;
  onErased: () => Promise<void>;
}) {
  const [typed, setTyped] = useState('');
  // As it was when the dialog opened: the profile is read again, nameless, just before it closes.
  const [name] = useState(guest.name);
  const confirmed = plain(typed) === plain(name) || typed.trim() === WORD;

  const erase = useAction(async () => {
    await api(`/guests/${guest.id}/erase`, { method: 'POST' });
    await onErased();
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Erase the personal data of ${name}?`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            form="erase-guest-form"
            variant="danger"
            disabled={!confirmed}
            loading={erase.busy}
          >
            Erase personal data
          </Button>
        </>
      }
    >
      <form
        id="erase-guest-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (confirmed) void erase.run();
        }}
        className="flex flex-col gap-3"
      >
        {erase.error && <Notice tone="danger">{erase.error}</Notice>}
        <div className="flex flex-col gap-3 text-sm text-ink-soft">
          <div>
            <p className="font-medium text-ink">What is removed</p>
            <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-5 marker:text-ink-faint">
              <li>
                Name, email, phone, address, date of birth, nationality, company and GSTIN, identity
                document details, notes, preferences and tags.
              </li>
              <li>All conversations with the guest.</li>
              <li>The special requests, notes and arrival times on their stays.</li>
              <li>Their documents, and what they entered at online check-in.</li>
              <li>Their name and address on their own bills.</li>
              <li>What the booking sites sent about their bookings.</li>
              <li>Their name on reviews, on alerts and in the audit trail.</li>
            </ul>
          </div>
          <div>
            <p className="font-medium text-ink">What is kept</p>
            <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-5 marker:text-ink-faint">
              <li>
                The stays themselves, with their dates, rooms and amounts, but without a name: they
                show as “Former guest”. The books and the statistics need them.
              </li>
              <li>
                Tax invoices, exactly as they were issued, with the name and address on them. The
                law requires them to be kept unchanged, and that comes before a request to erase.
              </li>
            </ul>
          </div>
        </div>
        <Notice tone="warning" title="This cannot be undone">
          Once erased, the details cannot be brought back or filled in again.
        </Notice>
        <Field label={`To confirm, type the guest’s name (${name}) or the word ${WORD}`}>
          {(props) => (
            <Input
              {...props}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
