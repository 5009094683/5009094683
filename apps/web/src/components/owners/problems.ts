'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * What is wrong with the fields of a form, by field. The messages appear when
 * the form is submitted, and a field's message goes once that field is changed.
 */
export function useProblems<Key extends string>() {
  const [problems, setProblems] = useState<Partial<Record<Key, string>>>({});
  const [refusals, setRefusals] = useState(0);
  const form = useRef<HTMLFormElement>(null);

  // A form can be longer than its dialog: after a refused attempt, go to the first field
  // that needs a look.
  useEffect(() => {
    if (refusals === 0) return;
    const wrong = form.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    wrong?.focus();
    wrong?.parentElement?.scrollIntoView({ block: 'nearest' });
  }, [refusals]);

  /** Shows what was found wrong. Answers whether the form can go ahead. */
  const accept = useCallback((found: Partial<Record<Key, string>>): boolean => {
    setProblems(found);
    if (Object.keys(found).length === 0) return true;
    setRefusals((count) => count + 1);
    return false;
  }, []);

  /** Takes away the messages of fields that have just been changed. */
  const clear = useCallback((...keys: Key[]) => {
    setProblems((current) => {
      if (!keys.some((key) => key in current)) return current;
      const next = { ...current };
      for (const key of keys) delete next[key];
      return next;
    });
  }, []);

  return { problems, accept, clear, form };
}
