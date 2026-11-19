/**
 * For the pages a guest lands on when they come back from the payment page,
 * which the payment gateway opens with `?paid=1` whether they paid or not.
 */

/** Pauses before asking again whether a payment has arrived: six seconds in all. */
const PAUSES_MS = [1500, 2000, 2500];

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });

/**
 * Asks what became of a payment. A payment can take a few seconds to register,
 * so while the answer is that it is still open, the question is put again a
 * few times before that answer is taken. A later try that fails ends the
 * asking: the last answer stands.
 */
export async function askAboutPayment<T>(
  ask: () => Promise<T>,
  stillOpen: (answer: T) => boolean,
): Promise<T> {
  let answer = await ask();
  for (const ms of PAUSES_MS) {
    if (!stillOpen(answer)) break;
    await pause(ms);
    try {
      answer = await ask();
    } catch {
      break;
    }
  }
  return answer;
}

/**
 * Takes `paid` out of the address without adding a step to the browser's
 * history, so that a reload shows the page rather than asking again.
 * `path` is the page the question was asked on: the guest may have moved on
 * while it was being answered, and another page's address is left alone.
 */
export function forgetPaymentReturn(path: string): void {
  const url = new URL(window.location.href);
  if (url.pathname !== path || !url.searchParams.has('paid')) return;
  url.searchParams.delete('paid');
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}
