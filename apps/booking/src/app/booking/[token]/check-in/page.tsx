import type { Metadata } from 'next';
import { CheckinView } from '@/components/checkin/checkin-view';
import { TooManyTries } from '@/components/too-many-tries';
import { brandStyle } from '@/lib/brand';
import { countriesWithFirst, countryName } from '@/lib/countries';
import { dateIn } from '@/lib/dates';
import { BUSY, forGuestPage, forGuestTitle } from '@/lib/guest-page';
import { getBooking, getCheckin } from '@/lib/server-api';

interface Props {
  params: Promise<{ token: string }>;
}

const metadata: Metadata = {
  title: 'Check in online',
  robots: { index: false, follow: false },
};

// The booking is asked for here too, and that request is shared with the page's own. It lets
// a link that does not work take the title of the page that says so, instead of this one's.
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { token } = await params;
  await forGuestTitle(getBooking(token));
  return metadata;
}

export default async function CheckinPage({ params }: Props) {
  const { token } = await params;
  const found = await forGuestPage(Promise.all([getCheckin(token), getBooking(token)]));
  if (found === BUSY) return <TooManyTries />;
  const [checkin, booking] = found;
  const { property } = booking;

  return (
    <div style={brandStyle(property.brandColor)}>
      <CheckinView
        token={token}
        checkin={checkin}
        bookedFor={booking.guestName}
        countries={countriesWithFirst(checkin.propertyCountry)}
        countryLabel={countryName(checkin.propertyCountry) ?? 'the country'}
        today={dateIn(property.timezone)}
        timezone={property.timezone}
        phone={property.phone}
        email={property.email}
      />
    </div>
  );
}
