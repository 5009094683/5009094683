'use client';

import { Plus, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import type { Property } from '@/lib/types';
import { FormError } from './form-error';
import { amountText, parseAmount, parsePercent, percentText } from './money';
import { CATEGORY_LABELS, ruleInWords, serviceCodeLabel, sortedSlabs } from './tax-words';
import type { TaxCategory, TaxComponent, TaxRule, TaxSlab } from './types';

const MAX_BANDS = 9;
const MAX_PARTS = 6;

/** A rate that applies up to a price. The rate above the highest limit is kept apart from these. */
interface Band {
  key: number;
  upTo: string;
  rate: string;
}

interface Part {
  key: number;
  code: string;
  share: string;
}

function readRate(text: string): number | null {
  const rate = parsePercent(text);
  return rate !== null && rate <= 10_000 ? rate : null;
}

type Checked = { problem: string } | { slabs: TaxSlab[]; components: TaxComponent[] };

/** The form as the server wants it, or what is wrong with it. The server applies the same rules. */
function check(bands: Band[], topRate: string, parts: Part[], currency: string): Checked {
  const limits = bands.map((band) => parseAmount(band.upTo, currency));
  if (limits.some((limit) => limit === null || limit === 0)) {
    return { problem: 'Each price limit has to be an amount above zero.' };
  }
  const rates = [...bands.map((band) => readRate(band.rate)), readRate(topRate)];
  if (rates.some((rate) => rate === null)) {
    return {
      problem: 'Each rate has to be a percentage from 0 to 100, with at most two decimals.',
    };
  }
  if (new Set(limits).size !== limits.length) {
    return { problem: 'Two rows have the same price limit.' };
  }
  const codes = parts.map((part) => part.code.trim());
  if (codes.some((code) => code === '')) {
    return { problem: 'Give each part of the tax the name it has on invoices, such as CGST.' };
  }
  if (new Set(codes.map((code) => code.toUpperCase())).size !== codes.length) {
    return { problem: 'Two parts of the tax have the same name.' };
  }
  const shares = parts.map((part) => parsePercent(part.share));
  if (shares.some((share) => share === null || share === 0)) {
    return { problem: 'Each share has to be a percentage above zero, with at most two decimals.' };
  }
  const total = shares.reduce<number>((sum, share) => sum + (share ?? 0), 0);
  if (total !== 10_000) {
    return { problem: `The shares add up to ${percentText(total)}%. They have to add up to 100%.` };
  }
  return {
    slabs: sortedSlabs([
      ...bands.map((_, index) => ({ upTo: limits[index] ?? null, rateBp: rates[index] ?? 0 })),
      { upTo: null, rateBp: rates[rates.length - 1] ?? 0 },
    ]),
    components: parts.map((_, index) => ({
      code: codes[index] ?? '',
      shareBp: shares[index] ?? 0,
    })),
  };
}

/** Sets or changes how one kind of charge is taxed at a property. */
export function TaxRuleDialog({
  property,
  category,
  rule,
  onClose,
  onSaved,
}: {
  property: Property;
  category: TaxCategory;
  /** The rule in force. Absent: this kind of charge is not taxed yet. */
  rule?: TaxRule;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const { currency } = property;
  const codeLabel = serviceCodeLabel(property.country);

  const [name, setName] = useState(rule?.name ?? '');
  const [serviceCode, setServiceCode] = useState(rule?.serviceCode ?? '');
  const [initial] = useState(() => {
    const sorted = sortedSlabs(rule?.slabs ?? []);
    const top = sorted.find((slab) => slab.upTo === null) ?? sorted[sorted.length - 1];
    return {
      bands: sorted
        .filter((slab) => slab !== top && slab.upTo !== null)
        .map((slab, key) => ({
          key,
          upTo: amountText(slab.upTo ?? 0, currency),
          rate: percentText(slab.rateBp),
        })),
      topRate: top ? percentText(top.rateBp) : '',
      parts: (rule?.components ?? [{ code: '', shareBp: 10_000 }]).map((component, key) => ({
        key,
        code: component.code,
        share: percentText(component.shareBp),
      })),
    };
  });
  const [bands, setBands] = useState<Band[]>(initial.bands);
  const [topRate, setTopRate] = useState(initial.topRate);
  const [parts, setParts] = useState<Part[]>(initial.parts);
  /** How many times the form was sent with something wrong: nothing is pointed out before the first. */
  const [attempts, setAttempts] = useState(0);
  const nextKey = useRef(initial.bands.length + initial.parts.length);

  const checked = check(bands, topRate, parts, currency);
  const problem = 'problem' in checked ? checked.problem : null;

  const save = useAction(async () => {
    if ('problem' in checked) {
      setAttempts((count) => count + 1);
      return;
    }
    await api<TaxRule>(`/properties/${property.id}/tax-rules/${category}`, {
      method: 'PUT',
      body: {
        name: name.trim(),
        serviceCode: serviceCode.trim() || null,
        slabs: checked.slabs,
        components: checked.components,
      },
    });
    toast.success(
      `Tax on ${CATEGORY_LABELS[category].toLowerCase()} saved`,
      'Charges posted from now on use it.',
    );
    onSaved();
    onClose();
  });

  const setBand = (key: number, change: Partial<Band>) =>
    setBands((rows) => rows.map((row) => (row.key === key ? { ...row, ...change } : row)));
  const setPart = (key: number, change: Partial<Part>) =>
    setParts((rows) => rows.map((row) => (row.key === key ? { ...row, ...change } : row)));

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={`Tax on ${CATEGORY_LABELS[category].toLowerCase()}`}
      description={property.name}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="tax-rule-form" variant="primary" loading={save.busy}>
            Save
          </Button>
        </>
      }
    >
      <form
        id="tax-rule-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save.run();
        }}
        className="flex flex-col gap-5"
      >
        <FormError message={save.error} />

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_11rem]">
          <Field label="Name" hint="For your own records, such as GST on accommodation.">
            {(props) => (
              <Input
                {...props}
                required
                maxLength={120}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </Field>
          <Field label={codeLabel} optional hint="Printed on invoices.">
            {(props) => (
              <Input
                {...props}
                maxLength={20}
                spellCheck={false}
                value={serviceCode}
                onChange={(event) => setServiceCode(event.target.value)}
              />
            )}
          </Field>
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium text-ink">Rates</legend>
          <p className="text-[13px] text-ink-soft">
            {category === 'room'
              ? 'The rate goes by the price of the room for one night, before tax.'
              : 'The rate goes by the price of one item, before tax.'}{' '}
            With one row, the same rate applies at any price.
          </p>
          <div className="grid max-w-md grid-cols-[minmax(0,1fr)_6.5rem_2rem] items-center gap-x-2 gap-y-2">
            <span className="text-[13px] font-medium text-ink-soft">Price up to ({currency})</span>
            <span className="text-[13px] font-medium text-ink-soft">Rate (%)</span>
            <span />
            {bands.map((band, index) => (
              <div key={band.key} className="contents">
                <Input
                  aria-label={`Price up to, row ${index + 1}`}
                  inputMode="decimal"
                  className="text-right"
                  value={band.upTo}
                  onChange={(event) => setBand(band.key, { upTo: event.target.value })}
                />
                <Input
                  aria-label={`Rate in percent, row ${index + 1}`}
                  inputMode="decimal"
                  className="text-right"
                  value={band.rate}
                  onChange={(event) => setBand(band.key, { rate: event.target.value })}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove row ${index + 1}`}
                  onClick={() => setBands((rows) => rows.filter((row) => row.key !== band.key))}
                >
                  <X className="size-4" aria-hidden />
                </Button>
              </div>
            ))}
            <span className="flex h-9 items-center rounded-md bg-sunken px-2.5 text-sm text-ink-soft">
              {bands.length === 0 ? 'Any price' : 'And above'}
            </span>
            <Input
              aria-label={bands.length === 0 ? 'Rate in percent' : 'Rate in percent, above that'}
              inputMode="decimal"
              className="text-right"
              value={topRate}
              onChange={(event) => setTopRate(event.target.value)}
            />
            <span />
          </div>
          {bands.length < MAX_BANDS && (
            <Button
              size="sm"
              className="self-start"
              icon={<Plus className="size-3.5" aria-hidden />}
              onClick={() => {
                const key = nextKey.current++;
                setBands((rows) => [...rows, { key, upTo: '', rate: '' }]);
              }}
            >
              Add a price limit
            </Button>
          )}
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium text-ink">How the tax is split</legend>
          <p className="text-[13px] text-ink-soft">
            Each part has its own line on invoices. The shares have to add up to 100%.
          </p>
          <div className="grid max-w-md grid-cols-[minmax(0,1fr)_6.5rem_2rem] items-center gap-x-2 gap-y-2">
            <span className="text-[13px] font-medium text-ink-soft">Name on invoices</span>
            <span className="text-[13px] font-medium text-ink-soft">Share (%)</span>
            <span />
            {parts.map((part, index) => (
              <div key={part.key} className="contents">
                <Input
                  aria-label={`Name on invoices, part ${index + 1}`}
                  maxLength={12}
                  spellCheck={false}
                  value={part.code}
                  onChange={(event) => setPart(part.key, { code: event.target.value })}
                />
                <Input
                  aria-label={`Share in percent, part ${index + 1}`}
                  inputMode="decimal"
                  className="text-right"
                  value={part.share}
                  onChange={(event) => setPart(part.key, { share: event.target.value })}
                />
                {parts.length > 1 ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove part ${index + 1}`}
                    onClick={() => setParts((rows) => rows.filter((row) => row.key !== part.key))}
                  >
                    <X className="size-4" aria-hidden />
                  </Button>
                ) : (
                  <span />
                )}
              </div>
            ))}
          </div>
          {parts.length < MAX_PARTS && (
            <Button
              size="sm"
              className="self-start"
              icon={<Plus className="size-3.5" aria-hidden />}
              onClick={() => {
                const key = nextKey.current++;
                setParts((rows) => [...rows, { key, code: '', share: '' }]);
              }}
            >
              Add a part
            </Button>
          )}
        </fieldset>

        {attempts > 0 && <FormError key={attempts} tone="warning" message={problem} />}
        {'slabs' in checked && (
          <p className="rounded-md bg-sunken px-3 py-2.5 text-sm text-ink">
            <span className="text-ink-soft">In words: </span>
            {ruleInWords(
              category,
              { ...checked, serviceCode: serviceCode.trim() || null },
              currency,
              property.country,
            )}
          </p>
        )}
        <p className="text-[13px] text-ink-soft">
          Charges already posted keep the tax they were posted with. Only charges posted after you
          save use this.
        </p>
      </form>
    </Dialog>
  );
}
