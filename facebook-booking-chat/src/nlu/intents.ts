import { hasAnyPhrase } from './text';

export type Intent =
  | 'greeting'
  | 'human'
  | 'book'
  | 'services'
  | 'price'
  | 'included'
  | 'payment'
  | 'cancel_policy'
  | 'documents'
  | 'contact'
  | 'location'
  | 'status'
  | 'cancel_booking'
  | 'change_booking'
  | 'thanks'
  | 'bye';

/*
  What customers say, written in lower case and without Vietnamese marks (the
  message is folded the same way before it is compared). Each entry must match
  as whole words: 'gia' matches "giá bao nhiêu" but not "giao".
*/
// prettier-ignore
const PHRASES: Record<Exclude<Intent, 'greeting'>, string[]> = {
  human: [
    'human', 'real person', 'a person', 'staff', 'agent', 'operator', 'talk to', 'speak to',
    'speak with', 'talk with', 'call me', 'customer service',
    'nhan vien', 'nguoi that', 'gap nguoi', 'tu van vien', 'noi chuyen voi', 'goi cho toi',
    'goi lai', 'goi cho minh', 'goi cho em', 'chu shop', 'gap chu',
  ],
  book: [
    'book', 'booking', 'reserve', 'reservation', 'i want', 'i would like', "i'd like", 'we want',
    'we would like', "we'd like", 'can i rent', 'can we rent', 'can i book', 'can we book',
    'looking for', 'interested in', 'sign up',
    'dat xe', 'dat tour', 'dat cho', 'dat truoc', 'muon dat', 'muon thue', 'can thue', 'muon di',
    'dang ky', 'cho minh dat', 'cho em dat', 'cho toi dat', 'cho minh thue', 'cho em thue',
  ],
  services: [
    'what do you offer', 'what do you have', 'services', 'what can i book', 'your options',
    'menu', 'dich vu', 'co nhung gi', 'co dich vu gi',
  ],
  price: [
    'price', 'prices', 'pricing', 'how much', 'cost', 'costs', 'rate', 'rates', 'fee', 'fees',
    'quote', 'price list', 'gia', 'bao nhieu', 'bao nhiu', 'bn', 'phi', 'bang gia', 'gia ca',
    'gia thue', 'nhieu tien', 'bnhieu',
  ],
  included: [
    'include', 'includes', 'included', 'including', 'come with', 'comes with', 'bao gom',
    'gom nhung gi', 'gom gi', 'kem theo', 'co kem',
  ],
  payment: [
    'deposit', 'pay', 'payment', 'paying', 'bank', 'transfer', 'cash', 'card', 'credit card',
    'paypal', 'coc', 'dat coc', 'tien coc', 'thanh toan', 'chuyen khoan', 'tien mat', 'tra truoc',
  ],
  cancel_policy: [
    'cancellation', 'cancel policy', 'refund', 'refunds', 'refundable', 'if i cancel',
    'if we cancel', 'can i cancel', 'can we cancel', 'chinh sach huy', 'hoan tien', 'neu huy',
    'co duoc huy', 'huy co mat', 'huy co duoc',
  ],
  documents: [
    'licence', 'license', 'passport', 'document', 'documents', 'id card', 'papers', 'bang lai',
    'giay to', 'ho chieu', 'cmnd', 'cccd', 'can cuoc', 'giay phep',
  ],
  contact: [
    'phone number', 'your number', 'your phone', 'whatsapp', 'zalo', 'contact', 'hotline',
    'so dien thoai', 'sdt', 'lien he', 'so zalo',
  ],
  location: [
    'where are you', 'where is your', 'where do i', 'where can i', 'address', 'location',
    'located', 'find you', 'dia chi', 'o dau', 'cho nao', 'ban do', 'map',
  ],
  status: [
    'my booking', 'my reservation', 'our booking', 'our reservation', 'booking status',
    'is it confirmed', 'confirmed yet', 'been confirmed', 'don cua toi', 'don cua minh',
    'don cua em', 'booking cua toi', 'booking cua minh', 'booking cua em', 'dat cho cua toi',
    'xac nhan chua', 'tinh trang don', 'tinh trang booking',
  ],
  cancel_booking: [
    'cancel my booking', 'cancel the booking', 'cancel booking', 'cancel our booking',
    'cancel my reservation', 'cancel my tour', 'cancel my rental', 'cancel my trip',
    'want to cancel', 'need to cancel', 'have to cancel', 'like to cancel',
    'huy dat', 'huy don', 'huy booking', 'huy tour', 'huy xe', 'huy chuyen', 'muon huy', 'can huy',
    'xin huy',
  ],
  change_booking: [
    'change my booking', 'change the booking', 'change our booking', 'change my reservation',
    'change the date', 'change the dates', 'change my date', 'reschedule', 'postpone',
    'move my booking', 'doi ngay', 'doi lich', 'doi booking', 'doi don', 'lui ngay', 'hoan lai',
    'doi chuyen',
  ],
  thanks: ['thanks', 'thank you', 'thank u', 'thank', 'thx', 'tks', 'cam on', 'cam on nhieu'],
  bye: ['bye', 'goodbye', 'see you', 'tam biet', 'hen gap lai'],
};

const GREETING =
  /^(?:hi+|hello+|helo|hallo|hey+|yo|good (?:morning|afternoon|evening)|xin chao|chao|alo+|hi there)(?![a-z])/;

/** Everything a message asks for or says. A message may carry several. */
export function detectIntents(folded: string): Set<Intent> {
  const intents = new Set<Intent>();
  if (GREETING.test(folded)) intents.add('greeting');
  // "gia đình" (family) folds to the same letters as "giá" (price).
  const text = folded.replace(/(?<![a-z])gia dinh(?![a-z])/g, 'family');
  for (const [intent, phrases] of Object.entries(PHRASES) as Array<[Intent, string[]]>) {
    if (hasAnyPhrase(text, phrases)) intents.add(intent);
  }

  // "Cancel my booking" is a request about a booking, not a question about the terms.
  if (intents.has('cancel_booking')) intents.delete('cancel_policy');
  // "My booking", "change my booking": about an existing booking, not a wish for a new one.
  if (intents.has('status') || intents.has('cancel_booking') || intents.has('change_booking')) {
    intents.delete('book');
  }
  // "Cancel my booking" asks for more than where the booking stands.
  if (intents.has('cancel_booking') || intents.has('change_booking')) intents.delete('status');
  return intents;
}

function bare(folded: string): string {
  return folded
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// prettier-ignore
const YES = new Set([
  'yes', 'y', 'yep', 'yeah', 'yup', 'ya', 'yes please', 'ok', 'okay', 'okie', 'oke', 'oki',
  'sure', 'correct', 'right', 'confirm', 'confirmed', 'i confirm', 'perfect', 'great', 'good',
  'fine', 'go ahead', 'book it', 'please do', 'sounds good', 'looks good', 'all good',
  'all correct', "that's right", 'that is right', "that's correct", 'that is correct',
  'co', 'dung', 'dung roi', 'dung vay', 'chinh xac', 'duoc', 'dong y', 'xac nhan', 'chuan',
  'vang', 'da', 'da vang', 'u', 'uh', 'um', 'uhm', 'chot', 'chot don', 'dat di', 'dat luon',
]);
// prettier-ignore
const YES_LEAD = /^(?:yes|yep|yeah|yup|ok|okay|oke|sure|correct|confirm|dung|duoc|dong y|xac nhan|vang|da|chot)(?![a-z])/;
const YES_SPOILER =
  /(?<![a-z])(?:no|not|but|change|except|wrong|instead|wait|khong|ko|nhung|doi|sai|khoan|chua)(?![a-z])/;

// prettier-ignore
const NO = new Set([
  'no', 'n', 'nope', 'nah', 'not yet', 'wrong', 'incorrect', 'not correct', 'not right',
  "that's wrong", 'no thanks', 'no thank you',
  'khong', 'ko', 'sai', 'chua', 'chua dung', 'khong dung', 'khong phai', 'sai roi',
]);

// prettier-ignore
const SKIP = new Set([
  'skip', 'none', 'no', 'nope', 'no phone', 'no number', 'n a', 'na', 'nothing', "don't have",
  'dont have', "i don't have", 'no thanks', 'not now', 'later', 'pass', 'not sure', "don't know",
  'bo qua', 'khong co', 'ko co', 'khong', 'ko', 'chua co', 'chua biet', 'de sau',
]);

// prettier-ignore
const ABORT = new Set([
  'cancel', 'cancel it', 'cancel that', 'stop', 'never mind', 'nevermind', 'forget it',
  'start over', 'start again', 'restart', 'reset',
  'thoi', 'huy', 'huy bo', 'bo di', 'thoi khong can', 'khong dat nua', 'dat lai tu dau', 'lam lai',
]);

/** "Yes", "ok, book it", "đúng rồi", a thumbs-up. Not "yes but change the date". */
export function isYes(folded: string, original = ''): boolean {
  const text = bare(folded);
  if (text === '') return /[\u{1F44D}\u{1F44C}\u{2705}]/u.test(original);
  if (YES.has(text)) return true;
  return YES_LEAD.test(text) && text.split(' ').length <= 4 && !YES_SPOILER.test(text);
}

export function isNo(folded: string): boolean {
  return NO.has(bare(folded));
}

/** The customer declines to give an optional detail. */
export function isSkip(folded: string): boolean {
  return SKIP.has(bare(folded));
}

/** The customer drops the booking being put together. */
export function isAbort(folded: string): boolean {
  return ABORT.has(bare(folded));
}
