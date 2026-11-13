import { and, eq } from 'drizzle-orm';
import { taxRules, type DbOrTx, type TaxCategory, type TaxComponent, type TaxSlab } from '@pms/db';

export interface PresetRule {
  category: TaxCategory;
  name: string;
  serviceCode: string;
  slabs: TaxSlab[];
}

export const HALVES: TaxComponent[] = [
  { code: 'CGST', shareBp: 5_000 },
  { code: 'SGST', shareBp: 5_000 },
];

/**
 * India's GST for a hotel, as notified from 22 September 2025: accommodation
 * at 5% up to 7,500 rupees per unit per night and 18% above; restaurant
 * service at 5%, or 18% at "specified premises"; other services at 18%.
 * A property's accountant should confirm these before invoices are issued:
 * rates change, and the rules are editable for that reason.
 */
export function indiaGst(specifiedPremises: boolean): PresetRule[] {
  return [
    {
      category: 'room',
      name: 'GST on accommodation',
      serviceCode: '996311',
      slabs: [
        { upTo: 750_000, rateBp: 500 },
        { upTo: null, rateBp: 1_800 },
      ],
    },
    {
      category: 'food',
      name: 'GST on food and beverage',
      serviceCode: '996331',
      slabs: [{ upTo: null, rateBp: specifiedPremises ? 1_800 : 500 }],
    },
    {
      category: 'service',
      name: 'GST on services',
      serviceCode: '999799',
      slabs: [{ upTo: null, rateBp: 1_800 }],
    },
    {
      category: 'extra',
      name: 'GST on extras',
      serviceCode: '996311',
      slabs: [{ upTo: null, rateBp: 1_800 }],
    },
    {
      category: 'fee',
      name: 'GST on fees',
      serviceCode: '999799',
      slabs: [{ upTo: null, rateBp: 1_800 }],
    },
  ];
}

/**
 * The rate on food follows whether the property is "specified premises". When that setting
 * changes, the rule made from the preset is moved to the other rate. A rule an accountant
 * has since changed by hand is theirs, and is left as it is. Nothing happens where the
 * rules have not been made yet: they will be made from the setting as it then stands.
 */
export async function applySpecifiedPremises(
  tx: DbOrTx,
  propertyId: string,
  specifiedPremises: boolean,
): Promise<boolean> {
  const rateOf = (premises: boolean): number =>
    indiaGst(premises).find((rule) => rule.category === 'food')!.slabs[0]!.rateBp;
  const [rule] = await tx
    .select()
    .from(taxRules)
    .where(and(eq(taxRules.propertyId, propertyId), eq(taxRules.category, 'food')));
  const untouched =
    rule !== undefined &&
    rule.slabs.length === 1 &&
    rule.slabs[0]!.upTo === null &&
    rule.slabs[0]!.rateBp === rateOf(!specifiedPremises);
  if (!untouched) return false;
  await tx
    .update(taxRules)
    .set({ slabs: [{ upTo: null, rateBp: rateOf(specifiedPremises) }] })
    .where(eq(taxRules.id, rule.id));
  return true;
}
