import { and, asc, eq } from 'drizzle-orm';
import {
  properties,
  taxRules,
  type DbOrTx,
  type LineTax,
  type TaxCategory,
  type TaxComponent,
  type TaxSlab,
} from '@pms/db';
import { writeAudit } from './audit';
import type { Actor } from './context';
import { validationError } from './errors';
import { requireProperty } from './properties';
import { HALVES, indiaGst } from './tax-presets';
import { transact } from './sqlx';

export type TaxRuleRow = typeof taxRules.$inferSelect;

export interface TaxResult {
  /** Whole rate applied, in basis points. */
  rateBp: number;
  taxAmount: number;
  taxes: LineTax[];
}

const NO_TAX: TaxResult = { rateBp: 0, taxAmount: 0, taxes: [] };

/**
 * The tax on a charge.
 *
 * The rate is chosen by the price of one unit for one night (`unitAmount`),
 * which is how price-dependent rates are defined: India taxes a room at 5% up
 * to 7,500 rupees a night and 18% above. Each component (CGST, SGST) is
 * worked out at its own share of the rate and rounded on its own, so the
 * figures on an invoice add up exactly as printed.
 */
export function computeTax(
  rule: Pick<TaxRuleRow, 'slabs' | 'components'> | null | undefined,
  unitAmount: number,
  quantity = 1,
  /**
   * The price that decides the rate, when it is not the amount being taxed: a charge for
   * cancelling a room is taxed at the rate of the room's nightly price, whatever its own size.
   */
  priceForRate: number = unitAmount,
): TaxResult {
  if (!rule || unitAmount === 0) return NO_TAX;
  const value = Math.abs(priceForRate);
  const slabs = [...rule.slabs].sort(
    (a, b) => (a.upTo ?? Number.MAX_SAFE_INTEGER) - (b.upTo ?? Number.MAX_SAFE_INTEGER),
  );
  const slab = slabs.find((s) => s.upTo === null || value <= s.upTo) ?? slabs[slabs.length - 1];
  if (!slab || slab.rateBp === 0) return NO_TAX;
  const base = unitAmount * quantity;
  const components =
    rule.components.length > 0 ? rule.components : [{ code: 'TAX', shareBp: 10_000 }];
  const taxes = components.map((component) => ({
    code: component.code,
    rateBp: Math.round((slab.rateBp * component.shareBp) / 10_000),
    // Rounded half away from zero, so a refund's tax mirrors the charge's.
    amount:
      Math.sign(base) *
      Math.round((Math.abs(base) * slab.rateBp * component.shareBp) / 100_000_000),
  }));
  return {
    rateBp: slab.rateBp,
    taxAmount: taxes.reduce((sum, t) => sum + t.amount, 0),
    taxes,
  };
}

/**
 * The property's tax rules. A property in India that has none yet is given
 * the GST preset the first time they are needed, so charges are taxed from
 * the first day without any set-up; everywhere else nothing is taxed until
 * rules are entered.
 */
export async function taxRulesFor(tx: DbOrTx, propertyId: string): Promise<TaxRuleRow[]> {
  const existing = await tx
    .select()
    .from(taxRules)
    .where(eq(taxRules.propertyId, propertyId))
    .orderBy(asc(taxRules.category));
  if (existing.length > 0) return existing.filter((r) => r.active);
  const [property] = await tx.select().from(properties).where(eq(properties.id, propertyId));
  if (!property || property.country.toUpperCase() !== 'IN') return [];
  const preset = indiaGst(property.settings.specifiedPremises ?? false);
  await tx
    .insert(taxRules)
    .values(preset.map((rule) => ({ propertyId, ...rule, components: HALVES })))
    .onConflictDoNothing();
  // Read back rather than trust what was inserted: another request may have got there first.
  return tx
    .select()
    .from(taxRules)
    .where(and(eq(taxRules.propertyId, propertyId), eq(taxRules.active, true)))
    .orderBy(asc(taxRules.category));
}

export async function taxRuleFor(
  tx: DbOrTx,
  propertyId: string,
  category: TaxCategory,
): Promise<TaxRuleRow | null> {
  return (await taxRulesFor(tx, propertyId)).find((r) => r.category === category) ?? null;
}

export interface TaxRuleInput {
  category: TaxCategory;
  name: string;
  serviceCode?: string | null;
  slabs: TaxSlab[];
  components: TaxComponent[];
}

function validateRule(input: TaxRuleInput): void {
  if (!input.name.trim()) throw validationError('A tax rule needs a name');
  if (input.slabs.length === 0) throw validationError('A tax rule needs at least one rate');
  const open = input.slabs.filter((s) => s.upTo === null);
  if (open.length !== 1) {
    throw validationError('Exactly one rate must have no upper limit, to cover every price');
  }
  const limits = input.slabs.filter((s) => s.upTo !== null).map((s) => s.upTo!);
  if (
    new Set(limits).size !== limits.length ||
    limits.some((l) => !Number.isInteger(l) || l <= 0)
  ) {
    throw validationError('Price limits must be different whole amounts above zero');
  }
  if (input.slabs.some((s) => !Number.isInteger(s.rateBp) || s.rateBp < 0 || s.rateBp > 10_000)) {
    throw validationError('A tax rate must be between 0% and 100%');
  }
  if (input.components.length === 0)
    throw validationError('A tax rule needs at least one component');
  if (input.components.some((c) => !c.code.trim() || c.shareBp <= 0)) {
    throw validationError('Each tax component needs a name and a share above zero');
  }
  if (input.components.reduce((sum, c) => sum + c.shareBp, 0) !== 10_000) {
    throw validationError('The shares of the tax components must add up to 100%');
  }
}

/**
 * Replaces the rule for one category of charge. Charges already posted keep
 * the tax they were posted with; only new charges use the new rule.
 */
export async function saveTaxRule(
  db: DbOrTx,
  actor: Actor,
  propertyId: string,
  input: TaxRuleInput,
): Promise<TaxRuleRow> {
  validateRule(input);
  return transact(db, async (tx) => {
    await requireProperty(tx, actor.orgId, propertyId);
    // Make sure the preset (if any) exists first, so saving one rule does not hide the others.
    await taxRulesFor(tx, propertyId);
    await tx
      .update(taxRules)
      .set({ active: false })
      .where(
        and(
          eq(taxRules.propertyId, propertyId),
          eq(taxRules.category, input.category),
          eq(taxRules.active, true),
        ),
      );
    const [row] = await tx
      .insert(taxRules)
      .values({
        propertyId,
        category: input.category,
        name: input.name.trim(),
        serviceCode: input.serviceCode?.trim() || null,
        slabs: input.slabs,
        components: input.components.map((c) => ({ code: c.code.trim(), shareBp: c.shareBp })),
      })
      .returning();
    await writeAudit(tx, actor, {
      action: 'tax.rule_saved',
      entityType: 'tax_rule',
      entityId: row!.id,
      propertyId,
      summary: `Changed the tax on ${input.category} charges`,
      changes: { slabs: input.slabs, components: input.components },
    });
    return row!;
  });
}
