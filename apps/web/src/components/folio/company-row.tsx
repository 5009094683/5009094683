'use client';

import { Building2, Pencil } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import type { Reservation } from '@/lib/types';
import { useCompanies } from './data';

/**
 * The company a reservation is booked for, with a control to change it. What is owed can be
 * billed to that company's account at check-out.
 */
export function CompanyRow({
  reservation,
  canEdit,
  onChanged,
}: {
  reservation: Reservation;
  canEdit: boolean;
  onChanged: (updated: Reservation) => void;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [companyId, setCompanyId] = useState('');
  const [saving, setSaving] = useState(false);
  const { companies, isLoading } = useCompanies(editing);

  // The current company stays in the list even if it has since been made inactive.
  const current = reservation.company;
  const options =
    current && !companies.some((company) => company.id === current.id)
      ? [{ id: current.id, name: current.name }, ...companies]
      : companies;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (companyId === (current?.id ?? '')) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      const updated = await api<Reservation>(`/reservations/${reservation.id}`, {
        method: 'PATCH',
        body: { companyId: companyId || null },
      });
      toast.success(
        updated.company ? `Linked to ${updated.company.name}` : 'Company removed',
        updated.company ? 'The bill can be moved to its account at check-out.' : undefined,
      );
      setEditing(false);
      onChanged(updated);
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-2 flex min-h-7 flex-wrap items-center gap-2 text-sm">
      <Building2 className="size-4 shrink-0 text-ink-faint" aria-hidden />
      <span className="text-ink-soft">Company</span>
      {editing ? (
        <form onSubmit={save} className="flex flex-1 flex-wrap items-center gap-2">
          <Select
            aria-label="Company"
            value={companyId}
            onChange={(e) => setCompanyId(e.target.value)}
            disabled={isLoading}
            autoFocus
            className="h-8 w-auto min-w-40 flex-1"
          >
            <option value="">None</option>
            {options.map((company) => (
              <option key={company.id} value={company.id}>
                {company.name}
              </option>
            ))}
          </Select>
          <Button size="sm" type="submit" variant="primary" loading={saving}>
            Save
          </Button>
          <Button size="sm" onClick={() => setEditing(false)} disabled={saving}>
            Cancel
          </Button>
        </form>
      ) : (
        <>
          <span className={current ? 'font-medium text-ink' : 'text-ink'}>
            {current?.name ?? 'None'}
          </span>
          {canEdit && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Pencil className="size-3.5" />}
              aria-label={current ? 'Change company' : undefined}
              onClick={() => {
                setCompanyId(current?.id ?? '');
                setEditing(true);
              }}
            >
              {current ? 'Change' : 'Link a company'}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
