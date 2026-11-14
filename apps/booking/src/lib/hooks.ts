'use client';

import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';

const never = () => () => {};

/**
 * False on the server and while the page is being made interactive, true
 * afterwards. For what only the guest's own device knows, such as its clock.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    never,
    () => true,
    () => false,
  );
}

/**
 * How far the server's clock is ahead of this device's, in milliseconds,
 * measured when the page becomes interactive. Deadlines are the server's, and
 * a device whose clock is a few minutes out would otherwise count down to the
 * wrong moment. Null until it has been measured.
 */
export function useClockOffset(serverTime: number): number | null {
  const [offset, setOffset] = useState<number | null>(null);
  useEffect(() => {
    setOffset(serverTime - Date.now());
  }, [serverTime]);
  return offset;
}

/**
 * Milliseconds left until a moment on the server's clock, counted down once a
 * second. Null when there is no such moment, and until the clocks have been
 * compared.
 */
export function useTimeLeft(
  until: string | null | undefined,
  offset: number | null,
): number | null {
  const [left, setLeft] = useState<number | null>(null);

  useEffect(() => {
    if (!until || offset === null) return;
    const end = new Date(until).getTime();
    const tick = () => setLeft(Math.max(0, end - (Date.now() + offset)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => {
      window.clearInterval(timer);
      setLeft(null);
    };
  }, [until, offset]);

  return left;
}

/** `14 minutes` for anything up to fourteen minutes, `less than a minute` at the end. */
export function formatTimeLeft(ms: number): string {
  if (ms < 60_000) return 'less than a minute';
  const minutes = Math.ceil(ms / 60_000);
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

const news = (type: string): Event => new Event(type, { bubbles: true });

/**
 * Announces one field to React as if it had just been filled in, when it no longer holds
 * what the server sent.
 */
function announce(control: Element): void {
  if (control instanceof HTMLSelectElement) {
    const options = Array.from(control.options);
    // A list sent with none of its options marked shows its first, or none where several
    // can be chosen.
    const untouched = control.multiple ? -1 : 0;
    const changed = options.some((option) => option.defaultSelected)
      ? options.some((option) => option.selected !== option.defaultSelected)
      : control.selectedIndex !== untouched;
    if (changed) control.dispatchEvent(news('change'));
    return;
  }
  if (!(control instanceof HTMLInputElement) && !(control instanceof HTMLTextAreaElement)) return;
  if (control instanceof HTMLInputElement && control.type === 'file') {
    if (control.files?.length) control.dispatchEvent(news('change'));
    return;
  }
  // React takes an event for news only when the field differs from what it last saw there,
  // and it sees what is written to the field's own `value` and `checked`. So the field is
  // first put back, which React sees, and then given the guest's entry in a way it does not.
  if (
    control instanceof HTMLInputElement &&
    (control.type === 'checkbox' || control.type === 'radio')
  ) {
    // A radio button that lost its mark is spoken for by the one that gained it.
    const unchanged = control.checked === control.defaultChecked;
    if (unchanged || (control.type === 'radio' && !control.checked)) return;
    control.checked = control.defaultChecked;
    control.click();
    return;
  }
  if (control.value === control.defaultValue) return;
  const typed = control.value;
  control.value = control.defaultValue;
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(control), 'value')?.set?.call(
    control,
    typed,
  );
  control.dispatchEvent(news('input'));
}

/**
 * Keeps what a guest put into a form before the page's scripts had taken over. The server
 * sends the form ready to use, and React never hears of what goes into it until it is in
 * charge: the fields show it, the component's own record of them does not, and the next
 * time the form is drawn it is wiped. Here every such field is announced once, when the
 * scripts take over, so that the component hears of it the way it hears of any typing.
 *
 * A form that React itself put on the page, on the way from another page of the site, has
 * nothing to announce, and is left alone.
 */
export function useEarlyInput(form: RefObject<HTMLFormElement | null>): void {
  const hydrated = useHydrated();
  const [sentByServer] = useState(!hydrated);
  const announced = useRef(false);
  useEffect(() => {
    if (!sentByServer || announced.current) return;
    announced.current = true;
    for (const control of Array.from(form.current?.elements ?? [])) announce(control);
  }, [form, sentByServer]);
}
