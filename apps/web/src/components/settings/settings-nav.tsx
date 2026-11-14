'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { PageLoading } from '@/components/ui/misc';
import { cn } from '@/lib/cn';
import { useSettingsSections } from './sections';

/** Settings sections: a tab strip on small screens, a list beside the page on wide ones. */
export function SettingsNav() {
  const pathname = usePathname();
  const sections = useSettingsSections();
  const current = useRef<HTMLAnchorElement>(null);

  // On a narrow screen the strip scrolls sideways, and the open section may start out of view.
  useEffect(() => {
    current.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [pathname]);

  return (
    <div className="shrink-0 border-b border-line bg-surface lg:w-52 lg:border-b-0 lg:bg-transparent">
      <nav
        aria-label="Settings"
        className="scrollbar-thin flex gap-1 overflow-x-auto px-2 sm:px-4 lg:sticky lg:top-0 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:py-6 lg:pr-0 lg:pl-4"
      >
        <p className="hidden px-2.5 pb-2 text-xs font-semibold tracking-wide text-ink-faint uppercase lg:block">
          Settings
        </p>
        {sections.map((section) => {
          const active = pathname === section.href || pathname.startsWith(`${section.href}/`);
          const Icon = section.icon;
          return (
            <Link
              key={section.href}
              href={section.href}
              ref={active ? current : undefined}
              aria-current={active ? 'page' : undefined}
              className={cn(
                '-mb-px flex shrink-0 items-center gap-2.5 border-b-2 px-3 py-2.5 text-sm font-medium whitespace-nowrap transition-colors',
                'lg:mb-0 lg:rounded-md lg:border-b-0 lg:px-2.5 lg:py-2',
                active
                  ? 'border-brand-600 text-brand-700 lg:bg-surface lg:shadow-card'
                  : 'border-transparent text-ink-soft hover:text-ink lg:hover:bg-sunken',
              )}
            >
              <Icon
                className={cn(
                  'hidden size-4 shrink-0 lg:block',
                  active ? 'text-brand-600' : 'text-ink-faint',
                )}
                aria-hidden
              />
              {section.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

/** Sends `/settings` to the first section the user may open. */
export function SettingsRedirect() {
  const router = useRouter();
  const sections = useSettingsSections();
  const first = sections[0]?.href;
  useEffect(() => {
    if (first) router.replace(first);
  }, [router, first]);
  return <PageLoading />;
}
