import { Pencil } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/misc';
import type { Property } from '@/lib/types';

function Item({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className}>
      <dt className="text-[13px] text-ink-faint">{label}</dt>
      <dd className="text-sm break-words text-ink">
        {children || <span className="text-ink-faint">Not set</span>}
      </dd>
    </div>
  );
}

/** A property's own details at a glance, with the way in to editing them for those who may. */
export function PropertySummary({ property, onEdit }: { property: Property; onEdit?: () => void }) {
  const lines = [
    property.addressLine1,
    property.addressLine2,
    property.city,
    property.state,
    property.postalCode,
  ].filter(Boolean);
  // Every property has a country; on its own it is not an address.
  const address = lines.length > 0 ? [...lines, property.country].join(', ') : '';
  return (
    <Card className="p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3 pb-3">
        <h2 className="text-base font-semibold text-ink">Details</h2>
        {onEdit && (
          <Button size="sm" icon={<Pencil className="size-3.5" />} onClick={onEdit}>
            Edit details
          </Button>
        )}
      </div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
        <Item label="Address" className="sm:col-span-2">
          {address}
        </Item>
        <Item label="Phone">{property.phone}</Item>
        <Item label="Email">{property.email}</Item>
        <Item label="Legal name" className="sm:col-span-2">
          {property.legalName}
        </Item>
        <Item label="GST state code">{property.stateCode}</Item>
        <Item label="GSTIN">{property.gstin}</Item>
        <Item label="Time zone">{property.timezone}</Item>
        <Item label="Currency">{property.currency}</Item>
        <Item label="Check-in from">{property.checkInTime}</Item>
        <Item label="Check-out by">{property.checkOutTime}</Item>
        <Item label="Availability horizon" className="sm:col-span-2">
          {property.inventoryHorizonDays} days ahead
        </Item>
      </dl>
    </Card>
  );
}
