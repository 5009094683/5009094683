'use client';

import { Percent } from 'lucide-react';
import { useState } from 'react';
import useSWR from 'swr';
import { useReturnFocus } from '@/components/housekeeping/focus';
import { PropertyPicker, usePropertyFor } from '@/components/housekeeping/property-picker';
import { Button } from '@/components/ui/button';
import {
  Card,
  EmptyState,
  ErrorState,
  Notice,
  PageHeader,
  PageLoading,
} from '@/components/ui/misc';
import { useAuth } from '@/lib/auth';
import type { Property } from '@/lib/types';
import { NoAccess } from './no-access';
import { TaxRuleDialog } from './tax-rule-dialog';
import { CATEGORIES, CATEGORY_COVERS, CATEGORY_LABELS, ruleInWords } from './tax-words';
import type { TaxCategory, TaxRule } from './types';

function Rules({ property }: { property: Property }) {
  const auth = useAuth();
  const canEdit = auth.can('accounting.manage', property.id);
  const [editing, setEditing] = useState<TaxCategory | null>(null);
  const rememberOpener = useReturnFocus(editing !== null);
  const { data, error, isLoading, mutate } = useSWR<{ rules: TaxRule[] }>(
    `/properties/${property.id}/tax-rules`,
  );

  if (error && !data) return <ErrorState error={error} onRetry={() => void mutate()} />;
  if (isLoading || !data) return <PageLoading label="Loading the tax rules" />;

  const ruleFor = (category: TaxCategory) => data.rules.find((rule) => rule.category === category);

  return (
    <>
      {data.rules.length === 0 && (
        <Notice tone="info" className="mb-4">
          No tax is set up for {property.name}, so charges are posted without tax.
          {canEdit && ' Set up the tax for each kind of charge below.'}
        </Notice>
      )}
      <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {CATEGORIES.map((category) => {
          const rule = ruleFor(category);
          return (
            <li key={category}>
              <Card className="flex h-full flex-col gap-3 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-base font-semibold text-ink">
                      {CATEGORY_LABELS[category]}
                    </h2>
                    <p className="text-[13px] text-ink-faint">{CATEGORY_COVERS[category]}</p>
                  </div>
                  {canEdit && (
                    <Button
                      size="sm"
                      aria-label={`${rule ? 'Edit' : 'Set up'} tax on ${CATEGORY_LABELS[category].toLowerCase()}`}
                      onClick={() => {
                        rememberOpener();
                        setEditing(category);
                      }}
                    >
                      {rule ? 'Edit' : 'Set up'}
                    </Button>
                  )}
                </div>
                {rule ? (
                  <div>
                    <p className="text-sm text-ink">
                      {ruleInWords(category, rule, property.currency, property.country)}
                    </p>
                    <p className="mt-1 text-[13px] text-ink-faint">{rule.name}</p>
                  </div>
                ) : (
                  <p className="text-sm text-ink-soft">No tax is charged.</p>
                )}
              </Card>
            </li>
          );
        })}
      </ul>

      {editing && (
        <TaxRuleDialog
          property={property}
          category={editing}
          rule={ruleFor(editing)}
          onClose={() => setEditing(null)}
          onSaved={() => void mutate()}
        />
      )}
    </>
  );
}

/** How each kind of charge is taxed at a property. */
export function TaxRulesView() {
  const auth = useAuth();
  const { property, properties, select, isLoading, error, retry } = usePropertyFor('folio.read');

  if (!auth.can('folio.read')) return <NoAccess />;

  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      <PageHeader
        title="Tax rules"
        description="The tax added to each kind of charge when it is posted to a folio."
        actions={
          property && (
            <PropertyPicker property={property} properties={properties} onSelect={select} />
          )
        }
      />
      <Notice tone="warning" className="mb-4">
        Tax rates are set by law. Confirm changes with your accountant. Charges already posted keep
        the tax they were posted with.
      </Notice>
      {isLoading ? (
        <PageLoading />
      ) : property ? (
        <Rules key={property.id} property={property} />
      ) : error ? (
        <ErrorState error={error} onRetry={retry} />
      ) : (
        <EmptyState
          icon={<Percent className="size-5" />}
          title="No property to show"
          description="There is no open property whose accounts you can see."
        />
      )}
    </div>
  );
}
