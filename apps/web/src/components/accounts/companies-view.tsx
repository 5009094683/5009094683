'use client';

import { Building2, Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import useSWR from 'swr';
import { useReturnFocus } from '@/components/housekeeping/focus';
import { Button } from '@/components/ui/button';
import { Checkbox, Input, Select } from '@/components/ui/field';
import { Badge, Card, EmptyState, ErrorState, PageHeader, PageLoading } from '@/components/ui/misc';
import { query } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { plural } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import { useLive } from '@/lib/live';
import { CompanyDialog, KIND_LABELS } from './company-dialog';
import { useAccountsCurrency } from './currency';
import { money, percentText } from './money';
import { NoAccess } from './no-access';
import type { Company, CompanyKind } from './types';

/** Whether the company owes more on account than it is allowed to. */
export function overLimit(company: Company): boolean {
  return company.creditLimit !== null && company.outstanding > company.creditLimit;
}

export function termsText(days: number): string {
  return days === 0 ? 'Due at once' : plural(days, 'day');
}

function CompanyTable({
  companies,
  currency,
  onEdit,
}: {
  companies: Company[];
  currency: string;
  onEdit?: (company: Company) => void;
}) {
  const router = useRouter();
  return (
    <Card className="overflow-hidden">
      <div className="scrollbar-thin relative overflow-x-auto">
        <table className="w-full min-w-[860px] text-left text-sm">
          <thead>
            <tr className="border-b border-line bg-sunken/60 text-xs font-medium text-ink-faint">
              <th scope="col" className="px-4 py-2.5 font-medium">
                Name
              </th>
              <th scope="col" className="px-4 py-2.5 font-medium">
                Kind
              </th>
              <th scope="col" className="px-4 py-2.5 font-medium">
                GSTIN
              </th>
              <th scope="col" className="px-4 py-2.5 text-right font-medium">
                Credit limit
              </th>
              <th scope="col" className="px-4 py-2.5 font-medium">
                Payment terms
              </th>
              <th scope="col" className="px-4 py-2.5 text-right font-medium">
                Owes
              </th>
              {onEdit && (
                <th scope="col" className="px-4 py-2.5 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {companies.map((company) => {
              const href = `/accounts/companies/${company.id}`;
              const over = overLimit(company);
              return (
                <tr
                  key={company.id}
                  className="cursor-pointer align-top transition-colors hover:bg-brand-50/60"
                  onClick={() => router.push(href)}
                >
                  <td className="px-4 py-3">
                    <span className="flex flex-wrap items-center gap-2">
                      <Link
                        href={href}
                        className="font-medium text-ink hover:underline"
                        onClick={(event) => event.stopPropagation()}
                      >
                        {company.name}
                      </Link>
                      {!company.active && <Badge tone="neutral">Inactive</Badge>}
                    </span>
                    {company.contactName && (
                      <p className="text-[13px] text-ink-faint">{company.contactName}</p>
                    )}
                  </td>
                  <td className="px-4 py-3 text-ink-soft">
                    {KIND_LABELS[company.kind]}
                    {company.kind === 'travel_agent' && company.commissionBp > 0 && (
                      <p className="text-[13px] text-ink-faint">
                        {percentText(company.commissionBp)}% commission
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-ink-soft">
                    {company.gstin ?? <span className="text-ink-faint">Not given</span>}
                  </td>
                  <td className="tabular px-4 py-3 text-right whitespace-nowrap text-ink-soft">
                    {company.creditLimit === null
                      ? 'No limit'
                      : money(company.creditLimit, currency)}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-ink-soft">
                    {termsText(company.paymentTermsDays)}
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <span
                      className={
                        over
                          ? 'tabular font-semibold text-danger-600'
                          : 'tabular font-medium text-ink'
                      }
                    >
                      {money(company.outstanding, currency)}
                    </span>
                    {over && <p className="text-[13px] text-danger-600">Over the limit</p>}
                  </td>
                  {onEdit && (
                    <td className="px-4 py-2 text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Edit ${company.name}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          onEdit(company);
                        }}
                      >
                        Edit
                      </Button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/** Companies and travel agents that are billed on account, with what each owes. */
export function CompaniesView() {
  const auth = useAuth();
  const allowed = auth.can('folio.read') && auth.can('reservations.read');
  const canManage = auth.can('accounting.manage');
  const currency = useAccountsCurrency();
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<CompanyKind | ''>('');
  const [inactive, setInactive] = useState(false);
  const [editing, setEditing] = useState<Company | 'new' | null>(null);
  const rememberOpener = useReturnFocus(editing !== null);
  const edit = (company: Company | 'new') => {
    rememberOpener();
    setEditing(company);
  };
  const term = useDebounced(search.trim(), 300);

  const { data, error, isLoading, mutate } = useSWR<{ companies: Company[] }>(
    allowed
      ? `/companies${query({ search: term, kind, includeInactive: inactive ? 'true' : '' })}`
      : null,
    // Companies kept from another search would stay on screen, unexplained, if this request failed.
    { keepPreviousData: false },
  );
  // What a company owes changes when a folio is billed to it or it pays.
  useLive(/^folio\./, () => void mutate());

  if (!allowed) return <NoAccess />;

  const companies = data?.companies ?? [];
  const filtered = term !== '' || kind !== '' || inactive;
  const add = canManage && (
    <Button
      variant="primary"
      icon={<Plus className="size-4" aria-hidden />}
      onClick={() => edit('new')}
    >
      Add company
    </Button>
  );

  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6">
      <PageHeader
        title="Companies"
        description="Companies and travel agents billed on account, and what each owes."
        actions={add}
      />

      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="relative min-w-0 flex-1 basis-56 sm:max-w-xs">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-ink-faint"
            aria-hidden
          />
          <Input
            type="search"
            aria-label="Search by name or GSTIN"
            placeholder="Search by name or GSTIN"
            maxLength={100}
            className="pl-8"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <Select
          aria-label="Kind"
          className="w-auto"
          value={kind}
          onChange={(event) => setKind(event.target.value as CompanyKind | '')}
        >
          <option value="">Companies and travel agents</option>
          <option value="corporate">Companies only</option>
          <option value="travel_agent">Travel agents only</option>
        </Select>
        <Checkbox
          label="Include inactive"
          checked={inactive}
          onChange={(event) => setInactive(event.target.checked)}
        />
      </div>

      {error && !data ? (
        <ErrorState error={error} onRetry={() => void mutate()} />
      ) : isLoading || !data ? (
        <PageLoading label="Loading companies" />
      ) : companies.length === 0 ? (
        <EmptyState
          icon={<Building2 className="size-5" />}
          title={filtered ? 'No company matches' : 'No companies yet'}
          description={
            filtered
              ? 'Try another name, or include inactive companies.'
              : 'Add a company or travel agent to bill its stays on account.'
          }
          action={!filtered && add}
        />
      ) : (
        <>
          <CompanyTable
            companies={companies}
            currency={currency}
            onEdit={canManage ? edit : undefined}
          />
          {auth.scope('folio.read') !== 'all' && (
            <p className="mt-2 text-[13px] text-ink-faint">
              What each owes counts only the properties you can see. What a company owes at other
              properties counts towards its credit limit as well.
            </p>
          )}
        </>
      )}

      {editing && (
        <CompanyDialog
          company={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={() => void mutate()}
        />
      )}
    </div>
  );
}
