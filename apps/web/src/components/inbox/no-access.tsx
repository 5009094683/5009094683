import { Lock } from 'lucide-react';
import { EmptyState } from '@/components/ui/misc';

export function NoAccess() {
  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      <EmptyState
        icon={<Lock className="size-5" />}
        title="You do not have access to this page"
        description="Ask an organisation admin if you need to read guest messages."
      />
    </div>
  );
}
