'use client';

import {
  Building2,
  KeyRound,
  Landmark,
  MessagesSquare,
  PlugZap,
  ScrollText,
  ShieldCheck,
  TicketPercent,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { Permission } from '@pms/domain/shared';
import { useAuth } from '@/lib/auth';

export interface SettingsSection {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Shown only to users who hold this. Absent means every signed-in user. */
  permission?: Permission;
}

export const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    href: '/settings/properties',
    label: 'Properties',
    icon: Building2,
    permission: 'property.read',
  },
  {
    href: '/settings/messaging',
    label: 'Guest messages',
    icon: MessagesSquare,
    permission: 'inbox.read',
  },
  {
    href: '/settings/promos',
    label: 'Promotional codes',
    icon: TicketPercent,
    permission: 'rates.read',
  },
  { href: '/settings/users', label: 'Users', icon: Users, permission: 'org.manage' },
  { href: '/settings/sso', label: 'Single sign-on', icon: KeyRound, permission: 'org.manage' },
  { href: '/settings/security', label: 'Security', icon: ShieldCheck },
  {
    href: '/settings/organisation',
    label: 'Organisation',
    icon: Landmark,
    permission: 'org.manage',
  },
  {
    href: '/settings/integrations',
    label: 'Integrations',
    icon: PlugZap,
    permission: 'org.manage',
  },
  { href: '/settings/audit', label: 'Audit trail', icon: ScrollText, permission: 'audit.read' },
];

/** The settings sections the signed-in user may open, in menu order. */
export function useSettingsSections(): SettingsSection[] {
  const auth = useAuth();
  return SETTINGS_SECTIONS.filter((section) => !section.permission || auth.can(section.permission));
}
