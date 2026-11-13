'use client';

import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Button, buttonClass } from '@/components/ui/button';
import { Stepper } from '@/components/ui/stepper';
import { cn } from '@/lib/cn';
import { count, formatMoney } from '@/lib/format';

interface Selection {
  selected: string | null;
  select: (id: string) => void;
}

const SelectionContext = createContext<Selection | null>(null);

/** Holds which rate the guest has picked: one at a time across all the rooms on the page. */
export function RateSelection({ children }: { children: ReactNode }) {
  const [selected, setSelected] = useState<string | null>(null);
  const value = useMemo(() => ({ selected, select: setSelected }), [selected]);
  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

export interface RateActionProps {
  /** Unique on the page: the room and the rate together. */
  id: string;
  /** For the button's name: "Standard Room, Flexible". */
  name: string;
  /** Rooms of this kind free on every night of the stay. */
  available: number;
  /** The most rooms one booking can take. */
  limit: number;
  /** For one room, with tax. */
  total: number;
  payNow: number;
  currency: string;
  /** The booking form for this room and rate, without the number of rooms. */
  href: string;
}

/**
 * "Select" on a rate; once selected, how many rooms and the way on to the
 * booking form. Where only one is free there is nothing to count, and the
 * stepper is left out.
 */
export function RateAction({
  id,
  name,
  available,
  limit,
  total,
  payNow,
  currency,
  href,
}: RateActionProps) {
  const selection = useContext(SelectionContext);
  const [rooms, setRooms] = useState(1);
  const proceed = useRef<HTMLAnchorElement>(null);
  const justSelected = useRef(false);
  const isSelected = selection?.selected === id;
  const most = Math.max(1, Math.min(limit, available));

  // "Select" is replaced by this panel, which would drop the focus: hand it to the way on.
  useEffect(() => {
    if (isSelected && justSelected.current) {
      justSelected.current = false;
      proceed.current?.focus();
    }
  }, [isSelected]);

  if (!isSelected) {
    return (
      <Button
        aria-label={`Select ${name}`}
        className="w-full sm:w-auto sm:min-w-28"
        onClick={() => {
          justSelected.current = true;
          selection?.select(id);
        }}
      >
        Select
      </Button>
    );
  }

  return (
    <div className="flex w-full flex-col gap-3 rounded-xl border border-brand-200 bg-brand-50 p-3 sm:w-64">
      {most > 1 ? (
        <>
          <Stepper
            id={`rooms-${id}`}
            label="Rooms"
            noun="rooms"
            value={rooms}
            min={1}
            max={most}
            onChange={setRooms}
            className="justify-between"
          />
          <p aria-live="polite" className="text-sm text-ink-soft">
            {rooms > 1 ? (
              <>
                {count(rooms, 'room')}:{' '}
                <span className="font-semibold text-ink">
                  {formatMoney(total * rooms, currency)}
                </span>{' '}
                total
                {payNow > 0 && payNow < total
                  ? `, ${formatMoney(payNow * rooms, currency)} to pay now`
                  : ''}
              </>
            ) : (
              `You can book up to ${most} at once.`
            )}
          </p>
        </>
      ) : null}
      <Link
        ref={proceed}
        href={`${href}&rooms=${rooms}`}
        prefetch={false}
        className={cn(buttonClass('primary'), 'w-full')}
      >
        Continue
        <ArrowRight className="size-4" aria-hidden />
      </Link>
    </div>
  );
}
