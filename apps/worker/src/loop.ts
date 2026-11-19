export interface LoopOptions {
  name: string;
  /** Longest pause between runs when nothing wakes the loop. */
  idleMs: number;
  /** Pause after a wake-up before running, so a burst of wake-ups becomes one run. */
  debounceMs?: number;
  onError(err: unknown): void;
}

/**
 * Runs one piece of work over and over, never overlapping with itself.
 *
 * The work returns how long it wants to sleep (or nothing, for the idle
 * pause). `wake()` cuts the sleep short; a wake-up that arrives while a run is
 * in progress causes exactly one more run afterwards, so no signal is lost
 * and none causes a pile-up.
 */
export class Loop {
  private timer: NodeJS.Timeout | null = null;
  private timerDueAt = Infinity;
  private current: Promise<void> | null = null;
  private again = false;
  private stopped = true;

  constructor(
    private readonly work: () => Promise<number | void>,
    private readonly options: LoopOptions,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  /** Asks for a run as soon as possible. */
  wake(): void {
    if (this.stopped) return;
    if (this.current) {
      this.again = true;
      return;
    }
    this.schedule(this.options.debounceMs ?? 0);
  }

  /** Runs the work now (waiting for a run in progress first). For tests and shutdown. */
  async runNow(): Promise<void> {
    while (this.current) await this.current;
    await this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.timerDueAt = Infinity;
    while (this.current) await this.current;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    const dueAt = Date.now() + delayMs;
    // An earlier timer already covers this request.
    if (this.timer && this.timerDueAt <= dueAt) return;
    if (this.timer) clearTimeout(this.timer);
    this.timerDueAt = dueAt;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.timerDueAt = Infinity;
      void this.run();
    }, delayMs);
  }

  private async run(): Promise<void> {
    if (this.current) {
      this.again = true;
      return;
    }
    let next: number | void = undefined;
    this.current = (async () => {
      try {
        next = await this.work();
      } catch (err) {
        this.options.onError(err);
      }
    })();
    await this.current;
    this.current = null;
    if (this.stopped) return;
    if (this.again) {
      this.again = false;
      this.schedule(this.options.debounceMs ?? 0);
      return;
    }
    const idle = this.options.idleMs;
    this.schedule(typeof next === 'number' ? Math.max(0, Math.min(next, idle)) : idle);
  }
}
