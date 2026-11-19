import { describe, expect, it } from 'vitest';
import {
  currencyExponent,
  decimalToMinor,
  displayMoney,
  formatMoney,
  minorToDecimal,
} from './money';

describe('money', () => {
  it('knows how many decimal places a currency has', () => {
    expect(currencyExponent('INR')).toBe(2);
    expect(currencyExponent('usd')).toBe(2);
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent('KWD')).toBe(3);
    expect(currencyExponent('???')).toBe(2);
  });

  it('converts decimal text to minor units exactly', () => {
    expect(decimalToMinor('200.00', 'INR')).toBe(20_000);
    expect(decimalToMinor('76.5', 'GBP')).toBe(7_650);
    expect(decimalToMinor('0.07', 'USD')).toBe(7);
    // The classic floating point trap: 1.15 * 100 is 114.99999999999999.
    expect(decimalToMinor('1.15', 'USD')).toBe(115);
    expect(decimalToMinor('19.999', 'USD')).toBe(2_000);
    expect(decimalToMinor('1500', 'JPY')).toBe(1_500);
    expect(decimalToMinor('1500.4', 'JPY')).toBe(1_500);
    expect(decimalToMinor('1.2345', 'KWD')).toBe(1_235);
    expect(decimalToMinor(153, 'GBP')).toBe(15_300);
    expect(decimalToMinor('-12.30', 'INR')).toBe(-1_230);
  });

  it('refuses text that is not a plain decimal', () => {
    expect(decimalToMinor('', 'INR')).toBeNull();
    expect(decimalToMinor('abc', 'INR')).toBeNull();
    expect(decimalToMinor('1,200.00', 'INR')).toBeNull();
    expect(decimalToMinor('1e3', 'INR')).toBeNull();
    expect(decimalToMinor(null, 'INR')).toBeNull();
  });

  it('writes minor units back as decimal text', () => {
    expect(minorToDecimal(20_000, 'INR')).toBe('200.00');
    expect(minorToDecimal(7, 'USD')).toBe('0.07');
    expect(minorToDecimal(1_500, 'JPY')).toBe('1500');
    expect(minorToDecimal(1_235, 'KWD')).toBe('1.235');
    expect(minorToDecimal(-1_230, 'INR')).toBe('-12.30');
    expect(formatMoney(24_000, 'usd')).toBe('USD 240.00');
  });

  it('writes amounts for guests the way they are read', () => {
    expect(displayMoney(945_000, 'INR')).toBe('₹9,450');
    expect(displayMoney(12_345_650, 'INR')).toBe('₹1,23,456.50');
    expect(displayMoney(24_050, 'usd')).toBe('$240.50');
    expect(displayMoney(1_500, 'JPY')).toBe('¥1,500');
    expect(displayMoney(100, 'XXXX')).toBe('XXXX 1.00');
  });
});
