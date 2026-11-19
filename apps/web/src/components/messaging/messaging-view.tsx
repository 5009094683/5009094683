'use client';

import { Plus } from 'lucide-react';
import { useState } from 'react';
import useSWR from 'swr';
import { NoAccess } from '@/components/settings/no-access';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/field';
import { ErrorState, PageHeader, PageLoading } from '@/components/ui/misc';
import { useAuth } from '@/lib/auth';
import { useProperties } from '@/lib/hooks';
import { useLive } from '@/lib/live';
import { LogTab } from './log-tab';
import { RulesTab } from './rules-tab';
import { TemplatesTab } from './templates-tab';
import type { AutomationsAnswer, TemplatesAnswer } from './types';

type Tab = 'rules' | 'templates' | 'log';

const TABS: { value: Tab; label: string }[] = [
  { value: 'rules', label: 'Automatic messages' },
  { value: 'templates', label: 'Templates' },
  { value: 'log', label: 'Log' },
];

/** What guests are sent automatically and the wording of it, for those who may see the inbox. */
export function MessagingView() {
  const auth = useAuth();
  const allowed = auth.can('inbox.read');
  const templates = useSWR<TemplatesAnswer>(allowed ? '/messaging/templates' : null);
  const automations = useSWR<AutomationsAnswer>(allowed ? '/messaging/automations' : null);
  const properties = useProperties();
  const [tab, setTab] = useState<Tab>('rules');
  const [adding, setAdding] = useState<'rule' | 'template' | null>(null);

  // A message going out is what adds to the log.
  useLive(/^message\./, () => void automations.mutate());

  if (!allowed) return <NoAccess />;

  const error = templates.error ?? automations.error ?? properties.error;
  const loaded = templates.data && automations.data && !properties.isLoading;
  const canAdd = auth.can('property.manage');
  const changed = () => {
    void templates.mutate();
    void automations.mutate();
  };

  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      <PageHeader
        title="Guest messages"
        description="The messages guests are sent automatically, and the wording of every message."
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Segmented label="Part of guest messages" value={tab} onChange={setTab} options={TABS} />
        {canAdd && loaded && tab !== 'log' && (
          <Button
            variant="primary"
            icon={<Plus className="size-4" />}
            onClick={() => setAdding(tab === 'rules' ? 'rule' : 'template')}
          >
            {tab === 'rules' ? 'New automatic message' : 'New template'}
          </Button>
        )}
      </div>

      {error && !loaded ? (
        <ErrorState
          error={error}
          onRetry={() => {
            changed();
            void properties.mutate();
          }}
        />
      ) : !templates.data || !automations.data || properties.isLoading ? (
        <PageLoading label="Loading the messages" />
      ) : tab === 'rules' ? (
        <RulesTab
          rules={automations.data.rules}
          templates={templates.data.templates}
          properties={properties.properties}
          adding={adding === 'rule'}
          onAddingDone={() => setAdding(null)}
          onChanged={changed}
        />
      ) : tab === 'templates' ? (
        <TemplatesTab
          templates={templates.data.templates}
          variables={templates.data.variables}
          rules={automations.data.rules}
          properties={properties.properties}
          adding={adding === 'template'}
          onAddingDone={() => setAdding(null)}
          onChanged={changed}
        />
      ) : (
        <LogTab log={automations.data.log} />
      )}
    </div>
  );
}
