/**
 * ============================================================================
 * HOME PAGE (src/components/HomePage.tsx)
 * ============================================================================
 *
 * Top-to-bottom layout for logged-in users:
 * a. Link input box + "Shorten" button (validates http/https)
 * b. Generated short link box + "Copy" button ("Copied!" feedback)
 * c. Stats summary + Wallet Card (progress bar ₹X / ₹200, next payment window,
 *    encrypted bank account unlock at ₹50, payout history) + "My links" list
 * d. Info section: RPM only (India ₹100 – ₹500 per 1,000 views), India-only rule,
 *    twice-monthly payment windows (4th–10th & 23rd–29th), how it works, FAQ
 */

import { useEffect, useState, type FormEvent } from 'react';
import {
  Copy,
  Check,
  ExternalLink,
  Trash2,
  ChevronDown,
  AlertCircle,
  Link2,
  Lock,
  Landmark,
  CheckCircle2,
  RotateCw,
  BarChart3,
  X,
} from 'lucide-react';
import {
  createShortLink,
  deleteShortLink,
  fetchLinkAnalytics,
  fetchMyLinks,
  fetchWalletSummary,
  saveBankAccount,
} from '../lib/api';
import { reverifyGoogleIdentity } from '../lib/firebaseAuth';
import {
  BANK_UNLOCK_BALANCE_INR,
  CURRENCY_SYMBOL,
  INDIA_ONLY_NOTICE,
  MINIMUM_PAYOUT_INR,
  MINIMUM_PAYOUT_PAISE,
  PAYMENT_WINDOWS,
  RPM_ESTIMATE_NOTE,
  formatInrFromPaise,
  formatPrimaryRpmLabel,
  getActiveCountryRate,
  getNextPaymentWindowInfo,
  getPaisePerVerifiedView,
} from '../config/rates';
import type {
  LinkAnalyticsDetail,
  LinksSummary,
  ShortLink,
  User,
  WalletSummary,
} from '../types';

interface HomePageProps {
  user: User;
  onOpenVisitorTest: (code: string) => void;
}

export function HomePage({ user, onOpenVisitorTest }: HomePageProps) {
  const [urlInput, setUrlInput] = useState('');
  const [urlError, setUrlError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [latestLink, setLatestLink] = useState<ShortLink | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [refreshingStats, setRefreshingStats] = useState(false);

  const [analyticsDetail, setAnalyticsDetail] = useState<LinkAnalyticsDetail | null>(null);
  const [loadingAnalytics, setLoadingAnalytics] = useState(false);

  const [summary, setSummary] = useState<LinksSummary>({
    totalLinks: 0,
    totalClicks: 0,
    totalPaidClicks: 0,
    totalEarnedPaise: 0,
    totalLinkClicks: 0,
    adImpressions: 0,
    adStarted: 0,
    adCompleted: 0,
    adSkipped: 0,
    adFailed: 0,
    validAdViews: 0,
    invalidViews: 0,
    duplicateViews: 0,
    botDetections: 0,
    links: [],
  });
  const [wallet, setWallet] = useState<WalletSummary>({
    totalEarnedPaise: 0,
    totalPaidPaise: 0,
    pendingBalancePaise: 0,
    minimumPayoutPaise: MINIMUM_PAYOUT_PAISE,
    bankUnlockPaise: BANK_UNLOCK_BALANCE_INR * 100,
    bankUnlocked: false,
    bankAccount: null,
    payouts: [],
  });
  const [loadingData, setLoadingData] = useState(true);
  const [openFaqIndex, setOpenFaqIndex] = useState<number | null>(0);

  // Bank account form state (shown only when balance >= ₹50 or bank already saved)
  const [showBankForm, setShowBankForm] = useState(false);
  const [holderName, setHolderName] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [confirmAccountNumber, setConfirmAccountNumber] = useState('');
  const [ifscCode, setIfscCode] = useState('');
  const [upiId, setUpiId] = useState('');
  const [bankError, setBankError] = useState('');
  const [bankSuccess, setBankSuccess] = useState('');
  const [savingBank, setSavingBank] = useState(false);

  const activeRate = getActiveCountryRate();
  const nextWindow = getNextPaymentWindowInfo();
  const primaryRpmLabel = formatPrimaryRpmLabel();
  const perViewRateLabel = formatInrFromPaise(getPaisePerVerifiedView(activeRate.countryCode));

  const faqItems = [
    {
      question: 'When is a view counted?',
      answer:
        'A view is counted automatically as soon as a visitor finishes watching all the ads on your short link — no extra click required.',
    },
    {
      question: 'Which views count toward my earnings?',
      answer: `${INDIA_ONLY_NOTICE} Each visitor from India who finishes watching all ads adds 1 view and adds ${perViewRateLabel} to your pending balance. Visitors from outside India still count toward Views and reach the link normally, without adding to your rupee balance.`,
    },
    {
      question: 'What is RPM and how much will I earn?',
      answer: `RPM = what you earn per 1,000 views. The current rate is ${primaryRpmLabel}. ${RPM_ESTIMATE_NOTE}`,
    },
    {
      question: 'When are payments sent?',
      answer: `Payments are processed twice a month: ${PAYMENT_WINDOWS[0].label} and ${PAYMENT_WINDOWS[1].label} of every month. Your balance must be ${CURRENCY_SYMBOL}${MINIMUM_PAYOUT_INR} or more to be paid in a window. If it is under ${CURRENCY_SYMBOL}${MINIMUM_PAYOUT_INR}, it carries forward automatically to the next window.`,
    },
    {
      question: 'When can I add my bank account?',
      answer: `The bank account option unlocks automatically as soon as your balance reaches ${CURRENCY_SYMBOL}${BANK_UNLOCK_BALANCE_INR}. Your account number is encrypted in our database and displayed only in masked form (such as XXXXXX1234). Changing it later requires re-confirming your Gmail account with Google.`,
    },
    {
      question: 'Can visitors skip the ads to reach the link faster?',
      answer:
        'No. The server issues a one-time session token for every visit and verifies minimum ad watch time on each step before unlocking the destination link.',
    },
  ];

  useEffect(() => {
    let active = true;
    setLoadingData(true);
    Promise.all([fetchMyLinks(), fetchWalletSummary()])
      .then(([linksData, walletData]) => {
        if (!active) return;
        setSummary(linksData);
        setWallet(walletData);
      })
      .catch(() => {
        // Keep clean initial states
      })
      .finally(() => {
        if (active) setLoadingData(false);
      });
    return () => {
      active = false;
    };
  }, []);

  function getFullShortUrl(code: string): string {
    return `${window.location.origin}/s/${code}`;
  }

  function validateHttpUrl(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) {
      return 'Please paste a web link first.';
    }
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return 'Link must start with http:// or https://';
      }
      return null;
    } catch {
      return 'Please enter a valid web link (example: https://example.com/page).';
    }
  }

  async function handleShorten(e: FormEvent) {
    e.preventDefault();
    const validationError = validateHttpUrl(urlInput);
    if (validationError) {
      setUrlError(validationError);
      return;
    }

    setUrlError('');
    setSubmitting(true);
    try {
      const created = await createShortLink(urlInput.trim());
      setLatestLink(created);
      setUrlInput('');
      setSummary((prev) => ({
        ...prev,
        totalLinks: prev.totalLinks + 1,
        links: [created, ...prev.links],
      }));
    } catch (err) {
      setUrlError(err instanceof Error ? err.message : 'Could not shorten link.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRefreshStats() {
    setRefreshingStats(true);
    try {
      const [linksData, walletData] = await Promise.all([fetchMyLinks(), fetchWalletSummary()]);
      setSummary(linksData);
      setWallet(walletData);
    } catch {
      // Keep current state
    } finally {
      setRefreshingStats(false);
    }
  }

  async function handleCopy(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(key);
      setTimeout(() => {
        setCopiedId((current) => (current === key ? null : current));
      }, 2000);
    } catch {
      const input = document.createElement('input');
      input.value = text;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
      setCopiedId(key);
      setTimeout(() => {
        setCopiedId((current) => (current === key ? null : current));
      }, 2000);
    }
  }

  async function handleOpenAnalytics(linkId: number) {
    setLoadingAnalytics(true);
    try {
      const detail = await fetchLinkAnalytics(linkId);
      setAnalyticsDetail(detail);
    } catch {
      // Keep UI stable if analytics fetch fails
    } finally {
      setLoadingAnalytics(false);
    }
  }

  async function handleDeleteLink(linkId: number) {
    try {
      await deleteShortLink(linkId);
      setSummary((prev) => {
        const remaining = prev.links.filter((item) => item.id !== linkId);
        return {
          ...prev,
          totalLinks: remaining.length,
          totalClicks: remaining.reduce((acc, item) => acc + item.clicks, 0),
          totalPaidClicks: remaining.reduce((acc, item) => acc + item.paidClicks, 0),
          totalLinkClicks: remaining.reduce((acc, item) => acc + item.totalLinkClicks, 0),
          adImpressions: remaining.reduce((acc, item) => acc + item.adImpressions, 0),
          adStarted: remaining.reduce((acc, item) => acc + item.adStarted, 0),
          adCompleted: remaining.reduce((acc, item) => acc + item.adCompleted, 0),
          adSkipped: remaining.reduce((acc, item) => acc + item.adSkipped, 0),
          adFailed: remaining.reduce((acc, item) => acc + item.adFailed, 0),
          validAdViews: remaining.reduce((acc, item) => acc + item.validAdViews, 0),
          invalidViews: remaining.reduce((acc, item) => acc + item.invalidViews, 0),
          duplicateViews: remaining.reduce((acc, item) => acc + item.duplicateViews, 0),
          botDetections: remaining.reduce((acc, item) => acc + item.botDetections, 0),
          links: remaining,
        };
      });
      if (latestLink?.id === linkId) {
        setLatestLink(null);
      }
      if (analyticsDetail?.link.id === linkId) {
        setAnalyticsDetail(null);
      }
    } catch {
      // Keep UI stable if delete fails
    }
  }

  function openBankEditor() {
    setBankError('');
    setBankSuccess('');
    setHolderName(wallet.bankAccount?.accountHolderName || '');
    setAccountNumber('');
    setConfirmAccountNumber('');
    setIfscCode(wallet.bankAccount?.ifscCode || '');
    setUpiId('');
    setShowBankForm(true);
  }

  async function handleBankSubmit(e: FormEvent) {
    e.preventDefault();
    setBankError('');
    setBankSuccess('');

    const cleanHolder = holderName.trim();
    const cleanAcc = accountNumber.trim();
    const cleanConfirm = confirmAccountNumber.trim();
    const cleanIfsc = ifscCode.trim().toUpperCase();
    const cleanUpi = upiId.trim();

    if (cleanHolder.length < 2) {
      setBankError('Please enter the account holder name.');
      return;
    }
    if (!/^\d{9,18}$/.test(cleanAcc)) {
      setBankError('Account number must contain digits only (9 to 18 digits).');
      return;
    }
    if (cleanAcc !== cleanConfirm) {
      setBankError('Account numbers do not match.');
      return;
    }
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(cleanIfsc)) {
      setBankError('Please enter a valid 11-character IFSC code (example: SBIN0001234).');
      return;
    }
    if (cleanUpi && !/^[a-zA-Z0-9._-]{2,}@[a-zA-Z0-9.-]{2,}$/.test(cleanUpi)) {
      setBankError('Please enter a valid UPI ID (example: name@upi) or leave it blank.');
      return;
    }
    setSavingBank(true);
    try {
      let googleIdToken: string | undefined;
      if (wallet.bankAccount) {
        googleIdToken = await reverifyGoogleIdentity(user.email);
      }
      const saved = await saveBankAccount({
        accountHolderName: cleanHolder,
        accountNumber: cleanAcc,
        confirmAccountNumber: cleanConfirm,
        ifscCode: cleanIfsc,
        upiId: cleanUpi,
        googleIdToken,
      });
      setWallet((prev) => ({
        ...prev,
        bankAccount: saved,
      }));
      setShowBankForm(false);
      setAccountNumber('');
      setConfirmAccountNumber('');
      setBankSuccess('Bank account saved securely.');
    } catch (err) {
      setBankError(err instanceof Error ? err.message : 'Could not save bank account.');
    } finally {
      setSavingBank(false);
    }
  }

  // Wallet meter calculations derived strictly from real DB paise & config values
  const unpaidApprovedPaise = Math.max(0, wallet.totalEarnedPaise - wallet.totalPaidPaise);
  const payoutProgressPaise = wallet.pendingBalancePaise + unpaidApprovedPaise;
  const payoutProgressRupees = payoutProgressPaise / 100;
  const remainingToMinPaise = Math.max(0, wallet.minimumPayoutPaise - payoutProgressPaise);
  const isEligibleForPayout = payoutProgressPaise >= wallet.minimumPayoutPaise;
  const progressPct = Math.min(
    100,
    Math.round((payoutProgressPaise / wallet.minimumPayoutPaise) * 100)
  );

  return (
    <main className="mx-auto max-w-5xl space-y-12 px-4 py-10 sm:px-6 sm:py-12">
      {/* a. TOP SHORTENER BOX */}
      <section id="shorten" aria-labelledby="shorten-heading">
        <div className="mb-5">
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Signed in as{' '}
            <span className="font-medium text-slate-900 dark:text-white">{user.name}</span>
            <span aria-hidden="true" className="mx-1.5">
              ·
            </span>
            <span className="font-mono text-xs text-slate-700 dark:text-slate-300">
              {user.email}
            </span>
          </p>
          <h1
            id="shorten-heading"
            className="mt-1 text-balance text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl dark:text-white"
          >
            Shorten a link and earn in Rupees
          </h1>
        </div>

        <form
          onSubmit={handleShorten}
          noValidate
          className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5 dark:border-slate-800 dark:bg-slate-900"
        >
          <label htmlFor="url-input" className="sr-only">
            Paste your long web link
          </label>
          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="relative flex-1">
              <Link2 className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                id="url-input"
                type="url"
                value={urlInput}
                onChange={(e) => {
                  setUrlInput(e.target.value);
                  if (urlError) setUrlError('');
                }}
                placeholder="https://example.com/your-long-link"
                className="h-12 w-full rounded-lg border border-slate-300 bg-white pr-4 pl-10 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-600 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-white dark:placeholder:text-slate-500"
              />
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex h-12 cursor-pointer items-center justify-center rounded-lg bg-indigo-600 px-6 text-sm font-semibold text-white transition-colors hover:bg-indigo-700 whitespace-nowrap shrink-0 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-indigo-600"
            >
              {submitting ? 'Shortening...' : 'Shorten'}
            </button>
          </div>

          {urlError && (
            <p
              role="alert"
              className="mt-3 flex items-center gap-2 text-sm text-red-700 dark:text-red-400"
            >
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{urlError}</span>
            </p>
          )}
        </form>

        {/* b. GENERATED SHORT LINK RESULT */}
        {latestLink && (
          <div className="mt-4 flex flex-col justify-between gap-4 rounded-xl border border-indigo-200 bg-indigo-50/70 p-4 sm:flex-row sm:items-center sm:p-5 dark:border-indigo-900/60 dark:bg-indigo-950/30">
            <div className="min-w-0">
              <p className="text-xs font-medium text-indigo-800 dark:text-indigo-300">
                Your short link is ready
              </p>
              <p className="mt-1 truncate font-mono text-base font-semibold text-slate-900 dark:text-white">
                {getFullShortUrl(latestLink.code)}
              </p>
              <p className="mt-0.5 truncate text-xs text-slate-600 dark:text-slate-400">
                Destination: {latestLink.originalUrl}
              </p>
            </div>

            <div className="flex items-center gap-2.5 shrink-0">
              <button
                type="button"
                onClick={() => handleCopy(getFullShortUrl(latestLink.code), `latest-${latestLink.id}`)}
                className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-lg bg-indigo-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-indigo-700 whitespace-nowrap shrink-0"
              >
                {copiedId === `latest-${latestLink.id}` ? (
                  <>
                    <Check className="h-4 w-4" />
                    <span>Copied!</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-4 w-4" />
                    <span>Copy</span>
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={() => onOpenVisitorTest(latestLink.code)}
                className="inline-flex h-10 cursor-pointer items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 text-sm font-medium text-slate-800 transition-colors hover:bg-slate-100 whitespace-nowrap shrink-0 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                <ExternalLink className="h-4 w-4" />
                <span>Test link</span>
              </button>
            </div>
          </div>
        )}
      </section>

      {/* c. STATS + WALLET PROGRESS METER + BANK ACCOUNT + PAYOUT HISTORY */}
      <section id="wallet" className="space-y-6" aria-labelledby="wallet-heading">
        {/* Ads Count Summary: Clicks, Views (all ads completed), Invalid & blocked */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
            <p className="text-sm text-slate-600 dark:text-slate-400">Clicks</p>
            <p className="mt-2 font-mono text-2xl font-bold tabular-nums text-slate-900 dark:text-white">
              {summary.totalLinkClicks}
            </p>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Total short link clicks
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
            <p className="text-sm text-slate-600 dark:text-slate-400">Views</p>
            <p className="mt-2 font-mono text-2xl font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
              {summary.totalClicks}
            </p>
            <p className="mt-1 text-xs tabular-nums text-slate-500 dark:text-slate-400">
              All ads watched & counted · {perViewRateLabel} per India view ({summary.totalPaidClicks} paid)
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
            <p className="text-sm text-slate-600 dark:text-slate-400">Invalid & blocked</p>
            <p className="mt-2 font-mono text-2xl font-bold tabular-nums text-amber-700 dark:text-amber-400">
              {summary.invalidViews}
            </p>
            <p className="mt-1 text-xs tabular-nums text-slate-500 dark:text-slate-400">
              Duplicates: {summary.duplicateViews} · Bots: {summary.botDetections}
            </p>
          </div>
        </div>

        {/* Wallet & Payout Progress Card */}
        <div className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
            <div>
              <h2
                id="wallet-heading"
                className="text-lg font-semibold text-slate-900 dark:text-white"
              >
                Wallet & Payout Progress
              </h2>
              <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-400">
                Next payment window:{' '}
                <span className="font-medium text-slate-900 dark:text-white">
                  {nextWindow.label}
                </span>
              </p>
            </div>
            <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
              Minimum payout: {CURRENCY_SYMBOL}
              {MINIMUM_PAYOUT_INR}
            </p>
          </div>

          {/* Live Progress Bar: ₹X / ₹200 */}
          <div className="mt-6">
            <div className="flex items-baseline justify-between text-sm">
              <span className="font-mono font-semibold tabular-nums text-slate-900 dark:text-white">
                {CURRENCY_SYMBOL}
                {payoutProgressRupees.toFixed(2)} / {CURRENCY_SYMBOL}
                {MINIMUM_PAYOUT_INR}
              </span>
              <span className="text-xs font-medium text-slate-600 dark:text-slate-300">
                {isEligibleForPayout
                  ? 'Eligible for the next payment window'
                  : `${formatInrFromPaise(remainingToMinPaise)} more to reach the minimum payout`}
              </span>
            </div>
            <div className="mt-2.5 h-3 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
              <div
                className={`h-full transition-[width] duration-300 ${
                  isEligibleForPayout ? 'bg-emerald-600' : 'bg-indigo-600'
                }`}
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>

          {/* Pending Balance (primary), Total Earned, Total Paid */}
          <div className="mt-6 grid grid-cols-1 gap-4 border-t border-slate-200 pt-5 sm:grid-cols-3 dark:border-slate-800">
            <div>
              <p className="text-xs text-slate-500 dark:text-slate-400">Pending balance</p>
              <p className="mt-1 font-mono text-lg font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">
                {formatInrFromPaise(wallet.pendingBalancePaise)}
              </p>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                +{perViewRateLabel} added here per verified view
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-500 dark:text-slate-400">Total earned</p>
              <p className="mt-1 font-mono text-lg font-semibold tabular-nums text-slate-900 dark:text-white">
                {formatInrFromPaise(wallet.totalEarnedPaise)}
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-500 dark:text-slate-400">Total paid</p>
              <p className="mt-1 font-mono text-lg font-semibold tabular-nums text-slate-900 dark:text-white">
                {formatInrFromPaise(wallet.totalPaidPaise)}
              </p>
            </div>
          </div>

          {/* Bank Account Section (Unlocks at ₹50) */}
          <div className="mt-6 border-t border-slate-200 pt-5 dark:border-slate-800">
            {!wallet.bankUnlocked ? (
              <div className="flex items-center gap-2.5 text-sm text-slate-600 dark:text-slate-400">
                <Lock className="h-4 w-4 shrink-0 text-slate-400" />
                <span>Reach {CURRENCY_SYMBOL}{BANK_UNLOCK_BALANCE_INR} to add your bank account.</span>
              </div>
            ) : (
              <div>
                <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                  <div className="flex items-center gap-2">
                    <Landmark className="h-4 w-4 text-slate-700 dark:text-slate-300" />
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
                      Bank account for payouts
                    </h3>
                  </div>

                  {!showBankForm && (
                    <button
                      type="button"
                      onClick={openBankEditor}
                      className="inline-flex h-9 cursor-pointer items-center justify-center rounded-lg border border-slate-300 bg-white px-4 text-xs font-semibold text-slate-900 transition-colors hover:bg-slate-100 whitespace-nowrap shrink-0 dark:border-slate-700 dark:bg-slate-950 dark:text-white dark:hover:bg-slate-800"
                    >
                      {wallet.bankAccount ? 'Change bank details' : 'Add bank account'}
                    </button>
                  )}
                </div>

                {bankSuccess && (
                  <div className="mt-3 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-200">
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                    <span>{bankSuccess}</span>
                  </div>
                )}

                {wallet.bankAccount && !showBankForm && (
                  <div className="mt-3 grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm sm:grid-cols-4 dark:border-slate-800 dark:bg-slate-950">
                    <div>
                      <p className="text-xs text-slate-500 dark:text-slate-400">Account holder</p>
                      <p className="mt-0.5 font-medium text-slate-900 dark:text-white">
                        {wallet.bankAccount.accountHolderName}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500 dark:text-slate-400">Account number</p>
                      <p className="mt-0.5 font-mono font-medium tabular-nums text-slate-900 dark:text-white">
                        {wallet.bankAccount.maskedAccountNumber}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500 dark:text-slate-400">IFSC code</p>
                      <p className="mt-0.5 font-mono font-medium text-slate-900 dark:text-white">
                        {wallet.bankAccount.ifscCode}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500 dark:text-slate-400">UPI ID</p>
                      <p className="mt-0.5 font-mono text-slate-900 dark:text-white">
                        {wallet.bankAccount.maskedUpiId || 'Not added'}
                      </p>
                    </div>
                  </div>
                )}

                {showBankForm && (
                  <form
                    onSubmit={handleBankSubmit}
                    className="mt-4 space-y-4 rounded-lg border border-slate-200 bg-slate-50 p-4 sm:p-5 dark:border-slate-800 dark:bg-slate-950"
                  >
                    {bankError && (
                      <div
                        role="alert"
                        className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200"
                      >
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>{bankError}</span>
                      </div>
                    )}

                    <div className="grid gap-4 sm:grid-cols-2">
                      <div>
                        <label
                          htmlFor="bank-holder"
                          className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                        >
                          Account holder name
                        </label>
                        <input
                          id="bank-holder"
                          type="text"
                          required
                          value={holderName}
                          onChange={(e) => setHolderName(e.target.value)}
                          placeholder="Full name on bank passbook"
                          className="mt-1 h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 focus:border-indigo-600 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-white"
                        />
                      </div>

                      <div>
                        <label
                          htmlFor="bank-ifsc"
                          className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                        >
                          IFSC code
                        </label>
                        <input
                          id="bank-ifsc"
                          type="text"
                          required
                          maxLength={11}
                          value={ifscCode}
                          onChange={(e) => setIfscCode(e.target.value.toUpperCase())}
                          placeholder="SBIN0001234"
                          className="mt-1 h-10 w-full rounded-lg border border-slate-300 bg-white px-3 font-mono text-sm uppercase text-slate-900 focus:border-indigo-600 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-white"
                        />
                      </div>

                      <div>
                        <label
                          htmlFor="bank-acc"
                          className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                        >
                          Account number (digits only)
                        </label>
                        <input
                          id="bank-acc"
                          type="password"
                          inputMode="numeric"
                          required
                          value={accountNumber}
                          onChange={(e) => setAccountNumber(e.target.value.replace(/\D/g, ''))}
                          placeholder="9 to 18 digits"
                          className="mt-1 h-10 w-full rounded-lg border border-slate-300 bg-white px-3 font-mono text-sm text-slate-900 focus:border-indigo-600 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-white"
                        />
                      </div>

                      <div>
                        <label
                          htmlFor="bank-acc-confirm"
                          className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                        >
                          Confirm account number
                        </label>
                        <input
                          id="bank-acc-confirm"
                          type="text"
                          inputMode="numeric"
                          required
                          value={confirmAccountNumber}
                          onChange={(e) =>
                            setConfirmAccountNumber(e.target.value.replace(/\D/g, ''))
                          }
                          placeholder="Re-enter account number"
                          className="mt-1 h-10 w-full rounded-lg border border-slate-300 bg-white px-3 font-mono text-sm text-slate-900 focus:border-indigo-600 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-white"
                        />
                      </div>

                      <div>
                        <label
                          htmlFor="bank-upi"
                          className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                        >
                          UPI ID (optional)
                        </label>
                        <input
                          id="bank-upi"
                          type="text"
                          value={upiId}
                          onChange={(e) => setUpiId(e.target.value)}
                          placeholder="yourname@upi"
                          className="mt-1 h-10 w-full rounded-lg border border-slate-300 bg-white px-3 font-mono text-sm text-slate-900 focus:border-indigo-600 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-white"
                        />
                      </div>

                      {wallet.bankAccount && (
                        <div className="sm:col-span-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
                          When you click Save bank account, you will be asked to confirm your Gmail
                          account (<span className="font-mono font-medium">{user.email}</span>) via
                          Google.
                        </div>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-3 pt-1">
                      <button
                        type="submit"
                        disabled={savingBank}
                        className="inline-flex h-10 cursor-pointer items-center justify-center rounded-lg bg-indigo-600 px-5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60"
                      >
                        {savingBank ? 'Saving securely...' : 'Save bank account'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setShowBankForm(false);
                          setBankError('');
                        }}
                        className="inline-flex h-10 cursor-pointer items-center justify-center rounded-lg border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Payout History Table */}
        <div className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4 dark:border-slate-800">
            <h3 className="text-base font-semibold text-slate-900 dark:text-white">
              Payout history
            </h3>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              Minimum {CURRENCY_SYMBOL}
              {MINIMUM_PAYOUT_INR}
            </span>
          </div>

          {loadingData ? (
            <div className="p-5">
              <div className="h-11 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800" />
            </div>
          ) : wallet.payouts.length === 0 ? (
            <div className="px-5 py-8 text-center text-sm text-slate-600 dark:text-slate-400">
              No payouts yet. Once your balance reaches {CURRENCY_SYMBOL}
              {MINIMUM_PAYOUT_INR}, your payout will appear here for the next window.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs font-medium text-slate-500 dark:border-slate-800 dark:text-slate-400">
                    <th className="px-5 py-3">Date / Window</th>
                    <th className="px-5 py-3">Account</th>
                    <th className="px-5 py-3 text-right">Amount</th>
                    <th className="px-5 py-3 text-right">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {wallet.payouts.map((row) => (
                    <tr key={row.id}>
                      <td className="px-5 py-3.5 text-slate-800 dark:text-slate-200">
                        {row.status === 'Paid'
                          ? new Date(row.date).toLocaleDateString('en-IN', {
                              day: 'numeric',
                              month: 'short',
                              year: 'numeric',
                            })
                          : row.windowLabel}
                      </td>
                      <td className="px-5 py-3.5 font-mono text-xs text-slate-600 dark:text-slate-400">
                        {row.bankMasked}
                      </td>
                      <td className="px-5 py-3.5 text-right font-mono font-semibold tabular-nums text-slate-900 dark:text-white">
                        {formatInrFromPaise(row.amountPaise)}
                      </td>
                      <td
                        className={`px-5 py-3.5 text-right text-xs font-semibold ${
                          row.status === 'Paid'
                            ? 'text-emerald-700 dark:text-emerald-400'
                            : 'text-amber-700 dark:text-amber-400'
                        }`}
                      >
                        {row.status}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* My Links Table */}
        <div
          id="my-links"
          className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-5 py-4 dark:border-slate-800">
            <div>
              <h3 className="text-base font-semibold text-slate-900 dark:text-white">My links</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                1 view (+{perViewRateLabel} for India traffic) is counted automatically as soon as a visitor finishes watching all ads.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
                {summary.links.length} {summary.links.length === 1 ? 'link' : 'links'}
              </span>
              <button
                type="button"
                disabled={refreshingStats}
                onClick={handleRefreshStats}
                className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                <RotateCw className={`h-3.5 w-3.5 ${refreshingStats ? 'animate-spin' : ''}`} />
                <span>Refresh views</span>
              </button>
            </div>
          </div>

          {loadingData ? (
            <div className="space-y-3 p-5">
              {[1, 2, 3].map((row) => (
                <div
                  key={row}
                  className="h-11 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800"
                />
              ))}
            </div>
          ) : summary.links.length === 0 ? (
            <div className="px-5 py-10 text-center">
              <p className="text-sm font-medium text-slate-900 dark:text-white">
                You have not shortened any links yet
              </p>
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                Paste any website URL in the box at the top and click Shorten to create your first
                link.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs font-medium text-slate-500 dark:border-slate-800 dark:text-slate-400">
                    <th className="px-4 py-3">Short link</th>
                    <th className="px-4 py-3 text-right">Clicks</th>
                    <th className="px-4 py-3 text-right">Views</th>
                    <th className="px-4 py-3 text-right">Invalid & blocked</th>
                    <th className="px-4 py-3 text-right">Earned ({perViewRateLabel}/view)</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {summary.links.map((link) => {
                    const shortUrl = getFullShortUrl(link.code);
                    const isCopied = copiedId === `row-${link.id}`;
                    return (
                      <tr
                        key={link.id}
                        className="transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/40"
                      >
                        <td className="px-4 py-3.5">
                          <p className="font-mono text-xs font-medium text-indigo-700 whitespace-nowrap dark:text-indigo-400">
                            /s/{link.code}
                          </p>
                          <p className="max-w-[220px] truncate text-xs text-slate-500 dark:text-slate-400">
                            {link.originalUrl}
                          </p>
                        </td>
                        <td className="px-4 py-3.5 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                          {link.totalLinkClicks}
                        </td>
                        <td className="px-4 py-3.5 text-right font-mono font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">
                          {link.clicks}
                        </td>
                        <td className="px-4 py-3.5 text-right font-mono tabular-nums text-amber-700 dark:text-amber-400">
                          {link.invalidViews}
                        </td>
                        <td className="px-4 py-3.5 text-right font-mono tabular-nums text-emerald-700 dark:text-emerald-400">
                          {formatInrFromPaise(link.earningsPaise)}
                        </td>
                        <td className="px-4 py-3.5 text-right whitespace-nowrap">
                          <div className="inline-flex items-center justify-end gap-1.5">
                            <button
                              type="button"
                              disabled={loadingAnalytics}
                              onClick={() => handleOpenAnalytics(link.id)}
                              title="View detailed ad analytics for this short link"
                              className="inline-flex h-8 cursor-pointer items-center gap-1 rounded-md border border-indigo-200 bg-indigo-50 px-2.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100 disabled:opacity-60 dark:border-indigo-900/60 dark:bg-indigo-950/40 dark:text-indigo-300 dark:hover:bg-indigo-950/60"
                            >
                              <BarChart3 className="h-3.5 w-3.5" />
                              <span>Stats</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => handleCopy(shortUrl, `row-${link.id}`)}
                              className="inline-flex h-8 cursor-pointer items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                            >
                              {isCopied ? (
                                <>
                                  <Check className="h-3.5 w-3.5 text-emerald-600" />
                                  <span>Copied!</span>
                                </>
                              ) : (
                                <>
                                  <Copy className="h-3.5 w-3.5" />
                                  <span>Copy</span>
                                </>
                              )}
                            </button>
                            <button
                              type="button"
                              onClick={() => onOpenVisitorTest(link.code)}
                              title="Test visitor ad flow"
                              className="inline-flex h-8 cursor-pointer items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                            >
                              <ExternalLink className="h-3.5 w-3.5" />
                              <span>Open</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteLink(link.id)}
                              aria-label="Delete short link"
                              title="Delete link"
                              className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40 dark:hover:text-red-400"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Per-Link Advertisement Analytics Modal */}
        {analyticsDetail && (
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="link-analytics-title"
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-xs"
          >
            <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-800 dark:bg-slate-900">
              <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-4 dark:border-slate-800">
                <div className="min-w-0">
                  <h4
                    id="link-analytics-title"
                    className="font-mono text-base font-bold text-slate-900 dark:text-white"
                  >
                    /s/{analyticsDetail.link.code} — Advertisement Analytics
                  </h4>
                  <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">
                    {analyticsDetail.link.originalUrl}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setAnalyticsDetail(null)}
                  aria-label="Close analytics modal"
                  className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-slate-800 dark:hover:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="space-y-6 overflow-y-auto p-6">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-950">
                    <p className="text-xs text-slate-500 dark:text-slate-400">Clicks</p>
                    <p className="mt-1 font-mono text-lg font-bold tabular-nums text-slate-900 dark:text-white">
                      {analyticsDetail.link.totalLinkClicks}
                    </p>
                  </div>
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-950">
                    <p className="text-xs text-slate-500 dark:text-slate-400">Views (all ads watched)</p>
                    <p className="mt-1 font-mono text-lg font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
                      {analyticsDetail.link.clicks}
                    </p>
                  </div>
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-950">
                    <p className="text-xs text-slate-500 dark:text-slate-400">Invalid & blocked</p>
                    <p className="mt-1 font-mono text-lg font-bold tabular-nums text-amber-700 dark:text-amber-400">
                      {analyticsDetail.link.invalidViews}
                    </p>
                  </div>
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-950">
                    <p className="text-xs text-slate-500 dark:text-slate-400">Earned ({perViewRateLabel}/view)</p>
                    <p className="mt-1 font-mono text-lg font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
                      {formatInrFromPaise(analyticsDetail.link.earningsPaise)}
                    </p>
                  </div>
                </div>

                <p className="text-xs tabular-nums text-slate-500 dark:text-slate-400">
                  Paid India views: {analyticsDetail.link.paidClicks} · Duplicates: {analyticsDetail.link.duplicateViews} · Bots blocked: {analyticsDetail.link.botDetections}
                </p>

                {analyticsDetail.recentEvents.length > 0 && (
                  <div>
                    <h5 className="text-sm font-semibold text-slate-900 dark:text-white">
                      Recent Activity & Blocked Checks
                    </h5>
                    <div className="mt-2 overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
                      <table className="w-full text-left text-xs">
                        <thead>
                          <tr className="border-b border-slate-200 bg-slate-50 text-slate-500 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-400">
                            <th className="px-3 py-2">Event</th>
                            <th className="px-3 py-2">Status</th>
                            <th className="px-3 py-2">Reason</th>
                            <th className="px-3 py-2 text-right">Time</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                          {analyticsDetail.recentEvents.map((ev) => (
                            <tr key={ev.id}>
                              <td className="px-3 py-2 font-mono font-medium text-slate-900 dark:text-white">
                                {ev.eventType}
                              </td>
                              <td
                                className={`px-3 py-2 font-semibold ${
                                  ev.status === 'accepted'
                                    ? 'text-emerald-700 dark:text-emerald-400'
                                    : 'text-red-700 dark:text-red-400'
                                }`}
                              >
                                {ev.status}
                              </td>
                              <td className="px-3 py-2 font-mono text-slate-500 dark:text-slate-400">
                                {ev.reason || '—'}
                              </td>
                              <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-500 dark:text-slate-400">
                                {new Date(ev.createdAt).toLocaleTimeString('en-IN')}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </section>

      <hr className="border-slate-200 dark:border-slate-800" />

      {/* d. INFO SECTION (RPM ONLY, INDIA-ONLY, PAYMENT SCHEDULE, HOW IT WORKS, FAQ) */}
      <section id="rpm-rates" className="space-y-6" aria-labelledby="rpm-heading">
        <div>
          <h2
            id="rpm-heading"
            className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white"
          >
            Earnings & RPM Rate (India)
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-600 sm:text-base dark:text-slate-300">
            RPM = what you earn per 1,000 views. {INDIA_ONLY_NOTICE}
          </p>
        </div>

        {/* Single India Rate Card */}
        <div className="rounded-xl border border-slate-200 bg-white p-6 sm:p-7 dark:border-slate-800 dark:bg-slate-900">
          <p className="text-xs font-semibold uppercase tracking-wide text-indigo-600 dark:text-indigo-400">
            Current payout rate
          </p>
          <p className="mt-2 font-mono text-2xl font-bold tabular-nums text-slate-900 sm:text-3xl dark:text-white">
            {primaryRpmLabel}
          </p>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
            {perViewRateLabel} per verified India view · {RPM_ESTIMATE_NOTE}
          </p>

          <div className="mt-5 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm leading-relaxed text-slate-700 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300">
            <strong className="font-semibold text-slate-900 dark:text-white">Simple example:</strong>{' '}
            At{' '}
            <span className="font-mono font-semibold text-slate-900 dark:text-white">
              {perViewRateLabel}
            </span>{' '}
            per view (RPM{' '}
            <span className="font-mono font-semibold text-slate-900 dark:text-white">
              {CURRENCY_SYMBOL}
              {activeRate.defaultRpmInr}
            </span>
            ), 1,000 verified visitors from India who watch all ads and click Get Link earn you{' '}
            <span className="font-mono font-semibold text-slate-900 dark:text-white">
              {CURRENCY_SYMBOL}
              {activeRate.defaultRpmInr}
            </span>
            . Visitors from outside India can still use your short links normally, but only views
            from India are paid at present.
          </div>
        </div>
      </section>

      {/* How It Works Step by Step */}
      <section id="how-it-works" className="space-y-6" aria-labelledby="how-heading">
        <div>
          <h2
            id="how-heading"
            className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white"
          >
            How it works, step by step
          </h2>
          <p className="mt-2 text-sm text-slate-600 sm:text-base dark:text-slate-300">
            Clear and honest from start to finish — no fake download buttons or hidden redirects.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            {
              step: '01',
              title: 'Create a short link',
              desc: 'Paste any valid web address above and click Shorten to generate your unique link.',
            },
            {
              step: '02',
              title: 'Share it anywhere',
              desc: 'Post your short link in YouTube descriptions, blogs, Telegram groups, or social profiles.',
            },
            {
              step: '03',
              title: 'Visitor watches all ads',
              desc: 'Visitors watch the full-screen rewarded ads through 3 pages. As soon as the last ad finishes, 1 view is counted automatically.',
            },
            {
              step: '04',
              title: 'Added to pending balance',
              desc: `When a verified visitor from India completes all ads, ${perViewRateLabel} is added to your pending wallet balance immediately.`,
            },
          ].map((item) => (
            <div
              key={item.step}
              className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900"
            >
              <p className="font-mono text-xs font-semibold text-indigo-600 dark:text-indigo-400">
                Step {item.step}
              </p>
              <h3 className="mt-2 text-base font-semibold text-slate-900 dark:text-white">
                {item.title}
              </h3>
              <p className="mt-1.5 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
                {item.desc}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Earnings & Twice-Monthly Payment Schedule */}
      <section className="space-y-5" aria-labelledby="payouts-heading">
        <div>
          <h2
            id="payouts-heading"
            className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white"
          >
            Earnings and payment schedule
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-600 sm:text-base dark:text-slate-300">
            Payments are sent twice every month directly to your saved Indian bank account or UPI.
            Minimum payout:{' '}
            <span className="font-mono font-semibold text-slate-900 dark:text-white">
              {CURRENCY_SYMBOL}
              {MINIMUM_PAYOUT_INR}
            </span>
            . If your balance is under {CURRENCY_SYMBOL}
            {MINIMUM_PAYOUT_INR}, it carries forward automatically to the next window.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
              Payment Window 1
            </h3>
            <p className="mt-2 font-mono text-lg font-bold text-slate-900 dark:text-white">
              {PAYMENT_WINDOWS[0].label} of every month
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
              Payment Window 2
            </h3>
            <p className="mt-2 font-mono text-lg font-bold text-slate-900 dark:text-white">
              {PAYMENT_WINDOWS[1].label} of every month
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
              Next payment window
            </h3>
            <p className="mt-2 text-base font-semibold text-indigo-700 dark:text-indigo-400">
              {nextWindow.label}
            </p>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="space-y-4 pb-8" aria-labelledby="faq-heading">
        <h2
          id="faq-heading"
          className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white"
        >
          Frequently asked questions
        </h2>

        <div className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
          {faqItems.map((item, idx) => {
            const isOpen = openFaqIndex === idx;
            return (
              <div key={item.question}>
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => setOpenFaqIndex(isOpen ? null : idx)}
                  className="flex w-full cursor-pointer items-center justify-between gap-4 px-5 py-4 text-left text-sm font-semibold text-slate-900 transition-colors hover:bg-slate-50 dark:text-white dark:hover:bg-slate-800/40"
                >
                  <span>{item.question}</span>
                  <ChevronDown
                    className={`h-4 w-4 shrink-0 text-slate-500 transition-transform duration-200 ${
                      isOpen ? 'rotate-180' : ''
                    }`}
                  />
                </button>
                {isOpen && (
                  <p className="px-5 pb-4 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
                    {item.answer}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </main>
  );
}
