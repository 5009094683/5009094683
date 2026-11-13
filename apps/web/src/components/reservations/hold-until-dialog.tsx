'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import { Notice } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { fromLocalInput, toLocalInput } from '@/lib/local-time';
import type { Reservation } from '@/lib/types';

/** Moves the moment at which a held reservation is released. */
export function HoldUntilDialog({
  reservation,
  open,
  onClose,
  onDone,
}: {
  reservation: Reservation;
  open: boolean;
  onClose: () => void;
  onDone: (updated: Reservation) => void;
}) {
  const toast = useToast();
  const [until, setUntil] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setUntil(toLocalInput(reservation.holdExpiresAt));
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const updated = await api<Reservation>(`/reservations/${reservation.id}`, {
        method: 'PATCH',
        body: { holdUntil: fromLocalInput(until) },
      });
      toast.success(
        updated.holdExpiresAt
          ? `Held until ${formatDateTime(updated.holdExpiresAt)}`
          : 'Hold changed',
      );
      onDone(updated);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Hold until"
      description={`Reservation ${reservation.code} is cancelled by itself if it is not confirmed by then.`}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="hold-until-form" variant="primary" loading={busy}>
            Save
          </Button>
        </>
      }
    >
      <form id="hold-until-form" onSubmit={submit} className="flex flex-col gap-3">
        {error && <Notice tone="danger">{error}</Notice>}
        <Field label="Hold until" hint="The day of arrival at the latest.">
          {(props) => (
            <Input
              {...props}
              type="datetime-local"
              value={until}
              min={toLocalInput(new Date())}
              max={`${reservation.checkIn}T23:59`}
              onChange={(e) => setUntil(e.target.value)}
              required
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
