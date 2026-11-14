'use client';

import { Lightbulb, RefreshCw, Settings2 } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { calmErrorMessage, isRateLimited } from '@/components/assistant/errors';
import { useReturnFocus } from '@/components/assistant/return-focus';
import { Button } from '@/components/ui/button';
import { Drawer } from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/field';
import { Badge, EmptyState, ErrorState, Notice, PageLoading } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { plural } from '@/lib/format';
import { useLive } from '@/lib/live';
import type { Property, PropertyDetail } from '@/lib/types';
import { ApplyDialog } from './apply-dialog';
import { PricingSettingsForm } from './pricing-settings';
import { SuggestionGroupCard } from './suggestion-group';
import { groupSuggestions } from './suggestions';
import type { PricingRun, RateSuggestion } from './types';

/** The API returns at most this many suggestions at once (`listRecommendations`). */
const PAGE = 500;

const suggestionsKey = (propertyId: string): string =>
  `/properties/${propertyId}/pricing/recommendations?status=pending`;

function runSummary(run: PricingRun): string {
  const parts = [
    run.created > 0 && `${plural(run.created, 'new suggestion')}`,
    run.superseded > 0 &&
      `${plural(run.superseded, 'earlier one')} withdrawn because the picture changed`,
    run.autoApplied > 0 &&
      `${plural(run.autoApplied, 'rate')} applied straight away for room types on autopilot`,
  ].filter(Boolean);
  return parts.length === 0
    ? 'Worked out again. Nothing has changed since last time.'
    : `Worked out again: ${parts.join(', ')}.`;
}

function SuggestionsDrawer({
  property,
  detail,
  onClose,
}: {
  property: Property;
  detail: PropertyDetail | undefined;
  onClose: () => void;
}) {
  const auth = useAuth();
  const toast = useToast();
  const { mutate: mutateAny } = useSWRConfig();
  const { data, error, mutate } = useSWR<{ recommendations: RateSuggestion[] }>(
    suggestionsKey(property.id),
  );
  const canDecide = auth.can('ai.pricing.approve', property.id);
  const canRefresh = auth.can('rates.write', property.id);
  const canManage = auth.can('property.manage', property.id);

  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<'refresh' | 'dismiss' | null>(null);
  const [problem, setProblem] = useState<{ text: string; calm: boolean } | null>(null);
  const [lastRun, setLastRun] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  // Once the rates are applied nothing is ticked and "Apply selected" cannot take the keyboard.
  const rememberApply = useReturnFocus(confirming, body);
  const rememberSettings = useReturnFocus(settingsOpen, body);

  const suggestions = useMemo(
    () => (data?.recommendations ?? []).filter((s) => s.propertyId === property.id),
    [data, property.id],
  );
  const groups = useMemo(() => groupSuggestions(suggestions), [suggestions]);
  // A suggestion can be withdrawn or applied by someone else while it is ticked here.
  const selected = useMemo(
    () => new Set(suggestions.filter((s) => chosen.has(s.id)).map((s) => s.id)),
    [suggestions, chosen],
  );
  const selectedGroups = useMemo(
    () =>
      groups
        .map((group) => ({
          ...group,
          suggestions: group.suggestions.filter((s) => selected.has(s.id)),
        }))
        .filter((group) => group.suggestions.length > 0),
    [groups, selected],
  );
  const plans = useMemo(
    () => new Map(detail?.roomTypes.flatMap((t) => t.ratePlans).map((p) => [p.id, p])),
    [detail],
  );

  const toggle = (ids: string[], on: boolean) => {
    const next = new Set(selected);
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    setChosen(next);
  };

  const fail = (err: unknown) =>
    setProblem({ text: calmErrorMessage(err), calm: isRateLimited(err) });

  const refresh = async () => {
    setBusy('refresh');
    setProblem(null);
    setLastRun(null);
    try {
      const run = await api<PricingRun>(`/properties/${property.id}/pricing/refresh`, {
        method: 'POST',
      });
      await mutate();
      setLastRun(runSummary(run));
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  const dismiss = async () => {
    setBusy('dismiss');
    setProblem(null);
    try {
      const { dismissed } = await api<{ dismissed: number }>('/pricing/recommendations/dismiss', {
        body: { ids: [...selected] },
      });
      await mutate();
      setChosen(new Set());
      toast.success(
        `${plural(dismissed, 'suggestion')} dismissed`,
        'No rate was changed. It is suggested again next time if the night still calls for it.',
      );
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    const ids = [...selected];
    const { applied } = await api<{ applied: number }>('/pricing/recommendations/apply', {
      body: { ids },
    });
    setConfirming(false);
    setChosen(new Set());
    // The grid behind also hears of it through the live stream; this does not wait for that.
    await Promise.all([
      mutate(),
      mutateAny(
        (key) => typeof key === 'string' && key.startsWith(`/properties/${property.id}/rates`),
      ),
    ]);
    if (applied === ids.length) {
      toast.success(
        `${plural(applied, 'suggested rate')} applied`,
        'The booking sites are being updated.',
      );
    } else {
      toast.info(
        `${applied} of ${plural(ids.length, 'suggested rate')} applied`,
        'The others had already been decided or replaced by newer suggestions.',
      );
    }
  };

  return (
    <Drawer
      open
      onClose={onClose}
      width="max-w-2xl"
      title="Rate suggestions"
      description={`${property.name}. Suggested from how each night is selling. No rate changes until a suggestion is applied.`}
      footer={
        canDecide && suggestions.length > 0 ? (
          <>
            <p className="mr-auto text-[13px] text-ink-soft" aria-live="polite">
              {selected.size === 0 ? 'None selected' : `${selected.size} selected`}
            </p>
            <Button
              disabled={selected.size === 0}
              loading={busy === 'dismiss'}
              onClick={() => void dismiss()}
            >
              Dismiss
            </Button>
            <Button
              variant="primary"
              disabled={selected.size === 0 || busy !== null}
              onClick={() => {
                rememberApply();
                setConfirming(true);
              }}
            >
              Apply selected
            </Button>
          </>
        ) : undefined
      }
    >
      <div ref={body} tabIndex={-1} className="flex flex-col gap-4 outline-none">
        <div className="flex flex-wrap items-center gap-2">
          <p className="mr-auto text-sm text-ink-soft">
            {data
              ? suggestions.length === 0
                ? 'No suggestions waiting'
                : `${plural(suggestions.length, 'suggestion')} waiting`
              : ''}
          </p>
          {canManage && detail && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Settings2 className="size-3.5" aria-hidden />}
              aria-expanded={settingsOpen}
              onClick={() => {
                if (!settingsOpen) rememberSettings();
                setSettingsOpen(!settingsOpen);
              }}
            >
              How suggestions work
            </Button>
          )}
          {canRefresh && (
            <Button
              size="sm"
              icon={<RefreshCw className="size-3.5" aria-hidden />}
              loading={busy === 'refresh'}
              disabled={busy === 'dismiss'}
              onClick={() => void refresh()}
            >
              Work out again
            </Button>
          )}
        </div>

        {settingsOpen && canManage && detail && (
          <PricingSettingsForm
            property={property}
            detail={detail}
            onClose={() => setSettingsOpen(false)}
          />
        )}
        {problem && <Notice tone={problem.calm ? 'warning' : 'danger'}>{problem.text}</Notice>}
        {lastRun && <Notice tone="info">{lastRun}</Notice>}

        {error && !data ? (
          <ErrorState error={error} onRetry={() => void mutate()} />
        ) : !data ? (
          <PageLoading label="Loading suggestions" />
        ) : suggestions.length === 0 ? (
          <EmptyState
            icon={<Lightbulb className="size-5" />}
            title="No suggestions waiting"
            description={
              canRefresh
                ? 'Suggestions are worked out once a night from how each night is selling. Work them out again to see whether anything has changed since.'
                : 'Suggestions are worked out once a night from how each night is selling. Nothing calls for a change at the moment.'
            }
          />
        ) : (
          <>
            {canDecide ? (
              <Checkbox
                checked={selected.size === suggestions.length}
                onChange={(event) =>
                  toggle(
                    suggestions.map((s) => s.id),
                    event.target.checked,
                  )
                }
                label={`Select all ${suggestions.length}`}
                className="cursor-pointer gap-3 self-start px-3"
              />
            ) : (
              <p className="text-[13px] text-ink-faint">
                Applying or dismissing a suggestion is for people who approve rates.
              </p>
            )}
            {groups.map((group) => (
              <SuggestionGroupCard
                key={group.ratePlanId}
                group={group}
                plan={plans.get(group.ratePlanId)}
                selected={canDecide ? selected : undefined}
                onToggle={toggle}
              />
            ))}
            {suggestions.length >= PAGE && (
              <p className="text-[13px] text-ink-faint">
                Only the first {PAGE} suggestions are listed. Apply or dismiss some to see the rest.
              </p>
            )}
          </>
        )}
      </div>

      {confirming && (
        <ApplyDialog
          propertyName={property.name}
          groups={selectedGroups}
          onApply={apply}
          onClose={() => setConfirming(false)}
        />
      )}
    </Drawer>
  );
}

/**
 * Suggested rates for the property on the Rates screen: a button in its toolbar with how many
 * wait, and a panel to read them, apply or dismiss them and, for managers, steer how they are
 * made.
 */
export function RateSuggestions({
  property,
  detail,
}: {
  property: Property;
  detail: PropertyDetail | undefined;
}) {
  const auth = useAuth();
  const [open, setOpen] = useState(false);
  const rememberOpener = useReturnFocus(open);
  const allowed = auth.can('rates.read', property.id);
  const { data, mutate } = useSWR<{ recommendations: RateSuggestion[] }>(
    allowed ? suggestionsKey(property.id) : null,
  );
  useLive(/^rates\./, (events) => {
    if (events.some((e) => e.kind === 'resync' || e.propertyId === property.id)) void mutate();
  });
  if (!allowed) return null;
  const count = (data?.recommendations ?? []).filter((s) => s.propertyId === property.id).length;
  // "Bulk update" sits at the right end of the toolbar for people who may change rates; this
  // follows it there, and takes the end itself when that button is absent.
  const afterBulkUpdate = auth.can('rates.write', property.id) && detail !== undefined;

  return (
    <>
      <Button
        size="sm"
        className={cn(!afterBulkUpdate && 'ml-auto')}
        icon={<Lightbulb className="size-3.5" aria-hidden />}
        onClick={() => {
          rememberOpener();
          setOpen(true);
        }}
      >
        Suggestions
        {count > 0 && (
          <Badge tone="brand" className="px-1.5 py-0">
            <span className="sr-only">: </span>
            {count >= PAGE ? `${PAGE}+` : count}
            <span className="sr-only"> waiting</span>
          </Badge>
        )}
      </Button>
      {open && (
        <SuggestionsDrawer property={property} detail={detail} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
