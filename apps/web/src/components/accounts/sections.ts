'use client';

import { Building2, Moon, Percent, ReceiptText, type LucideIcon } from 'lucide-react';
import type { Permission } from '@pms/domain/shared';
import { useAuth } from '@/lib/auth';

export interface AccountsSection {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Shown only to users who hold every one of these. */
  permissions: Permission[];
}

export const ACCOUNTS_SECTIONS: AccountsSection[] = [
  { href: '/accounts/invoices', label: 'Invoices', icon: ReceiptText, permissions: ['folio.read'] },
  {
    href: '/accounts/companies',
    label: 'Companies',
    icon: Building2,
    // The list of companies comes with reservations; what they owe comes with folios.
    permissions: ['folio.read', 'reservations.read'],
  },
  { href: '/accounts/night-audit', label: 'Night audit', icon: Moon, permissions: ['folio.read'] },
  { href: '/accounts/taxes', label: 'Tax rules', icon: Percent, permissions: ['folio.read'] },
];

/** The accounts sections the signed-in user may open, in menu order. */
export function useAccountsSections(): AccountsSection[] {
  const auth = useAuth();
  return ACCOUNTS_SECTIONS.filter((section) =>
    section.permissions.every((permission) => auth.can(permission)),
  );
}
