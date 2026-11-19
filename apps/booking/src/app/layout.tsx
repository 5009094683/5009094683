import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { SiteFooter, SiteHeader } from '@/components/site-chrome';
import { getOrganisationName } from '@/lib/server-api';
import './globals.css';

const FALLBACK_NAME = 'Book your stay';

export async function generateMetadata(): Promise<Metadata> {
  const name = (await getOrganisationName()) ?? FALLBACK_NAME;
  return {
    title: { default: name, template: `%s · ${name}` },
    description: `Book your stay with ${name}, directly with the property.`,
  };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#197b6e',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const name = (await getOrganisationName()) ?? FALLBACK_NAME;
  return (
    // Anchor links on a page scroll smoothly; this tells Next.js to jump, not glide, between pages.
    <html lang="en" data-scroll-behavior="smooth">
      <body className="flex min-h-dvh flex-col">
        <a
          href="#content"
          className="sr-only rounded-lg bg-surface px-4 py-3 font-medium text-ink shadow-pop focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50"
        >
          Skip to the content
        </a>
        <SiteHeader name={name} />
        <main id="content" className="flex-1">
          {children}
        </main>
        <SiteFooter name={name} />
      </body>
    </html>
  );
}
