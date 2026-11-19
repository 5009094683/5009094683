import type { Metadata } from 'next';
import { PaymentRequestView } from '@/components/booking/payment-request-view';
import { TooManyTries } from '@/components/too-many-tries';
import { brandStyle } from '@/lib/brand';
import { BUSY, forGuestPage, forGuestTitle } from '@/lib/guest-page';
import { getBooking, getPaymentRequest } from '@/lib/server-api';
import type { SearchParams } from '@/lib/stay';

interface Props {
  params: Promise<{ token: string; orderId: string }>;
  searchParams: Promise<SearchParams>;
}

const metadata: Metadata = {
  title: 'Payment request',
  robots: { index: false, follow: false },
};

// The request is asked for here too, and that asking is shared with the page's own. It lets
// a link that does not work take the title of the page that says so, instead of this one's.
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { token, orderId } = await params;
  await forGuestTitle(getPaymentRequest(token, orderId));
  return metadata;
}

export default async function PaymentRequestPage({ params, searchParams }: Props) {
  const [{ token, orderId }, query] = await Promise.all([params, searchParams]);
  const found = await forGuestPage(
    Promise.all([getPaymentRequest(token, orderId), getBooking(token)]),
  );
  if (found === BUSY) return <TooManyTries />;
  const [request, booking] = found;

  return (
    <div style={brandStyle(booking.property.brandColor)}>
      <PaymentRequestView
        token={token}
        orderId={orderId}
        request={request}
        phone={booking.property.phone}
        email={booking.property.email}
        timezone={booking.property.timezone}
        justPaid={query.paid === '1'}
        serverTime={Date.now()}
      />
    </div>
  );
}
