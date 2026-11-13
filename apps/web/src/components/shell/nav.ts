import {
  ChartColumn,
  BrushCleaning,
  CalendarDays,
  ClipboardList,
  ConciergeBell,
  Handshake,
  House,
  MessagesSquare,
  Network,
  ReceiptText,
  Settings,
  Star,
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
  /** A count shown beside the label. */
  badge?: 'inbox';
}

export const NAV: NavItem[] = [
  // Villa owners see only this; nobody else holds the permission.
  { href: '/owner', label: 'My villa', icon: House, permissions: ['owner.portal'] },
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
    href: '/inbox',
    label: 'Inbox',
    icon: MessagesSquare,
    permissions: ['inbox.read'],
    badge: 'inbox',
  },
  {
    href: '/housekeeping',
    label: 'Housekeeping',
    icon: BrushCleaning,
    permissions: ['housekeeping.read'],
  },
  { href: '/maintenance', label: 'Maintenance', icon: Wrench, permissions: ['housekeeping.read'] },
  { href: '/accounts', label: 'Accounts', icon: ReceiptText, permissions: ['folio.read'] },
  { href: '/owners', label: 'Villa owners', icon: Handshake, permissions: ['accounting.manage'] },
  { href: '/reports', label: 'Reports', icon: ChartColumn, permissions: ['reports.read'] },
  { href: '/reviews', label: 'Reviews', icon: Star, permissions: ['reports.read'] },
  { href: '/channels', label: 'Channels', icon: Network, permissions: ['channels.read'] },
  {
    href: '/settings',
    label: 'Settings',
    icon: Settings,
    permissions: ['property.manage', 'org.manage', 'property.read'],
  },
];

/** Where a signed-in user starts: the first screen their role opens. */
export function homeFor(can: (permission: Permission) => boolean): string {
  return NAV.find((item) => item.permissions.some(can))?.href ?? '/settings/security';
}
