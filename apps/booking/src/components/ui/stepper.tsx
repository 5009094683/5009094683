import { Minus, Plus } from 'lucide-react';
import { cn } from '@/lib/cn';

export interface StepperProps {
  id: string;
  label: string;
  /** What is counted, in the plural, for the buttons' names: "rooms". */
  noun: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  className?: string;
}

const STEP =
  'flex size-11 items-center justify-center rounded-lg text-ink hover:bg-sunken ' +
  'aria-disabled:cursor-not-allowed aria-disabled:text-line-strong aria-disabled:hover:bg-transparent';

/**
 * A small number chosen with minus and plus. At either end the button is
 * marked disabled rather than made so: a button that disables itself while it
 * has the focus would drop the focus.
 */
export function Stepper({ id, label, noun, value, min, max, onChange, className }: StepperProps) {
  const step = (by: number) => {
    const next = value + by;
    if (next >= min && next <= max) onChange(next);
  };
  return (
    <div
      role="group"
      aria-labelledby={`${id}-label`}
      className={cn('flex items-center gap-3', className)}
    >
      <span id={`${id}-label`} className="text-[15px] font-medium text-ink">
        {label}
      </span>
      <div className="flex items-center rounded-xl border border-line-strong bg-surface p-0.5">
        <button
          type="button"
          aria-label={`Fewer ${noun}`}
          aria-disabled={value <= min}
          onClick={() => step(-1)}
          className={STEP}
        >
          <Minus className="size-4" aria-hidden />
        </button>
        <output
          id={id}
          aria-live="polite"
          className="min-w-8 text-center text-base font-semibold text-ink tabular-nums"
        >
          {value}
        </output>
        <button
          type="button"
          aria-label={`More ${noun}`}
          aria-disabled={value >= max}
          onClick={() => step(1)}
          className={STEP}
        >
          <Plus className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
