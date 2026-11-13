'use client';

import type { Permission } from '@pms/domain/shared';
import { Select } from '@/components/ui/field';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { useCurrentProperty } from '@/lib/hooks';
import type { Property } from '@/lib/types';

/**
 * The property the screen works on, out of the open properties where the user
 * holds `permission`: the one last chosen anywhere in the app when it qualifies,
 * else the first that does.
 */
export function usePropertyFor(permission: Permission): {
  property: Property | undefined;
  properties: Property[];
  select: (id: string) => void;
  isLoading: boolean;
} {
  const auth = useAuth();
  const current = useCurrentProperty();
  const properties = current.properties.filter((p) => p.active && auth.can(permission, p.id));
  const property = properties.find((p) => p.id === current.property?.id) ?? properties[0];
  return { property, properties, select: current.select, isLoading: current.isLoading };
}

export function PropertyPicker({
  property,
  properties,
  onSelect,
  className,
}: {
  property: Property;
  properties: Property[];
  onSelect: (id: string) => void;
  className?: string;
}) {
  if (properties.length < 2) return null;
  return (
    <Select
      aria-label="Property"
      value={property.id}
      onChange={(event) => onSelect(event.target.value)}
      className={cn('w-auto max-w-full', className)}
    >
      {properties.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </Select>
  );
}
