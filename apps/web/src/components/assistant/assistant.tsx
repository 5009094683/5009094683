'use client';

import { Sparkles } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Tooltip } from '@/components/ui/misc';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { plural } from '@/lib/format';
import { useAiStatus } from './ai-status';
import { ASSISTANT_PANEL_ID, AssistantPanel } from './assistant-panel';
import { useConversation } from './conversation';

/** The time now, kept moving while something on screen depends on it. */
function useNow(ticking: boolean): [number, () => void] {
  const [now, setNow] = useState(() => Date.now());
  const refresh = useCallback(() => setNow(Date.now()), []);
  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(refresh, 15_000);
    return () => window.clearInterval(timer);
  }, [ticking, refresh]);
  return [now, refresh];
}

const isPhoneWidth = (): boolean => window.matchMedia('(max-width: 639px)').matches;

/** The assistant: a button in the header that opens a panel to ask questions and prepare changes. */
export function Assistant() {
  const { me } = useAuth();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [mac] = useState(
    () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform),
  );
  const buttonRef = useRef<HTMLButtonElement>(null);
  const chat = useConversation(me.user.id);
  const status = useAiStatus(open);

  const undecided = Object.values(chat.conversation.proposals).filter(
    (proposal) => proposal.outcome.state === 'waiting',
  );
  const [now, refreshNow] = useNow(undecided.length > 0);
  const waiting = undecided.filter((proposal) => proposal.lapsesAt > now).length;

  // On a phone the panel fills the screen, so a page chosen from the menu would open unseen
  // behind it.
  const [shownPath, setShownPath] = useState(pathname);
  if (shownPath !== pathname) {
    setShownPath(pathname);
    if (open && isPhoneWidth()) setOpen(false);
  }

  const { loadEarlier } = chat;
  const show = useCallback(() => {
    setOpen(true);
    refreshNow();
    loadEarlier();
  }, [refreshNow, loadEarlier]);

  const hide = useCallback(() => {
    const focusInside = document
      .getElementById(ASSISTANT_PANEL_ID)
      ?.contains(document.activeElement);
    setOpen(false);
    if (focusInside) buttonRef.current?.focus();
  }, []);

  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== 'j') return;
      // A modal dialog has the page to itself while it is open; Radix marks that on the body.
      if (document.body.style.pointerEvents === 'none') return;
      event.preventDefault();
      if (openRef.current) hide();
      else show();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [show, hide]);

  const shortcut = mac ? '\u2318J' : 'Ctrl+J';
  return (
    <>
      <Tooltip content={`${open ? 'Close the assistant' : 'Ask the assistant'} (${shortcut})`}>
        <button
          ref={buttonRef}
          type="button"
          aria-label={
            waiting > 0 ? `Assistant: ${plural(waiting, 'change')} waiting for you` : 'Assistant'
          }
          aria-expanded={open}
          aria-controls={ASSISTANT_PANEL_ID}
          aria-keyshortcuts="Control+J Meta+J"
          onClick={() => (open ? hide() : show())}
          className={cn(
            'relative flex shrink-0 items-center gap-1.5 rounded-md p-2 transition-colors',
            open ? 'bg-brand-50 text-brand-700' : 'text-ink-soft hover:bg-sunken hover:text-ink',
          )}
        >
          <Sparkles className="size-[18px]" aria-hidden />
          <span className="hidden text-[13px] font-medium lg:inline">Assistant</span>
          {waiting > 0 && (
            <span
              aria-hidden
              className="absolute top-1.5 left-[22px] size-2 rounded-full bg-warning-500 ring-2 ring-surface"
            />
          )}
        </button>
      </Tooltip>
      {open && (
        <AssistantPanel
          chat={chat}
          now={now}
          rules={status?.provider === null}
          draft={draft}
          onDraft={setDraft}
          onClose={hide}
        />
      )}
    </>
  );
}
