import { useEffect } from 'react';

/**
 * Names the page for as long as it is being printed. A browser offers the page's title as the
 * file name when the page is saved as a PDF, and may print it at the top of the sheet: an
 * accountant filing invoices needs each one to carry its own number there.
 */
export function usePrintTitle(title: string | null): void {
  useEffect(() => {
    if (!title) return;
    let before: string | null = null;
    const start = () => {
      before = document.title;
      document.title = title;
    };
    const end = () => {
      // Left alone when the page has been given another title in the meantime.
      if (before !== null && document.title === title) document.title = before;
      before = null;
    };
    window.addEventListener('beforeprint', start);
    window.addEventListener('afterprint', end);
    return () => {
      end();
      window.removeEventListener('beforeprint', start);
      window.removeEventListener('afterprint', end);
    };
  }, [title]);
}
