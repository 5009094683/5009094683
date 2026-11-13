'use client';

import Link from 'next/link';
import { Card } from '@/components/ui/misc';
import { ConnectionMenu, StatusSwitch, useConnectionActions } from './connection-actions';
import { ConnectionOverview, ConnectionStatusBadge } from './connection-summary';
import { ButtonLink } from './parts';
import type { Connection } from './types';

/** One property's route to the booking sites, as the list shows it. */
export function ConnectionCard({
  connection,
  canManage,
  now,
  onChanged,
}: {
  connection: Connection;
  canManage: boolean;
  now: Date;
  onChanged: () => Promise<unknown>;
}) {
  const actions = useConnectionActions(connection, onChanged);
  const href = `/channels/${connection.id}`;
  const headingId = `connection-${connection.id}`;

  return (
    <Card className="flex flex-col">
      <article aria-labelledby={headingId} className="flex flex-1 flex-col">
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 px-4 pt-4">
          <div className="min-w-0">
            <h3 id={headingId} className="text-[15px] font-semibold text-ink">
              <Link href={href} className="hover:underline">
                {connection.propertyName}
              </Link>
            </h3>
            <p className="text-xs text-ink-faint">{connection.name}</p>
          </div>
          <ConnectionStatusBadge connection={connection} />
        </div>
        <div className="flex-1 px-4 py-3">
          <ConnectionOverview connection={connection} now={now} />
        </div>
        <div className="flex items-center gap-2 border-t border-line px-4 py-2.5">
          <ButtonLink href={href} aria-label={`Open ${connection.propertyName}`}>
            Open
          </ButtonLink>
          {canManage && (
            <>
              <StatusSwitch connection={connection} actions={actions} placement="card" />
              <div className="ml-auto">
                <ConnectionMenu connection={connection} actions={actions} />
              </div>
            </>
          )}
        </div>
      </article>
    </Card>
  );
}
