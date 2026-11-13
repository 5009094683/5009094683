'use client';

import { ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { plural } from '@/lib/format';
import { PERMISSION_LABELS } from './labels';
import type { RoleInfo } from './roles';

/** Lists every role with what it allows, in plain words. */
export function RolesDialog({ roles, onClose }: { roles: RoleInfo[]; onClose: () => void }) {
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="What each role can do"
      description="A role given for one property allows these things at that property only. Organisation settings and the audit trail need a role that covers all properties."
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <ul className="flex flex-col gap-2">
        {roles.map((info) => (
          <li key={info.role}>
            <details className="group rounded-lg border border-line">
              <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2.5 text-sm hover:bg-sunken [&::-webkit-details-marker]:hidden">
                <ChevronRight
                  className="size-4 shrink-0 text-ink-faint transition-transform group-open:rotate-90"
                  aria-hidden
                />
                <span className="font-medium text-ink">{info.label}</span>
                <span className="ml-auto text-[13px] text-ink-faint">
                  {plural(info.permissions.length, 'permission')}
                </span>
              </summary>
              <ul className="grid list-disc grid-cols-1 gap-x-8 gap-y-1 border-t border-line py-3 pr-3 pl-9 text-[13px] text-ink-soft marker:text-ink-faint sm:grid-cols-2">
                {info.permissions.map((permission) => (
                  <li key={permission}>{PERMISSION_LABELS[permission] ?? permission}</li>
                ))}
              </ul>
            </details>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
