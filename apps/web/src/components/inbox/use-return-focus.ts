'use client';

import { useEffect, useState } from 'react';

/**
 * Puts the keyboard back on whatever opened a dialog once the dialog has gone. The kit's
 * dialog is opened by a flag rather than by a trigger of its own, so when it closes it has
 * nowhere to send the keyboard and leaves it on nothing.
 *
 * Call it in the component that renders the dialog, which must be mounted when the dialog
 * opens and unmounted when it closes.
 */
export function useReturnFocus(): void {
  // Read while rendering: by the time an effect runs the dialog has taken the keyboard.
  const [opener] = useState(() =>
    typeof document === 'undefined' ? null : document.activeElement,
  );
  useEffect(
    () => () => {
      window.setTimeout(() => {
        // Only when the keyboard was left on nothing: what closed the dialog may have sent it
        // somewhere better.
        if (
          opener instanceof HTMLElement &&
          opener.isConnected &&
          document.activeElement === document.body
        ) {
          opener.focus();
        }
      }, 0);
    },
    [opener],
  );
}
