'use client';

import { Building2, Lock, Plug, Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import useSWR from 'swr';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { Card, EmptyState, ErrorState, PageHeader, PageLoading } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useProperties } from '@/lib/hooks';
import type { Property } from '@/lib/types';
import { ConnectionCard } from './connection-card';
import { HealthBanners } from './health-banners';
import { useMonitor, useNow } from './monitor';
import { StaleNotice } from './parts';
import { ReceivedBookings } from './received-bookings';
import type { Connection } from './types';

/** With more properties than this, a box to find one by name is worth its space. */
const FILTER_FROM = 8;
/** How many unconnected properties are listed before the rest is folded away. */
const UNCONNECTED_SHOWN = 8;

function UnconnectedCard({
  property,
  canManage,
  connecting,
  disabled,
  onConnect,
}: {
  property: Property;
  canManage: boolean;
  connecting: boolean;
  disabled: boolean;
  onConnect: () => void;
}) {
  return (
    <Card className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <h4 className="truncate text-sm font-medium text-ink">{property.name}</h4>
        <p className="truncate text-xs text-ink-faint">
          {property.active ? 'Not on the booking sites' : 'Inactive property'}
        </p>
      </div>
      {canManage && (
        <Button
          size="sm"
          icon={<Plug className="size-3.5" />}
          loading={connecting}
          disabled={disabled}
          aria-label={`Connect ${property.name}`}
          onClick={onConnect}
        >
          Connect
        </Button>
      )}
    </Card>
  );
}

function Connections({ now }: { now: Date }) {
  const auth = useAuth();
  const router = useRouter();
  const toast = useToast();
  const properties = useProperties();
  const { data, error, mutate } = useMonitor<{ connections: Connection[] }>(
    '/channels/connections',
  );
  const [filter, setFilter] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [connecting, setConnecting] = useState<string | null>(null);

  const connect = async (property: Property) => {
    setConnecting(property.id);
    try {
      const created = await api<Connection>('/channels/connections', {
        body: { propertyId: property.id, adapter: 'channex' },
      });
      void mutate();
      router.push(`/channels/${created.id}`);
    } catch (err) {
      toast.error(err);
      setConnecting(null);
      void mutate();
    }
  };

  if (!data || (properties.isLoading && properties.properties.length === 0)) {
    const failure = error ?? properties.error;
    return (
      <Card>
        {failure ? (
          <ErrorState
            error={failure}
            onRetry={() => {
              void mutate();
              void properties.mutate();
            }}
          />
        ) : (
          <PageLoading />
        )}
      </Card>
    );
  }

  const term = filter.trim().toLowerCase();
  const matches = (name: string) => !term || name.toLowerCase().includes(term);
  const visible = properties.properties.filter((p) => auth.can('channels.read', p.id));
  const connections = data.connections.filter((c) => matches(c.propertyName));
  const onChannelManager = new Set(
    data.connections.filter((c) => c.adapter === 'channex').map((c) => c.propertyId),
  );
  // Properties in use come first: a switched-off property is rarely the one being connected.
  const unconnected = visible
    .filter((p) => !onChannelManager.has(p.id) && matches(p.name))
    .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
  const folded = !term && !showAll && unconnected.length > UNCONNECTED_SHOWN;
  const total = new Set([...visible.map((p) => p.id), ...data.connections.map((c) => c.propertyId)])
    .size;

  return (
    <>
      {error && <StaleNotice error={error} onRetry={() => void mutate()} />}
      {properties.error && (
        <StaleNotice
          title="The list of properties could not be loaded"
          consequence="Properties that are not connected yet may be missing below."
          error={properties.error}
          onRetry={() => void properties.mutate()}
        />
      )}
      {total > FILTER_FROM && (
        <div className="relative mb-4 max-w-xs">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-ink-faint"
            aria-hidden
          />
          <Input
            type="search"
            aria-label="Find a property"
            placeholder="Find a property"
            className="pl-8"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      )}

      {total === 0 ? (
        <Card>
          <EmptyState
            icon={<Building2 className="size-5" />}
            title="There are no properties to connect yet"
            description="Add a property under Settings first. It can then be connected to the booking sites here."
          />
        </Card>
      ) : connections.length === 0 && unconnected.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Search className="size-5" />}
            title={`No property matches "${filter.trim()}"`}
          />
        </Card>
      ) : (
        <>
          {connections.length > 0 && (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {connections.map((connection) => (
                <ConnectionCard
                  key={connection.id}
                  connection={connection}
                  canManage={auth.can('channels.manage', connection.propertyId)}
                  now={now}
                  onChanged={mutate}
                />
              ))}
            </div>
          )}

          {unconnected.length > 0 && (
            <div className={connections.length > 0 ? 'mt-6' : undefined}>
              <h3 className="text-sm font-semibold text-ink">Not connected</h3>
              <p className="mt-0.5 mb-3 text-sm text-ink-soft">
                The booking sites do not get availability or rates for these properties, and
                bookings made there do not arrive here. Connecting starts the set-up; nothing is
                sent until you switch it on.
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {(folded ? unconnected.slice(0, UNCONNECTED_SHOWN) : unconnected).map(
                  (property) => (
                    <UnconnectedCard
                      key={property.id}
                      property={property}
                      canManage={auth.can('channels.manage', property.id)}
                      connecting={connecting === property.id}
                      disabled={connecting !== null}
                      onConnect={() => void connect(property)}
                    />
                  ),
                )}
              </div>
              {!term && unconnected.length > UNCONNECTED_SHOWN && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-3"
                  aria-expanded={showAll}
                  onClick={() => setShowAll(!showAll)}
                >
                  {showAll ? 'Show fewer' : `Show all ${unconnected.length}`}
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </>
  );
}

function Overview() {
  const auth = useAuth();
  const { properties } = useProperties();
  // The same list the cards are made from; it is kept fresh there.
  const { data } = useSWR<{ connections: Connection[] }>('/channels/connections');
  const now = useNow();
  const visible = properties.filter((p) => auth.can('channels.read', p.id));
  const propertyNames =
    visible.length > 1 ? new Map(visible.map((p) => [p.id, p.name])) : undefined;

  return (
    <>
      <HealthBanners />
      <section aria-labelledby="connections-heading">
        <h2 id="connections-heading" className="mb-3 text-base font-semibold text-ink">
          Connections
        </h2>
        <Connections now={now} />
      </section>
      <section aria-labelledby="bookings-heading" className="mt-8">
        <h2 id="bookings-heading" className="text-base font-semibold text-ink">
          Recent bookings from the channels
        </h2>
        <p className="mt-0.5 mb-3 text-sm text-ink-soft">
          New bookings, changes and cancellations as they arrived, newest first, and whether each
          one was recorded.
        </p>
        <ReceivedBookings
          connections={data?.connections}
          propertyNames={propertyNames}
          now={now}
          emptyHint="Once a property is live, bookings made on the booking sites appear here within seconds."
        />
      </section>
    </>
  );
}

/** Channel connections of every property, with what the booking sites have sent lately. */
export function ChannelsView() {
  const auth = useAuth();
  return (
    <div className="mx-auto flex max-w-7xl flex-col p-4 sm:p-6">
      <PageHeader
        title="Channels"
        description="How each property is connected to the booking sites, and what is going out and coming in."
      />
      {auth.can('channels.read') ? (
        <Overview />
      ) : (
        <EmptyState
          icon={<Lock className="size-5" />}
          title="You do not have access to this page"
          description="Ask an administrator if you need to see how properties are connected to the booking sites."
        />
      )}
    </div>
  );
}
