'use client';

import { ExternalLink, Eye, EyeOff, FileText } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Drawer } from '@/components/ui/dialog';
import { Badge, Notice } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDate, formatDateTime, plural } from '@/lib/format';
import { useAction } from '@/lib/hooks';
import type { Reservation } from '@/lib/types';
import {
  CHECKIN_LABELS,
  CHECKIN_TONES,
  checkinTimes,
  countryName,
  fileSize,
  idTypeLabel,
} from './checkin-words';
import { IntoView } from './into-view';
import type { Checkin, CheckinFile, CheckinPerson } from './types';

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-ink-faint">{label}</dt>
      <dd className="min-w-0 break-words text-ink">{children}</dd>
    </>
  );
}

function Person({ person, revealed }: { person: CheckinPerson; revealed: boolean }) {
  const idType = idTypeLabel(person.idType);
  const idNumber = revealed ? person.idNumber : person.idNumberEnding;
  const rows: [string, ReactNode][] = [];
  if (person.nationality) rows.push(['Nationality', countryName(person.nationality)]);
  if (person.dateOfBirth) rows.push(['Date of birth', formatDate(person.dateOfBirth)]);
  if (idType) rows.push(['Identity document', idType]);
  if (idNumber) {
    rows.push([
      revealed ? 'Document number' : 'Document number ends',
      <span key="number" className="font-mono">
        {idNumber}
      </span>,
    ]);
  }
  if (person.idExpiry) rows.push(['Document valid until', formatDate(person.idExpiry)]);
  if (person.address) rows.push(['Address', person.address]);
  if (revealed && person.visaNumber) {
    rows.push([
      'Visa number',
      <span key="visa" className="font-mono">
        {person.visaNumber}
      </span>,
    ]);
  }
  if (person.visaExpiry) rows.push(['Visa valid until', formatDate(person.visaExpiry)]);
  if (person.arrivedInCountryOn) {
    rows.push(['Arrived in the country', formatDate(person.arrivedInCountryOn)]);
  }
  if (person.arrivingFrom) rows.push(['Arriving from', person.arrivingFrom]);
  if (person.nextDestination) rows.push(['Going on to', person.nextDestination]);

  return (
    <li className="rounded-lg border border-line p-3">
      <p className="text-sm font-semibold break-words text-ink">{person.name}</p>
      {rows.length === 0 ? (
        <p className="mt-1 text-[13px] text-ink-faint">No other details given.</p>
      ) : (
        <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
          {rows.map(([label, value]) => (
            <Detail key={label} label={label}>
              {value}
            </Detail>
          ))}
        </dl>
      )}
    </li>
  );
}

function Documents({
  reservationId,
  files,
  canOpen,
}: {
  reservationId: string;
  files: CheckinFile[];
  canOpen: boolean;
}) {
  if (files.length === 0) {
    return <p className="text-[13px] text-ink-faint">No documents uploaded.</p>;
  }
  if (!canOpen) {
    return (
      <p className="text-[13px] text-ink-soft">
        {plural(files.length, 'document')} uploaded. Opening them takes access to guests&apos;
        identity details.
      </p>
    );
  }
  return (
    <>
      <ul className="divide-y divide-line rounded-lg border border-line text-[13px]">
        {files.map((file) => (
          <li key={file.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-2">
            <a
              href={`/api/reservations/${reservationId}/online-checkin/documents/${file.id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-w-0 items-center gap-1.5 font-medium text-brand-700 underline-offset-2 hover:underline"
            >
              <FileText className="size-3.5 shrink-0" aria-hidden />
              <span className="break-all">{file.fileName}</span>
              <ExternalLink className="size-3 shrink-0" aria-hidden />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
            <span className="ml-auto whitespace-nowrap text-ink-faint">
              {fileSize(file.size)} · {formatDateTime(file.createdAt)}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-[13px] text-ink-faint">
        Each time a document is opened, it is recorded in the audit trail.
      </p>
    </>
  );
}

/** What a guest sent in through online check-in, for the front desk to compare on arrival. */
export function CheckinDrawer({
  reservation,
  checkin,
  checkedBy,
  onClose,
  onVerified,
}: {
  reservation: Reservation;
  /** The answer with identity numbers masked, as everyone who may see the reservation gets it. */
  checkin: Checkin;
  /** Who marked it as checked, when that is known. */
  checkedBy?: string | null;
  onClose: () => void;
  onVerified: () => void;
}) {
  const auth = useAuth();
  const toast = useToast();
  const propertyId = reservation.propertyId;
  const canSeeIdentity = auth.can('guests.pii', propertyId);
  const canVerify = auth.can('frontdesk.operate', propertyId) && checkin.status === 'submitted';
  // Asked for once, on request: every answer with the numbers in full is written to the audit trail.
  const [full, setFull] = useState<Checkin | null>(null);
  const [refused, setRefused] = useState(false);

  const reveal = useAction(async () => {
    try {
      setFull(await api<Checkin>(`/reservations/${reservation.id}/online-checkin?reveal=true`));
    } catch (err) {
      // Not allowed after all: the numbers simply stay hidden.
      if (err instanceof ApiError && err.status === 403) setRefused(true);
      else throw err;
    }
  });

  const verify = useAction(async () => {
    await api(`/reservations/${reservation.id}/online-checkin/verify`, { method: 'POST' });
    toast.success('Online check-in marked as checked');
    onVerified();
  });

  const people = (full ?? checkin).guests;
  const hasNumbers = checkin.guests.some(
    (person) => person.idNumberEnding || person.visaExpiry || person.arrivedInCountryOn,
  );
  const times = checkinTimes(checkin, checkedBy);

  return (
    <Drawer
      open
      onClose={onClose}
      title="Online check-in"
      description={`${reservation.guestName}, booking ${reservation.code}`}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          {canVerify && (
            <Button variant="primary" loading={verify.busy} onClick={() => void verify.run()}>
              Mark as checked
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={CHECKIN_TONES[checkin.status]}>{CHECKIN_LABELS[checkin.status]}</Badge>
            {times && <span className="text-[13px] text-ink-soft">{times}</span>}
          </div>
          {checkin.arrivalTime && (
            <p className="text-sm text-ink">Expects to arrive at {checkin.arrivalTime}.</p>
          )}
          {checkin.signatureName && (
            <p className="text-[13px] text-ink-soft">
              House rules accepted by typing the name “{checkin.signatureName}”.
            </p>
          )}
        </div>

        {verify.error && (
          <IntoView>
            <Notice tone="danger">{verify.error}</Notice>
          </IntoView>
        )}
        {canVerify && (
          <Notice tone="info">
            Compare these details with the documents the guest shows on arrival, then mark them as
            checked. After that the guest can no longer change them.
          </Notice>
        )}

        <section className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-semibold tracking-wide text-ink-faint uppercase">
              Guests ({people.length})
            </h3>
            {canSeeIdentity &&
              !refused &&
              hasNumbers &&
              (full ? (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<EyeOff className="size-3.5" />}
                  onClick={() => setFull(null)}
                >
                  Hide the numbers
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Eye className="size-3.5" />}
                  loading={reveal.busy}
                  onClick={() => void reveal.run()}
                >
                  Show the numbers in full
                </Button>
              ))}
          </div>
          {reveal.error && <Notice tone="danger">{reveal.error}</Notice>}
          {people.length === 0 ? (
            <p className="text-[13px] text-ink-faint">The guest has not filled in any details.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {people.map((person, index) => (
                <Person key={index} person={person} revealed={Boolean(full)} />
              ))}
            </ul>
          )}
          {canSeeIdentity && !refused && hasNumbers && (
            <p className="text-[13px] text-ink-faint">
              {full
                ? 'Showing the numbers in full has been recorded in the audit trail.'
                : 'Document and visa numbers are hidden. Showing them in full is recorded in the audit trail.'}
            </p>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold tracking-wide text-ink-faint uppercase">
            Identity documents
          </h3>
          <Documents
            reservationId={reservation.id}
            files={checkin.documents}
            canOpen={canSeeIdentity && !refused}
          />
        </section>
      </div>
    </Drawer>
  );
}
