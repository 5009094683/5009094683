'use client';

import { useMemo, useState } from 'react';
import { isValidDate } from '@pms/domain/shared';
import { FormError } from '@/components/housekeeping/form-error';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Segmented, Select, Textarea } from '@/components/ui/field';
import { Notice } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction, useProperties, usePropertyDetail } from '@/lib/hooks';
import { amountText, parseAmount, parsePercent, percentText } from './money';
import { useProblems } from './problems';
import type { Contract, ContractModel, FeeBasis, Owner } from './types';
import { BASIS_HELP, BASIS_LABELS, MODEL_HELP, MODEL_LABELS, villaName } from './words';

type Problem =
  'property' | 'unit' | 'startsOn' | 'endsOn' | 'fee' | 'feeTax' | 'rent' | 'nights' | 'notice';

type Cover = 'property' | 'unit';

/** What the API answers when a contract is saved: the contract without the names joined to it. */
type SavedContract = Omit<Contract, 'propertyName' | 'propertyCode' | 'currency' | 'unitName'>;

const Legend = ({ children }: { children: string }) => (
  <legend className="mb-2 text-xs font-semibold tracking-wide text-ink-faint uppercase">
    {children}
  </legend>
);

/** Adds a contract for one of the owner's villas, or changes the terms of one. */
export function ContractDialog({
  owner,
  contract,
  hasIssued = false,
  onClose,
  onSaved,
}: {
  owner: Owner;
  /** The contract to change. Absent: a new one. */
  contract?: Contract;
  /** Whether a statement has been issued on this contract, which its changed terms will not touch. */
  hasIssued?: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const auth = useAuth();
  const toast = useToast();
  const { properties, isLoading: loadingProperties, error: propertiesError } = useProperties();
  const choices = useMemo(
    () => properties.filter((p) => p.active && auth.can('accounting.manage', p.id)),
    [properties, auth],
  );

  const [chosenProperty, setChosenProperty] = useState('');
  // With one property to choose from there is nothing to choose.
  const propertyId =
    contract?.propertyId ?? (chosenProperty || (choices.length === 1 ? choices[0]!.id : ''));
  const currency =
    contract?.currency ?? choices.find((p) => p.id === propertyId)?.currency ?? 'INR';
  const detail = usePropertyDetail(contract ? null : propertyId || null);

  const [cover, setCover] = useState<Cover>('property');
  const [unitId, setUnitId] = useState('');
  const [startsOn, setStartsOn] = useState(contract?.startsOn ?? '');
  const [endsOn, setEndsOn] = useState(contract?.endsOn ?? '');
  const [model, setModel] = useState<ContractModel>(contract?.model ?? 'revenue_share');
  const [fee, setFee] = useState(percentText(contract?.managementFeeBp ?? 2000));
  const [basis, setBasis] = useState<FeeBasis>(contract?.feeBasis ?? 'net');
  const [feeTax, setFeeTax] = useState(percentText(contract?.feeTaxBp ?? 1800));
  const [commissionOnOwner, setCommissionOnOwner] = useState(contract?.commissionOnOwner ?? true);
  const [rent, setRent] = useState(
    contract && contract.fixedRent !== null
      ? amountText(contract.fixedRent, contract.currency)
      : '',
  );
  const [nights, setNights] = useState(
    contract && contract.ownerNightsPerYear !== null ? String(contract.ownerNightsPerYear) : '',
  );
  const [notice, setNotice] = useState(String(contract?.ownerStayNoticeDays ?? 0));
  const [notes, setNotes] = useState(contract?.notes ?? '');
  const { problems, accept, clear, form } = useProblems<Problem>();

  // Units in the order they are let: each villa or room, then the rooms inside it.
  const units = useMemo(() => {
    const all = (detail.data?.roomTypes ?? [])
      .flatMap((type) => type.units)
      .filter((u) => u.active);
    const top = all.filter((u) => !u.parentUnitId || !all.some((p) => p.id === u.parentUnitId));
    return top.flatMap((unit) => [
      { id: unit.id, label: unit.name },
      ...all
        .filter((child) => child.parentUnitId === unit.id)
        .map((child) => ({ id: child.id, label: `${child.name} (inside ${unit.name})` })),
    ]);
  }, [detail.data]);

  const share = model === 'revenue_share';

  const save = useAction(async () => {
    const found: Partial<Record<Problem, string>> = {};
    if (!contract) {
      if (!propertyId) found.property = 'Choose the property the villa belongs to.';
      if (cover === 'unit' && !unitId) found.unit = 'Choose the unit, or cover the whole property.';
    }
    if (!isValidDate(startsOn)) found.startsOn = 'Choose the first day of the contract.';
    if (endsOn && !isValidDate(endsOn)) {
      found.endsOn = 'Choose the last day, or leave this empty.';
    } else if (endsOn && isValidDate(startsOn) && endsOn < startsOn) {
      found.endsOn = 'The last day cannot be before the first.';
    }
    const feeBp = parsePercent(fee);
    const feeTaxBp = parsePercent(feeTax);
    const rentAmount = parseAmount(rent, currency);
    if (share) {
      if (feeBp === null || feeBp > 10_000) found.fee = 'Enter a percentage from 0 to 100.';
      if (feeTaxBp === null || feeTaxBp > 10_000) {
        found.feeTax = 'Enter a percentage from 0 to 100. 0 means no tax.';
      }
    } else if (rentAmount === null) {
      found.rent = 'Enter the rent for a month, such as 150000.';
    }
    const nightsAllowed = nights.trim() === '' ? null : Number(nights);
    if (nights.trim() !== '' && (!/^\d{1,3}$/.test(nights.trim()) || Number(nights) > 366)) {
      found.nights = 'Enter a number of nights from 0 to 366, or leave this empty for no limit.';
    }
    const noticeDays = /^\d{1,3}$/.test(notice.trim()) ? Number(notice) : null;
    if (noticeDays === null || noticeDays > 365) {
      found.notice = 'Enter a number of days from 0 to 365.';
    }
    if (!accept(found)) return;

    const terms = {
      startsOn,
      endsOn: endsOn || null,
      model,
      ...(share
        ? {
            managementFeeBp: feeBp ?? 0,
            feeBasis: basis,
            feeTaxBp: feeTaxBp ?? 0,
            commissionOnOwner,
            // Only a fixed-rent contract may carry a rent.
            fixedRent: null,
          }
        : { fixedRent: rentAmount }),
      ownerNightsPerYear: nightsAllowed,
      ownerStayNoticeDays: noticeDays ?? 0,
      notes: notes.trim() || null,
    };
    if (contract) {
      await api<SavedContract>(`/owner-contracts/${contract.id}`, { method: 'PATCH', body: terms });
      toast.success('Contract saved');
    } else {
      await api<SavedContract>('/owner-contracts', {
        body: {
          ...terms,
          ownerId: owner.id,
          propertyId,
          unitId: cover === 'unit' ? unitId : null,
        },
      });
      toast.success('Contract added');
    }
    onSaved();
    onClose();
  });

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={contract ? `Contract for ${villaName(contract)}` : `Add a contract with ${owner.name}`}
      description={
        contract
          ? undefined
          : 'What you have agreed for one villa: what it covers, how the owner is paid, and when they may stay there themselves.'
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="contract-form" variant="primary" loading={save.busy}>
            {contract ? 'Save' : 'Add contract'}
          </Button>
        </>
      }
    >
      <form
        ref={form}
        id="contract-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save.run();
        }}
        className="flex flex-col gap-5"
      >
        <FormError message={save.error ? `Could not save. ${save.error}` : null} />

        {contract && hasIssued && (
          <Notice tone="info">
            Statements already issued keep their figures. The terms you change here apply to
            statements prepared from now on; a draft takes them up when it is prepared again.
          </Notice>
        )}

        <fieldset className="flex flex-col gap-3">
          <Legend>What it covers</Legend>
          {contract ? (
            <p className="text-sm text-ink">
              {contract.propertyName},{' '}
              {contract.unitName ? `the unit ${contract.unitName}` : 'the whole property'}.
              <span className="block text-[13px] text-ink-faint">
                To cover something else, end this contract and add a new one.
              </span>
            </p>
          ) : (
            <>
              <Field
                label="Property"
                error={problems.property}
                hint={
                  propertiesError
                    ? 'The properties could not be loaded. Close this and try again.'
                    : !loadingProperties && choices.length === 0
                      ? 'There is no property whose accounts you keep.'
                      : undefined
                }
              >
                {(props) => (
                  <Select
                    {...props}
                    value={propertyId}
                    disabled={choices.length <= 1}
                    onChange={(event) => {
                      setChosenProperty(event.target.value);
                      setUnitId('');
                      clear('property');
                    }}
                  >
                    {choices.length !== 1 && <option value="">Choose a property</option>}
                    {choices.map((property) => (
                      <option key={property.id} value={property.id}>
                        {property.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <div className="flex flex-col items-start gap-1.5">
                <Segmented<Cover>
                  label="What the contract covers"
                  value={cover}
                  onChange={(value) => {
                    setCover(value);
                    clear('unit');
                  }}
                  options={[
                    { value: 'property', label: 'The whole property' },
                    { value: 'unit', label: 'One unit of it' },
                  ]}
                />
                <p className="text-[13px] text-ink-faint">
                  {cover === 'property'
                    ? 'Every unit of the property counts towards the owner\u2019s statement, including any added later.'
                    : 'Only this unit counts. A villa that is also let by the bedroom is covered together with its bedrooms.'}
                </p>
              </div>
              {cover === 'unit' && (
                <Field
                  label="Unit"
                  error={problems.unit}
                  hint={
                    !propertyId
                      ? 'Choose the property first.'
                      : detail.error
                        ? 'The units could not be loaded. Choose the property again.'
                        : undefined
                  }
                >
                  {(props) => (
                    <Select
                      {...props}
                      value={unitId}
                      disabled={!propertyId || !detail.data}
                      onChange={(event) => {
                        setUnitId(event.target.value);
                        clear('unit');
                      }}
                    >
                      <option value="">
                        {propertyId && detail.isLoading ? 'Loading units…' : 'Choose a unit'}
                      </option>
                      {units.map((unit) => (
                        <option key={unit.id} value={unit.id}>
                          {unit.label}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              )}
            </>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label="First day"
              hint="Stays and costs before it are not counted."
              error={problems.startsOn}
            >
              {(props) => (
                <Input
                  {...props}
                  type="date"
                  required
                  value={startsOn}
                  onChange={(event) => {
                    setStartsOn(event.target.value);
                    clear('startsOn', 'endsOn');
                  }}
                />
              )}
            </Field>
            <Field
              label="Last day"
              optional
              hint="Leave empty while the contract runs on."
              error={problems.endsOn}
            >
              {(props) => (
                <Input
                  {...props}
                  type="date"
                  min={startsOn || undefined}
                  value={endsOn}
                  onChange={(event) => {
                    setEndsOn(event.target.value);
                    clear('endsOn');
                  }}
                />
              )}
            </Field>
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-3">
          <Legend>How the owner is paid</Legend>
          <div className="flex flex-col items-start gap-1.5">
            <Segmented<ContractModel>
              label="How the owner is paid"
              value={model}
              onChange={(value) => {
                setModel(value);
                clear('fee', 'feeTax', 'rent');
              }}
              options={[
                { value: 'revenue_share', label: MODEL_LABELS.revenue_share },
                { value: 'fixed_rent', label: MODEL_LABELS.fixed_rent },
              ]}
            />
            <p className="text-[13px] text-ink-faint">{MODEL_HELP[model]}</p>
          </div>

          {share ? (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field
                  label="Management fee (%)"
                  hint="What you keep for managing the villa, as a share of its room revenue."
                  error={problems.fee}
                >
                  {(props) => (
                    <Input
                      {...props}
                      inputMode="decimal"
                      value={fee}
                      onChange={(event) => {
                        setFee(event.target.value);
                        clear('fee');
                      }}
                    />
                  )}
                </Field>
                <Field
                  label="Tax on the fee (%)"
                  hint="GST on your fee. It is taken off what the owner receives as well. 0 means none."
                  error={problems.feeTax}
                >
                  {(props) => (
                    <Input
                      {...props}
                      inputMode="decimal"
                      value={feeTax}
                      onChange={(event) => {
                        setFeeTax(event.target.value);
                        clear('feeTax');
                      }}
                    />
                  )}
                </Field>
              </div>
              <Field label="The fee is a share of" hint={BASIS_HELP[basis]}>
                {(props) => (
                  <Select
                    {...props}
                    value={basis}
                    onChange={(event) => setBasis(event.target.value as FeeBasis)}
                  >
                    <option value="net">{BASIS_LABELS.net}</option>
                    <option value="gross">{BASIS_LABELS.gross}</option>
                  </Select>
                )}
              </Field>
              <div className="flex flex-col gap-1">
                <Checkbox
                  label={'Take commission off the owner\u2019s share'}
                  checked={commissionOnOwner}
                  onChange={(event) => setCommissionOnOwner(event.target.checked)}
                />
                <p className="text-[13px] text-ink-faint">
                  {commissionOnOwner
                    ? 'What booking sites and travel agents keep of a booking is taken off before the owner is paid.'
                    : 'The commission is not taken off the owner\u2019s share: it comes out of yours.'}
                </p>
              </div>
            </>
          ) : (
            <Field
              label={`Rent a month (${currency})`}
              hint="The same amount every month. A month the contract covers only in part is paid in proportion to its days."
              error={problems.rent}
              className="sm:max-w-xs"
            >
              {(props) => (
                <Input
                  {...props}
                  inputMode="decimal"
                  value={rent}
                  onChange={(event) => {
                    setRent(event.target.value);
                    clear('rent');
                  }}
                />
              )}
            </Field>
          )}
        </fieldset>

        <fieldset className="flex flex-col gap-3">
          <Legend>The owner&rsquo;s own stays</Legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label="Nights a year"
              optional
              hint="How many nights a year they may take for themselves in the owner portal. Empty means no limit; 0 means none."
              error={problems.nights}
            >
              {(props) => (
                <Input
                  {...props}
                  inputMode="numeric"
                  value={nights}
                  onChange={(event) => {
                    setNights(event.target.value);
                    clear('nights');
                  }}
                />
              )}
            </Field>
            <Field
              label="Notice (days)"
              hint="How many days ahead they must ask. 0 lets them take free dates from today."
              error={problems.notice}
            >
              {(props) => (
                <Input
                  {...props}
                  inputMode="numeric"
                  value={notice}
                  onChange={(event) => {
                    setNotice(event.target.value);
                    clear('notice');
                  }}
                />
              )}
            </Field>
          </div>
        </fieldset>

        <Field
          label="Notes"
          optional
          hint="Anything else that was agreed. Write nothing here the owner should not read."
        >
          {(props) => (
            <Textarea
              {...props}
              maxLength={2000}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
