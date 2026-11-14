import type { CheckOutResult, FrontDeskBoard, FrontDeskStay, freeUnitsFor } from '@pms/domain';
import type { Serialized } from '@/lib/types';

export type Board = Serialized<FrontDeskBoard>;
/** One room of a reservation on the front desk board. */
export type Stay = Serialized<FrontDeskStay>;
export type CheckOutOutcome = Serialized<CheckOutResult>;
export type FreeUnit = Awaited<ReturnType<typeof freeUnitsFor>>[number];
export type Housekeeping = FreeUnit['housekeepingStatus'];

export type BoardList = 'arrivals' | 'departures' | 'inHouse';
