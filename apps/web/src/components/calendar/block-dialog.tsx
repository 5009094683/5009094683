'use client';

import { useState, type FormEvent } from 'react';
import { BLOCK_KIND_LABELS, addDays, isValidDate } from '@pms/domain/shared';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select } from '@/components/ui/field';
import { Notice } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { announceRelocations } from '@/lib/feedback';
import { formatStay } from '@/lib/format';
import type { BlockSaved, CalBlock, CalProperty } from '@/lib/types';

type Kind = keyof typeof BLOCK_KIND_LABELS;

const KIND_HELP: Record<Kind, string> = {
  block: 'Dates you do not want to sell.',
  maintenance: 'The unit cannot be used: repairs, deep cleaning.',
  owner_stay: 'The owner is using the property.',
  hold: 'Rooms kept back for a group or an enquiry.',
};

export interface BlockDraft {
  property: CalProperty;
  roomTypeId: string;
  /** Null blocks a number of rooms of the type rather than one unit. */
  unitId: string | null;
  from: string;
  to: string;
}

/** Creates a block from a date selection on the calendar. */
export function NewBlockDialog({
  draft,
  onClose,
  onSaved,
}: {
  draft: BlockDraft;
  onClose: () => void;
  onSaved: () => void;
}) {
  const auth = useAuth();
  const toast = useToast();
  const roomType = draft.property.roomTypes.find((t) => t.id === draft.roomTypeId);
  const unit = roomType?.units.find((u) => u.id === draft.unitId);
  const canMaintain = auth.can('maintenance.write', draft.property.id);
  const canBlock = auth.can('blocks.write', draft.property.id);
  const kinds = (Object.keys(BLOCK_KIND_LABELS) as Kind[]).filter((k) => {
    if (k === 'maintenance') return canMaintain && draft.unitId !== null;
    if (!canBlock) return false;
    if (k === 'owner_stay') return draft.property.kind === 'villa' && draft.unitId !== null;
    if (k === 'hold') return draft.unitId === null;
    return true;
  });

  const [kind, setKind] = useState<Kind>(kinds[0] ?? 'block');
  const [from, setFrom] = useState(draft.from);
  const [to, setTo] = useState(draft.to);
  const [quantity, setQuantity] = useState(1);
  const [reason, setReason] = useState('');
  const [force, setForce] = useState(false);
  const [relocate, setRelocate] = useState(false);
  /** What the server refused the block for, which decides the options offered next. */
  const [refusal, setRefusal] = useState<'occupied' | 'no_room_left' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canOverride = auth.can('reservations.override', draft.property.id);
  const canMoveStays =
    auth.can('reservations.write', draft.property.id) && roomType?.assignment === 'at_check_in';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const block = await api<BlockSaved>('/blocks', {
        body: {
          propertyId: draft.property.id,
          ...(draft.unitId ? { unitId: draft.unitId } : { roomTypeId: draft.roomTypeId, quantity }),
          kind,
          startDate: from,
          endDate: to,
          reason: reason.trim() || null,
          ...(force ? { force: true } : {}),
          ...(relocate ? { relocate: true } : {}),
        },
      });
      toast.success(
        `${BLOCK_KIND_LABELS[kind]}: ${unit?.name ?? roomType?.name}`,
        formatStay(from, to),
      );
      announceRelocations(toast, block);
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      if (err instanceof ApiError && err.code === 'unit_occupied') setRefusal('occupied');
      if (err instanceof ApiError && err.code === 'no_availability') setRefusal('no_room_left');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title="Block dates"
      description={`${draft.property.name} · ${unit?.name ?? roomType?.name ?? ''}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            form="block-form"
            variant="primary"
            loading={busy}
            disabled={kinds.length === 0}
          >
            Block dates
          </Button>
        </>
      }
    >
      <form id="block-form" onSubmit={submit} className="flex flex-col gap-3">
        {error && <Notice tone="danger">{error}</Notice>}
        {kinds.length === 0 ? (
          <Notice tone="warning">You do not have permission to block these dates.</Notice>
        ) : (
          <>
            <Field label="Type" hint={KIND_HELP[kind]}>
              {(props) => (
                <Select {...props} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
                  {kinds.map((k) => (
                    <option key={k} value={k}>
                      {BLOCK_KIND_LABELS[k]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="From">
                {(props) => (
                  <Input
                    {...props}
                    type="date"
                    value={from}
                    onChange={(e) => {
                      setFrom(e.target.value);
                      if (isValidDate(e.target.value) && to <= e.target.value)
                        setTo(addDays(e.target.value, 1));
                    }}
                    required
                  />
                )}
              </Field>
              <Field label="Back on sale" hint="The first night available again.">
                {(props) => (
                  <Input
                    {...props}
                    type="date"
                    value={to}
                    min={isValidDate(from) ? addDays(from, 1) : undefined}
                    onChange={(e) => setTo(e.target.value)}
                    required
                  />
                )}
              </Field>
            </div>
            {draft.unitId === null && (
              <Field label="Number of rooms">
                {(props) => (
                  <Input
                    {...props}
                    type="number"
                    min={1}
                    max={roomType?.units.length ?? 1}
                    value={quantity}
                    onChange={(e) => setQuantity(Math.max(1, Number(e.target.value) || 1))}
                    required
                  />
                )}
              </Field>
            )}
            <Field label="Reason" optional>
              {(props) => (
                <Input
                  {...props}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  maxLength={200}
                  placeholder="Shown on the calendar"
                />
              )}
            </Field>
            {refusal !== null && canMoveStays && draft.unitId !== null && (
              <Checkbox
                checked={relocate}
                onChange={(e) => setRelocate(e.target.checked)}
                label="Move the upcoming stays in this room to other free rooms of the same type."
              />
            )}
            {refusal === 'no_room_left' && canOverride && (
              <Checkbox
                checked={force}
                onChange={(e) => setForce(e.target.checked)}
                label="Block anyway. Reservations left without a room are flagged as overbooked."
              />
            )}
            <p className="text-[13px] text-ink-faint">
              The dates close on every connected channel as soon as you save.
            </p>
          </>
        )}
      </form>
    </Dialog>
  );
}

/** Edits or releases an existing block. */
export function EditBlockDialog({
  block,
  property,
  onClose,
  onSaved,
}: {
  block: CalBlock;
  property: CalProperty;
  onClose: () => void;
  onSaved: () => void;
}) {
  const auth = useAuth();
  const toast = useToast();
  const roomType = property.roomTypes.find((t) => t.id === block.roomTypeId);
  const unit = roomType?.units.find((u) => u.id === block.unitId);
  const editable = auth.can('blocks.write', property.id) && block.source === 'manual';
  const [from, setFrom] = useState(block.startDate);
  const [to, setTo] = useState(block.endDate);
  const [reason, setReason] = useState(block.reason ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'release' | null>(null);

  const run = async (kind: 'save' | 'release', action: () => Promise<unknown>, message: string) => {
    setBusy(kind);
    setError(null);
    try {
      await action();
      toast.success(message);
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(null);
    }
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    void run(
      'save',
      () =>
        api(`/blocks/${block.id}`, {
          method: 'PATCH',
          body: { startDate: from, endDate: to, reason: reason.trim() || null },
        }),
      'Block updated',
    );
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={BLOCK_KIND_LABELS[block.kind]}
      description={`${property.name} · ${unit?.name ?? `${block.quantity} × ${roomType?.name ?? ''}`}`}
      footer={
        editable ? (
          <>
            <Button
              variant="danger-ghost"
              className="mr-auto"
              loading={busy === 'release'}
              onClick={() =>
                void run(
                  'release',
                  () => api(`/blocks/${block.id}/release`, { method: 'POST' }),
                  'Dates are back on sale',
                )
              }
            >
              Release dates
            </Button>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              type="submit"
              form="edit-block-form"
              variant="primary"
              loading={busy === 'save'}
            >
              Save
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>Close</Button>
        )
      }
    >
      <form id="edit-block-form" onSubmit={save} className="flex flex-col gap-3">
        {error && <Notice tone="danger">{error}</Notice>}
        {block.source !== 'manual' && (
          <Notice tone="info">
            This block comes from{' '}
            {block.source === 'ical'
              ? 'a connected calendar feed'
              : `the ${block.source} integration`}
            . It updates on its own when the source changes.
          </Notice>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="From">
            {(props) => (
              <Input
                {...props}
                type="date"
                value={from}
                disabled={!editable}
                onChange={(e) => setFrom(e.target.value)}
                required
              />
            )}
          </Field>
          <Field label="Back on sale">
            {(props) => (
              <Input
                {...props}
                type="date"
                value={to}
                disabled={!editable}
                min={isValidDate(from) ? addDays(from, 1) : undefined}
                onChange={(e) => setTo(e.target.value)}
                required
              />
            )}
          </Field>
        </div>
        <Field label="Reason" optional>
          {(props) => (
            <Input
              {...props}
              value={reason}
              disabled={!editable}
              onChange={(e) => setReason(e.target.value)}
              maxLength={200}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
