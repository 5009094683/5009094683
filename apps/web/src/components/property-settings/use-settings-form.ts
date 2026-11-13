'use client';

import { useState, type FormEvent, type RefObject } from 'react';
import { useSWRConfig } from 'swr';
import { useFirstProblem } from '@/components/engagement/first-problem';
import { changedFields } from '@/components/settings/form-values';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import type { Property, PropertyDetail } from '@/lib/types';
import type { Settings } from './values';

export interface Reading<Body extends Partial<Settings>, Field extends string> {
  /** The settings the form holds, as the server takes them. */
  body: Body;
  /** What has to be put right before they can be saved, by field. */
  problems: Partial<Record<Field, string>>;
}

export interface SettingsForm<Values, Field extends string> {
  values: Values;
  change: (patch: Partial<Values>) => void;
  /** What is wrong with each field, once a save has been tried. */
  problems: Partial<Record<Field, string>>;
  /** The form holds something that is not saved. */
  dirty: boolean;
  busy: boolean;
  /** What the server said when it refused. */
  error: string | null;
  ref: RefObject<HTMLFormElement | null>;
  submit: (event: FormEvent) => void;
}

/**
 * One section of a property's settings as a form: what it opens with, what is wrong with it,
 * and the saving. Only the settings that differ from what the form opened with are sent, and
 * the server merges those into the rest, so two people editing different settings do not undo
 * each other's work.
 */
export function useSettingsForm<Values, Body extends Partial<Settings>, Field extends string>({
  property,
  start,
  read,
  stored,
  saved,
  onClose,
}: {
  property: Property;
  /** The form as it opens. */
  start: () => Values;
  read: (values: Values) => Reading<Body, Field>;
  /** Saved values to compare with, for settings the form does not open with. */
  stored?: Partial<Body>;
  /** What to say once it is saved, given what changed. */
  saved: (changes: Partial<Body>) => { message: string; detail?: string };
  onClose: () => void;
}): SettingsForm<Values, Field> {
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const firstProblem = useFirstProblem();
  const [initial] = useState(start);
  const [values, setValues] = useState(initial);
  const [attempted, setAttempted] = useState(false);

  const { body, problems } = read(values);
  const changes = changedFields<Body>({ ...stored, ...read(initial).body }, body);
  const dirty = Object.keys(changes).length > 0;

  const save = useAction(async () => {
    if (dirty) {
      const answer = await api<Property>(`/properties/${property.id}`, {
        method: 'PATCH',
        body: { settings: changes },
      });
      // The answer is shown at once and then read again. The list of properties is refreshed
      // too: other screens take a property's settings from it.
      await Promise.all([
        mutate<PropertyDetail>(
          `/properties/${property.id}`,
          (current) => current && { ...current, property: answer },
          { revalidate: true },
        ),
        mutate<{ properties: Property[] }>(
          '/properties',
          (current) =>
            current && {
              properties: current.properties.map((other) =>
                other.id === answer.id ? answer : other,
              ),
            },
          { revalidate: true },
        ),
      ]);
      const { message, detail } = saved(changes);
      toast.success(message, detail);
    }
    onClose();
  });

  return {
    values,
    change: (patch) => setValues((current) => ({ ...current, ...patch })),
    problems: attempted ? problems : {},
    dirty,
    busy: save.busy,
    error: save.error,
    ref: firstProblem.form,
    submit: (event) => {
      event.preventDefault();
      if (save.busy) return;
      setAttempted(true);
      if (Object.keys(problems).length > 0) {
        firstProblem.show();
        return;
      }
      void save.run();
    },
  };
}
