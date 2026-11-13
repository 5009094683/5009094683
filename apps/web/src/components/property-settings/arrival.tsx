'use client';

import type { Property } from '@/lib/types';
import {
  Item,
  Items,
  LongText,
  LongTextField,
  SettingsCard,
  SettingsDialog,
  tooLong,
} from './parts';
import { useSettingsForm, type Reading } from './use-settings-form';
import { LIMITS, type Settings } from './values';

/** What guests are told before they arrive, and what suggested replies may draw on. */
export function ArrivalCard({ property, onEdit }: { property: Property; onEdit?: () => void }) {
  const arrival = property.settings.arrivalInstructions?.trim() ?? '';
  const knowledge = property.settings.knowledge?.trim() ?? '';
  return (
    <SettingsCard title="Arrival and guest questions" onEdit={onEdit}>
      <p className="text-sm text-ink-soft">
        The arrival instructions go to guests before they arrive. The facts are only used to suggest
        replies in the inbox: nothing in them is sent by itself.
      </p>
      <Items className="mt-3">
        <Item label="Arrival instructions" className="sm:col-span-2">
          {arrival && <LongText text={arrival} />}
        </Item>
        <Item label="Facts for answering guests" className="sm:col-span-2">
          {knowledge && <LongText text={knowledge} />}
        </Item>
      </Items>
    </SettingsCard>
  );
}

interface Values {
  arrival: string;
  knowledge: string;
}

type Body = Required<Pick<Settings, 'arrivalInstructions' | 'knowledge'>>;

type Problem = 'arrival' | 'knowledge';

function read(values: Values): Reading<Body, Problem> {
  const problems: Reading<Body, Problem>['problems'] = {};
  const arrival = tooLong(values.arrival, LIMITS.arrivalInstructions);
  if (arrival) problems.arrival = arrival;
  const knowledge = tooLong(values.knowledge, LIMITS.knowledge);
  if (knowledge) problems.knowledge = knowledge;
  return {
    problems,
    // There is no taking a setting away again: an empty text is how it is cleared.
    body: { arrivalInstructions: values.arrival.trim(), knowledge: values.knowledge.trim() },
  };
}

const KNOWLEDGE_EXAMPLE = [
  'Breakfast is served from 7:30 to 10:30.',
  'Parking is free, behind the building.',
  'The pool is open from 7:00 to 20:00.',
  'The airport is 45 minutes away by taxi.',
].join('\n');

export function ArrivalDialog({ property, onClose }: { property: Property; onClose: () => void }) {
  const { settings } = property;
  const form = useSettingsForm<Values, Body, Problem>({
    property,
    start: () => ({
      arrival: settings.arrivalInstructions ?? '',
      knowledge: settings.knowledge ?? '',
    }),
    read,
    saved: () => ({ message: 'Arrival instructions and facts saved' }),
    onClose,
  });
  const { values, change } = form;

  return (
    <SettingsDialog
      title="Arrival and guest questions"
      description={`What guests of ${property.name} are told before they arrive, and what a suggested reply may draw on.`}
      form={form}
      onClose={onClose}
    >
      <LongTextField
        label="Arrival instructions"
        hint="How to find the property, where to collect the key, a number to call. Sent to guests before they arrive, in the messages that include them, and shown on the guest’s own booking page once the booking is confirmed."
        value={values.arrival}
        onChange={(arrival) => change({ arrival })}
        limit={LIMITS.arrivalInstructions}
        rows={6}
      />
      <LongTextField
        label="Facts for answering guests"
        hint="What guests ask about most, a fact to a line, for suggesting replies in the inbox. Nothing written here is sent to anyone by itself: a suggested reply is only sent when someone sends it."
        value={values.knowledge}
        onChange={(knowledge) => change({ knowledge })}
        limit={LIMITS.knowledge}
        rows={8}
        placeholder={KNOWLEDGE_EXAMPLE}
      />
    </SettingsDialog>
  );
}
