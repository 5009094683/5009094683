'use client';

import useSWR from 'swr';
import { ROLE_LABELS } from '@pms/domain/shared';
import type { Grant, Permission, Property } from '@/lib/types';

export type Role = Grant['role'];

/** A role as `GET /roles` describes it. */
export interface RoleInfo {
  role: Role;
  label: string;
  permissions: Permission[];
}

/** The roles a user can be given, with what each one allows. Pass false to skip loading. */
export function useRoles(enabled = true) {
  const { data, error, isLoading, mutate } = useSWR<{ roles: RoleInfo[] }>(
    enabled ? '/roles' : null,
  );
  return { roles: data?.roles ?? [], error, isLoading, mutate };
}

const names = new Intl.ListFormat('en-GB', { style: 'long', type: 'conjunction' });

/**
 * A user's grants in words, one line per role: "Front desk at Sea Breeze
 * Candolim", "Organisation admin, all properties".
 */
export function grantSummaries(
  grants: Grant[],
  roles: RoleInfo[],
  properties: Property[],
): string[] {
  const byRole = new Map<Role, (string | null)[]>();
  for (const grant of grants) {
    byRole.set(grant.role, [...(byRole.get(grant.role) ?? []), grant.propertyId]);
  }
  return [...byRole.entries()].map(([role, propertyIds]) => {
    const label = roles.find((info) => info.role === role)?.label ?? ROLE_LABELS[role];
    if (propertyIds.includes(null)) return `${label}, all properties`;
    const places = propertyIds.map(
      (id) => properties.find((property) => property.id === id)?.name ?? 'an unknown property',
    );
    return `${label} at ${names.format(places)}`;
  });
}
