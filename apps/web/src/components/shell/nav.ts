import { CalendarDays, ClipboardList, Settings, Tags, Users, type LucideIcon } from 'lucide-react';
import type { Permission } from '@pms/domain/shared';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Shown when the user holds any of these. */
  permissions: Permission[];
}

export const NAV: NavItem[] = [
  { href: '/calendar', label: 'Calendar', icon: CalendarDays, permissions: ['reservations.read'] },
  {
    href: '/reservations',
    label: 'Reservations',
    icon: ClipboardList,
    permissions: ['reservations.read'],
  },
  { href: '/rates', label: 'Rates', icon: Tags, permissions: ['rates.read'] },
  { href: '/guests', label: 'Guests', icon: Users, permissions: ['guests.read'] },
  {
    href: '/settings',
    label: 'Settings',
    icon: Settings,
    permissions: ['property.manage', 'org.manage', 'property.read'],
  },
];
