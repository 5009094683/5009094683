/** Booking sites by the codes the channel manager uses for them. */
export const CHANNEL_NAMES: Record<string, string> = {
  BDC: 'Booking.com',
  ABB: 'Airbnb',
  EXP: 'Expedia',
  AGO: 'Agoda',
  MMT: 'MakeMyTrip',
  GOI: 'Goibibo',
  CTP: 'Trip.com',
  VRB: 'Vrbo',
  GHA: 'Google',
  YTR: 'Yatra',
  // The codes the mailbox reader and the calendar connections give the same sites, and
  // the sites only they know.
  GIB: 'Goibibo',
  YAT: 'Yatra',
  TRA: 'Tripadvisor',
  HWL: 'Hostelworld',
  CLT: 'Cleartrip',
  EMT: 'EaseMyTrip',
  HBD: 'Hotelbeds',
  TVL: 'Traveloka',
  DDC: 'Despegar',
};

/** How a booking came when it did not come through a booking site. */
export const SOURCE_LABELS: Record<string, string> = {
  direct: 'Direct',
  walk_in: 'Walk-in',
  phone: 'Phone',
  website: 'Website',
  ota: 'Booking site',
  corporate: 'Corporate',
  travel_agent: 'Travel agent',
  owner: 'Owner',
  group: 'Group',
};

/** What to call where a booking came from, given a booking site code or a source. */
export function sourceName(key: string): string {
  return CHANNEL_NAMES[key.toUpperCase()] ?? SOURCE_LABELS[key] ?? key;
}
