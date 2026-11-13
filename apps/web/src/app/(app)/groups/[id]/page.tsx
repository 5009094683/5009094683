import type { Metadata } from 'next';
import { GroupDetailView } from '@/components/groups/group-detail';

export const metadata: Metadata = { title: 'Group' };

export default async function GroupPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <GroupDetailView groupId={id} />;
}
