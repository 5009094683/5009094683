'use client';

import { useProperties } from '@/lib/hooks';

/**
 * The currency for figures that belong to a company rather than a property.
 * A company's credit limit and what it owes come from the server as bare
 * amounts, so they are shown in the currency the properties trade in.
 */
export function useAccountsCurrency(): string {
  const { properties } = useProperties();
  return (properties.find((p) => p.active) ?? properties[0])?.currency ?? 'INR';
}
