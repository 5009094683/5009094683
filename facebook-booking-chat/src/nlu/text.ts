import type { Lang } from '../business/schema';

/**
 * Lower case, Vietnamese tone and vowel marks removed, punctuation that only
 * decorates dropped, spaces collapsed. Matching is done on this form so that
 * "Thuê xe máy", "thue xe may" and "THUÊ  XE MÁY" are the same words.
 */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

export function words(folded: string): string[] {
  return folded.split(/[^a-z0-9']+/).filter(Boolean);
}

/** True when `phrase` occurs in `folded` as whole words. Both must be folded. */
export function hasPhrase(folded: string, phrase: string): boolean {
  if (phrase.length === 0) return false;
  let from = 0;
  for (;;) {
    const at = folded.indexOf(phrase, from);
    if (at === -1) return false;
    const before = at === 0 ? ' ' : folded.charAt(at - 1);
    const after = at + phrase.length >= folded.length ? ' ' : folded.charAt(at + phrase.length);
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
    from = at + 1;
  }
}

export function hasAnyPhrase(folded: string, phrases: readonly string[]): boolean {
  return phrases.some((phrase) => hasPhrase(folded, phrase));
}

// Letters that Vietnamese has and French, Spanish, German and the like do not.
const VIETNAMESE_LETTERS = /[ăđơưạảãậẩẫấầắằẳẵặẹẻẽếềểễệịỉĩọỏõốồổỗộớờởỡợụủũứừửữựỳỷỹỵ]/i;

// Written without marks, these still give Vietnamese away. Words that are also
// English ("can", "ban", "may", "to", "an") are left out on purpose.
// prettier-ignore
const VIETNAMESE_WORDS = new Set([
  'xin', 'chao', 'thue', 'nhieu', 'khong', 'nguoi', 'muon', 'duoc', 'ngay', 'gia', 'bao',
  'nhe', 'nha', 'toi', 'minh', 'dat', 'tien', 'coc', 'xe', 'cho', 'em', 'anh', 'chi',
  'oi', 'vang', 'da', 'cam', 'hom', 'nay', 'mai', 'thang', 'nhan', 'vien', 'gui', 'giup',
  'tu', 'den', 'ko', 'dc', 'nhiu', 'bn', 'ok', 'huy', 'doi', 'lich', 'dung', 'roi',
]);

// prettier-ignore
const ENGLISH_WORDS = new Set([
  'the', 'is', 'are', 'how', 'much', 'i', 'we', 'you', 'want', 'would', 'like', 'to', 'book',
  'rent', 'for', 'days', 'day', 'people', 'please', 'hi', 'hello', 'hey', 'price', 'what',
  'when', 'where', 'do', 'does', 'have', 'need', 'my', 'our', 'your', 'and', 'from', 'with',
  'thanks', 'thank', 'yes', 'no', 'a', 'an', 'of', 'on', 'in', 'it', 'can', 'tomorrow',
  'today', 'bike', 'motorbike', 'tour', 'me', 'us', 'there', 'this', 'that', 'not', 'ok',
]);

/**
 * The language a message is written in, or null when the message does not say
 * (a number, a date, a name). The caller then keeps the language it had.
 */
export function detectLanguage(text: string): Lang | null {
  if (VIETNAMESE_LETTERS.test(text)) return 'vi';

  const tokens = words(fold(text));
  if (tokens.length === 0) return null;

  let vietnamese = 0;
  let english = 0;
  for (const token of new Set(tokens)) {
    const isVi = VIETNAMESE_WORDS.has(token);
    const isEn = ENGLISH_WORDS.has(token);
    if (isVi && !isEn) vietnamese += 1;
    if (isEn && !isVi) english += 1;
  }

  if (vietnamese > english && (vietnamese >= 2 || tokens.length <= 3)) return 'vi';
  if (english > vietnamese && (english >= 2 || tokens.length <= 3)) return 'en';
  return null;
}
