'use client';

import { useState, type ReactNode } from 'react';
import useSWR from 'swr';
import { addDays, todayIn } from '@pms/domain/shared';
import { FormError } from '@/components/housekeeping/form-error';
import { PersonOptions, staffFor } from '@/components/housekeeping/staff';
import type { StaffMember } from '@/components/housekeeping/types';
import { Button } from '@/components/ui/button';
import { Drawer } from '@/components/ui/dialog';
import { Checkbox, Field, Select, Textarea } from '@/components/ui/field';
import { Badge, Notice } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useAction } from '@/lib/hooks';
import type { Property } from '@/lib/types';
import {
  PRIORITIES,
  PRIORITY_LABELS,
  PRIORITY_TONES,
  STATUSES,
  STATUS_LABELS,
  STATUS_TONES,
  isFinished,
  offSaleProblem,
  offSaleSentence,
  offSaleText,
  placeText,
  saveError,
  whereText,
} from './labels';
import { OffSaleExplanation, OffSaleFields } from './off-sale-fields';
import type { Issue, IssueStatus, OffSale, Priority } from './types';

interface DrawerProps {
  issue: Issue;
  property: Property | undefined;
  onClose: () => void;
  onSaved: () => void;
}

function Heading({ children }: { children: ReactNode }) {
  return (
    <h3 className="text-xs font-semibold tracking-wide text-ink-faint uppercase">{children}</h3>
  );
}

function About({ issue }: { issue: Issue }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={STATUS_TONES[issue.status]}>{STATUS_LABELS[issue.status]}</Badge>
        <Badge tone={PRIORITY_TONES[issue.priority]}>
          {PRIORITY_LABELS[issue.priority]} priority
        </Badge>
      </div>
      {issue.description ? (
        <p className="text-sm whitespace-pre-line text-ink">{issue.description}</p>
      ) : (
        <p className="text-sm text-ink-faint">No details were given.</p>
      )}
      <p className="text-[13px] text-ink-soft">
        Reported {formatDateTime(issue.createdAt)}
        {issue.reportedByLabel ? ` by ${issue.reportedByLabel}` : ''}.
        {issue.resolvedAt ? ` Finished ${formatDateTime(issue.resolvedAt)}.` : ''}
      </p>
    </div>
  );
}

function ViewDrawer({ issue, property, onClose }: DrawerProps) {
  return (
    <Drawer
      open
      onClose={onClose}
      title={issue.title}
      description={whereText(issue, property?.name)}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <div className="flex flex-col gap-5">
        <About issue={issue} />
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-ink-soft">Person</dt>
          <dd className="text-ink">{issue.assignedToName ?? 'Not assigned'}</dd>
          {issue.unitId && (
            <>
              <dt className="text-ink-soft">Room</dt>
              <dd className="text-ink">{issue.offSale ? offSaleText(issue.offSale) : 'On sale'}</dd>
            </>
          )}
          {issue.resolution && (
            <>
              <dt className="text-ink-soft">Resolution</dt>
              <dd className="whitespace-pre-line text-ink">{issue.resolution}</dd>
            </>
          )}
        </dl>
      </div>
    </Drawer>
  );
}

function EditDrawer({ issue, property, onClose, onSaved }: DrawerProps) {
  const toast = useToast();
  const { data: staffData } = useSWR<{ staff: StaffMember[] }>(
    `/properties/${issue.propertyId}/staff`,
  );
  const staff = staffFor(staffData?.staff ?? [], 'maintenance');

  const [status, setStatus] = useState<IssueStatus>(issue.status);
  const [priority, setPriority] = useState<Priority>(issue.priority);
  const [person, setPerson] = useState(issue.assignedTo ?? '');
  const [resolution, setResolution] = useState(issue.resolution ?? '');
  const [closed, setClosed] = useState(issue.offSale !== null);
  const [dates, setDates] = useState<OffSale>(() => {
    if (issue.offSale) return issue.offSale;
    const today = property ? (property.businessDate ?? todayIn(property.timezone)) : '';
    return { from: today, to: today ? addDays(today, 1) : '' };
  });

  const room = placeText(issue);
  const finished = isFinished(status);
  const finishing = finished && !isFinished(issue.status);
  const datesChanged = dates.from !== issue.offSale?.from || dates.to !== issue.offSale?.to;

  const save = useAction(async () => {
    const body: {
      status?: IssueStatus;
      priority?: Priority;
      assignedTo?: string | null;
      resolution?: string | null;
      offSale?: OffSale | null;
    } = {};
    if (status !== issue.status) body.status = status;
    if (priority !== issue.priority) body.priority = priority;
    if ((person || null) !== issue.assignedTo) body.assignedTo = person || null;
    if ((resolution.trim() || null) !== issue.resolution) {
      body.resolution = resolution.trim() || null;
    }
    // Finishing the issue puts the room back on sale by itself.
    if (!finished && issue.unitId) {
      if (issue.offSale && !closed) body.offSale = null;
      if (closed && datesChanged) {
        if (offSaleProblem(dates)) throw new Error('Check the off sale dates');
        body.offSale = dates;
      }
    }
    if (Object.keys(body).length === 0) {
      onClose();
      return;
    }
    try {
      await api(`/maintenance/${issue.id}`, { method: 'PATCH', body });
    } catch (err) {
      throw saveError(err);
    }
    const backOnSale = issue.offSale && (finishing || body.offSale === null);
    toast.success(
      finishing ? `Issue ${STATUS_LABELS[status].toLowerCase()}` : 'Issue saved',
      backOnSale
        ? `${room} is back on sale.`
        : body.offSale
          ? offSaleSentence(room, body.offSale)
          : undefined,
    );
    onSaved();
    onClose();
  });

  return (
    <Drawer
      open
      onClose={onClose}
      title={issue.title}
      description={whereText(issue, property?.name)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="issue-form" variant="primary" loading={save.busy}>
            Save
          </Button>
        </>
      }
    >
      <form
        id="issue-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save.run();
        }}
        className="flex flex-col gap-5"
      >
        <FormError message={save.error} />
        <About issue={issue} />

        <div className="flex flex-col gap-3">
          <Heading>Progress</Heading>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Status">
              {(props) => (
                <Select
                  {...props}
                  value={status}
                  onChange={(event) => setStatus(event.target.value as IssueStatus)}
                >
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {STATUS_LABELS[s]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Priority">
              {(props) => (
                <Select
                  {...props}
                  value={priority}
                  onChange={(event) => setPriority(event.target.value as Priority)}
                >
                  {PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {PRIORITY_LABELS[p]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <Field label="Person">
            {(props) => (
              <Select {...props} value={person} onChange={(event) => setPerson(event.target.value)}>
                <PersonOptions
                  staff={staff}
                  area="maintenance"
                  current={{ id: issue.assignedTo, name: issue.assignedToName }}
                />
              </Select>
            )}
          </Field>
          {finished && (
            <Field
              label="Resolution note"
              optional={status === 'closed'}
              hint="What was done, for whoever looks at this later."
            >
              {(props) => (
                <Textarea
                  {...props}
                  required={status === 'resolved'}
                  maxLength={4000}
                  value={resolution}
                  onChange={(event) => setResolution(event.target.value)}
                />
              )}
            </Field>
          )}
        </div>

        {issue.unitId && (!finished || issue.offSale) && (
          <div className="flex flex-col gap-3">
            <Heading>On sale or off sale</Heading>
            {finished ? (
              <Notice tone="info">
                Saving puts {room} back on sale. If it was out of service it is marked not cleaned,
                so housekeeping can get it ready.
              </Notice>
            ) : issue.offSale && !closed ? (
              <>
                <Notice tone="info">
                  {room} goes back on sale when you save. The issue stays open.
                </Notice>
                <Button className="self-start" onClick={() => setClosed(true)}>
                  Keep it off sale
                </Button>
              </>
            ) : (
              <>
                {issue.offSale ? (
                  <p className="text-sm text-ink">{offSaleText(issue.offSale)}.</p>
                ) : (
                  <Checkbox
                    label="Take the room off sale"
                    checked={closed}
                    onChange={(event) => setClosed(event.target.checked)}
                  />
                )}
                {closed && <OffSaleFields value={dates} onChange={setDates} />}
                {closed && (!issue.offSale || datesChanged) && <OffSaleExplanation />}
                {issue.offSale && (
                  <Button className="self-start" onClick={() => setClosed(false)}>
                    Put the room back on sale
                  </Button>
                )}
              </>
            )}
          </div>
        )}
      </form>
    </Drawer>
  );
}

/** One issue: what it is about and, for people who may, the controls to move it along. */
export function IssueDrawer({ canWrite, ...props }: DrawerProps & { canWrite: boolean }) {
  return canWrite ? <EditDrawer {...props} /> : <ViewDrawer {...props} />;
}
