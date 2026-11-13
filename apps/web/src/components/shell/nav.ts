import {
  BrushCleaning,
  CalendarDays,
  ClipboardList,
  ConciergeBell,
  Network,
  ReceiptText,
  Settings,
  Tags,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
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
  { href: '/front-desk', label: 'Front desk', icon: ConciergeBell, permissions: ['folio.read'] },
  {
    href: '/reservations',
    label: 'Reservations',
    icon: ClipboardList,
    permissions: ['reservations.read'],
  },
  { href: '/rates', label: 'Rates', icon: Tags, permissions: ['rates.read'] },
  { href: '/guests', label: 'Guests', icon: Users, permissions: ['guests.read'] },
  {
    href: '/housekeeping',
    label: 'Housekeeping',
    icon: BrushCleaning,
    permissions: ['housekeeping.read'],
  },
  { href: '/maintenance', label: 'Maintenance', icon: Wrench, permissions: ['housekeeping.read'] },
  { href: '/accounts', label: 'Accounts', icon: ReceiptText, permissions: ['folio.read'] },
  { href: '/channels', label: 'Channels', icon: Network, permissions: ['channels.read'] },
  {
    href: '/settings',
    label: 'Settings',
    icon: Settings,
    permissions: ['property.manage', 'org.manage', 'property.read'],
  },
];
