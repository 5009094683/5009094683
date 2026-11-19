import type { Permission } from '@pms/domain/shared';
import type { Property, RatePlan, RoomType } from '@/lib/types';

export const KIND_LABELS: Record<Property['kind'], string> = {
  hotel: 'Hotel',
  villa: 'Villa',
};

export const MEAL_PLAN_LABELS: Record<RatePlan['mealPlan'], string> = {
  room_only: 'Room only',
  breakfast: 'Breakfast included',
  half_board: 'Half board (breakfast and dinner)',
  full_board: 'Full board (all meals)',
  all_inclusive: 'All inclusive',
};

/** The choices as worded when picking one. */
export const ASSIGNMENT_LABELS: Record<RoomType['assignment'], string> = {
  at_booking: 'Every booking is tied to a unit straight away (villas, linked units)',
  at_check_in: 'Sold by count; the room can be chosen later (hotels)',
};

/** The same choices as a statement about a room type. */
export const ASSIGNMENT_SUMMARIES: Record<RoomType['assignment'], string> = {
  at_booking: 'Every booking is tied to a unit straight away.',
  at_check_in: 'Sold by count; the room can be chosen later.',
};

/** What each permission lets someone do, in the words an administrator would use. */
export const PERMISSION_LABELS: Record<Permission, string> = {
  'org.manage': 'Manage organisation settings, users and single sign-on',
  'audit.read': 'See the audit trail',
  'property.read': 'See properties, room types, units and rate plans',
  'property.manage': 'Change property details, room types and units',
  'rates.read': 'See rates and restrictions',
  'rates.write': 'Change rate plans, rates and restrictions',
  'reservations.read': 'See reservations and the calendar',
  'reservations.write': 'Create and change reservations',
  'reservations.override': 'Book past capacity, bypass restrictions and override rates',
  'blocks.write': 'Block dates and hold rooms',
  'frontdesk.operate': 'Check guests in and out',
  'guests.read': 'See guest profiles',
  'guests.write': 'Change guest profiles',
  'guests.pii': 'See identity document numbers',
  'folio.read': 'See folios and payments',
  'folio.write': 'Post charges and take payments',
  'payments.refund': 'Refund payments',
  'accounting.manage': 'Manage accounting settings',
  'nightaudit.run': 'Run the night audit',
  'housekeeping.read': 'See housekeeping status',
  'housekeeping.write': 'Update housekeeping status',
  'maintenance.write': 'Take units out of service for maintenance',
  'channels.read': 'See channel connections',
  'channels.manage': 'Manage channel connections',
  'inbox.read': 'Read guest messages',
  'inbox.write': 'Reply to guest messages',
  'reports.read': 'See reports',
  'ai.use': 'Use the assistant',
  'ai.pricing.approve': 'Approve pricing recommendations',
  'owner.portal': 'Owner portal: the calendar and statements of their own units',
};
