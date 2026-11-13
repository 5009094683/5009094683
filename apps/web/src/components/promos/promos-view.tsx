'use client';

import { Copy, Pencil, Plus, TicketPercent } from 'lucide-react';
import { useState } from 'react';
import useSWR from 'swr';
import { todayIn } from '@pms/domain/shared';
import { copyText } from '@/components/engagement/clipboard';
import { NoAccess } from '@/components/settings/no-access';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/field';
import { Badge, Card, EmptyState, ErrorState, PageHeader, PageLoading } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useProperties } from '@/lib/hooks';
import { useLive } from '@/lib/live';
import type { Property } from '@/lib/types';
import { PromoDialog } from './promo-dialog';
import {
  STATE_LABELS,
  STATE_TONES,
  conditionsText,
  discountText,
  promoState,
  usesText,
  validityText,
} from './promo-words';
import type { Promo } from './types';

type Open = { kind: 'new' } | { kind: 'edit'; promo: Promo };

interface RowProps {
  promo: Promo;
  property: Property | undefined;
  canEdit: boolean;
  busy: boolean;
  onCopy: () => void;
  onEdit: () => void;
  onSwitch: (active: boolean) => void;
}

function Code({ promo, onCopy }: Pick<RowProps, 'promo' | 'onCopy'>) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="font-mono font-semibold break-all text-ink">{promo.code}</span>
      <Button
        size="icon"
        variant="ghost"
        aria-label={`Copy the code ${promo.code}`}
        onClick={onCopy}
        className="size-7"
      >
        <Copy className="size-3.5" />
      </Button>
    </span>
  );
}

function State({ promo, property }: Pick<RowProps, 'promo' | 'property'>) {
  const zone = property?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const state = promoState(promo, new Date(), todayIn(zone));
  return <Badge tone={STATE_TONES[state]}>{STATE_LABELS[state]}</Badge>;
}

function Lines({ lines }: { lines: string[] }) {
  return (
    <ul className="flex flex-col gap-0.5">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

function Controls({ promo, canEdit, busy, onEdit, onSwitch }: RowProps) {
  if (!canEdit) return null;
  return (
    <span className="inline-flex items-center gap-2">
      <Switch
        checked={promo.active}
        disabled={busy}
        label={`Code ${promo.code} switched on`}
        onChange={onSwitch}
      />
      <Button
        size="sm"
        variant="ghost"
        icon={<Pencil className="size-3.5" />}
        aria-label={`Edit the code ${promo.code}`}
        onClick={onEdit}
      >
        Edit
      </Button>
    </span>
  );
}

function PromoCard(props: RowProps) {
  const { promo, property } = props;
  return (
    <Card className="flex flex-col gap-2 p-4">
      <div className="flex items-start justify-between gap-3">
        <Code promo={promo} onCopy={props.onCopy} />
        <State promo={promo} property={property} />
      </div>
      <div className="text-sm text-ink">
        <Lines lines={[discountText(promo), ...conditionsText(promo)]} />
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
        <dt className="text-ink-faint">At</dt>
        <dd className="text-ink-soft">{property?.name ?? 'All properties'}</dd>
        <dt className="text-ink-faint">Valid</dt>
        <dd className="text-ink-soft">
          <Lines lines={validityText(promo)} />
        </dd>
        <dt className="text-ink-faint">Used</dt>
        <dd className="tabular text-ink-soft">{usesText(promo)}</dd>
        {promo.description && (
          <>
            <dt className="text-ink-faint">Note</dt>
            <dd className="break-words text-ink-soft">{promo.description}</dd>
          </>
        )}
      </dl>
      {props.canEdit && (
        <div className="flex items-center justify-between gap-3 border-t border-line pt-2.5">
          <span className="text-[13px] text-ink-soft">
            {promo.active ? 'Switched on' : 'Switched off'}
          </span>
          <Controls {...props} />
        </div>
      )}
    </Card>
  );
}

function PromoTableRow(props: RowProps) {
  const { promo, property } = props;
  return (
    <tr className="align-top">
      <td className="max-w-64 px-4 py-3">
        <Code promo={promo} onCopy={props.onCopy} />
        <p className="text-[13px] text-ink-soft">{property?.name ?? 'All properties'}</p>
        {promo.description && (
          <p className="mt-0.5 text-[13px] break-words text-ink-faint">{promo.description}</p>
        )}
      </td>
      <td className="px-4 py-3 text-ink">
        <p className="whitespace-nowrap">{discountText(promo)}</p>
        {conditionsText(promo).length > 0 && (
          <div className="text-[13px] text-ink-soft">
            <Lines lines={conditionsText(promo)} />
          </div>
        )}
      </td>
      <td className="px-4 py-3 text-ink-soft">
        <Lines lines={validityText(promo)} />
      </td>
      <td className="tabular px-4 py-3 whitespace-nowrap text-ink-soft">{usesText(promo)}</td>
      <td className="px-4 py-3">
        <State promo={promo} property={property} />
      </td>
      <td className="px-4 py-2.5 text-right whitespace-nowrap">
        <Controls {...props} />
      </td>
    </tr>
  );
}

/** The promotional codes guests can type on the website, for those who may see rates. */
export function PromosView() {
  const auth = useAuth();
  const toast = useToast();
  const allowed = auth.can('rates.read');
  const { data, error, mutate } = useSWR<{ promos: Promo[] }>(allowed ? '/promos' : null);
  const properties = useProperties();
  const [open, setOpen] = useState<Open | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // A confirmed booking made with a code counts as a use of it.
  useLive(/^reservation\./, () => void mutate());

  if (!allowed) return <NoAccess />;

  const canAdd = auth.can('rates.write');
  const loading = !data || properties.isLoading;
  const promos = data?.promos ?? [];

  const switchCode = async (promo: Promo, active: boolean) => {
    setBusyId(promo.id);
    try {
      await api(`/promos/${promo.id}`, { method: 'PATCH', body: { active } });
      toast.success(
        `Code ${promo.code} switched ${active ? 'on' : 'off'}`,
        active ? undefined : 'The website now turns it down.',
      );
      await mutate();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusyId(null);
    }
  };

  const copy = async (promo: Promo) => {
    if (await copyText(promo.code)) toast.success(`Code ${promo.code} copied`);
    else toast.error('Could not copy. Select the code and copy it yourself.');
  };

  const rowProps = (promo: Promo): RowProps => ({
    promo,
    property: properties.properties.find((p) => p.id === promo.propertyId),
    canEdit: promo.propertyId
      ? auth.can('rates.write', promo.propertyId)
      : auth.canOrgWide('rates.write'),
    busy: busyId === promo.id,
    onCopy: () => void copy(promo),
    onEdit: () => setOpen({ kind: 'edit', promo }),
    onSwitch: (active) => void switchCode(promo, active),
  });

  const addButton = canAdd && (
    <Button
      variant="primary"
      icon={<Plus className="size-4" />}
      onClick={() => setOpen({ kind: 'new' })}
      disabled={loading}
    >
      New code
    </Button>
  );

  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      <PageHeader
        title="Promotional codes"
        description="Codes guests type when they book on the website, to get a lower price. They only work there."
        actions={addButton}
      />

      {(error ?? properties.error) && loading ? (
        <ErrorState
          error={error ?? properties.error}
          onRetry={() => {
            void mutate();
            void properties.mutate();
          }}
        />
      ) : loading ? (
        <PageLoading label="Loading the codes" />
      ) : promos.length === 0 ? (
        <EmptyState
          icon={<TicketPercent className="size-5" />}
          title="No promotional codes yet"
          description="A code takes a percentage or a fixed amount off for guests who type it when they book on the website."
        />
      ) : (
        // Cards until the table has the room it needs: the page's own width, not the screen's.
        <div className="@container">
          <ul className="flex flex-col gap-3 @3xl:hidden">
            {promos.map((promo) => (
              <li key={promo.id}>
                <PromoCard {...rowProps(promo)} />
              </li>
            ))}
          </ul>
          <Card className="hidden overflow-hidden @3xl:block">
            <div className="scrollbar-thin relative overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead>
                  <tr className="border-b border-line bg-sunken/60 text-xs font-medium text-ink-faint">
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      Code
                    </th>
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      What it gives
                    </th>
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      Valid
                    </th>
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      Used
                    </th>
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      Status
                    </th>
                    <th scope="col" className="px-4 py-2.5">
                      <span className="sr-only">Switch on or off, and edit</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {promos.map((promo) => (
                    <PromoTableRow key={promo.id} {...rowProps(promo)} />
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      {open && (
        <PromoDialog
          promo={open.kind === 'edit' ? open.promo : undefined}
          codes={promos.map((promo) => promo.code.toUpperCase())}
          properties={properties.properties}
          onClose={() => setOpen(null)}
          onSaved={() => void mutate()}
        />
      )}
    </div>
  );
}
