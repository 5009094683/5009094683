/*
  SETTINGS of the booking assistant: who the company is, what can be booked,
  what it costs and on which terms.

  The assistant only says what is written here. Where a price is left as
  `null`, it tells the customer that the team will confirm the price, and the
  booking waits for a person to confirm it in the dashboard.

  After changing this file, restart the assistant (it checks every value on
  start and names the line that is wrong).

  Company name, contacts, the 30% deposit and the cancellation figures are the
  ones printed on the company's agreements (rental-agreement/config.js). Keep
  the two in step.
*/
import { defineBusiness } from '../src/business/schema';

// Tours and Easy Rider, counted in hours before the start:
//   freeHours or more before      -> everything paid is refunded
//   between the two               -> midChargePercent % of the total price is charged
//   less than lateHours before    -> 100% is charged
const cancellation = { freeHours: 72, lateHours: 24, midChargePercent: 50 };

export default defineBusiness({
  company: {
    name: 'Cao Bằng Travel Guide',

    // Signs the welcome and confirmation messages. Leave '' for no signature.
    signature: 'Thu Hien',

    // Given to customers who ask how to reach the team.
    contacts: [
      { label: 'Zalo', value: '0914 674 724' },
      { label: 'WhatsApp', value: '+(84) 0352 476 994' },
    ],

    // Optional. Leave '' and the assistant says the team will send the location.
    address: '',
    // Optional link to the place on a map.
    mapUrl: '',
  },

  timezone: 'Asia/Ho_Chi_Minh',

  // Used until the customer writes in English or Vietnamese.
  defaultLanguage: 'en',

  booking: {
    // Booking numbers look like CB-7K3FQ.
    codePrefix: 'CB',
    // How far ahead a booking may start, the longest booking, the largest group.
    // Anything beyond is passed to a person.
    maxAdvanceDays: 365,
    maxDays: 30,
    maxQuantity: 20,
    // Ask for a phone number (WhatsApp / Zalo) and for the pick-up place.
    // The customer may skip either.
    askPhone: true,
    askPickup: true,
  },

  payment: {
    methods: {
      en: ['cash', 'bank transfer'],
      vi: ['tiền mặt', 'chuyển khoản'],
    },
    // Optional: how to pay, for example the bank account for deposits.
    // Leave '' and the assistant says the team will send the payment details.
    // One wording for both languages, or { en: '...', vi: '...' }.
    instructions: '',
  },

  /*
    WHAT CAN BE BOOKED

    kind:        'rental'      the customer rides a rented motorbike   (price per motorbike per day)
                 'tour'        a tour package                           (price per person)
                 'easy_rider'  a passenger behind one of our drivers    (price per passenger per day)

    options:     the choices inside a service: motorbike models, tours, routes.
                 With a single option the assistant does not ask which one.
        name     shown to the customer; one wording, or { en: '...', vi: '...' }
        aliases  other words customers use for it, e.g. ['wave', 'semi-auto']
        price    in VND, plain digits. null = the team quotes the price.
        days     tours only: the length of the tour. Without it the assistant asks.
        capacity how many can be out on the same day (motorbikes, drivers, seats).
                 null = not known; a person checks availability.

    autoConfirm: true  -> the assistant confirms by itself while capacity is left.
                          Every option then needs a price and a capacity.
                 false -> the booking waits for a person to confirm it in the dashboard.

    depositPercent: deposit asked for in the confirmation message; 0 = none.
  */
  services: [
    {
      id: 'motorbike-rental',
      kind: 'rental',
      name: { en: 'Motorbike rental', vi: 'Thuê xe máy' },
      options: [
        // Replace with the real fleet, for example:
        //   { id: 'honda-wave', name: 'Honda Wave 110 (semi-automatic)', aliases: ['wave'], price: 150000, capacity: 6 },
        { id: 'motorbike', name: { en: 'Motorbike', vi: 'Xe máy' }, price: null, capacity: null },
      ],
      included: {
        en: ['helmet', 'raincoat', 'copy of the vehicle papers'],
        vi: ['mũ bảo hiểm', 'áo mưa', 'bản sao giấy tờ xe'],
      },
      note: {
        en: 'Fuel is paid by the renter. A deposit or collateral is left with us at pick-up.',
        vi: 'Người thuê tự trả tiền xăng. Khi nhận xe, anh/chị để lại tiền cọc hoặc tài sản thế chấp.',
      },
      depositPercent: 0,
      cancellation: null,
      autoConfirm: false,
    },
    {
      id: 'tour-package',
      kind: 'tour',
      name: { en: 'Tour package', vi: 'Tour trọn gói' },
      options: [
        // Replace with the real tours, for example:
        //   { id: 'ban-gioc-day', name: { en: 'Ban Gioc waterfall day tour', vi: 'Tour thác Bản Giốc 1 ngày' },
        //     aliases: ['ban gioc', 'waterfall'], days: 1, price: 1200000, capacity: 12 },
        { id: 'tour', name: { en: 'Tour', vi: 'Tour' }, price: null, capacity: null },
      ],
      depositPercent: 30,
      cancellation,
      autoConfirm: false,
    },
    {
      id: 'easy-rider',
      kind: 'easy_rider',
      name: { en: 'Easy Rider (motorbike with driver)', vi: 'Easy Rider (xe máy có tài xế)' },
      options: [
        {
          id: 'easy-rider',
          name: { en: 'Easy Rider', vi: 'Easy Rider' },
          price: null,
          capacity: null,
        },
      ],
      included: {
        en: ['driver-guide', 'motorbike', 'helmet'],
        vi: ['tài xế kiêm hướng dẫn', 'xe máy', 'mũ bảo hiểm'],
      },
      depositPercent: 30,
      cancellation,
      autoConfirm: false,
    },
  ],

  /*
    EXTRA QUESTIONS AND ANSWERS (optional)

    When a customer's message contains one of the keywords, the assistant
    answers with the text. Write keywords in lower case.

      {
        keywords: ['helmet', 'mũ bảo hiểm'],
        answer: { en: 'A helmet is included with every motorbike.', vi: 'Mỗi xe đều kèm mũ bảo hiểm.' },
      },
  */
  faq: [],
});
