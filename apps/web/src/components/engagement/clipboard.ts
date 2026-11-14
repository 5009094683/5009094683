/**
 * Puts text on the clipboard. False when the browser will not allow it: on a plain-HTTP address,
 * or when the person has refused access. The caller then shows the text to be copied by hand.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
