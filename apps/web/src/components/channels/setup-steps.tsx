'use client';

import { BellRing, Plus, Wand2 } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import useSWR from 'swr';
import { Button } from '@/components/ui/button';
import { Field, Select } from '@/components/ui/field';
import { Badge, Card, Notice, Spinner } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { plural } from '@/lib/format';
import { useAction, usePropertyDetail } from '@/lib/hooks';
import type { PropertyDetail } from '@/lib/types';
import { ChannelScreenButton } from './channel-screen';
import { StatusSwitch, type ConnectionActions } from './connection-actions';
import { isLive, joinList } from './labels';
import { MappingEditor, MappingSummary, mappingProgress } from './mapping-editor';
import { ASK_ONCE, useChannelManagerStructure } from './structure';
import type {
  AnnouncementRegistration,
  ChannelManagerAccount,
  ChannelManagerProperty,
  ChannelManagerStructure,
  Connection,
  Mappings,
  Provisioned,
} from './types';

type StepState = 'done' | 'todo' | 'partial' | 'paused' | 'off' | 'unknown';

const STEP_BADGES = {
  done: { label: 'Done', tone: 'success' },
  todo: { label: 'To do', tone: 'neutral' },
  partial: { label: 'Partly done', tone: 'warning' },
  paused: { label: 'Paused', tone: 'warning' },
  off: { label: 'Off', tone: 'neutral' },
} as const;

function Step({
  number,
  title,
  state,
  children,
}: {
  number: number;
  title: string;
  /** `unknown` where the PMS has no way of telling, so no state is claimed. */
  state: StepState;
  children: ReactNode;
}) {
  const badge = state === 'unknown' ? null : STEP_BADGES[state];
  return (
    <li className="px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span
          aria-hidden
          className={cn(
            'tabular flex size-7 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold',
            state === 'done' ? 'bg-success-100 text-success-700' : 'bg-sunken text-ink-soft',
          )}
        >
          {number}
        </span>
        <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
        {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
      </div>
      <div className="mt-2 flex flex-col items-start gap-3 text-sm text-ink-soft sm:pl-10">
        {children}
      </div>
    </li>
  );
}

function provisionSummary(
  result: Provisioned,
  before: Pick<Connection, 'mappedRoomTypes' | 'mappedRatePlans'>,
): string {
  const created = [
    result.propertyCreated ? 'the property' : null,
    result.roomTypesCreated > 0 ? plural(result.roomTypesCreated, 'room type') : null,
    result.ratePlansCreated > 0 ? plural(result.ratePlansCreated, 'rate plan') : null,
  ].filter((part): part is string => part !== null);
  const mapped = `${plural(result.mappedRoomTypes, 'room type')} and ${plural(result.mappedRatePlans, 'rate plan')} are mapped.`;
  if (created.length > 0) return `Created ${joinList(created)}. ${mapped}`;
  // A room or rate of the same name that the channel manager already has is used, not made twice.
  const mappedMore =
    result.mappedRoomTypes > before.mappedRoomTypes ||
    result.mappedRatePlans > before.mappedRatePlans;
  return mappedMore
    ? `Nothing had to be created: rooms and rates of the same name were already in the channel manager and are mapped now. ${mapped}`
    : `Nothing was missing. ${mapped}`;
}

function ExistingPropertyPicker({
  connection,
  onLinked,
  onCancel,
}: {
  connection: Connection;
  onLinked: () => Promise<unknown>;
  onCancel: () => void;
}) {
  const { data, error, mutate } = useSWR<{ properties: ChannelManagerProperty[] }>(
    '/channels/channex/properties',
    ASK_ONCE,
  );
  const others = useSWR<{ connections: Connection[] }>('/channels/connections');
  const [choice, setChoice] = useState('');
  const link = useAction(async () => {
    await api<Connection>(`/channels/connections/${connection.id}`, {
      method: 'PATCH',
      body: { config: { externalPropertyId: choice } },
    });
    await onLinked();
  });
  const usedBy = (externalId: string): string | undefined =>
    others.data?.connections.find(
      (other) => other.id !== connection.id && other.config.externalPropertyId === externalId,
    )?.propertyName;

  return (
    <div className="flex w-full max-w-xl flex-col gap-3 rounded-lg border border-line bg-sunken/40 p-3">
      {!data ? (
        error ? (
          <Notice tone="danger" title="The channel manager's properties could not be loaded">
            {errorMessage(error)}
          </Notice>
        ) : (
          <p className="flex items-center gap-2 text-ink-faint">
            <Spinner /> Loading the properties in the channel manager
          </p>
        )
      ) : data.properties.length === 0 ? (
        <p>
          The channel manager account has no properties yet. Set this one up automatically instead.
        </p>
      ) : (
        <Field
          label="Property in the channel manager"
          hint="Choose the one that stands for this property. Its rooms and rates are then mapped in step 2."
        >
          {(props) => (
            <Select
              {...props}
              value={choice}
              disabled={link.busy}
              onChange={(e) => setChoice(e.target.value)}
            >
              <option value="">Choose a property</option>
              {data.properties.map((option) => {
                const taken = usedBy(option.id);
                const linkedNow = option.id === connection.config.externalPropertyId;
                return (
                  <option
                    key={option.id}
                    value={option.id}
                    disabled={taken !== undefined || linkedNow}
                  >
                    {option.title}
                    {option.currency ? ` (${option.currency})` : ''}
                    {linkedNow ? ', linked now' : taken ? `, used by ${taken}` : ''}
                  </option>
                );
              })}
            </Select>
          )}
        </Field>
      )}
      {link.error && <Notice tone="danger">{link.error}</Notice>}
      <div className="flex flex-wrap gap-2">
        {data && data.properties.length > 0 && (
          <Button
            variant="primary"
            disabled={!choice}
            loading={link.busy}
            onClick={() => void link.run()}
          >
            Use this property
          </Button>
        )}
        {!data && error && <Button onClick={() => void mutate()}>Try again</Button>}
        <Button disabled={link.busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

interface StructureState {
  data: ChannelManagerStructure | undefined;
  error: unknown;
  reload: () => Promise<unknown>;
}

function PropertyStep({
  connection,
  canManage,
  structure,
  account,
  onMappingsReplaced,
}: {
  connection: Connection;
  canManage: boolean;
  structure: StructureState;
  /** Whose channel manager account this installation uses, once that is known. */
  account: ChannelManagerAccount | undefined;
  onMappingsReplaced: () => Promise<unknown>;
}) {
  const linked = Boolean(connection.config.externalPropertyId);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const provision = useAction(async () => {
    setOutcome(null);
    const result = await api<Provisioned>(
      `/channels/connections/${connection.id}/channex/provision`,
      { method: 'POST' },
    );
    setOutcome(provisionSummary(result, connection));
    await onMappingsReplaced();
  });
  // Linking another property while rooms are mapped would leave them pointing at the old one.
  const relinkable =
    connection.status === 'pending' &&
    connection.mappedRoomTypes === 0 &&
    connection.mappedRatePlans === 0;
  const title = structure.data?.property?.title;

  return (
    <Step number={1} title="Channel manager property" state={linked ? 'done' : 'todo'}>
      {!linked ? (
        <p>
          The channel manager needs its own copy of this property before any booking site can be
          connected.
          {canManage &&
            ' Setting it up automatically creates the property there, with a room for each room type here and a rate for each rate plan, and maps them to each other.'}
        </p>
      ) : !canManage ? (
        <p>This property is linked to a property in the channel manager.</p>
      ) : title ? (
        <p>
          Linked to <span className="font-medium text-ink">{title}</span> in the channel manager.
        </p>
      ) : structure.data ? (
        <Notice tone="warning">
          The linked property can no longer be found in the channel manager.
        </Notice>
      ) : structure.error ? (
        <Notice tone="danger" title="The channel manager could not be asked about this property">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>{errorMessage(structure.error)}</span>
            <Button size="sm" onClick={() => void structure.reload()}>
              Try again
            </Button>
          </div>
        </Notice>
      ) : (
        <p className="flex items-center gap-2 text-ink-faint">
          <Spinner /> Asking the channel manager
        </p>
      )}

      {outcome && <Notice tone="success">{outcome}</Notice>}
      {provision.error && <Notice tone="danger">{provision.error}</Notice>}
      {account?.error && (
        <Notice tone="danger" title="The channel manager could not be reached">
          {account.error}
        </Notice>
      )}

      {canManage &&
        (choosing ? (
          <ExistingPropertyPicker
            connection={connection}
            onCancel={() => setChoosing(false)}
            onLinked={async () => {
              setOutcome(null);
              provision.clearError();
              await onMappingsReplaced();
              setChoosing(false);
            }}
          />
        ) : linked ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                icon={<Plus className="size-4" />}
                loading={provision.busy}
                onClick={() => void provision.run()}
              >
                Add anything missing
              </Button>
              {relinkable && (
                <Button variant="ghost" disabled={provision.busy} onClick={() => setChoosing(true)}>
                  Link a different property
                </Button>
              )}
            </div>
            <p className="text-[13px] text-ink-faint">
              Creates and maps the room types and rate plans that exist here but not yet in the
              channel manager. What is already mapped is left as it is.
            </p>
          </>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              icon={<Wand2 className="size-4" />}
              loading={provision.busy}
              onClick={() => void provision.run()}
            >
              Set up automatically
            </Button>
            <Button disabled={provision.busy} onClick={() => setChoosing(true)}>
              Use an existing property
            </Button>
          </div>
        ))}

      {account?.account && (
        <p className="text-[13px] text-ink-faint">
          Channel manager account:{' '}
          {[account.account.name, account.account.email].filter(Boolean).join(', ')}
        </p>
      )}
    </Step>
  );
}

function MappingStep({
  connection,
  mappings,
  canManage,
  property,
  structure,
  editorVersion,
  onSaved,
}: {
  connection: Connection;
  mappings: Mappings;
  canManage: boolean;
  property: { data: PropertyDetail | undefined; error: unknown; reload: () => Promise<unknown> };
  structure: StructureState;
  editorVersion: number;
  onSaved: () => Promise<unknown>;
}) {
  const linked = Boolean(connection.config.externalPropertyId);
  const roomTypes = property.data?.roomTypes;

  return (
    <Step
      number={2}
      title="Rooms and rates"
      state={roomTypes ? mappingProgress(roomTypes, mappings) : 'unknown'}
    >
      <p>
        {canManage
          ? 'Map each room type and rate plan here to the room and rate it stands for in the channel manager.'
          : 'Each room type and rate plan here stands for a room and a rate in the channel manager.'}{' '}
        Availability and prices are sent only for what is mapped.
      </p>
      {!roomTypes ? (
        property.error ? (
          <Notice tone="danger" title="The room types of this property could not be loaded">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>{errorMessage(property.error)}</span>
              <Button size="sm" onClick={() => void property.reload()}>
                Try again
              </Button>
            </div>
          </Notice>
        ) : (
          <p className="flex items-center gap-2 text-ink-faint">
            <Spinner /> Loading the room types
          </p>
        )
      ) : !canManage ? (
        <div className="w-full">
          <MappingSummary roomTypes={roomTypes} mappings={mappings} />
        </div>
      ) : !linked ? (
        <p className="text-ink-faint">
          Set the channel manager property in step 1 first. Its rooms and rates can then be mapped
          here.
        </p>
      ) : structure.data ? (
        <div className="w-full">
          <MappingEditor
            key={editorVersion}
            connection={connection}
            roomTypes={roomTypes}
            structure={structure.data}
            mappings={mappings}
            onSaved={onSaved}
          />
        </div>
      ) : structure.error ? (
        <>
          <Notice
            tone="danger"
            title="The rooms and rates in the channel manager could not be loaded"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>{errorMessage(structure.error)}</span>
              <Button size="sm" onClick={() => void structure.reload()}>
                Try again
              </Button>
            </div>
          </Notice>
          <div className="w-full">
            <MappingSummary roomTypes={roomTypes} mappings={mappings} />
          </div>
        </>
      ) : (
        <p className="flex items-center gap-2 text-ink-faint">
          <Spinner /> Loading the rooms and rates in the channel manager
        </p>
      )}
    </Step>
  );
}

const ANNOUNCEMENTS_KEY = 'pms.channels.announcements';

/**
 * A registration made earlier in this browser session. The server cannot be asked whether one
 * exists, so this is all the page can know.
 */
function rememberedRegistration(): AnnouncementRegistration | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(ANNOUNCEMENTS_KEY);
    return raw ? (JSON.parse(raw) as AnnouncementRegistration) : null;
  } catch {
    return null;
  }
}

function AnnouncementsStep() {
  const auth = useAuth();
  const [registration, setRegistration] = useState(rememberedRegistration);
  const register = useAction(async () => {
    const result = await api<AnnouncementRegistration>('/channels/channex/webhook', {
      method: 'POST',
    });
    setRegistration(result);
    try {
      window.sessionStorage.setItem(ANNOUNCEMENTS_KEY, JSON.stringify(result));
    } catch {
      // Storage blocked: the confirmation simply does not survive a reload.
    }
  });

  return (
    <Step number={3} title="Booking announcements" state={registration ? 'done' : 'unknown'}>
      <p>
        The channel manager can announce a booking here the moment it is made. Without this,
        bookings still arrive, but by the regular check every 15 minutes instead of within seconds.
        It is registered once for the whole installation, not for each property.
      </p>
      {registration ? (
        <Notice tone="success">
          <p>
            {registration.created
              ? 'Registered. Bookings are now announced as they are made.'
              : 'This was already registered. The registration has been renewed.'}
          </p>
          <p className="break-all">Announcements are sent to {registration.callbackUrl}</p>
        </Notice>
      ) : (
        <p>
          This page cannot tell whether it has been registered before. Registering again does no
          harm: it renews the existing registration.
        </p>
      )}
      {register.error && <Notice tone="danger">{register.error}</Notice>}
      {auth.can('org.manage') ? (
        <Button
          icon={<BellRing className="size-4" />}
          loading={register.busy}
          onClick={() => void register.run()}
        >
          {registration ? 'Register again' : 'Register'}
        </Button>
      ) : (
        <p className="text-[13px] text-ink-faint">Only an organisation admin can register it.</p>
      )}
    </Step>
  );
}

function GoLiveStep({
  connection,
  actions,
  canManage,
}: {
  connection: Connection;
  actions: ConnectionActions;
  canManage: boolean;
}) {
  const live = isLive(connection);
  const state: StepState = live
    ? 'done'
    : connection.status === 'paused'
      ? 'paused'
      : connection.status === 'disabled'
        ? 'off'
        : 'todo';

  return (
    <Step number={4} title="Go live" state={state}>
      {live ? (
        <p>
          This connection is switched on. Changes to availability and rates go out as they happen,
          and bookings from the booking sites are recorded here.
        </p>
      ) : (
        <p>
          {connection.status === 'paused'
            ? 'This connection is paused. Resuming'
            : connection.status === 'disabled'
              ? 'This connection is switched off. Switching on'
              : 'Switching on'}{' '}
          sends availability and rates for the whole planning horizon once. After that, every change
          goes out as it happens and bookings from the booking sites are recorded here.
        </p>
      )}
      {actions.switchOnError && !live && <Notice tone="danger">{actions.switchOnError}</Notice>}
      {canManage && <StatusSwitch connection={connection} actions={actions} placement="step" />}
    </Step>
  );
}

function BookingSitesStep({
  connection,
  canManage,
}: {
  connection: Connection;
  canManage: boolean;
}) {
  const linked = Boolean(connection.config.externalPropertyId);
  return (
    <Step number={5} title="Booking sites" state="unknown">
      <p>
        {canManage
          ? "Connect Booking.com, Airbnb and the other sites to this property, and match each site's rooms and rates. This is done on the channel manager's own screen, which opens here."
          : "Booking.com, Airbnb and the other sites are connected to this property on the channel manager's own screen, where each site's rooms and rates are matched as well."}{' '}
        The channel manager keeps track of which sites are connected; this page does not show it.
      </p>
      {canManage &&
        (linked ? (
          <ChannelScreenButton connection={connection} />
        ) : (
          <p className="text-ink-faint">
            Set the channel manager property in step 1 first. The sites are connected to that
            property.
          </p>
        ))}
    </Step>
  );
}

/**
 * What it takes to get a property onto the booking sites, as a checklist.
 * Every step works on its own, so a finished set-up can be changed later
 * without going through the others again.
 */
export function SetupSteps({
  connection,
  mappings,
  actions,
  canManage,
}: {
  connection: Connection;
  mappings: Mappings;
  actions: ConnectionActions;
  canManage: boolean;
}) {
  const property = usePropertyDetail(connection.propertyId);
  const structure = useChannelManagerStructure(connection, canManage);
  const account = useSWR<ChannelManagerAccount>(canManage ? '/channels/channex' : null, ASK_ONCE);
  // Raised when the mapping is replaced from outside the editor, which then starts again from what
  // is saved.
  const [editorVersion, setEditorVersion] = useState(0);

  // What the channel manager could not be asked while it was down is asked again as soon as an
  // exchange with it has worked, rather than leaving an old error on screen.
  const askAgain = useRef(() => {});
  useEffect(() => {
    askAgain.current = () => {
      if (structure.error) void structure.mutate();
      if (account.error || account.data?.error) void account.mutate();
    };
  });
  useEffect(() => {
    askAgain.current();
  }, [connection.lastSuccessAt]);

  const structureState: StructureState = {
    data: structure.data,
    error: structure.error,
    reload: () => structure.mutate(),
  };
  const mappingsReplaced = async () => {
    await actions.refresh();
    await structure.mutate();
    setEditorVersion((version) => version + 1);
  };

  return (
    <Card>
      <ol className="divide-y divide-line">
        <PropertyStep
          connection={connection}
          canManage={canManage}
          structure={structureState}
          account={account.data}
          onMappingsReplaced={mappingsReplaced}
        />
        <MappingStep
          connection={connection}
          mappings={mappings}
          canManage={canManage}
          property={{
            data: property.data,
            error: property.error,
            reload: () => property.mutate(),
          }}
          structure={structureState}
          editorVersion={editorVersion}
          onSaved={actions.refresh}
        />
        <AnnouncementsStep />
        <GoLiveStep connection={connection} actions={actions} canManage={canManage} />
        <BookingSitesStep connection={connection} canManage={canManage} />
      </ol>
    </Card>
  );
}
