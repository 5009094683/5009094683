'use client';

import { CalendarOff } from 'lucide-react';
import { Badge, Card } from '@/components/ui/misc';
import { formatDateTime, formatRelative } from '@/lib/format';
import type { Property } from '@/lib/types';
import {
  PRIORITY_LABELS,
  PRIORITY_TONES,
  STATUS_LABELS,
  STATUS_TONES,
  offSaleText,
  placeText,
} from './labels';
import type { Issue } from './types';

interface ListProps {
  issues: Issue[];
  properties: Map<string, Property>;
  onOpen: (issue: Issue) => void;
}

function OffSaleNote({ issue }: { issue: Issue }) {
  if (!issue.offSale) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-warning-700">
      <CalendarOff className="size-3.5 shrink-0" aria-hidden />
      {offSaleText(issue.offSale)}
    </span>
  );
}

function IssueCards({ issues, properties, onOpen }: ListProps) {
  return (
    <ul className="flex flex-col gap-3 md:hidden">
      {issues.map((issue) => (
        <li key={issue.id}>
          <Card className="transition-colors hover:border-line-strong">
            <button
              type="button"
              onClick={() => onOpen(issue)}
              className="flex w-full flex-col gap-2 rounded-xl p-4 text-left"
            >
              <span className="flex items-start justify-between gap-3">
                <span className="font-medium text-ink">{issue.title}</span>
                <Badge tone={PRIORITY_TONES[issue.priority]}>
                  {PRIORITY_LABELS[issue.priority]}
                </Badge>
              </span>
              <span className="text-[13px] text-ink-soft">
                {properties.get(issue.propertyId)?.name} · {placeText(issue)}
              </span>
              <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px] text-ink-soft">
                <Badge tone={STATUS_TONES[issue.status]}>{STATUS_LABELS[issue.status]}</Badge>
                <span>{issue.assignedToName ?? 'Not assigned'}</span>
                <span className="text-ink-faint">Reported {formatRelative(issue.createdAt)}</span>
              </span>
              <OffSaleNote issue={issue} />
            </button>
          </Card>
        </li>
      ))}
    </ul>
  );
}

function IssueTable({ issues, properties, onOpen }: ListProps) {
  return (
    <Card className="hidden overflow-hidden md:block">
      <div className="scrollbar-thin relative overflow-x-auto">
        <table className="w-full min-w-[880px] text-left text-sm">
          <thead>
            <tr className="border-b border-line bg-sunken/60 text-xs font-medium text-ink-faint">
              <th scope="col" className="px-4 py-2.5 font-medium">
                Issue
              </th>
              <th scope="col" className="px-4 py-2.5 font-medium">
                Where
              </th>
              <th scope="col" className="px-4 py-2.5 font-medium">
                Priority
              </th>
              <th scope="col" className="px-4 py-2.5 font-medium">
                Status
              </th>
              <th scope="col" className="px-4 py-2.5 font-medium">
                Person
              </th>
              <th scope="col" className="px-4 py-2.5 font-medium">
                Reported
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {issues.map((issue) => (
              <tr
                key={issue.id}
                className="cursor-pointer align-top transition-colors hover:bg-brand-50/60"
                onClick={() => onOpen(issue)}
              >
                <td className="max-w-md px-4 py-3">
                  <button
                    type="button"
                    className="text-left font-medium text-ink hover:underline"
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpen(issue);
                    }}
                  >
                    {issue.title}
                  </button>
                  {issue.offSale && (
                    <p className="mt-1">
                      <OffSaleNote issue={issue} />
                    </p>
                  )}
                </td>
                <td className="px-4 py-3">
                  <p className="text-ink">{placeText(issue)}</p>
                  <p className="text-[13px] text-ink-faint">
                    {properties.get(issue.propertyId)?.name}
                  </p>
                </td>
                <td className="px-4 py-3">
                  <Badge tone={PRIORITY_TONES[issue.priority]}>
                    {PRIORITY_LABELS[issue.priority]}
                  </Badge>
                </td>
                <td className="px-4 py-3">
                  <Badge tone={STATUS_TONES[issue.status]}>{STATUS_LABELS[issue.status]}</Badge>
                </td>
                <td className="px-4 py-3 text-ink-soft">
                  {issue.assignedToName ?? <span className="text-ink-faint">Not assigned</span>}
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-ink-soft">
                  {formatDateTime(issue.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/** The issues as cards on a phone and as a table where there is room for one. */
export function IssueList(props: ListProps) {
  return (
    <>
      <IssueCards {...props} />
      <IssueTable {...props} />
    </>
  );
}
