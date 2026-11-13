'use client';

import { ExternalLink } from 'lucide-react';
import { Notice } from '@/components/ui/misc';
import { formatDateTime } from '@/lib/format';
import { useMonitor } from './monitor';
import type { ChannelsStatus } from './types';

/** What stands between the PMS and the booking sites right now, shown only when something does. */
export function HealthBanners() {
  const { data } = useMonitor<ChannelsStatus>('/channels/status');
  if (!data) return null;
  const { channex, worker, simulatorUrl } = data;
  const testing = channex.environment === 'simulator' || channex.environment === 'staging';
  if (worker.alive && channex.configured && !testing) return null;

  return (
    <div className="mb-4 flex flex-col gap-2">
      {!worker.alive && (
        <Notice tone="danger" title="Nothing is being sent to or fetched from the booking sites">
          The sync worker, the background service that does the sending and fetching, is not
          running.{' '}
          {worker.lastSeenAt
            ? `It last reported at ${formatDateTime(worker.lastSeenAt)}.`
            : 'It has not reported yet.'}{' '}
          Changes made here are queued and go out as soon as it is back.
        </Notice>
      )}
      {!channex.configured && (
        <Notice tone="warning" title="The channel manager is not set up">
          No channel manager key is set for this installation, so properties cannot be connected to
          the booking sites. An administrator needs to set{' '}
          <code className="font-mono text-xs font-semibold">CHANNEX_API_KEY</code> on the server.
        </Notice>
      )}
      {channex.environment === 'simulator' && (
        <Notice tone="info">
          This installation is connected to the built-in simulator, not to real booking sites.
          Nothing here reaches real guests.{' '}
          {simulatorUrl && (
            <a
              href={simulatorUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-medium underline underline-offset-2"
            >
              Open the simulator
              <ExternalLink className="size-3.5" aria-hidden />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          )}
        </Notice>
      )}
      {channex.environment === 'staging' && (
        <Notice tone="info">
          This installation is connected to the channel manager&apos;s test environment, not to real
          booking sites.
        </Notice>
      )}
    </div>
  );
}
