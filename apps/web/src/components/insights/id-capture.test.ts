import { describe, expect, it } from 'vitest';
import {
  MAX_PHOTO_BYTES,
  countryName,
  fieldProblems,
  fieldsFrom,
  guestPatch,
  hasExpired,
  nothingRead,
  photoProblem,
  readCaptureAnswer,
} from './id-capture';
import type { IdCapture } from './types';

const READ: IdCapture = {
  documentType: 'passport',
  fullName: 'SPECIMEN TRAVELLER',
  documentNumber: 'X0000000',
  nationality: 'IN',
  issuingCountry: 'IN',
  dateOfBirth: '1990-04-12',
  expiryDate: '2031-08-30',
  address: null,
  legible: true,
};

describe('photoProblem', () => {
  it('lets through the three formats the server takes, up to 8 MB', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp']) {
      expect(photoProblem({ type, size: 1 })).toBeNull();
      expect(photoProblem({ type, size: MAX_PHOTO_BYTES })).toBeNull();
    }
  });

  it('refuses other files, empty ones and photos over 8 MB before anything is sent', () => {
    expect(photoProblem({ type: 'application/pdf', size: 1000 })).toMatch(/JPEG, PNG or WebP/);
    expect(photoProblem({ type: 'image/heic', size: 1000 })).toMatch(/JPEG, PNG or WebP/);
    expect(photoProblem({ type: '', size: 1000 })).toMatch(/JPEG, PNG or WebP/);
    expect(photoProblem({ type: 'image/jpeg', size: 0 })).toMatch(/empty/);
    expect(photoProblem({ type: 'image/jpeg', size: MAX_PHOTO_BYTES + 1 })).toMatch(/8 MB/);
  });
});

describe('readCaptureAnswer', () => {
  it('takes what was read', () => {
    expect(readCaptureAnswer(200, JSON.stringify(READ))).toEqual({ capture: READ });
  });

  it('treats missing, empty and misshapen fields as not read, and legible only on a plain yes', () => {
    const answer = readCaptureAnswer(
      200,
      JSON.stringify({
        documentType: 'library_card',
        fullName: '  ',
        documentNumber: 42,
        nationality: ' in ',
        dateOfBirth: '12/04/1990',
        expiryDate: '2031-02-30',
        legible: 'yes',
      }),
    );
    expect(answer).toEqual({
      capture: {
        documentType: null,
        fullName: null,
        documentNumber: null,
        nationality: 'in',
        issuingCountry: null,
        dateOfBirth: null,
        expiryDate: null,
        address: null,
        legible: false,
      },
    });
  });

  it('keeps the server’s own code, message and details when it refuses', () => {
    const body = JSON.stringify({
      error: {
        code: 'not_configured',
        message: 'Reading identity documents automatically is switched off.',
        details: { feature: 'id_capture' },
        requestId: 'req-1',
      },
    });
    expect(readCaptureAnswer(503, body)).toEqual({
      failure: {
        status: 503,
        code: 'not_configured',
        message: 'Reading identity documents automatically is switched off.',
        details: { feature: 'id_capture' },
      },
    });
    expect(
      readCaptureAnswer(
        429,
        '{"error":{"code":"rate_limited","message":"Rate limit exceeded, retry in 1 minute"}}',
      ),
    ).toEqual({
      failure: {
        status: 429,
        code: 'rate_limited',
        message: 'Rate limit exceeded, retry in 1 minute',
        details: undefined,
      },
    });
  });

  it('says what the server answered when a failure carries no message', () => {
    for (const body of ['Internal Server Error', '', '<html></html>', '{"error":"down"}', '[]']) {
      expect(readCaptureAnswer(500, body)).toEqual({
        failure: {
          status: 500,
          code: 'error',
          message: 'The server answered 500',
          details: undefined,
        },
      });
    }
  });

  it('does not take a success without a reading for one', () => {
    for (const body of ['', 'OK', 'null', '[]', '"passport"']) {
      const answer = readCaptureAnswer(200, body);
      expect('failure' in answer && answer.failure.code).toBe('unreadable');
    }
  });
});

describe('the form a reading fills', () => {
  it('carries the details the profile keeps and leaves the rest', () => {
    expect(fieldsFrom(READ)).toEqual({
      idType: 'passport',
      idNumber: 'X0000000',
      nationality: 'IN',
      dateOfBirth: '1990-04-12',
      idExpiry: '2031-08-30',
    });
    expect(nothingRead(READ)).toBe(false);
  });

  it('knows a reading with nothing in it, whatever it says about the name or address', () => {
    const blank: IdCapture = {
      ...READ,
      documentType: null,
      documentNumber: null,
      nationality: null,
      dateOfBirth: null,
      expiryDate: null,
      address: 'Somewhere',
    };
    expect(nothingRead(blank)).toBe(true);
    expect(fieldsFrom(blank)).toEqual({
      idType: '',
      idNumber: '',
      nationality: '',
      dateOfBirth: '',
      idExpiry: '',
    });
  });

  it('asks for the number and the kind of document together, and a birth date in the past', () => {
    const fields = fieldsFrom(READ);
    expect(fieldProblems(fields, '2026-11-14')).toEqual({});
    expect(fieldProblems({ ...fields, idType: '' }, '2026-11-14')).toHaveProperty('idType');
    expect(fieldProblems({ ...fields, idNumber: '  ' }, '2026-11-14')).toHaveProperty('idNumber');
    expect(fieldProblems({ ...fields, idType: '', idNumber: '' }, '2026-11-14')).toEqual({});
    expect(fieldProblems({ ...fields, dateOfBirth: '2026-11-15' }, '2026-11-14')).toHaveProperty(
      'dateOfBirth',
    );
    expect(fieldProblems({ ...fields, dateOfBirth: '2026-11-14' }, '2026-11-14')).toEqual({});
  });

  it('notices a document that has run out, without making it a mistake', () => {
    const fields = fieldsFrom(READ);
    expect(hasExpired(fields, '2026-11-14')).toBe(false);
    expect(hasExpired({ ...fields, idExpiry: '2026-11-13' }, '2026-11-14')).toBe(true);
    expect(hasExpired({ ...fields, idExpiry: '2026-11-14' }, '2026-11-14')).toBe(false);
    expect(hasExpired({ ...fields, idExpiry: '' }, '2026-11-14')).toBe(false);
    expect(fieldProblems({ ...fields, idExpiry: '2020-01-01' }, '2026-11-14')).toEqual({});
  });

  it('sends only what is filled in, trimmed, so that empty fields leave the profile alone', () => {
    expect(
      guestPatch({
        idType: 'aadhaar',
        idNumber: ' 0000 0000 0000 ',
        nationality: '',
        dateOfBirth: '',
        idExpiry: '',
      }),
    ).toEqual({ idType: 'aadhaar', idNumber: '0000 0000 0000' });
    expect(
      guestPatch({ idType: '', idNumber: '', nationality: ' ', dateOfBirth: '', idExpiry: '' }),
    ).toEqual({});
  });
});

describe('countryName', () => {
  it('names a two-letter code and nothing else', () => {
    expect(countryName('IN')).toBe('India');
    expect(countryName(' gb ')).toBe('United Kingdom');
    expect(countryName('Indian')).toBeNull();
    expect(countryName('')).toBeNull();
    expect(countryName('QQ')).toBeNull();
    expect(countryName('ZZ')).toBeNull();
  });
});
