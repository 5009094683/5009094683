'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/misc';
import { plural } from '@/lib/format';
import type { Property } from '@/lib/types';
import { AmenitiesEditor } from './amenities-editor';
import { ColourField } from './colour-field';
import {
  FormSection,
  Item,
  Items,
  LongText,
  LongTextField,
  SettingsCard,
  SettingsDialog,
  tooLong,
} from './parts';
import { PhotoThumbnail, PhotosEditor } from './photos-editor';
import { useSettingsForm, type Reading } from './use-settings-form';
import {
  LIMITS,
  hexColour,
  onWebsite,
  websiteShowsPhoto,
  websiteUsesColour,
  type Settings,
} from './values';

const PHOTOS_SHOWN = 6;
const AMENITIES_SHOWN = 12;

/** The amenities as the website lists them. A long list is shown by its start, with a way to the rest. */
function AmenityBadges({ amenities }: { amenities: string[] }) {
  const [open, setOpen] = useState(false);
  const shown = open ? amenities : amenities.slice(0, AMENITIES_SHOWN);
  return (
    <>
      <ul className="my-1 flex flex-wrap gap-1.5">
        {shown.map((name, index) => (
          <li key={`${name}-${index}`} className="flex max-w-full">
            <Badge className="max-w-full whitespace-normal">{name}</Badge>
          </li>
        ))}
      </ul>
      {amenities.length > AMENITIES_SHOWN && (
        <button
          type="button"
          aria-expanded={open}
          className="mt-1 text-[13px] font-medium text-brand-700 hover:underline"
          onClick={() => setOpen(!open)}
        >
          {open ? 'Show less' : `Show all ${amenities.length}`}
        </button>
      )}
    </>
  );
}

function PhotoStrip({ photos }: { photos: string[] }) {
  const shown = photos.slice(0, PHOTOS_SHOWN);
  return (
    <ul className="my-1 flex flex-wrap items-center gap-1.5">
      {shown.map((address, index) => (
        <li key={`${index}:${address}`} className="flex">
          <PhotoThumbnail address={address} className="h-12 w-16" />
        </li>
      ))}
      {photos.length > shown.length && (
        <li className="pl-1 text-[13px] text-ink-soft">and {photos.length - shown.length} more</li>
      )}
    </ul>
  );
}

function photosNote(photos: string[]): string {
  const leftOut = photos.filter((address) => !websiteShowsPhoto(address)).length;
  return [
    `${plural(photos.length, 'photo')}.`,
    photos.length > 1 && 'The first is the main photo.',
    leftOut === 1 && 'One is not a photo on the web, so the website leaves it out.',
    leftOut > 1 && `${leftOut} are not photos on the web, so the website leaves them out.`,
  ]
    .filter(Boolean)
    .join(' ');
}

/** What the website says about the property, and the house rules guests accept. */
export function GuestContentCard({
  property,
  onEdit,
}: {
  property: Property;
  onEdit?: () => void;
}) {
  const { settings } = property;
  const description = settings.description?.trim() ?? '';
  const terms = settings.bookingTerms?.trim() ?? '';
  const amenities = settings.amenities ?? [];
  const photos = settings.photos ?? [];
  const colour = settings.brandColor?.trim() ?? '';
  return (
    <SettingsCard title="What guests read" onEdit={onEdit}>
      <p className="text-sm text-ink-soft">
        {onWebsite(property)
          ? 'Guests read these on the property’s page on the website. They accept the house rules when they book there and when they check in online.'
          : 'This property is not on the website, where guests would read these. They still accept the house rules when they check in online.'}
      </p>
      <Items className="mt-3">
        <Item label="Description" className="sm:col-span-2">
          {description && <LongText text={description} />}
        </Item>
        <Item label="Amenities" empty="None listed" className="sm:col-span-2">
          {amenities.length > 0 && <AmenityBadges amenities={amenities} />}
        </Item>
        <Item
          label="Photos"
          empty="None"
          note={photos.length > 0 ? photosNote(photos) : null}
          className="sm:col-span-2"
        >
          {photos.length > 0 && <PhotoStrip photos={photos} />}
        </Item>
        <Item label="House rules and booking terms" className="sm:col-span-2">
          {terms && <LongText text={terms} />}
        </Item>
        <Item
          label="Colour of buttons and links"
          empty="The website’s own colour"
          note={
            colour && !websiteUsesColour(colour)
              ? 'The website cannot use this, and shows its own colour.'
              : null
          }
          className="sm:col-span-2"
        >
          {colour &&
            (websiteUsesColour(colour) ? (
              <span className="inline-flex items-center gap-2">
                <span
                  aria-hidden
                  className="size-4 rounded border border-line-strong"
                  style={{ backgroundColor: colour }}
                />
                <span className="font-mono text-[13px]">{colour}</span>
              </span>
            ) : (
              colour
            ))}
        </Item>
      </Items>
    </SettingsCard>
  );
}

interface Values {
  description: string;
  amenities: string[];
  /** In the box for adding an amenity, and not in the list. */
  amenityTyped: string;
  photos: string[];
  /** In the box for adding a photo, and not in the list. */
  photoTyped: string;
  terms: string;
  colour: string;
}

type Body = Required<
  Pick<Settings, 'description' | 'amenities' | 'photos' | 'bookingTerms' | 'brandColor'>
>;

type Problem = 'description' | 'amenities' | 'photos' | 'terms' | 'colour';

function valuesFrom(settings: Settings): Values {
  return {
    description: settings.description ?? '',
    amenities: settings.amenities ?? [],
    amenityTyped: '',
    photos: settings.photos ?? [],
    photoTyped: '',
    terms: settings.bookingTerms ?? '',
    colour: settings.brandColor ?? '',
  };
}

const NOT_ADDED = 'This is not in the list yet. Put it right and add it, or empty the box.';

function read(values: Values, settings: Settings): Reading<Body, Problem> {
  const problems: Reading<Body, Problem>['problems'] = {};
  const description = tooLong(values.description, LIMITS.description);
  if (description) problems.description = description;
  const terms = tooLong(values.terms, LIMITS.bookingTerms);
  if (terms) problems.terms = terms;
  if (values.amenityTyped.trim() !== '') problems.amenities = NOT_ADDED;
  if (values.photoTyped.trim() !== '') problems.photos = NOT_ADDED;

  // A colour that was not touched stays as it is saved, whatever it is.
  const saved = settings.brandColor ?? '';
  let brandColor = saved;
  if (values.colour !== saved) {
    const typed = values.colour.trim();
    const colour = hexColour(typed);
    if (typed !== '' && !colour) {
      problems.colour =
        'This is not the code of a colour. A code is # and six letters or digits, such as #1f6f8b. Or pick the colour with the button beside the code.';
    }
    brandColor = colour ?? typed;
  }

  return {
    problems,
    body: {
      // There is no taking a setting away again: an empty text or list is how it is cleared.
      description: values.description.trim(),
      amenities: values.amenities,
      photos: values.photos,
      bookingTerms: values.terms.trim(),
      brandColor,
    },
  };
}

export function GuestContentDialog({
  property,
  onClose,
}: {
  property: Property;
  onClose: () => void;
}) {
  const { settings } = property;
  const form = useSettingsForm<Values, Body, Problem>({
    property,
    start: () => valuesFrom(settings),
    read: (values) => read(values, settings),
    saved: () => ({ message: 'What guests read is saved' }),
    onClose,
  });
  const { values, change, problems } = form;

  return (
    <SettingsDialog
      title="What guests read"
      description={`How ${property.name} is shown on the website, and the house rules guests accept.`}
      form={form}
      onClose={onClose}
    >
      <FormSection title="About the property">
        <LongTextField
          label="Description"
          hint={`Shown under “About ${property.name}” on the property’s page. The list of properties shows its first two lines.`}
          value={values.description}
          onChange={(description) => change({ description })}
          limit={LIMITS.description}
          className="sm:col-span-2"
        />
      </FormSection>

      <FormSection title="Amenities">
        <p className="text-[13px] text-ink-soft sm:col-span-2">
          Listed on the property’s page, each with a small picture where the website has one for it.
          Also used for suggested replies in the inbox.
        </p>
        <AmenitiesEditor
          value={values.amenities}
          onChange={(amenities) => change({ amenities })}
          typed={values.amenityTyped}
          onTyped={(amenityTyped) => change({ amenityTyped })}
          error={problems.amenities}
        />
      </FormSection>

      <FormSection title="Photos">
        <p className="text-[13px] text-ink-soft sm:col-span-2">
          Photos cannot be uploaded here. A photo has to be on the web already, on your own website
          or with a photo service, and what you add here is its address. The first photo is the main
          one: the large photo on the property’s page, and the one in the list of properties.
        </p>
        <PhotosEditor
          value={values.photos}
          onChange={(photos) => change({ photos })}
          typed={values.photoTyped}
          onTyped={(photoTyped) => change({ photoTyped })}
          error={problems.photos}
        />
      </FormSection>

      <FormSection title="House rules">
        <LongTextField
          label="House rules and booking terms"
          hint="Guests accept these when they book on the website and when they check in online. Also used for suggested replies in the inbox."
          value={values.terms}
          onChange={(terms) => change({ terms })}
          limit={LIMITS.bookingTerms}
          rows={6}
          className="sm:col-span-2"
        />
      </FormSection>

      <FormSection title="Colour">
        <ColourField
          value={values.colour}
          onChange={(colour) => change({ colour })}
          saved={settings.brandColor ?? ''}
          error={problems.colour}
          className="sm:col-span-2"
        />
      </FormSection>
    </SettingsDialog>
  );
}
