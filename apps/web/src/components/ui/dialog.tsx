'use client';

import * as RadixDialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}

const WIDTHS = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl' };

/** The control to hand the keyboard back to: the one in use when the dialog opened. */
function openerOf(active: Element | null): Element | null {
  // A menu closes as its item is chosen, so the item is gone by the time the dialog closes;
  // the button that opened the menu is still there.
  const menu = active?.closest('[role="menu"]');
  const trigger = menu?.getAttribute('aria-labelledby');
  return trigger ? document.getElementById(trigger) : active;
}

/**
 * Remembers what had the keyboard when a dialog opened and gives it back when the dialog
 * closes. These dialogs are opened by a flag, not by a trigger of their own, so without this
 * closing one leaves the keyboard on nothing and the next Tab starts from the top of the page.
 */
function useReturnFocus(open: boolean): (event: Event) => void {
  const [seen, setSeen] = useState<{ open: boolean; opener: Element | null }>({
    open: false,
    opener: null,
  });
  if (seen.open !== open) {
    // Read as the dialog opens: once it is on screen it has taken the keyboard itself. It is
    // kept through the closing, which is when it is needed.
    setSeen({
      open,
      opener:
        open && typeof document !== 'undefined' ? openerOf(document.activeElement) : seen.opener,
    });
  }
  return (event) => {
    const { opener } = seen;
    if (
      opener instanceof HTMLElement &&
      opener !== document.body &&
      opener.isConnected &&
      !opener.matches(':disabled')
    ) {
      event.preventDefault();
      opener.focus();
    }
  };
}

function Header({ title, description }: { title: ReactNode; description?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
      <div className="min-w-0">
        <RadixDialog.Title className="text-base font-semibold text-ink">{title}</RadixDialog.Title>
        {description ? (
          <RadixDialog.Description className="mt-0.5 text-[13px] text-ink-soft">
            {description}
          </RadixDialog.Description>
        ) : (
          <RadixDialog.Description className="sr-only">Dialog</RadixDialog.Description>
        )}
      </div>
      <RadixDialog.Close
        aria-label="Close"
        className="-mr-1.5 rounded-md p-1.5 text-ink-faint transition-colors hover:bg-sunken hover:text-ink"
      >
        <X className="size-4" />
      </RadixDialog.Close>
    </div>
  );
}

/** A modal dialog centred on the screen. Escape and the backdrop close it. */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: DialogProps) {
  const returnFocus = useReturnFocus(open);
  return (
    <RadixDialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 animate-fade-in bg-ink/40" />
        <RadixDialog.Content
          onCloseAutoFocus={returnFocus}
          className={cn(
            'fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col',
            'animate-pop-in rounded-xl bg-surface shadow-pop',
            WIDTHS[size],
          )}
        >
          <Header title={title} description={description} />
          <div className="scrollbar-thin flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && (
            <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
              {footer}
            </div>
          )}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/** A panel that slides in from the right, for details alongside the page behind it. */
export function Drawer({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 'max-w-lg',
}: Omit<DialogProps, 'size'> & { width?: string }) {
  const returnFocus = useReturnFocus(open);
  return (
    <RadixDialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 animate-fade-in bg-ink/25" />
        <RadixDialog.Content
          onCloseAutoFocus={returnFocus}
          className={cn(
            'fixed top-0 right-0 z-50 flex h-dvh w-full animate-slide-in flex-col bg-surface shadow-pop',
            width,
          )}
        >
          <Header title={title} description={description} />
          <div className="scrollbar-thin flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && (
            <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
              {footer}
            </div>
          )}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
