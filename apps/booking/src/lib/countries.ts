import 'server-only';

export interface Country {
  /** ISO 3166-1 alpha-2, the form the API takes. */
  code: string;
  name: string;
}

const CODES =
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS ' +
  'BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE ' +
  'EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM ' +
  'HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC ' +
  'LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA ' +
  'NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW ' +
  'SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO ' +
  'TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW';

let cached: Country[] | undefined;

/**
 * Every country, by name. The names come from the server's own data and are
 * handed to the browser as they are: a browser with different data would
 * otherwise write some of them differently and the page would not match.
 */
export function countries(): Country[] {
  if (!cached) {
    const names = new Intl.DisplayNames(['en'], { type: 'region' });
    cached = CODES.split(' ')
      .map((code) => ({ code, name: names.of(code) ?? code }))
      .sort((a, b) => a.name.localeCompare(b.name, 'en'));
  }
  return cached;
}

/** The list with one country moved to the top: the one most guests of a property come from. */
export function countriesWithFirst(code: string): Country[] {
  const all = countries();
  const first = all.find((country) => country.code === code.toUpperCase());
  return first ? [first, ...all.filter((country) => country !== first)] : all;
}

export function countryName(code: string | null | undefined): string | null {
  if (!code) return null;
  return countries().find((country) => country.code === code.toUpperCase())?.name ?? code;
}
