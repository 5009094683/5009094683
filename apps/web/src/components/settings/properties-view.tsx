'use client';

import { Banknote, Building2, Clock, MapPin, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import useSWR from 'swr';
import { Button } from '@/components/ui/button';
import {
  Badge,
  EmptyState,
  ErrorState,
  Notice,
  PageHeader,
  PageLoading,
} from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { useAuth } from '@/lib/auth';
import { useProperties } from '@/lib/hooks';
import type { Organization, Property } from '@/lib/types';
import { KIND_LABELS } from './labels';
import { NoAccess } from './no-access';
import { PropertyDialog } from './property-dialog';

/** For the admin who has just created the organisation: first-time setup sends them here. */
function WelcomeNotice() {
  const welcome = useSearchParams().get('welcome') === '1';
  if (!welcome) return null;
  return (
    <Notice tone="info" title="Welcome. Your organisation is ready." className="mb-4">
      Start by adding your first property. Then open it to add its room types, the units in each
      room type and the rate plans they are sold on. Once those are in place you can take
      reservations.
    </Notice>
  );
}

function PropertyCard({ property }: { property: Property }) {
  const place = [property.city, property.state].filter(Boolean).join(', ');
  return (
    <li>
      <Link
        href={`/settings/properties/${property.id}`}
        className="flex h-full flex-col gap-3 rounded-xl border border-line bg-surface p-4 shadow-card transition-colors hover:border-brand-300"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate font-medium text-ink">{property.name}</p>
            <p className="font-mono text-xs text-ink-faint">{property.code}</p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <Badge tone={property.kind === 'villa' ? 'info' : 'brand'}>
              {KIND_LABELS[property.kind]}
            </Badge>
            {!property.active && <Badge tone="warning">Inactive</Badge>}
          </div>
        </div>
        <dl className="flex flex-col gap-1.5 text-[13px] text-ink-soft">
          <div className="flex items-center gap-2">
            <dt>
              <MapPin className="size-3.5 text-ink-faint" aria-hidden />
              <span className="sr-only">Location</span>
            </dt>
            <dd className={place ? 'truncate' : 'text-ink-faint'}>{place || 'No address yet'}</dd>
          </div>
          <div className="flex items-center gap-2">
            <dt>
              <Clock className="size-3.5 text-ink-faint" aria-hidden />
              <span className="sr-only">Time zone</span>
            </dt>
            <dd className="truncate">{property.timezone}</dd>
          </div>
          <div className="flex items-center gap-2">
            <dt>
              <Banknote className="size-3.5 text-ink-faint" aria-hidden />
              <span className="sr-only">Currency</span>
            </dt>
            <dd>{property.currency}</dd>
          </div>
        </dl>
      </Link>
    </li>
  );
}

export function PropertiesView() {
  const auth = useAuth();
  const router = useRouter();
  const toast = useToast();
  const { properties, error, isLoading, mutate } = useProperties();
  const canAdd = auth.canOrgWide('property.manage');
  // A new property starts from the organisation's defaults; the API does not apply them itself.
  const { data: organisation } = useSWR<Organization>(canAdd ? '/org' : null);
  const [adding, setAdding] = useState(false);

  if (!auth.can('property.read')) return <NoAccess />;

  const addButton = canAdd && (
    <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
      Add property
    </Button>
  );

  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      <PageHeader
        title="Properties"
        description="The hotels and villas you run, with their room types, units and rate plans."
        actions={addButton}
      />
      {canAdd && (
        <Suspense fallback={null}>
          <WelcomeNotice />
        </Suspense>
      )}

      {error ? (
        <ErrorState error={error} onRetry={() => void mutate()} />
      ) : isLoading ? (
        <PageLoading />
      ) : properties.length === 0 ? (
        <EmptyState
          icon={<Building2 className="size-5" />}
          title="No properties yet"
          description={
            canAdd
              ? 'Add your first hotel or villa to start setting up rooms and rates.'
              : 'No property has been shared with you. Ask an organisation admin for access.'
          }
          action={addButton}
        />
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {/* Properties in use first; the order within each group stays as the API gives it. */}
          {[...properties]
            .sort((a, b) => Number(b.active) - Number(a.active))
            .map((property) => (
              <PropertyCard key={property.id} property={property} />
            ))}
        </ul>
      )}

      {adding && (
        <PropertyDialog
          defaults={{
            timezone: organisation?.defaultTimezone ?? 'Asia/Kolkata',
            currency: organisation?.defaultCurrency ?? 'INR',
          }}
          onClose={() => setAdding(false)}
          onCreated={(property) => {
            toast.success(`${property.name} added`, 'Next, add its room types.');
            void mutate();
            router.push(`/settings/properties/${property.id}`);
          }}
        />
      )}
    </div>
  );
}
