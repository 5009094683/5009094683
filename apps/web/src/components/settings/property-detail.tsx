'use client';

import { ArrowLeft, Building2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { useSWRConfig } from 'swr';
import { Badge, EmptyState, ErrorState, PageHeader, PageLoading } from '@/components/ui/misc';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { usePropertyDetail } from '@/lib/hooks';
import { KIND_LABELS } from './labels';
import { NoAccess } from './no-access';
import { PropertyDetailsDialog } from './property-details-dialog';
import { PropertySummary } from './property-summary';
import { RoomTypes } from './room-types';

/** One property: its details, and its room types with their units and rate plans. */
export function PropertyDetailView({ propertyId }: { propertyId: string }) {
  const auth = useAuth();
  const { mutate: mutateKey } = useSWRConfig();
  const canRead = auth.can('property.read', propertyId);
  const { data, error, mutate } = usePropertyDetail(canRead ? propertyId : null);
  const [editingDetails, setEditingDetails] = useState(false);

  if (!canRead) return <NoAccess />;
  const canManage = auth.can('property.manage', propertyId);
  // An address that names no property (400 when it is not even an id) will not load on a retry.
  const missing = error instanceof ApiError && (error.status === 404 || error.status === 400);

  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      <Link
        href="/settings/properties"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-ink-soft hover:text-ink"
      >
        <ArrowLeft className="size-4" aria-hidden /> Properties
      </Link>

      {missing ? (
        <EmptyState
          icon={<Building2 className="size-5" />}
          title="This property does not exist"
          description="The address may be wrong. Go back to the list to find the property."
        />
      ) : error ? (
        <ErrorState error={error} onRetry={() => void mutate()} />
      ) : !data ? (
        <PageLoading />
      ) : (
        <>
          <PageHeader
            title={data.property.name}
            description={
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs">{data.property.code}</span>
                <Badge tone={data.property.kind === 'villa' ? 'info' : 'brand'}>
                  {KIND_LABELS[data.property.kind]}
                </Badge>
                {!data.property.active && <Badge tone="warning">Inactive</Badge>}
              </span>
            }
          />

          <PropertySummary
            property={data.property}
            onEdit={canManage ? () => setEditingDetails(true) : undefined}
          />

          <RoomTypes
            detail={data}
            canManage={canManage}
            canRates={auth.can('rates.write', propertyId)}
            onChanged={() => void mutate()}
          />

          {editingDetails && (
            <PropertyDetailsDialog
              property={data.property}
              onClose={() => setEditingDetails(false)}
              onSaved={() => {
                void mutate();
                // The list of properties shows the name, place, time zone and currency.
                void mutateKey('/properties');
              }}
            />
          )}
        </>
      )}
    </div>
  );
}
