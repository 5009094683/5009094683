import type { GroupDetail, GroupSummary } from '@pms/domain';
import type { Serialized } from '@/lib/types';

export type GroupItem = Serialized<GroupSummary>;
export type Group = Serialized<GroupDetail>;
export type GroupHold = Group['holds'][number];
export type GroupNight = Group['nights'][number];
export type GroupBooking = Group['reservations'][number];
export type GroupStatus = GroupItem['status'];
export type StatusFilter = GroupStatus | 'all';
