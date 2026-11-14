'use client';

import { useState } from 'react';
import type { PropertyDetail } from '@/lib/types';
import { ArrivalCard, ArrivalDialog } from './arrival';
import { BookingWebsiteCard, BookingWebsiteDialog } from './booking-website';
import { GuestContentCard, GuestContentDialog } from './guest-content';
import { HouseCard, HouseDialog } from './house';

type Section = 'website' | 'content' | 'arrival' | 'house';

/**
 * A property's settings, section by section: each shows what is in force in plain words, and
 * opens a dialog to change it for those who may manage the property. Anyone who may see the
 * property reads them. The settings of the rate suggestions are kept on the Rates screen.
 */
export function PropertySettings({
  detail,
  canManage,
}: {
  detail: PropertyDetail;
  canManage: boolean;
}) {
  const [editing, setEditing] = useState<Section | null>(null);
  const { property } = detail;
  const edit = (section: Section) => (canManage ? () => setEditing(section) : undefined);
  const close = () => setEditing(null);

  return (
    <div className="mt-4 flex flex-col gap-4">
      <BookingWebsiteCard detail={detail} canManage={canManage} onEdit={edit('website')} />
      <GuestContentCard property={property} onEdit={edit('content')} />
      <ArrivalCard property={property} onEdit={edit('arrival')} />
      <HouseCard property={property} onEdit={edit('house')} />

      {editing === 'website' && <BookingWebsiteDialog property={property} onClose={close} />}
      {editing === 'content' && <GuestContentDialog property={property} onClose={close} />}
      {editing === 'arrival' && <ArrivalDialog property={property} onClose={close} />}
      {editing === 'house' && <HouseDialog property={property} onClose={close} />}
    </div>
  );
}
