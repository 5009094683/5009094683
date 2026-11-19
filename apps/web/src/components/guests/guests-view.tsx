'use client';

import { Eye, FileDown, Mail, Phone, Search, Star, Users } from 'lucide-react';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import useSWR from 'swr';
import { Button } from '@/components/ui/button';
import { Drawer } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Textarea } from '@/components/ui/field';
import {
  Badge,
  EmptyState,
  ErrorState,
  Notice,
  PageHeader,
  PageLoading,
  STATUS_TONES,
} from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage, query } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { STATUS_LABELS, formatDate, formatMoney, formatStay, plural } from '@/lib/format';
import { useDebounced, useProperties } from '@/lib/hooks';
import type { Guest, Reservation } from '@/lib/types';
import { PrivacyActions } from './privacy-actions';
import { GuestRegisterDialog } from './register-dialog';

function GuestPanel({ guestId, onChanged }: { guestId: string; onChanged: () => void }) {
  const auth = useAuth();
  const toast = useToast();
  const { data, error, mutate } = useSWR<{ guest: Guest; stays: Reservation[] }>(
    `/guests/${guestId}`,
  );
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const [flags, setFlags] = useState({ vip: false, blacklisted: false, marketingConsent: false });
  const [idNumber, setIdNumber] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  if (error) return <ErrorState error={error} onRetry={() => void mutate()} />;
  if (!data) return <PageLoading />;
  const { guest, stays } = data;
  const canWrite = auth.can('guests.write') && !guest.anonymizedAt;
  const canSeeId = auth.can('guests.pii');

  const startEdit = () => {
    setForm({
      firstName: guest.firstName,
      lastName: guest.lastName,
      email: guest.email ?? '',
      phone: guest.phone ?? '',
      nationality: guest.nationality ?? '',
      company: guest.company ?? '',
      gstin: guest.gstin ?? '',
      idType: guest.idType ?? '',
      idNumber: '',
      notes: guest.notes ?? '',
    });
    setFlags({
      vip: guest.vip,
      blacklisted: guest.blacklisted,
      marketingConsent: guest.marketingConsent,
    });
    setFormError(null);
    setEditing(true);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      const text = (key: string) => form[key]?.trim() || null;
      await api(`/guests/${guest.id}`, {
        method: 'PATCH',
        body: {
          firstName: form.firstName?.trim(),
          lastName: form.lastName?.trim() ?? '',
          email: text('email'),
          phone: text('phone'),
          nationality: text('nationality'),
          company: text('company'),
          gstin: text('gstin'),
          idType: text('idType'),
          // An empty field leaves the stored number as it is.
          ...(form.idNumber?.trim() ? { idNumber: form.idNumber.trim() } : {}),
          notes: text('notes'),
          ...flags,
        },
      });
      await mutate();
      onChanged();
      setEditing(false);
      setIdNumber(null);
      toast.success('Guest saved');
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const set = (key: string) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));
  const completed = stays.filter((s) => s.status === 'checked_out' || s.status === 'in_house');
  const spend = stays
    .filter((s) => s.status !== 'cancelled' && s.status !== 'no_show')
    .reduce((sum, s) => sum + s.totalAmount, 0);
  const currency = stays[0]?.currency ?? 'INR';

  if (editing) {
    return (
      <form onSubmit={save} className="flex flex-col gap-3">
        {formError && <Notice tone="danger">{formError}</Notice>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="First name">
            {(p) => (
              <Input {...p} value={form.firstName ?? ''} onChange={set('firstName')} required />
            )}
          </Field>
          <Field label="Last name">
            {(p) => <Input {...p} value={form.lastName ?? ''} onChange={set('lastName')} />}
          </Field>
          <Field label="Email" optional className="col-span-2">
            {(p) => <Input {...p} type="email" value={form.email ?? ''} onChange={set('email')} />}
          </Field>
          <Field label="Phone" optional>
            {(p) => <Input {...p} type="tel" value={form.phone ?? ''} onChange={set('phone')} />}
          </Field>
          <Field label="Nationality" optional>
            {(p) => <Input {...p} value={form.nationality ?? ''} onChange={set('nationality')} />}
          </Field>
          <Field label="Company" optional>
            {(p) => <Input {...p} value={form.company ?? ''} onChange={set('company')} />}
          </Field>
          <Field label="GSTIN" optional hint="For business invoices.">
            {(p) => <Input {...p} value={form.gstin ?? ''} onChange={set('gstin')} />}
          </Field>
          <Field label="Identity document" optional hint="Passport, Aadhaar, driving licence.">
            {(p) => <Input {...p} value={form.idType ?? ''} onChange={set('idType')} />}
          </Field>
          <Field
            label="Document number"
            optional
            hint={
              guest.hasIdNumber
                ? 'A number is stored. Type a new one to replace it.'
                : 'Stored encrypted.'
            }
          >
            {(p) => (
              <Input
                {...p}
                value={form.idNumber ?? ''}
                onChange={set('idNumber')}
                autoComplete="off"
              />
            )}
          </Field>
        </div>
        <Field label="Notes" optional>
          {(p) => <Textarea {...p} rows={3} value={form.notes ?? ''} onChange={set('notes')} />}
        </Field>
        <div className="flex flex-col gap-2">
          <Checkbox
            label="VIP"
            checked={flags.vip}
            onChange={(e) => setFlags((f) => ({ ...f, vip: e.target.checked }))}
          />
          <Checkbox
            label="Do not accept bookings from this guest"
            checked={flags.blacklisted}
            onChange={(e) => setFlags((f) => ({ ...f, blacklisted: e.target.checked }))}
          />
          <Checkbox
            label="Agreed to receive marketing messages"
            checked={flags.marketingConsent}
            onChange={(e) => setFlags((f) => ({ ...f, marketingConsent: e.target.checked }))}
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={() => setEditing(false)}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy}>
            Save
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          {guest.vip && (
            <Badge tone="warning">
              <Star className="size-3" aria-hidden /> VIP
            </Badge>
          )}
          {guest.blacklisted && <Badge tone="danger">Do not accept</Badge>}
          {canWrite && (
            <Button size="sm" className="ml-auto" onClick={startEdit}>
              Edit
            </Button>
          )}
        </div>
        <div className="mt-2 flex flex-col gap-1 text-sm text-ink-soft">
          {guest.email && (
            <a
              href={`mailto:${guest.email}`}
              className="inline-flex items-center gap-2 hover:text-brand-700"
            >
              <Mail className="size-3.5 text-ink-faint" aria-hidden /> {guest.email}
            </a>
          )}
          {guest.phone && (
            <a
              href={`tel:${guest.phone}`}
              className="inline-flex items-center gap-2 hover:text-brand-700"
            >
              <Phone className="size-3.5 text-ink-faint" aria-hidden /> {guest.phone}
            </a>
          )}
          {[guest.nationality, guest.company].filter(Boolean).length > 0 && (
            <p>{[guest.nationality, guest.company].filter(Boolean).join(' · ')}</p>
          )}
        </div>
        {guest.notes && (
          <p className="mt-2 rounded-md bg-sunken px-3 py-2 text-sm whitespace-pre-wrap text-ink">
            {guest.notes}
          </p>
        )}
      </div>

      {(guest.idType || guest.hasIdNumber) && (
        <div className="rounded-lg border border-line p-3">
          <p className="text-xs font-semibold tracking-wide text-ink-faint uppercase">
            Identity document
          </p>
          <div className="mt-1 flex items-center justify-between gap-3 text-sm">
            <span className="text-ink">
              {guest.idType ?? 'Document'}
              {guest.hasIdNumber && (
                <span className="ml-2 font-mono">{idNumber ?? '••••••••'}</span>
              )}
            </span>
            {guest.hasIdNumber && canSeeId && idNumber === null && (
              <Button
                size="sm"
                variant="ghost"
                icon={<Eye className="size-3.5" />}
                onClick={async () => {
                  try {
                    const result = await api<{ idNumber: string | null }>(
                      `/guests/${guest.id}/reveal-id`,
                      { method: 'POST' },
                    );
                    setIdNumber(result.idNumber ?? '');
                  } catch (err) {
                    toast.error(err);
                  }
                }}
              >
                Show
              </Button>
            )}
          </div>
          {guest.hasIdNumber && canSeeId && (
            <p className="mt-1 text-xs text-ink-faint">
              Each time the number is shown is recorded in the audit log.
            </p>
          )}
        </div>
      )}

      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Reservations', value: String(stays.length) },
          { label: 'Stays completed', value: String(completed.length) },
          { label: 'Total booked', value: formatMoney(spend, currency) },
        ].map((stat) => (
          <div key={stat.label} className="rounded-lg border border-line p-3">
            <p className="text-xs text-ink-faint">{stat.label}</p>
            <p className="tabular mt-0.5 text-base font-semibold text-ink">{stat.value}</p>
          </div>
        ))}
      </div>

      <div>
        <p className="mb-2 text-xs font-semibold tracking-wide text-ink-faint uppercase">
          Reservations
        </p>
        {stays.length === 0 ? (
          <p className="text-sm text-ink-faint">No reservations at the properties you can see.</p>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {stays.map((stay) => (
              <li key={stay.id}>
                <Link
                  href={`/reservations/${stay.id}`}
                  className="flex items-center justify-between gap-3 px-3 py-2.5 hover:bg-sunken"
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-ink">
                      {formatStay(stay.checkIn, stay.checkOut)}
                    </span>
                    <span className="block truncate text-xs text-ink-faint">
                      {stay.rooms[0]?.roomTypeName} · {plural(stay.nights, 'night')} ·{' '}
                      <span className="font-mono">{stay.code}</span>
                    </span>
                  </span>
                  <Badge tone={STATUS_TONES[stay.status]}>{STATUS_LABELS[stay.status]}</Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
      <PrivacyActions
        guest={guest}
        onErased={async () => {
          await mutate();
          onChanged();
        }}
      />
      <p className="text-xs text-ink-faint">
        Guest since {formatDate(guest.createdAt.slice(0, 10))}
      </p>
    </div>
  );
}

export function GuestsView() {
  const auth = useAuth();
  const { properties } = useProperties();
  // The register holds identity numbers: for those who may see them, property by property.
  const registerProperties = properties.filter((p) => p.active && auth.can('guests.pii', p.id));
  const [register, setRegister] = useState(false);
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const term = useDebounced(search.trim(), 250);
  const { data, error, isLoading, mutate } = useSWR<{ guests: Guest[] }>(
    `/guests${query({ query: term, limit: 60 })}`,
  );
  const open = data?.guests.find((g) => g.id === openId);

  return (
    <div className="mx-auto flex max-w-5xl flex-col p-4 sm:p-6">
      <PageHeader
        title="Guests"
        description="Everyone who has booked, with their stay history."
        actions={
          registerProperties.length > 0 && (
            <Button
              icon={<FileDown className="size-4" aria-hidden />}
              onClick={() => setRegister(true)}
            >
              Guest register
            </Button>
          )
        }
      />
      <div className="relative mb-3 max-w-sm">
        <Search
          className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-ink-faint"
          aria-hidden
        />
        <Input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Name, email or phone"
          aria-label="Search guests"
          className="pl-8"
        />
      </div>
      <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-card">
        {error ? (
          <ErrorState error={error} onRetry={() => void mutate()} />
        ) : isLoading || !data ? (
          <PageLoading />
        ) : data.guests.length === 0 ? (
          <EmptyState
            icon={<Users className="size-5" />}
            title={term ? `No guest matches "${term}"` : 'No guests yet'}
            description={term ? undefined : 'Guests appear here with their first reservation.'}
          />
        ) : (
          <ul className="divide-y divide-line">
            {data.guests.map((guest) => (
              <li key={guest.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(guest.id)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-brand-50/60"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-sunken text-xs font-semibold text-ink-soft">
                    {(guest.firstName[0] ?? '') + (guest.lastName[0] ?? '')}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 text-sm font-medium text-ink">
                      <span className="truncate">{guest.name}</span>
                      {guest.vip && <Badge tone="warning">VIP</Badge>}
                      {guest.blacklisted && <Badge tone="danger">Do not accept</Badge>}
                    </span>
                    <span className="block truncate text-xs text-ink-faint">
                      {[guest.email, guest.phone].filter(Boolean).join(' · ') ||
                        'No contact details'}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {/* An erased guest drops out of the list while their panel is still open. */}
      <Drawer
        open={openId !== null}
        onClose={() => setOpenId(null)}
        title={open?.name ?? 'Guest'}
        description={open ? undefined : 'No longer in the list'}
      >
        {openId && <GuestPanel guestId={openId} onChanged={() => void mutate()} />}
      </Drawer>
      {register && (
        <GuestRegisterDialog properties={registerProperties} onClose={() => setRegister(false)} />
      )}
    </div>
  );
}
