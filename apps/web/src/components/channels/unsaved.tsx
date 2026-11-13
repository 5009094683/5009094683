'use client';

import { Save } from 'lucide-react';
import { useRouter } from 'next/navigation';
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';

interface Guard {
  claim(id: string): void;
  release(id: string): void;
}

const GuardContext = createContext<Guard | null>(null);

/** Where a click leads, when the browser would answer it by opening another page of this application. */
function pageBehind(event: MouseEvent): string | null {
  if (event.defaultPrevented || event.button !== 0) return null;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
  if (!(link instanceof HTMLAnchorElement)) return null;
  if ((link.target && link.target !== '_self') || link.hasAttribute('download')) return null;
  const url = new URL(link.href, window.location.href);
  // Leaving the application altogether is the browser's to ask about, through `beforeunload`.
  if (url.origin !== window.location.origin) return null;
  if (url.pathname === window.location.pathname && url.search === window.location.search) {
    return null;
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Keeps changes that have not been saved from being lost by accident. While any form inside it
 * has such changes, following a link to another page asks first, and so does the browser when
 * the tab is closed or reloaded.
 *
 * The browser's Back button, and moves made by other parts of the application without a link,
 * are not caught: the router gives no way to hold those.
 */
export function UnsavedChangesGuard({ children }: { children: ReactNode }) {
  const router = useRouter();
  const unsaved = useRef(new Set<string>());
  const [leavingTo, setLeavingTo] = useState<string | null>(null);
  const guard = useMemo<Guard>(
    () => ({
      claim: (id) => void unsaved.current.add(id),
      release: (id) => void unsaved.current.delete(id),
    }),
    [],
  );

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (unsaved.current.size > 0) event.preventDefault();
    };
    const click = (event: MouseEvent) => {
      if (unsaved.current.size === 0) return;
      const page = pageBehind(event);
      if (page === null) return;
      // The link's own handler sees the click as dealt with and stays where it is.
      event.preventDefault();
      setLeavingTo(page);
    };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', click, true);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('click', click, true);
    };
  }, []);

  const stay = () => setLeavingTo(null);

  return (
    <GuardContext.Provider value={guard}>
      {children}
      {/* On screen only while it asks: the dialog gives the keyboard back as it goes. */}
      {leavingTo !== null && (
        <Dialog
          open
          onClose={stay}
          size="sm"
          title="Leave without saving?"
          footer={
            <>
              <Button onClick={stay}>Stay on this page</Button>
              <Button
                variant="danger"
                onClick={() => {
                  setLeavingTo(null);
                  router.push(leavingTo);
                }}
              >
                Leave without saving
              </Button>
            </>
          }
        >
          <p className="text-sm text-ink-soft">
            This page has changes that are not saved. If you leave now, they are lost.
          </p>
        </Dialog>
      )}
    </GuardContext.Provider>
  );
}

/** Tells the guard around this form that it holds changes that are not saved. */
export function useUnsavedChanges(dirty: boolean): void {
  const guard = useContext(GuardContext);
  const id = useId();
  useEffect(() => {
    if (!guard || !dirty) return;
    guard.claim(id);
    return () => guard.release(id);
  }, [guard, dirty, id]);
}

/**
 * The foot of a form whose changes are kept until saved: the button that saves, and, once
 * something has changed, a way to drop the changes, which asks first.
 */
export function SaveBar({
  label,
  what,
  dirty,
  busy,
  onSave,
  onDiscard,
}: {
  /** What the saving button says: `Save calendars`. */
  label: string;
  /** What the changes were made to, for the question before dropping them: `the calendars`. */
  what: string;
  dirty: boolean;
  busy: boolean;
  /** Left out where the bar sits in a form that saves when submitted. */
  onSave?: () => void;
  onDiscard: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  useUnsavedChanges(dirty);

  // Saving or discarding takes away the button that was just used (the one is switched off, the
  // other goes), and with it the keyboard focus. The bar takes the focus instead of the page.
  const bar = useRef<HTMLDivElement>(null);
  const wasDirty = useRef(dirty);
  useEffect(() => {
    const settled = wasDirty.current && !dirty;
    wasDirty.current = dirty;
    if (!settled) return;
    // A moment later: the dialog that asked about discarding gives the keyboard back first.
    const timer = window.setTimeout(() => {
      const focused = document.activeElement;
      const lost =
        focused === null ||
        focused === document.body ||
        (focused instanceof HTMLButtonElement && focused.disabled);
      if (lost) bar.current?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [dirty]);

  return (
    <div
      ref={bar}
      tabIndex={-1}
      className="flex flex-wrap items-center gap-x-3 gap-y-2 outline-none"
    >
      <Button
        type={onSave ? 'button' : 'submit'}
        variant="primary"
        icon={<Save className="size-4" />}
        disabled={!dirty}
        loading={busy}
        onClick={onSave}
      >
        {label}
      </Button>
      {dirty && (
        <>
          <Button variant="ghost" disabled={busy} onClick={() => setConfirming(true)}>
            Discard changes
          </Button>
          <span className="text-[13px] font-medium text-warning-700">Unsaved changes</span>
        </>
      )}
      {confirming && (
        <Dialog
          open
          onClose={() => setConfirming(false)}
          size="sm"
          title="Discard the changes?"
          footer={
            <>
              <Button onClick={() => setConfirming(false)}>Keep editing</Button>
              <Button
                variant="danger"
                onClick={() => {
                  setConfirming(false);
                  onDiscard();
                }}
              >
                Discard changes
              </Button>
            </>
          }
        >
          <p className="text-sm text-ink-soft">
            What you changed in {what} since the last save is lost. What is saved stays as it is.
          </p>
        </Dialog>
      )}
    </div>
  );
}
