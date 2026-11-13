'use client';

import { Plus } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/misc';
import { ConnectionJobs, StatusSwitch, useConnectionActions } from './connection-actions';
import { ConnectionOverview, ConnectionStatusBadge } from './connection-summary';
import { kindOf, ownName } from './kinds';
import { ButtonLink } from './parts';
import type { Connection } from './types';

/** One connection of a property: what kind it is, how it is doing, and what can be done with it. */
function ConnectionSection({
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
  const kind = kindOf(connection);
  const Icon = kind.icon;
  const name = ownName(connection);
  const href = `/channels/${connection.id}`;
  const headingId = `connection-${connection.id}`;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h4 id={headingId} className="flex min-w-0 items-center gap-2 text-sm font-medium text-ink">
          <Icon className="size-4 shrink-0 text-ink-faint" aria-hidden />
          <Link href={href} className="hover:underline">
            {kind.label}
          </Link>
          {name && <span className="truncate text-xs font-normal text-ink-faint">{name}</span>}
        </h4>
        <ConnectionStatusBadge connection={connection} />
      </div>
      <ConnectionOverview connection={connection} now={now} />
      <div className="flex flex-wrap items-center gap-2">
        <ButtonLink href={href} aria-label={`Open ${kind.named(connection.propertyName)}`}>
          Open
        </ButtonLink>
        {canManage && (
          <>
            <StatusSwitch connection={connection} actions={actions} placement="card" />
            <div className="ml-auto">
              <ConnectionJobs connection={connection} actions={actions} placement="card" />
            </div>
          </>
        )}
      </div>
    </section>
  );
}

/**
 * One property's routes to the booking sites, as the list shows them. A property can have a
 * connection of each kind; each has a part of the card to itself.
 */
export function PropertyConnections({
  propertyId,
  propertyName,
  connections,
  canManage,
  now,
  onChanged,
  onAdd,
}: {
  propertyId: string;
  propertyName: string;
  connections: Connection[];
  canManage: boolean;
  now: Date;
  onChanged: () => Promise<unknown>;
  /** Left out when there is no further kind of connection to add, or no right to add one. */
  onAdd?: () => void;
}) {
  const headingId = `property-${propertyId}`;
  return (
    <Card>
      <article aria-labelledby={headingId}>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 pt-3 pb-1">
          <h3 id={headingId} className="min-w-0 text-[15px] font-semibold text-ink">
            {propertyName}
          </h3>
          {onAdd && (
            <Button
              size="sm"
              variant="ghost"
              className="-mr-2"
              icon={<Plus className="size-3.5" />}
              aria-label={`Add a connection for ${propertyName}`}
              onClick={onAdd}
            >
              Add a connection
            </Button>
          )}
        </div>
        <ul className="divide-y divide-line">
          {connections.map((connection) => (
            <li key={connection.id}>
              <ConnectionSection
                connection={connection}
                canManage={canManage}
                now={now}
                onChanged={onChanged}
              />
            </li>
          ))}
        </ul>
      </article>
    </Card>
  );
}
