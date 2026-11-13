'use client';

import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/field';
import type { Grant, Property } from '@/lib/types';
import type { Role, RoleInfo } from './roles';

/** One row of the editor. `role` is empty until one is chosen. */
export interface GrantRow {
  key: number;
  role: Role | '';
  propertyId: string | null;
}

let nextKey = 0;

export function emptyGrantRow(): GrantRow {
  return { key: nextKey++, role: '', propertyId: null };
}

export function grantRows(grants: Grant[]): GrantRow[] {
  return grants.map((grant) => ({ key: nextKey++, ...grant }));
}

/** The grants the rows describe: unfinished rows dropped, repeats merged, in a stable order. */
export function grantsFromRows(rows: GrantRow[]): Grant[] {
  const seen = new Map<string, Grant>();
  for (const row of rows) {
    if (row.role === '') continue;
    // The organisation admin role is never limited to one property.
    const propertyId = row.role === 'org_admin' ? null : row.propertyId;
    seen.set(`${row.role}|${propertyId ?? ''}`, { role: row.role, propertyId });
  }
  return [...seen.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, grant]) => grant);
}

/** Edits what a user may do: rows of a role and where it applies. */
export function GrantsEditor({
  rows,
  onChange,
  roles,
  properties,
}: {
  rows: GrantRow[];
  onChange: (rows: GrantRow[]) => void;
  roles: RoleInfo[];
  properties: Property[];
}) {
  const update = (key: number, patch: Partial<GrantRow>) =>
    onChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-[13px] font-medium text-ink-soft">Roles</legend>
      {rows.length === 0 ? (
        <p className="text-[13px] text-ink-faint">
          No roles. Without one the user can sign in but cannot see or do anything.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((row, index) => (
            <div
              key={row.key}
              role="group"
              aria-label={`Role ${index + 1}`}
              className="grid grid-cols-[1fr_auto] gap-2 rounded-md border border-line p-2 sm:grid-cols-[1fr_1fr_auto] sm:border-0 sm:p-0"
            >
              <Select
                aria-label="Role"
                value={row.role}
                onChange={(e) => {
                  const role = e.target.value as Role | '';
                  update(row.key, {
                    role,
                    ...(role === 'org_admin' ? { propertyId: null } : {}),
                  });
                }}
                required
                className="col-span-2 sm:col-span-1"
              >
                <option value="">Choose a role</option>
                {roles.map((info) => (
                  <option key={info.role} value={info.role}>
                    {info.label}
                  </option>
                ))}
              </Select>
              <Select
                aria-label="Property"
                value={row.propertyId ?? ''}
                onChange={(e) => update(row.key, { propertyId: e.target.value || null })}
                disabled={row.role === 'org_admin'}
                title={
                  row.role === 'org_admin'
                    ? 'The organisation admin role always covers all properties'
                    : undefined
                }
              >
                <option value="">All properties</option>
                {properties.map((property) => (
                  <option key={property.id} value={property.id}>
                    {property.name}
                    {property.active ? '' : ' (inactive)'}
                  </option>
                ))}
              </Select>
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Remove role ${index + 1}`}
                onClick={() => onChange(rows.filter((other) => other.key !== row.key))}
                className="h-9 w-9"
              >
                <Trash2 className="size-4" aria-hidden />
              </Button>
            </div>
          ))}
        </div>
      )}
      <div>
        <Button
          size="sm"
          icon={<Plus className="size-3.5" />}
          onClick={() => onChange([...rows, emptyGrantRow()])}
        >
          Add role
        </Button>
      </div>
      <p className="text-[13px] text-ink-faint">
        A role applies to all properties or to one. Add a row for each property to give the same
        role at several. The organisation admin role always covers all properties.
      </p>
    </fieldset>
  );
}
