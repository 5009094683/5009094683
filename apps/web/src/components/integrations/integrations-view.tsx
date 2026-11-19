'use client';

import { Plus } from 'lucide-react';
import { usePathname, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import useSWR from 'swr';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/field';
import { ErrorState, PageHeader, PageLoading } from '@/components/ui/misc';
import { useAuth } from '@/lib/auth';
import { useProperties } from '@/lib/hooks';
import { useLive } from '@/lib/live';
import { ApiKeysTab } from './api-keys-tab';
import { NoAccess } from './no-access';
import type { ApiKeysAnswer, WebhooksAnswer } from './types';
import { WebhooksTab } from './webhooks-tab';

type Tab = 'keys' | 'webhooks';

const TABS: { value: Tab; label: string }[] = [
  { value: 'keys', label: 'API keys' },
  { value: 'webhooks', label: 'Webhooks' },
];

function Integrations() {
  const pathname = usePathname();
  const params = useSearchParams();
  const tab: Tab = params.get('tab') === 'webhooks' ? 'webhooks' : 'keys';
  const keys = useSWR<ApiKeysAnswer>('/api-keys');
  const webhooks = useSWR<WebhooksAnswer>('/outbound-webhooks');
  const properties = useProperties();
  const [adding, setAdding] = useState<Tab | null>(null);

  // A webhook the system switches off after repeated failures is announced as an alert.
  useLive(/^alert\./, () => void webhooks.mutate());

  // The tab lives in the address, so a link to the webhooks opens on the webhooks. It is
  // written directly, not through the router: no request goes to the server for the page.
  const show = (next: Tab) => {
    setAdding(null);
    window.history.replaceState(null, '', next === 'keys' ? pathname : `${pathname}?tab=${next}`);
  };

  const error = keys.error ?? webhooks.error ?? properties.error;
  const loaded = keys.data && webhooks.data && !properties.isLoading;

  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      <PageHeader
        title="Integrations"
        description="How other systems work with this one: with an API key they ask, and through a webhook they are told when something changes."
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Segmented label="Part of integrations" value={tab} onChange={show} options={TABS} />
        {loaded && (
          <Button
            variant="primary"
            icon={<Plus className="size-4" />}
            onClick={() => setAdding(tab)}
          >
            {tab === 'keys' ? 'New API key' : 'Add webhook'}
          </Button>
        )}
      </div>

      {error && !loaded ? (
        <ErrorState
          error={error}
          onRetry={() => {
            void keys.mutate();
            void webhooks.mutate();
            void properties.mutate();
          }}
        />
      ) : !keys.data || !webhooks.data || properties.isLoading ? (
        <PageLoading label="Loading the integrations" />
      ) : tab === 'keys' ? (
        <ApiKeysTab
          data={keys.data}
          mutate={keys.mutate}
          properties={properties.properties}
          adding={adding === 'keys'}
          onAdd={() => setAdding('keys')}
          onAddingDone={() => setAdding(null)}
        />
      ) : (
        <WebhooksTab
          data={webhooks.data}
          mutate={webhooks.mutate}
          properties={properties.properties}
          adding={adding === 'webhooks'}
          onAdd={() => setAdding('webhooks')}
          onAddingDone={() => setAdding(null)}
        />
      )}
    </div>
  );
}

/** API keys and webhooks, for those who manage the organisation. */
export function IntegrationsView() {
  const auth = useAuth();
  if (!auth.can('org.manage')) return <NoAccess />;
  return (
    <Suspense fallback={<PageLoading />}>
      <Integrations />
    </Suspense>
  );
}
