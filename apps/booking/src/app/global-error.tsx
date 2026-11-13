'use client';

import { useEffect } from 'react';

/**
 * Stands in for the whole document when the layout itself fails, so nothing
 * of the site's own styling can be counted on: the few styles are set here.
 */
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100dvh',
          display: 'grid',
          placeItems: 'center',
          padding: '24px',
          background: '#faf8f5',
          color: '#1d2327',
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif',
        }}
      >
        <title>This page could not be shown</title>
        <main role="alert" style={{ maxWidth: '32rem', textAlign: 'center' }}>
          <h1
            style={{
              margin: 0,
              fontFamily: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif',
              fontSize: '1.875rem',
              fontWeight: 400,
              lineHeight: 1.2,
            }}
          >
            This page could not be shown
          </h1>
          <p style={{ margin: '12px 0 0', fontSize: '1rem', lineHeight: 1.5, color: '#4c5760' }}>
            Something went wrong on our side. Please try again in a moment.
          </p>
          <button
            type="button"
            onClick={() => retry()}
            style={{
              marginTop: '28px',
              minHeight: '44px',
              padding: '8px 20px',
              border: 0,
              borderRadius: '8px',
              background: '#197b6e',
              color: '#ffffff',
              font: 'inherit',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
