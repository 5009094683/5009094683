'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

function isControl(element: HTMLElement): element is Control {
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement
  );
}

/**
 * For a form that is longer than its dialog. When a save is held back because something is
 * wrong, `show()` goes to the first field that needs a look, far enough to read its name and
 * what is wrong with it, which is written under the field.
 */
export function useFirstProblem(): {
  form: RefObject<HTMLFormElement | null>;
  show: () => void;
} {
  const form = useRef<HTMLFormElement>(null);
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    if (asked === 0) return;
    const wrong = form.current?.querySelector<HTMLElement>(
      '[aria-invalid="true"], p[role="alert"]',
    );
    if (!wrong) return;
    if (!isControl(wrong)) {
      wrong.scrollIntoView({ block: 'nearest' });
      return;
    }
    wrong.focus({ preventScroll: true });
    // The label's parent holds the label, the field and what is wrong with it.
    (wrong.labels?.[0]?.parentElement ?? wrong).scrollIntoView({ block: 'nearest' });
  }, [asked]);
  return { form, show: () => setAsked((count) => count + 1) };
}
