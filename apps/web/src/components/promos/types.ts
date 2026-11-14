import type { PromoRow } from '@pms/domain';
import type { Serialized } from '@/lib/types';

export type Promo = Serialized<PromoRow>;
/** A percentage off every night, or a fixed amount off the stay. */
export type PromoKind = Promo['kind'];
