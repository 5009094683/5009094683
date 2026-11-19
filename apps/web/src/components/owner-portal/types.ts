import type { BlockRow, OwnerBlock, OwnerCalendar, OwnerOverview, OwnerStay } from '@pms/domain';
import type { Serialized } from '@/lib/types';

export type { Contract, Statement } from '@/components/owners/types';

export type Overview = Serialized<OwnerOverview>;
/** One of the owner's villas, with its month so far and the nights they have taken this year. */
export type Villa = Overview['contracts'][number];

export type Calendar = Serialized<OwnerCalendar>;
/** A guest stay on one of the owner's units. Guests are never named to owners. */
export type Stay = Serialized<OwnerStay>;
/** Dates closed on one of the owner's units: their own stay, or anything else. */
export type Block = Serialized<OwnerBlock>;

/** What the API answers when the owner takes dates: the closure it made. */
export type TakenDates = Serialized<BlockRow>;
