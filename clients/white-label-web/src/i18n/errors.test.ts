import { describe, expect, it } from 'vitest';

import { ApiError } from '../api/api';

import { describeError, reasonText } from './errors';

describe('describeError', () => {
  it('maps a problem code to a friendly sentence and keeps the code', () => {
    const err = new ApiError({
      status: 403,
      code: 'SOD_VIOLATION',
      title: 'Forbidden',
      detail: 'The approver may not disburse',
      traceId: 'abc123def456',
    });
    const f = describeError(err, 'en-NG');
    expect(f.message).toMatch(/Maker-checker/);
    expect(f.code).toBe('SOD_VIOLATION');
    expect(f.status).toBe(403);
    expect(f.traceId).toBe('abc123def456');
  });

  it('localises by the lender locale', () => {
    const err = new ApiError({ status: 422, code: 'REPAYMENT_EXCEEDS_PAYOFF' });
    expect(describeError(err, 'fr-SN').message).toMatch(/dépasse/);
    expect(describeError(err, 'en-NG').message).toMatch(/more than/);
  });

  it('falls back on the HTTP status for unknown codes', () => {
    const err = new ApiError({ status: 409, code: 'SOMETHING_NEW' });
    const f = describeError(err, 'en-NG');
    expect(f.message).toMatch(/conflicts/);
    expect(f.code).toBe('SOMETHING_NEW');
  });

  it('exposes field errors of VALIDATION_FAILED', () => {
    const err = new ApiError({
      status: 400,
      code: 'VALIDATION_FAILED',
      errors: [{ field: 'phone', message: 'phone must be in E.164 format' }],
    });
    expect(describeError(err, 'en-NG').fields).toEqual([
      { field: 'phone', message: 'phone must be in E.164 format' },
    ]);
  });

  it('handles network failures and non-API errors', () => {
    expect(
      describeError(new ApiError({ status: 0, code: 'NETWORK_ERROR' }), 'en-NG').message,
    ).toMatch(/Cannot reach/);
    expect(describeError(new Error('boom'), 'en-NG')).toMatchObject({
      code: 'CLIENT_ERROR',
      message: 'boom',
    });
  });
});

describe('new backend codes', () => {
  it.each([
    'VALUE_DATE_OUT_OF_RANGE',
    'EXTERNAL_REFERENCE_REQUIRED',
    'PAYEE_NOT_ALLOWED',
    'CHECKOUT_ORDER_NOT_FOUND',
    'REGISTRATION_CONFLICT',
    'APR_EXCEEDS_CAP',
  ])('%s has its own English and French message', (code) => {
    const err = new ApiError({ status: 422, code });
    const en = describeError(err, 'en-NG').message;
    const fr = describeError(err, 'fr-SN').message;
    expect(en).not.toMatch(/business rule/);
    expect(fr).not.toBe(en);
  });
});

describe('reasonText', () => {
  it('explains scorecard reason codes', () => {
    expect(reasonText('R01_DTI_ABOVE_THRESHOLD', 'en-NG')).toMatch(/income/);
    expect(reasonText('R99_UNKNOWN', 'en-NG')).toBe('R99_UNKNOWN');
  });
});
