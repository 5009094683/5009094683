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
