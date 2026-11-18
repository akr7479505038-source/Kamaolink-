/**
 * ============================================================================
 * PAYOUT, RPM & PAYMENT WINDOW CONFIGURATION (src/config/rates.ts)
 * ============================================================================
 *
 * Non-coder guide:
 * - All rates, currency symbols, minimum payout limits, and payment windows
 *   live in this single file so you never have to hunt through other files.
 * - Currently only India ('IN') is enabled for paid views. To add more
 *   countries later, add a new entry to COUNTRY_RATES with `enabled: true`.
 */

export interface CountryRpmConfig {
  countryCode: string;
  countryName: string;
  enabled: boolean;
  rpmMinInr: number;
  rpmMaxInr: number;
  /** Default RPM used to calculate per-view earnings in ₹ (1,000 views = defaultRpmInr) */
  defaultRpmInr: number;
}

export const CURRENCY_SYMBOL = '₹';
export const CURRENCY_CODE = 'INR';

/**
 * Minimum wallet balance required for payout (in ₹).
 */
export const MINIMUM_PAYOUT_INR = 200;
export const MINIMUM_PAYOUT_PAISE = MINIMUM_PAYOUT_INR * 100;

/**
 * Minimum balance required before a creator can add bank details (in ₹).
 */
export const BANK_UNLOCK_BALANCE_INR = 50;
export const BANK_UNLOCK_BALANCE_PAISE = BANK_UNLOCK_BALANCE_INR * 100;

/**
 * Twice-monthly payment windows (inclusive day of month).
 */
export const PAYMENT_WINDOWS = [
  { id: 1, startDay: 4, endDay: 10, label: '4th – 10th' },
  { id: 2, startDay: 23, endDay: 29, label: '23rd – 29th' },
] as const;

/**
 * Active country currently open for paid views.
 */
export const PRIMARY_COUNTRY_CODE = 'IN';

/**
 * Country-based RPM settings.
 * Structure is ready for adding more countries in the future without rewriting code.
 */
export const COUNTRY_RATES: Record<string, CountryRpmConfig> = {
  IN: {
    countryCode: 'IN',
    countryName: 'India',
    enabled: true,
    rpmMinInr: 100,
    rpmMaxInr: 500,
    defaultRpmInr: 200, // ₹200 per 1,000 India views = ₹0.20 (20 paise) per verified view
  },
  // Example for the future:
  // US: { countryCode: 'US', countryName: 'United States', enabled: false, rpmMinInr: 300, rpmMaxInr: 500, defaultRpmInr: 400 },
};

export const RPM_ESTIMATE_NOTE = 'Estimated. Actual RPM depends on traffic quality.';
export const INDIA_ONLY_NOTICE = 'Only views from India are paid at present.';

export function getCountryRateConfig(countryCode: string): CountryRpmConfig | null {
  const normalized = countryCode.trim().toUpperCase();
  const entry = COUNTRY_RATES[normalized];
  if (!entry || !entry.enabled) return null;
  return entry;
}

export function isPaidCountry(countryCode: string): boolean {
  return getCountryRateConfig(countryCode) !== null;
}

export function getActiveCountryRate(): CountryRpmConfig {
  return COUNTRY_RATES[PRIMARY_COUNTRY_CODE];
}

/**
 * Calculates integer paise earned for 1 verified view from a given country.
 * Returns 0 if the country is not currently enabled for paid views.
 */
export function getPaisePerVerifiedView(countryCode: string): number {
  const cfg = getCountryRateConfig(countryCode);
  if (!cfg) return 0;
  // 1,000 views = defaultRpmInr * 100 paise -> 1 view = (defaultRpmInr * 100) / 1000 paise
  return Math.round((cfg.defaultRpmInr * 100) / 1000);
}

/**
 * Formats the single active RPM range string from config values.
 * Example: "RPM ₹100 – ₹500 per 1,000 views (India)"
 */
export function formatPrimaryRpmLabel(): string {
  const cfg = getActiveCountryRate();
  return `RPM ${CURRENCY_SYMBOL}${cfg.rpmMinInr} – ${CURRENCY_SYMBOL}${cfg.rpmMaxInr} per 1,000 views (${cfg.countryName})`;
}

export function formatInrFromPaise(paise: number): string {
  const rupees = paise / 100;
  return `${CURRENCY_SYMBOL}${rupees.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export interface PaymentWindowInfo {
  isWindowOpenNow: boolean;
  label: string;
  shortLabel: string;
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function formatOrdinal(day: number): string {
  if (day >= 11 && day <= 13) return `${day}th`;
  const last = day % 10;
  if (last === 1) return `${day}st`;
  if (last === 2) return `${day}nd`;
  if (last === 3) return `${day}rd`;
  return `${day}th`;
}

/**
 * Automatically determines the current or upcoming payment window
 * using India Standard Time (Asia/Kolkata) calendar date.
 */
export function getNextPaymentWindowInfo(referenceDate = new Date()): PaymentWindowInfo {
  // Convert to IST (UTC+5:30) so payment windows align with India dates
  const utcMs = referenceDate.getTime() + referenceDate.getTimezoneOffset() * 60_000;
  const istDate = new Date(utcMs + 5.5 * 60 * 60_000);

  const year = istDate.getFullYear();
  const monthIndex = istDate.getMonth();
  const day = istDate.getDate();

  const w1 = PAYMENT_WINDOWS[0];
  const w2 = PAYMENT_WINDOWS[1];

  if (day < w1.startDay) {
    const month = MONTH_NAMES[monthIndex];
    const range = `${formatOrdinal(w1.startDay)} – ${formatOrdinal(w1.endDay)} ${month} ${year}`;
    return { isWindowOpenNow: false, label: range, shortLabel: `${w1.label} ${month}` };
  }

  if (day <= w1.endDay) {
    const month = MONTH_NAMES[monthIndex];
    const range = `${formatOrdinal(w1.startDay)} – ${formatOrdinal(w1.endDay)} ${month} ${year} (Open now)`;
    return { isWindowOpenNow: true, label: range, shortLabel: `${w1.label} ${month}` };
  }

  if (day < w2.startDay) {
    const month = MONTH_NAMES[monthIndex];
    const range = `${formatOrdinal(w2.startDay)} – ${formatOrdinal(w2.endDay)} ${month} ${year}`;
    return { isWindowOpenNow: false, label: range, shortLabel: `${w2.label} ${month}` };
  }

  if (day <= w2.endDay) {
    const month = MONTH_NAMES[monthIndex];
    const range = `${formatOrdinal(w2.startDay)} – ${formatOrdinal(w2.endDay)} ${month} ${year} (Open now)`;
    return { isWindowOpenNow: true, label: range, shortLabel: `${w2.label} ${month}` };
  }

  // Day 30 or 31 -> Window 1 of next month
  const nextMonthIndex = (monthIndex + 1) % 12;
  const nextYear = monthIndex === 11 ? year + 1 : year;
  const nextMonth = MONTH_NAMES[nextMonthIndex];
  const range = `${formatOrdinal(w1.startDay)} – ${formatOrdinal(w1.endDay)} ${nextMonth} ${nextYear}`;
  return { isWindowOpenNow: false, label: range, shortLabel: `${w1.label} ${nextMonth}` };
}
