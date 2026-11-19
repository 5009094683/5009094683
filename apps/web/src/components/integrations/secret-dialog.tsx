'use client';

import { Copy } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/field';
import { Notice } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';

/**
 * Shows a key or a signing secret the one time the server gives it out.
 *
 * Nothing can bring the value back once this is closed, so it does not close on a click
 * outside, on Escape or on the cross until the person has said they copied it.
 */
export function SecretDialog({
  title,
  label,
  name,
  value,
  children,
  onClose,
}: {
  title: string;
  /** What the value is, as a heading: "API key", "Signing secret". */
  label: string;
  /** The same in the middle of a sentence: "API key", "signing secret". */
  name: string;
  value: string;
  /** What the value is for and where it goes. */
  children: ReactNode;
  onClose: () => void;
}) {
  const toast = useToast();
  const labelId = useId();
  const confirmId = useId();
  const [confirmed, setConfirmed] = useState(false);
  const [reminded, setReminded] = useState(false);

  // Reloading or closing the tab would lose the value just as surely as closing the dialog.
  useEffect(() => {
    if (confirmed) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [confirmed]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copied`);
    } catch {
      // The clipboard is unavailable on plain-HTTP origins and when the browser denies access.
      toast.error('Could not copy. Select the text and copy it yourself.');
    }
  };

  const close = () => {
    if (confirmed) {
      onClose();
      return;
    }
    setReminded(true);
    document.getElementById(confirmId)?.focus();
  };

  return (
    <Dialog
      open
      onClose={close}
      title={title}
      footer={
        <Button variant="primary" disabled={!confirmed} onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="text-sm text-ink-soft">{children}</div>
        <div className="flex flex-col gap-1">
          <p id={labelId} className="text-[13px] font-medium text-ink-soft">
            {label}
          </p>
          <div className="flex items-start gap-2">
            <code
              aria-labelledby={labelId}
              data-secret
              className="min-w-0 flex-1 rounded-md border border-line-strong bg-sunken px-2.5 py-2 font-mono text-[13px] leading-5 break-all text-ink select-all"
            >
              {value}
            </code>
            <Button
              icon={<Copy className="size-4" />}
              aria-label={`Copy ${name}`}
              onClick={() => void copy()}
            >
              Copy
            </Button>
          </div>
        </div>
        <Notice tone="warning" title="This is the only time it is shown">
          Copy the {name} now and keep it somewhere safe, such as a password manager. It cannot be
          shown again after you close this.
        </Notice>
        <Checkbox
          id={confirmId}
          checked={confirmed}
          onChange={(event) => {
            setConfirmed(event.target.checked);
            setReminded(false);
          }}
          label={`I have copied the ${name}`}
        />
        {reminded && !confirmed && (
          <p role="alert" className="text-[13px] text-danger-600">
            Copy the {name} and tick the box before you close this. It cannot be shown again.
          </p>
        )}
      </div>
    </Dialog>
  );
}
