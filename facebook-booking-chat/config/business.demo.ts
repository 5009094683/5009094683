/*
  SAMPLE settings for trying the assistant (`pnpm demo`) and for the tests.

  The models, tours, prices and capacities below are invented examples. They
  are not the company's price list: the real settings are in business.ts.
*/
import { defineBusiness } from '../src/business/schema';

const cancellation = { freeHours: 72, lateHours: 24, midChargePercent: 50 };

export default defineBusiness({
  company: {
    name: 'Cao Bằng Travel Guide',
    signature: 'Thu Hien',
    contacts: [
      { label: 'Zalo', value: '0914 674 724' },
      { label: 'WhatsApp', value: '+(84) 0352 476 994' },
    ],
    address: {
      en: '12 Sample Street, Cao Bằng City (example address)',
      vi: '12 phố Ví Dụ, TP. Cao Bằng (địa chỉ ví dụ)',
    },
  },
  payment: {
    methods: { en: ['cash', 'bank transfer'], vi: ['tiền mặt', 'chuyển khoản'] },
    instructions: {
      en: 'Bank transfer: Sample Bank, account 0000 000 000 (example).',
      vi: 'Chuyển khoản: Ngân hàng Ví Dụ, số tài khoản 0000 000 000 (ví dụ).',
    },
  },
  services: [
    {
      id: 'motorbike-rental',
      kind: 'rental',
      name: { en: 'Motorbike rental', vi: 'Thuê xe máy' },
      options: [
        {
          id: 'honda-wave',
          name: { en: 'Honda Wave 110 (semi-automatic)', vi: 'Honda Wave 110 (xe số)' },
          aliases: ['wave', 'semi-automatic', 'semi auto', 'xe số'],
          price: 150_000,
          capacity: 6,
        },
        {
          id: 'honda-vision',
          name: { en: 'Honda Vision (automatic)', vi: 'Honda Vision (xe ga)' },
          aliases: ['vision', 'automatic', 'scooter', 'xe ga'],
          price: 200_000,
          capacity: 4,
        },
        {
          id: 'honda-xr150',
          name: { en: 'Honda XR 150 (manual)', vi: 'Honda XR 150 (xe côn tay)' },
          aliases: ['xr', 'xr150', 'xr 150', 'manual', 'côn tay'],
          price: 400_000,
          capacity: 2,
        },
      ],
      included: {
        en: ['helmet', 'raincoat', 'copy of the vehicle papers'],
        vi: ['mũ bảo hiểm', 'áo mưa', 'bản sao giấy tờ xe'],
      },
      note: {
        en: 'Fuel is paid by the renter. A deposit or collateral is left with us at pick-up.',
        vi: 'Người thuê tự trả tiền xăng. Khi nhận xe, anh/chị để lại tiền cọc hoặc tài sản thế chấp.',
      },
      autoConfirm: true,
    },
    {
      id: 'tour-package',
      kind: 'tour',
      name: { en: 'Tour package', vi: 'Tour trọn gói' },
      options: [
        {
          id: 'ban-gioc-day',
          name: {
            en: 'Ban Gioc waterfall & Nguom Ngao cave (1 day)',
            vi: 'Thác Bản Giốc & động Ngườm Ngao (1 ngày)',
          },
          aliases: ['ban gioc', 'waterfall', 'nguom ngao', 'day tour', 'thác'],
          days: 1,
          price: 1_200_000,
          capacity: 12,
        },
        {
          id: 'cao-bang-loop',
          name: {
            en: 'Cao Bang loop (3 days 2 nights)',
            vi: 'Vòng cung Cao Bằng (3 ngày 2 đêm)',
          },
          aliases: ['loop', 'vòng cung', '3 days 2 nights', '3 ngày 2 đêm'],
          days: 3,
          price: 4_500_000,
          capacity: 8,
        },
      ],
      included: {
        en: ['transport', 'guide', 'meals', 'entrance tickets'],
        vi: ['xe đưa đón', 'hướng dẫn viên', 'các bữa ăn', 'vé tham quan'],
      },
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
          price: 1_300_000,
          capacity: 4,
        },
      ],
      included: {
        en: ['driver-guide', 'motorbike and fuel', 'helmet'],
        vi: ['tài xế kiêm hướng dẫn', 'xe máy và xăng', 'mũ bảo hiểm'],
      },
      depositPercent: 30,
      cancellation,
      autoConfirm: true,
    },
  ],
  faq: [
    {
      keywords: ['open', 'opening hours', 'mở cửa', 'giờ làm việc'],
      answer: {
        en: 'We are open every day from 7:00 to 21:00 (example).',
        vi: 'Chúng tôi mở cửa hằng ngày từ 7:00 đến 21:00 (ví dụ).',
      },
    },
  ],
});
