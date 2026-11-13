'use client';

import {
  Download,
  GitCompareArrows,
  Import,
  MoreHorizontal,
  Pause,
  Play,
  RefreshCw,
  Send,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Menu, MenuItem, MenuLabel, Notice } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { useReturnFocus } from './focus';
import { calendarsOf, hasMailbox, kindOf } from './kinds';
import { isLive } from './labels';
import type { Connection } from './types';

type BackgroundAction = 'full-sync' | 'pull' | 'drift-check' | 'import-bookings';

const BACKGROUND_ACTIONS: Record<
  Exclude<BackgroundAction, 'pull'>,
  { label: string; started: string }
> = {
  'full-sync': { label: 'Send everything again', started: 'Sending everything again' },
  'drift-check': { label: 'Compare with the channels', started: 'Comparing with the channels' },
  'import-bookings': {
    label: 'Import existing bookings',
    started: 'Importing existing bookings',
  },
};

/** What a job is called, and what is said once it has started. Looking for bookings is named by the kind of connection. */
function actionWords(
  connection: Connection,
  action: BackgroundAction,
): { label: string; started: string } {
  return action === 'pull' ? kindOf(connection).read : BACKGROUND_ACTIONS[action];
}

export interface ConnectionActions {
  /** What is in flight, if anything. */
  busy: 'switch-on' | BackgroundAction | null;
  /** Why switching on was refused, for as long as the connection is as it was then. */
  switchOnError: string | null;
  /**
   * Starts or resumes syncing. A refusal is always kept in `switchOnError`;
   * pass 'inline' where that is shown next to the button, so it is not also raised as a toast.
   */
  switchOn(feedback?: 'toast' | 'inline'): Promise<void>;
  /** Asks for a job that the sync worker then does in the background. */
  run(action: BackgroundAction): Promise<void>;
  /** Fetches the connection again after a change. */
  refresh(): Promise<unknown>;
}

/** The things staff can do to a connection, shared by its card and its own page. */
export function useConnectionActions(
  connection: Connection,
  refresh: () => Promise<unknown>,
): ConnectionActions {
  const toast = useToast();
  const [busy, setBusy] = useState<ConnectionActions['busy']>(null);
  const [refusal, setRefusal] = useState<{ message: string; madeWhen: string } | null>(null);
  const path = `/channels/connections/${connection.id}`;
  // A refusal says what was wrong at the time. Once the set-up has moved on it no longer applies.
  const setUp = `${connection.status}/${connection.mappedRoomTypes}/${connection.mappedRatePlans}`;
  const switchOnError = refusal?.madeWhen === setUp ? refusal.message : null;

  const switchOn: ConnectionActions['switchOn'] = async (feedback = 'toast') => {
    setBusy('switch-on');
    setRefusal(null);
    try {
      await api<Connection>(path, { method: 'PATCH', body: { status: 'active' } });
      await refresh();
      const done = kindOf(connection).switchedOn(connection.propertyName);
      toast.success(done.title, done.detail);
    } catch (err) {
      setRefusal({ message: errorMessage(err), madeWhen: setUp });
      if (feedback === 'toast') toast.error(err);
    } finally {
      setBusy(null);
    }
  };

  const run = async (action: BackgroundAction) => {
    setBusy(action);
    try {
      const { queued } = await api<{ queued: boolean }>(`${path}/${action}`, { method: 'POST' });
      if (queued) {
        toast.success(
          actionWords(connection, action).started,
          'This runs in the background. The page shows the result when it is done.',
        );
      } else {
        toast.info(
          'Already under way',
          'This was asked for a moment ago and has not finished yet. The page shows the result when it is done.',
        );
      }
      await refresh();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  };

  return { busy, switchOnError, switchOn, run, refresh };
}

function PauseDialog({
  connection,
  actions,
  onClose,
}: {
  connection: Connection;
  actions: ConnectionActions;
  onClose: () => void;
}) {
  const toast = useToast();
  const kind = kindOf(connection);
  const pause = useAction(async () => {
    await api<Connection>(`/channels/connections/${connection.id}`, {
      method: 'PATCH',
      body: { status: 'paused' },
    });
    await actions.refresh();
    const done = kind.paused(connection.propertyName);
    toast.success(done.title, done.detail);
    onClose();
  });

  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={`Pause ${kind.named(connection.propertyName)}?`}
      footer={
        <>
          <Button onClick={onClose}>Keep it on</Button>
          <Button variant="danger" loading={pause.busy} onClick={() => void pause.run()}>
            Pause
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm text-ink-soft">
        {pause.error && <Notice tone="danger">{pause.error}</Notice>}
        <p>{kind.pauseWarning}</p>
        <p>{kind.afterPause}</p>
      </div>
    </Dialog>
  );
}

/**
 * The button that pauses a live connection or switches a stopped one on.
 * On a card a connection that is still being set up has no such button: it
 * is switched on from the set-up steps, which is where `placement="step"` is used.
 */
export function StatusSwitch({
  connection,
  actions,
  placement,
}: {
  connection: Connection;
  actions: ConnectionActions;
  placement: 'card' | 'step';
}) {
  const [confirming, setConfirming] = useState(false);
  const rememberOpener = useReturnFocus(confirming);
  const inStep = placement === 'step';
  const live = isLive(connection);

  if (connection.status === 'pending' && !inStep) return null;
  // One button for both directions: it stays in place when the connection is paused or switched
  // on, and with it the keyboard focus.
  return (
    <>
      <Button
        size={inStep ? 'md' : 'sm'}
        variant={inStep && !live ? 'primary' : 'secondary'}
        icon={live ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
        loading={actions.busy === 'switch-on'}
        onClick={(event) => {
          if (live) {
            rememberOpener(event);
            setConfirming(true);
          } else {
            void actions.switchOn(inStep ? 'inline' : 'toast');
          }
        }}
      >
        {live ? 'Pause' : connection.status === 'paused' ? 'Resume' : 'Switch on'}
      </Button>
      {confirming && (
        <PauseDialog
          connection={connection}
          actions={actions}
          onClose={() => setConfirming(false)}
        />
      )}
    </>
  );
}

/** Jobs that can be asked for by hand. They only do something while the connection is live. */
function ConnectionMenu({
  connection,
  actions,
}: {
  connection: Connection;
  actions: ConnectionActions;
}) {
  const live = isLive(connection);
  const { ari, bookings } = connection.capabilities;
  // A comparison is skipped while the last update is failing or a full send is still to go out.
  const comparable = connection.status === 'active' && !connection.fullSyncRequestedAt;

  const item = (action: BackgroundAction, icon: ReactNode, enabled: boolean) => (
    <MenuItem icon={icon} disabled={!enabled} onSelect={() => void actions.run(action)}>
      {actionWords(connection, action).label}
    </MenuItem>
  );

  return (
    <Menu
      trigger={
        <Button
          size="icon"
          variant="ghost"
          aria-label={`More actions for ${kindOf(connection).named(connection.propertyName)}`}
          icon={<MoreHorizontal className="size-4" />}
          loading={actions.busy !== null && actions.busy !== 'switch-on'}
        />
      }
    >
      {!live && <MenuLabel>Available once the connection is live</MenuLabel>}
      {ari && item('full-sync', <Send />, live)}
      {bookings !== 'none' && item('pull', <Download />, live)}
      {ari && item('drift-check', <GitCompareArrows />, comparable)}
      {ari && item('import-bookings', <Import />, live)}
      {live && ari && !comparable && (
        <MenuLabel>
          <span className="block max-w-60 font-normal">
            {connection.status === 'error'
              ? 'Comparing is possible once updates go through again.'
              : 'Comparing is possible once everything has been sent.'}
          </span>
        </MenuLabel>
      )}
    </Menu>
  );
}

/**
 * What can be asked of a connection by hand. One that sends availability has several jobs, kept
 * in a menu. One that only reads has a single job, which gets a button of its own while the
 * connection is live.
 */
export function ConnectionJobs({
  connection,
  actions,
  placement,
}: {
  connection: Connection;
  actions: ConnectionActions;
  /** On a card there is room for a short name only. */
  placement: 'card' | 'page';
}) {
  const { ari, bookings } = connection.capabilities;
  if (ari) return <ConnectionMenu connection={connection} actions={actions} />;
  if (bookings === 'none' || !isLive(connection)) return null;
  // Nothing to ask for while there is nothing to read: no calendar with the address of a site's
  // calendar, or no mailbox. A mailbox set for the whole installation is still read by itself.
  if (connection.adapter === 'ical' && !calendarsOf(connection).read) return null;
  if (connection.adapter === 'email' && !hasMailbox(connection)) return null;
  const kind = kindOf(connection);
  const onCard = placement === 'card';
  return (
    <Button
      size="sm"
      icon={<RefreshCw className="size-3.5" />}
      loading={actions.busy === 'pull'}
      aria-label={onCard ? `Read now: ${kind.named(connection.propertyName)}` : undefined}
      onClick={() => void actions.run('pull')}
    >
      {onCard ? 'Read now' : kind.read.label}
    </Button>
  );
}
