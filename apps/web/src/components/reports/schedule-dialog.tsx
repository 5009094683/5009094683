'use client';

import { useEffect, useRef, useState } from 'react';
import { FormError } from '@/components/housekeeping/form-error';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import type { Property } from '@/lib/types';
import { PropertyFilter } from './property-filter';
import {
  DAYS_OF_MONTH,
  FREQUENCY_LABELS,
  HOURS,
  PERIODS_AHEAD,
  PERIODS_BACK,
  PERIOD_WORDS,
  REPORT_LABELS,
  WEEKDAYS,
  hourText,
  ordinal,
  whenText,
} from './schedule-words';
import type { ReportFrequency, ReportKind, ReportPeriod, Schedule, ScheduleBody } from './types';
import { PACE_GROUPS, PERFORMANCE_GROUPS } from './views';

/** The server's own test of an address, so that what passes here passes there. */
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MOST_RECIPIENTS = 20;
const LONGEST_ADDRESS = 254;

const REPORTS = Object.keys(REPORT_LABELS) as ReportKind[];
const FREQUENCIES = Object.keys(FREQUENCY_LABELS) as ReportFrequency[];

interface Problems {
  name?: string;
  properties?: string;
  recipients?: string;
}

/** The addresses typed, one for each line or between commas, each of them once. */
function readRecipients(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,;]+/)
        .map((address) => address.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

function recipientsProblem(recipients: string[]): string | undefined {
  if (recipients.length === 0) {
    return 'Add at least one email address for the report to go to.';
  }
  const wrong = recipients.find(
    (address) => !EMAIL.test(address) || address.length > LONGEST_ADDRESS,
  );
  if (wrong) {
    return `\u201c${wrong}\u201d is not an email address. Correct it or take it off the list.`;
  }
  if (recipients.length > MOST_RECIPIENTS) {
    return `A report goes to at most ${MOST_RECIPIENTS} addresses and there are ${recipients.length} here. Take ${recipients.length - MOST_RECIPIENTS} off the list.`;
  }
  return undefined;
}

/** Schedules a report to go out by email, or changes one that is scheduled. */
export function ScheduleDialog({
  schedule,
  offered,
  timeZone,
  onClose,
  onSaved,
}: {
  /** The schedule to change. Absent: a new one. */
  schedule?: Schedule;
  /** The properties whose reports the person signed in may read. */
  offered: Property[];
  /** The organisation's time zone, which schedules run by. */
  timeZone: string | undefined;
  onClose: () => void;
  onSaved: () => void;
}) {
  const auth = useAuth();
  const toast = useToast();
  // "All properties" sends figures for every property there is, now and later, so it takes a
  // role that is not tied to particular ones. The server refuses it to anyone else.
  const orgWide = auth.canOrgWide('reports.read');

  const [name, setName] = useState(schedule?.name ?? '');
  const [report, setReport] = useState<ReportKind>(schedule?.report ?? 'performance');
  const [groupBy, setGroupBy] = useState(schedule?.groupBy ?? (schedule ? '' : 'day'));
  const [propertyIds, setPropertyIds] = useState<string[]>(
    schedule?.propertyIds ?? (!orgWide && offered.length === 1 ? [offered[0]!.id] : []),
  );
  const [period, setPeriod] = useState<ReportPeriod>(schedule?.period ?? 'last_7_days');
  const [periodChosen, setPeriodChosen] = useState(schedule !== undefined);
  const [frequency, setFrequency] = useState<ReportFrequency>(schedule?.frequency ?? 'weekly');
  const [weekday, setWeekday] = useState(schedule?.weekday ?? 1);
  const [dayOfMonth, setDayOfMonth] = useState(schedule?.dayOfMonth ?? 1);
  const [hour, setHour] = useState(schedule?.hour ?? 8);
  const [recipients, setRecipients] = useState(schedule?.recipients.join('\n') ?? '');
  const [problems, setProblems] = useState<Problems>({});
  const form = useRef<HTMLFormElement>(null);

  // Go to the first field that needs a look, far enough to show what is wrong with it.
  useEffect(() => {
    const wrong = form.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    wrong?.focus();
    wrong?.parentElement?.scrollIntoView({ block: 'nearest' });
  }, [problems]);

  const chooseReport = (next: ReportKind) => {
    setReport(next);
    setGroupBy(next === 'performance' ? 'day' : '');
    // Pace is about the nights ahead, the others about what has happened: start from a period
    // that suits, unless one was chosen already.
    if (!periodChosen) setPeriod(next === 'pace' ? 'next_30_days' : 'last_7_days');
  };

  const groups =
    report === 'performance'
      ? PERFORMANCE_GROUPS
      : report === 'pace'
        ? [{ value: '', label: 'As fits the period' }, ...PACE_GROUPS]
        : null;

  const save = useAction(async () => {
    const found: Problems = {};
    const cleanName = name.trim();
    if (!cleanName)
      found.name = 'Give the schedule a name, such as \u201cWeekly performance\u201d.';

    const covered =
      propertyIds.length > 0 ? offered.filter((p) => propertyIds.includes(p.id)) : offered;
    const currencies = [...new Set(covered.map((p) => p.currency))].sort();
    if (propertyIds.length === 0 && !orgWide) {
      found.properties =
        'Tick the properties this report covers. Your role is for particular properties, so it cannot cover all of them.';
    } else if (currencies.length > 1) {
      found.properties = `These properties are priced in different currencies (${currencies.join(', ')}), which one report cannot add up. Tick properties that share a currency.`;
    }

    const addresses = readRecipients(recipients);
    found.recipients = recipientsProblem(addresses);
    if (!found.recipients) delete found.recipients;

    setProblems(found);
    if (Object.keys(found).length > 0) return;

    const body: ScheduleBody = {
      name: cleanName,
      report,
      groupBy: groups ? groupBy || null : null,
      propertyIds: propertyIds.length > 0 ? propertyIds : null,
      period,
      frequency,
      weekday: frequency === 'weekly' ? weekday : null,
      dayOfMonth: frequency === 'monthly' ? dayOfMonth : null,
      hour,
      recipients: addresses,
    };
    const saved = schedule
      ? await api<Schedule>(`/reports/schedules/${schedule.id}`, { method: 'PATCH', body })
      : await api<Schedule>('/reports/schedules', { body });
    toast.success(
      schedule ? `\u201c${saved.name}\u201d saved` : `\u201c${saved.name}\u201d scheduled`,
      `${whenText(saved)}, to ${saved.recipients.join(', ')}.`,
    );
    onSaved();
    onClose();
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title={schedule ? `Edit \u201c${schedule.name}\u201d` : 'Schedule a report'}
      description="The report goes out by email as a spreadsheet, for the dates it covers on the day it is sent."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="report-schedule-form" variant="primary" loading={save.busy}>
            {schedule ? 'Save' : 'Schedule report'}
          </Button>
        </>
      }
    >
      <form
        ref={form}
        id="report-schedule-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save.run();
        }}
        className="flex flex-col gap-4"
      >
        <FormError message={save.error} />

        <Field label="Name" error={problems.name} hint="It is the subject of the email.">
          {(props) => (
            <Input
              {...props}
              maxLength={120}
              autoFocus={!schedule}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </Field>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Report" className={groups ? undefined : 'sm:col-span-2'}>
            {(props) => (
              <Select
                {...props}
                value={report}
                onChange={(event) => chooseReport(event.target.value as ReportKind)}
              >
                {REPORTS.map((kind) => (
                  <option key={kind} value={kind}>
                    {REPORT_LABELS[kind]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {groups && (
            <Field label="Group by">
              {(props) => (
                <Select
                  {...props}
                  value={groupBy}
                  onChange={(event) => setGroupBy(event.target.value)}
                >
                  {groups.map((group) => (
                    <option key={group.value} value={group.value}>
                      {group.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
        </div>

        <PropertyFilter
          offered={offered}
          chosenIds={propertyIds}
          allLabel={orgWide ? 'All properties' : null}
          onChange={setPropertyIds}
          error={problems.properties}
        />

        <Field label="Period" hint={PERIOD_WORDS[period].covers}>
          {(props) => (
            <Select
              {...props}
              value={period}
              onChange={(event) => {
                setPeriod(event.target.value as ReportPeriod);
                setPeriodChosen(true);
              }}
            >
              <optgroup label="Looking back">
                {PERIODS_BACK.map((key) => (
                  <option key={key} value={key}>
                    {PERIOD_WORDS[key].label}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Looking ahead">
                {PERIODS_AHEAD.map((key) => (
                  <option key={key} value={key}>
                    {PERIOD_WORDS[key].label}
                  </option>
                ))}
              </optgroup>
            </Select>
          )}
        </Field>

        <div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Field label="How often" className="col-span-2 sm:col-span-1">
              {(props) => (
                <Select
                  {...props}
                  value={frequency}
                  onChange={(event) => setFrequency(event.target.value as ReportFrequency)}
                >
                  {FREQUENCIES.map((key) => (
                    <option key={key} value={key}>
                      {FREQUENCY_LABELS[key]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {frequency === 'weekly' && (
              <Field label="On">
                {(props) => (
                  <Select
                    {...props}
                    value={weekday}
                    onChange={(event) => setWeekday(Number(event.target.value))}
                  >
                    {WEEKDAYS.map((day) => (
                      <option key={day.value} value={day.value}>
                        {day.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            )}
            {frequency === 'monthly' && (
              <Field label="On the">
                {(props) => (
                  <Select
                    {...props}
                    value={dayOfMonth}
                    onChange={(event) => setDayOfMonth(Number(event.target.value))}
                  >
                    {DAYS_OF_MONTH.map((day) => (
                      <option key={day} value={day}>
                        {ordinal(day)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            )}
            <Field label="At" className={frequency === 'daily' ? 'col-span-2' : undefined}>
              {(props) => (
                <Select
                  {...props}
                  value={hour}
                  onChange={(event) => setHour(Number(event.target.value))}
                >
                  {HOURS.map((value) => (
                    <option key={value} value={value}>
                      {hourText(value)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <p className="mt-1 text-[13px] text-ink-faint">
            By the organisation&rsquo;s clock{timeZone ? ` (${timeZone.replace(/_/g, ' ')})` : ''}.
            {frequency === 'monthly' && ' The day goes up to the 28th, so that every month has it.'}
          </p>
        </div>

        <Field
          label="Send to"
          error={problems.recipients}
          hint={`One email address on each line, or with commas between them. Up to ${MOST_RECIPIENTS}.`}
        >
          {(props) => (
            <Textarea
              {...props}
              rows={3}
              spellCheck={false}
              autoCapitalize="none"
              value={recipients}
              onChange={(event) => setRecipients(event.target.value)}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
