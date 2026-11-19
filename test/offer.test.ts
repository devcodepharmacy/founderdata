import { describe, expect, it } from 'vitest';
import { amount, currentOffer, offerFromText, parseOffer, type OfferFile } from '../src/shared/offer';

const TIERS = [
  { price: 499, seats: 5 },
  { price: 999, seats: 10 },
  { price: 1499, seats: 20 },
  { price: 1999, seats: 30 },
  { price: 2499, seats: 50 },
];
const file = (sold: number, extra: Partial<OfferFile> = {}): OfferFile => ({ regular: 2999, tiers: TIERS, sold, ...extra });

describe('launch offer', () => {
  it.each([
    // sold, price, seats in step, sold in step, left, next price
    [0, 499, 5, 0, 5, 999],
    [4, 499, 5, 4, 1, 999],
    [5, 999, 10, 0, 10, 1499],
    [14, 999, 10, 9, 1, 1499],
    [15, 1499, 20, 0, 20, 1999],
    [34, 1499, 20, 19, 1, 1999],
    [35, 1999, 30, 0, 30, 2499],
    [64, 1999, 30, 29, 1, 2499],
    [65, 2499, 50, 0, 50, 2999],
    [114, 2499, 50, 49, 1, 2999],
  ])('sold %i: %i, %i seats, %i sold, %i left, then %i', (sold, price, seats, soldInStep, leftInStep, next) => {
    expect(currentOffer(file(sold))).toEqual({ kind: 'launch', price, regular: 2999, saving: 2999 - price, seats, soldInStep, leftInStep, next, checkout: undefined });
  });

  it.each([115, 116, 500])('sold %i: the regular price', (sold) => {
    expect(currentOffer(file(sold))).toEqual({ kind: 'regular', regular: 2999, checkout: undefined });
  });

  it('has no launch price without steps', () => {
    expect(currentOffer(file(0, { tiers: [] }))).toEqual({ kind: 'regular', regular: 2999, checkout: undefined });
  });

  it('passes the checkout link on', () => {
    const checkout = 'https://buy.polar.sh/abc';
    expect(currentOffer(file(0, { checkout }))).toMatchObject({ kind: 'launch', checkout });
    expect(currentOffer(file(115, { checkout }))).toMatchObject({ kind: 'regular', checkout });
  });

  it('reads the published file', () => {
    const text = JSON.stringify({ ...file(2), checkout: 'https://buy.polar.sh/abc', updated: '2026-11-19T10:00:00Z' });
    expect(offerFromText(text)).toMatchObject({ kind: 'launch', price: 499, leftInStep: 3, checkout: 'https://buy.polar.sh/abc' });
  });

  it.each([
    ['not JSON', '<html>404: Not Found</html>'],
    ['null', 'null'],
    ['an array', '[]'],
    ['no regular price', JSON.stringify({ tiers: TIERS, sold: 0 })],
    ['a regular price as text', JSON.stringify({ ...file(0), regular: '29.99' })],
    ['a regular price in major units', JSON.stringify({ ...file(0), regular: 29.99 })],
    ['a regular price of 0', JSON.stringify({ ...file(0), regular: 0 })],
    ['a negative sold count', JSON.stringify(file(-1))],
    ['a fractional sold count', JSON.stringify(file(2.5))],
    ['sold as text', JSON.stringify({ ...file(0), sold: '2' })],
    ['no sold count', JSON.stringify({ regular: 2999, tiers: TIERS })],
    ['tiers that are not a list', JSON.stringify({ ...file(0), tiers: {} })],
    ['a step that is not an object', JSON.stringify({ ...file(0), tiers: [499] })],
    ['a step at the regular price', JSON.stringify({ ...file(0), tiers: [{ price: 2999, seats: 5 }] })],
    ['a step above the regular price', JSON.stringify({ ...file(0), tiers: [{ price: 3999, seats: 5 }] })],
    ['a step priced 0', JSON.stringify({ ...file(0), tiers: [{ price: 0, seats: 5 }] })],
    ['a negative price', JSON.stringify({ ...file(0), tiers: [{ price: -499, seats: 5 }] })],
    ['a step with 0 seats', JSON.stringify({ ...file(0), tiers: [{ price: 499, seats: 0 }] })],
    ['a step with negative seats', JSON.stringify({ ...file(0), tiers: [{ price: 499, seats: -5 }] })],
    ['steps that get cheaper', JSON.stringify({ ...file(0), tiers: [{ price: 999, seats: 5 }, { price: 499, seats: 5 }] })],
    ['a checkout link over http', JSON.stringify({ ...file(0), checkout: 'http://buy.polar.sh/abc' })],
    ['a checkout link that runs script', JSON.stringify({ ...file(0), checkout: 'javascript:alert(1)' })],
    ['a checkout link that is not text', JSON.stringify({ ...file(0), checkout: 5 })],
    ['an update time that is not text', JSON.stringify({ ...file(0), updated: 5 })],
  ])('treats %s as no data', (_, text) => {
    expect(offerFromText(text)).toBeNull();
  });

  it('keeps only the fields it knows', () => {
    expect(parseOffer({ ...file(3), note: 'x' })).toEqual(file(3));
  });

  it('prints minor units', () => {
    expect(amount(499)).toBe('4.99');
    expect(amount(2999)).toBe('29.99');
    expect(amount(2500)).toBe('25.00');
  });
});
