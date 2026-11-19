import {
  AirVent,
  Bath,
  BedDouble,
  Car,
  Check,
  ChefHat,
  Coffee,
  ConciergeBell,
  Dumbbell,
  Flower2,
  Laptop,
  type LucideIcon,
  PawPrint,
  Plane,
  Refrigerator,
  Sparkles,
  SquareParking,
  Sunrise,
  Trees,
  Tv,
  Umbrella,
  Utensils,
  WashingMachine,
  Waves,
  Wifi,
  Wine,
} from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * Amenities are free text typed by the property. An icon is given where a
 * word in the text makes the meaning plain; everything else gets a tick.
 * The first match wins, so the narrower words come first.
 */
const ICONS: [RegExp, LucideIcon][] = [
  [/wi-?fi|internet/, Wifi],
  [/pool|jacuzzi|hot tub/, Waves],
  [/breakfast|coffee|tea\b/, Coffee],
  [/air.?con|a\/c\b|\bac\b/, AirVent],
  [/airport|transfer|shuttle/, Plane],
  [/parking/, SquareParking],
  [/restaurant|dining|meals?\b/, Utensils],
  [/bar\b|wine|minibar/, Wine],
  [/cook|chef|kitchen/, ChefHat],
  [/fridge|refrigerator/, Refrigerator],
  [/beach|towel|umbrella/, Umbrella],
  [/housekeeping|cleaning|cleaned/, Sparkles],
  [/laundry|washing/, WashingMachine],
  [/garden|lawn|trees?\b/, Trees],
  [/\btv\b|television/, Tv],
  [/gym|fitness/, Dumbbell],
  [/spa\b|massage|yoga/, Flower2],
  [/view|balcony|terrace|veranda/, Sunrise],
  [/bath|shower/, Bath],
  [/pets?\b|dogs?\b/, PawPrint],
  [/desk|workspace/, Laptop],
  [/bed\b|linen/, BedDouble],
  [/car\b|taxi|scooter|bike/, Car],
  [/reception|concierge|front desk|room service/, ConciergeBell],
];

function iconFor(amenity: string): LucideIcon {
  const text = amenity.toLowerCase();
  return ICONS.find(([words]) => words.test(text))?.[1] ?? Check;
}

export interface AmenityListProps {
  items: readonly string[];
  /** `compact` is a wrapping line of small items, for a room; the default is a grid, for a property. */
  compact?: boolean;
  className?: string;
}

export function AmenityList({ items, compact = false, className }: AmenityListProps) {
  if (items.length === 0) return null;
  return (
    <ul
      className={cn(
        compact
          ? 'flex flex-wrap gap-x-4 gap-y-1.5 text-sm text-ink-soft'
          : 'grid grid-cols-1 gap-x-6 gap-y-3 text-[15px] text-ink min-[420px]:grid-cols-2 lg:grid-cols-3',
        className,
      )}
    >
      {items.map((amenity, index) => {
        const Icon = iconFor(amenity);
        return (
          <li key={`${index}:${amenity}`} className="flex items-center gap-2">
            <Icon
              className={cn('shrink-0 text-ink-faint', compact ? 'size-4' : 'size-5')}
              aria-hidden
            />
            <span>{amenity}</span>
          </li>
        );
      })}
    </ul>
  );
}
