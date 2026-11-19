import type { Metadata } from 'next';
import { UsersView } from '@/components/settings/users-view';

export const metadata: Metadata = { title: 'Users' };

export default function UsersPage() {
  return <UsersView />;
}
