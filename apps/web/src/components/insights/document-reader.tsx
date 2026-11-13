'use client';

import { ScanText } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { todayIn } from '@pms/domain/shared';
import { useAiStatus } from '@/components/assistant/ai-status';
import { calmErrorMessage, isRateLimited } from '@/components/assistant/errors';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Notice } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { Reservation } from '@/lib/types';
import {
  PHOTO_TYPES,
  countryName,
  fieldProblems,
  fieldsFrom,
  guestPatch,
  hasExpired,
  nothingRead,
  photoProblem,
  readCaptureAnswer,
  type IdentityFields,
} from './id-capture';
import type { IdCapture } from './types';

type Guest = NonNullable<Reservation['guest']>;

const DOCUMENT_LABELS: Record<NonNullable<IdCapture['documentType']>, string> = {
  passport: 'Passport',
  aadhaar: 'Aadhaar card',
  driving_licence: 'Driving licence',
  voter_id: 'Voter ID card',
  national_id: 'National identity card',
  other: 'Other document',
};

/**
 * Sends the photo itself as the request body, which `api()` cannot do: it only speaks JSON.
 * Failures become the same `ApiError`s, with the server's own message.
 */
async function readDocument(
  reservationId: string,
  photo: File,
  signal: AbortSignal,
): Promise<IdCapture> {
  let response: Response;
  try {
    response = await fetch(`/api/reservations/${reservationId}/id-capture`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': photo.type },
      body: photo,
      signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(
      0,
      'network',
      'Could not reach the server. Check your connection and try again.',
    );
  }
  const answer = readCaptureAnswer(response.status, await response.text());
  if ('failure' in answer) {
    const { status, code, message, details } = answer.failure;
    throw new ApiError(status, code, message, details);
  }
  return answer.capture;
}

function Reader({
  reservationId,
  guest,
  canSave,
  onSaved,
}: {
  reservationId: string;
  guest: Guest;
  canSave: boolean;
  onSaved: () => void;
}) {
  const toast = useToast();
  const headingId = useId();
  const group = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);
  const [reading, setReading] = useState(false);
  const [problem, setProblem] = useState<{ message: string; calm: boolean } | null>(null);
  const [capture, setCapture] = useState<IdCapture | null>(null);
  const [fields, setFields] = useState<IdentityFields | null>(null);
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // A reading still under way when the dialog closes has nowhere to go.
  useEffect(() => () => request.current?.abort(), []);

  const read = async (photo: File) => {
    setSaved(false);
    const wrong = photoProblem(photo);
    if (wrong) {
      setProblem({ message: wrong, calm: false });
      return;
    }
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setReading(true);
    setProblem(null);
    try {
      const result = await readDocument(reservationId, photo, controller.signal);
      setCapture(result);
      setFields(fieldsFrom(result));
      setTried(false);
      setSaveError(null);
    } catch (err) {
      if (!controller.signal.aborted) {
        setProblem({ message: calmErrorMessage(err), calm: isRateLimited(err) });
      }
    } finally {
      if (request.current === controller) {
        request.current = null;
        setReading(false);
      }
    }
  };

  const discard = () => {
    setCapture(null);
    setFields(null);
    setSaveError(null);
    // The buttons under the fields go with them: the keyboard moves to the control that stays.
    group.current?.querySelector<HTMLButtonElement>('button')?.focus();
  };

  const today = todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const problems = fields ? fieldProblems(fields, today) : {};
  const patch = fields ? guestPatch(fields) : {};

  const save = async () => {
    setTried(true);
    if (Object.keys(problems).length > 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api(`/guests/${guest.id}`, { method: 'PATCH', body: patch });
      toast.success('Identity details saved', `They are on the profile of ${guest.name}.`);
      discard();
      setSaved(true);
      onSaved();
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const set = (key: keyof IdentityFields) => (event: { target: { value: string } }) => {
    if (fields) setFields({ ...fields, [key]: event.target.value });
  };

  // These fields sit inside the check-in form, where Enter in a field would check the guest in.
  const keepEnterHere = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) event.preventDefault();
  };

  return (
    <div
      ref={group}
      role="group"
      aria-labelledby={headingId}
      onKeyDown={keepEnterHere}
      className="flex flex-col gap-3 rounded-lg border border-line p-3"
    >
      <div className="flex flex-col gap-1.5">
        <p id={headingId} className="text-sm font-medium text-ink">
          Identity document
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            icon={<ScanText className="size-4" aria-hidden />}
            loading={reading}
            onClick={() => picker.current?.click()}
          >
            {capture ? 'Read another photo' : 'Read from photo'}
          </Button>
          {reading && (
            <span role="status" className="text-[13px] text-ink-soft">
              Reading the document…
            </span>
          )}
        </div>
        <input
          ref={picker}
          type="file"
          accept={PHOTO_TYPES.join(',')}
          className="hidden"
          onChange={(event) => {
            const photo = event.target.files?.[0];
            // Cleared so that choosing the same photo again counts as a change.
            event.target.value = '';
            if (photo) void read(photo);
          }}
        />
        <p className="text-[13px] text-ink-soft">
          The photo is sent to the AI service to be read and is not stored. Only the details you
          save are kept, on the guest&apos;s profile.
        </p>
        <p className="text-xs text-ink-faint">A JPEG, PNG or WebP photo of up to 8 MB.</p>
      </div>

      {problem && <Notice tone={problem.calm ? 'warning' : 'danger'}>{problem.message}</Notice>}

      {capture && fields && nothingRead(capture) && (
        <Notice tone="warning" title="Nothing could be read from this photo">
          Take a photo of the side that shows the guest&apos;s details, in good light and without
          glare, and read it again.
        </Notice>
      )}

      {capture && fields && !nothingRead(capture) && (
        <>
          {capture.legible ? (
            <Notice tone="info" title="Check these against the document">
              The AI service read them from the photo and can be wrong. Correct anything that
              differs, then save.
            </Notice>
          ) : (
            <Notice tone="warning" title="The photo could not be read reliably">
              Compare every detail with the document itself and correct it, or take a clearer photo
              and read it again.
            </Notice>
          )}
          {capture.fullName && (
            <p className="text-[13px] text-ink-soft">
              Name on the document: <span className="font-medium text-ink">{capture.fullName}</span>
              . The booking is for {guest.name}.
            </p>
          )}
          <Field label="Kind of document" error={tried ? problems.idType : null}>
            {(props) => (
              <Select {...props} value={fields.idType} onChange={set('idType')}>
                <option value="">Choose…</option>
                {Object.entries(DOCUMENT_LABELS).map(([type, label]) => (
                  <option key={type} value={type}>
                    {label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label="Document number"
            error={tried ? problems.idNumber : null}
            hint={
              guest.hasIdNumber
                ? 'A number is already on the profile. Saving replaces it.'
                : 'Stored encrypted.'
            }
          >
            {(props) => (
              <Input
                {...props}
                value={fields.idNumber}
                onChange={set('idNumber')}
                maxLength={60}
                autoComplete="off"
                spellCheck={false}
              />
            )}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Nationality"
              hint={
                countryName(fields.nationality) ??
                (fields.nationality.trim() === '' ? 'A country code such as IN.' : undefined)
              }
            >
              {(props) => (
                <Input
                  {...props}
                  value={fields.nationality}
                  onChange={set('nationality')}
                  maxLength={60}
                  autoComplete="off"
                />
              )}
            </Field>
            <Field label="Date of birth" error={tried ? problems.dateOfBirth : null}>
              {(props) => (
                <Input
                  {...props}
                  type="date"
                  max={today}
                  value={fields.dateOfBirth}
                  onChange={set('dateOfBirth')}
                />
              )}
            </Field>
          </div>
          <Field
            label="Valid until"
            optional
            hint={
              hasExpired(fields, today) ? (
                <span className="text-warning-700">
                  This date has passed: the document is no longer valid.
                </span>
              ) : undefined
            }
          >
            {(props) => (
              <Input {...props} type="date" value={fields.idExpiry} onChange={set('idExpiry')} />
            )}
          </Field>
          {saveError && (
            <Notice tone="danger" title="Could not save the identity details">
              {saveError}
            </Notice>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button onClick={discard} disabled={saving}>
              Discard
            </Button>
            {canSave && (
              <Button
                variant="primary"
                loading={saving}
                disabled={Object.keys(patch).length === 0}
                onClick={() => void save()}
              >
                Save to the guest&apos;s profile
              </Button>
            )}
          </div>
          <p className="text-xs text-ink-faint">
            {canSave
              ? 'Checking in does not save these details. Save them here first.'
              : 'Saving to a guest profile is for people who may change guest details.'}
          </p>
        </>
      )}

      {saved && (
        <p role="status" className="text-[13px] text-success-700">
          The identity details are on the profile of {guest.name}.
        </p>
      )}
    </div>
  );
}

/**
 * "Read from photo" in the check-in dialog: reads an identity document with the AI service and
 * offers what it read for checking, correcting and saving to the guest's profile. It appears
 * only where the installation has switched document reading on and the person may both see
 * identity details and use the AI features.
 */
export function DocumentReader({
  reservation,
  onSaved,
}: {
  reservation: Reservation;
  /** Called once the details are on the guest's profile. */
  onSaved: () => void;
}) {
  const auth = useAuth();
  const guest = reservation.guest;
  const allowed =
    guest !== null &&
    auth.can('guests.pii', reservation.propertyId) &&
    auth.can('ai.use', reservation.propertyId);
  const status = useAiStatus(allowed);
  if (!guest || !allowed || !status?.documentCapture) return null;
  return (
    <Reader
      key={guest.id}
      reservationId={reservation.id}
      guest={guest}
      canSave={auth.can('guests.write')}
      onSaved={onSaved}
    />
  );
}
