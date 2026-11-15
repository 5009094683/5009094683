import type { Lang } from '../../business/schema';
import { en } from './en';
import type { Wording } from './types';
import { vi } from './vi';

export const WORDING: Record<Lang, Wording> = { en, vi };
export type { BookingView, Wording } from './types';
