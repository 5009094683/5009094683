'use client';

import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/field';
import type { Property } from '@/lib/types';
import type { ApiKeysAnswer, KeyGrant, KeyRole } from './types';
import { KEY_ROLE_HELP } from './words';

/** One row of the editor. `role` is empty until one is chosen. */
export interface KeyGrantRow {
  key: number;
  role: KeyRole | '';
  propertyId: string | null;
}

let nextKey = 0;

export function emptyKeyGrantRow(): KeyGrantRow {
  return { key: nextKey++, role: '', propertyId: null };
}

/** The grants the rows describe: unfinished rows dropped, repeats merged, in a stable order. */
export function keyGrantsFromRows(rows: KeyGrantRow[]): KeyGrant[] {
  const seen = new Map<string, KeyGrant>();
  for (const row of rows) {
    if (row.role === '') continue;
    seen.set(`${row.role}|${row.propertyId ?? ''}`, { role: row.role, propertyId: row.propertyId });
  }
  return [...seen.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, grant]) => grant);
}

/**
 * Edits what a key may do: rows of a role and where it applies. The same idea as the roles of a
 * user, with only the roles the server allows a key to have.
 */
export function KeyGrantsEditor({
  rows,
  onChange,
  roles,
  properties,
}: {
  rows: KeyGrantRow[];
  onChange: (rows: KeyGrantRow[]) => void;
  roles: ApiKeysAnswer['roles'];
  properties: Property[];
}) {
  const update = (key: number, patch: Partial<KeyGrantRow>) =>
    onChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  const active = properties.filter((property) => property.active);
  const inactive = properties.filter((property) => !property.active);

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-[13px] font-medium text-ink-soft">What the key may do</legend>
      <div className="flex flex-col gap-2">
        {rows.map((row, index) => {
          const help = row.role === '' ? undefined : KEY_ROLE_HELP[row.role];
          return (
            <div
              key={row.key}
              role="group"
              aria-label={`Role ${index + 1}`}
              className="grid grid-cols-[1fr_auto] gap-2 rounded-md border border-line p-2 sm:grid-cols-[1fr_1fr_auto] sm:border-0 sm:p-0"
            >
              <Select
                aria-label="Role"
                value={row.role}
                onChange={(e) => update(row.key, { role: e.target.value as KeyRole | '' })}
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
                className={rows.length > 1 ? undefined : 'col-span-2 sm:col-span-1'}
              >
                <option value="">All properties</option>
                {active.map((property) => (
                  <option key={property.id} value={property.id}>
                    {property.name}
                  </option>
                ))}
                {inactive.length > 0 && (
                  <optgroup label="Inactive properties">
                    {inactive.map((property) => (
                      <option key={property.id} value={property.id}>
                        {property.name}
                      </option>
                    ))}
                  </optgroup>
                )}
              </Select>
              {rows.length > 1 ? (
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Remove role ${index + 1}`}
                  onClick={() => onChange(rows.filter((other) => other.key !== row.key))}
                  className="h-9 w-9"
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              ) : (
                // Keeps the two selects the same width whether or not there is a row to remove.
                <span className="hidden w-9 sm:block" aria-hidden />
              )}
              {help && (
                <p className="col-span-2 text-[13px] text-ink-faint sm:col-span-3">{help}</p>
              )}
            </div>
          );
        })}
      </div>
      <div>
        <Button
          size="sm"
          icon={<Plus className="size-3.5" />}
          onClick={() => onChange([...rows, emptyKeyGrantRow()])}
        >
          Add role
        </Button>
      </div>
      <p className="text-[13px] text-ink-faint">
        A role applies to all properties or to one. Add a row for each property to give the same
        role at several. No key can manage users, sign-in, keys or webhooks: that stays with people.
      </p>
    </fieldset>
  );
}
