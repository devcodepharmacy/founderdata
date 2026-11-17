const decimals = new Map<string, number>();

/**
 * Minor-unit digits of a currency (JPY 0, USD 2, KWD 3), from Intl. The Worker and the browser share it. Kept per
 * currency: a new Intl.NumberFormat costs about 50 microseconds, and a query across 25 sites asks 25 times.
 */
export function currencyDecimals(currency: string): number {
  let n = decimals.get(currency);
  if (n === undefined) {
    try {
      n = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
    } catch {
      n = 2;
    }
    if (decimals.size < 500) decimals.set(currency, n);
  }
  return n;
}
