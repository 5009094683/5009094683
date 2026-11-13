'use client';

import { Store } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Notice, PageLoading } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { useReturnFocus } from './focus';
import type { Connection } from './types';

type Screen =
  { state: 'opening' } | { state: 'ready'; url: string } | { state: 'failed'; message: string };

/** Only an ordinary web address goes into the frame, whatever the answer holds. */
function isWebAddress(url: string): boolean {
  try {
    return ['https:', 'http:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * Opens the channel manager's own screen for connecting booking sites and
 * matching their rooms and rates, inside a dialog.
 *
 * The link to that screen signs the viewer in, works once and expires within
 * minutes, so a new one is asked for every time the dialog opens and it is
 * never kept after closing.
 */
export function ChannelScreenButton({ connection }: { connection: Connection }) {
  const [screen, setScreen] = useState<Screen | null>(null);
  const latest = useRef(0);
  const rememberOpener = useReturnFocus(screen !== null);

  const open = async () => {
    const request = ++latest.current;
    setScreen({ state: 'opening' });
    try {
      const { url } = await api<{ url: string }>(
        `/channels/connections/${connection.id}/channex/channel-screen`,
        { body: {} },
      );
      if (latest.current !== request) return;
      setScreen(
        isWebAddress(url)
          ? { state: 'ready', url }
          : { state: 'failed', message: 'The channel manager gave a link that cannot be opened.' },
      );
    } catch (err) {
      if (latest.current === request) setScreen({ state: 'failed', message: errorMessage(err) });
    }
  };

  const close = () => {
    // An answer still on its way belongs to a dialog that is no longer open.
    latest.current++;
    setScreen(null);
  };

  return (
    <>
      <Button
        icon={<Store className="size-4" />}
        onClick={(event) => {
          rememberOpener(event);
          void open();
        }}
      >
        Connect booking sites
      </Button>
      <Dialog
        open={screen !== null}
        onClose={close}
        size="lg"
        title="Connect booking sites"
        description={`The channel manager's own screen for ${connection.propertyName}. What you change there is saved straight away.`}
      >
        {screen?.state === 'opening' && (
          <div className="h-[70dvh]">
            <PageLoading label="Opening the channel manager" />
          </div>
        )}
        {screen?.state === 'failed' && (
          <div className="flex min-h-40 flex-col items-start gap-3">
            <Notice tone="danger" title="The channel manager's screen could not be opened">
              {screen.message}
            </Notice>
            <Button onClick={() => void open()}>Try again</Button>
          </div>
        )}
        {screen?.state === 'ready' && (
          <iframe
            key={screen.url}
            src={screen.url}
            title={`Booking sites for ${connection.propertyName} in the channel manager`}
            className="block h-[70dvh] w-full rounded-md border border-line bg-surface"
          />
        )}
      </Dialog>
    </>
  );
}
