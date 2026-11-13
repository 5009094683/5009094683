import type { Metadata } from 'next';
import { BookingView } from '@/components/booking/booking-view';
import { TooManyTries } from '@/components/too-many-tries';
import { brandStyle } from '@/lib/brand';
import { BUSY, forGuestPage, forGuestTitle } from '@/lib/guest-page';
import { getBooking, getProperty } from '@/lib/server-api';
import type { SearchParams } from '@/lib/stay';

interface Props {
  params: Promise<{ token: string }>;
  searchParams: Promise<SearchParams>;
}

const metadata: Metadata = {
  title: 'Your booking',
  robots: { index: false, follow: false },
};

// The booking is asked for here too, and that request is shared with the page's own. It lets
// a link that does not work take the title of the page that says so, instead of this one's.
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { token } = await params;
  await forGuestTitle(getBooking(token));
  return metadata;
}

export default async function BookingPage({ params, searchParams }: Props) {
  const [{ token }, query] = await Promise.all([params, searchParams]);
  const booking = await forGuestPage(getBooking(token));
  if (booking === BUSY) return <TooManyTries />;
  // A link is given out for every booking, also at a property that takes no bookings on this
  // website. Such a property has no page here, and nothing on this page may lead to one.
  const propertyOnWebsite = await getProperty(booking.property.code).then(Boolean, () => false);

  return (
    <div style={brandStyle(booking.property.brandColor)}>
      <BookingView
        token={token}
        booking={booking}
        justPaid={query.paid === '1'}
        serverTime={Date.now()}
        propertyOnWebsite={propertyOnWebsite}
      />
    </div>
  );
}
