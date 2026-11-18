/**
 * ============================================================================
 * VISITOR AD FLOW (src/components/VisitorFlow.tsx)
 * ============================================================================
 *
 * Runs when someone opens a short link (/s/:code):
 * - Step A: Full-screen muted autoplay video ad immediately on open -> Page 1
 * - Pages 1, 2, 3: Each page has an honest "Next" button.
 *     * Clicking "Next" plays 1 full-screen Rewarded Video Ad, then returns to the same page.
 *     * After 3 ads on that page finish, "Next" becomes "Next Page".
 * - Final Page: 1 small image/banner ad (labelled "Ad") + "Get Link" button below.
 * - Progress cannot be skipped: every step is checked by the server using a
 *   one-time session token and minimum watch-time enforcement.
 */

import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, ArrowRight, ExternalLink, RotateCw, ShieldCheck } from 'lucide-react';
import { AD_CONFIG } from '../config/ads';
import { dispatchVastBeacons } from '../lib/adProvider';
import {
  advanceVisitorPage,
  completeVisitorAd,
  startVisitorSession,
  unlockDestinationLink,
} from '../lib/api';
import type { VisitorSessionState } from '../types';
import { AdPlayer } from './AdPlayer';

interface VisitorFlowProps {
  code: string;
  onExitHome: () => void;
}

export function VisitorFlow({ code, onExitHome }: VisitorFlowProps) {
  const [session, setSession] = useState<VisitorSessionState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [honeypot, setHoneypot] = useState('');

  // Controls whether a step video ad (on Page 1, 2, or 3) is currently playing
  const [watchingStepAd, setWatchingStepAd] = useState(false);
  const [adStartTimestamp, setAdStartTimestamp] = useState<number>(0);
  const [busy, setBusy] = useState(false);
  const [redirectingUrl, setRedirectingUrl] = useState('');
  const [promoImgFailed, setPromoImgFailed] = useState(false);
  const [bannerImgFailed, setBannerImgFailed] = useState(false);

  const initSession = useCallback(async () => {
    setLoading(true);
    setError('');
    setWatchingStepAd(false);
    try {
      const state = await startVisitorSession(code, honeypot);
      setSession(state);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to open this short link.');
    } finally {
      setLoading(false);
    }
  }, [code, honeypot]);

  useEffect(() => {
    initSession();
  }, [initSession]);

  useEffect(() => {
    if (session?.stage === 'final' && AD_CONFIG.finalBannerAd.impressionTrackingUrl) {
      dispatchVastBeacons([AD_CONFIG.finalBannerAd.impressionTrackingUrl]);
    }
  }, [session?.stage]);

  // Triggered when the Step A full-screen ad finishes
  const handleIntroAdComplete = useCallback(
    async (adAttemptId?: string) => {
      if (!session) return;
      setBusy(true);
      setError('');
      try {
        const nextState = await completeVisitorAd(session.sessionToken, honeypot, adAttemptId);
        setSession(nextState);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not verify intro ad.');
      } finally {
        setBusy(false);
      }
    },
    [session, honeypot]
  );

  // Triggered when the visitor clicks "Next" on Pages 1, 2, or 3
  function handleStartStepAd() {
    setError('');
    setAdStartTimestamp(Date.now());
    setWatchingStepAd(true);
  }

  // Triggered when one step video ad finishes
  const handleStepAdComplete = useCallback(
    async (adAttemptId?: string) => {
      if (!session) return;
      setBusy(true);
      setError('');
      try {
        // Ensure at least minWatchSeconds elapsed even if user tab throttled timers
        const elapsed = Date.now() - adStartTimestamp;
        const requiredMs = session.minWatchSeconds * 1000;
        if (elapsed < requiredMs && !adAttemptId) {
          await new Promise((r) => setTimeout(r, requiredMs - elapsed));
        }
        const nextState = await completeVisitorAd(session.sessionToken, honeypot, adAttemptId);
        setSession(nextState);
        setWatchingStepAd(false);
      } catch (err) {
        setWatchingStepAd(false);
        setError(err instanceof Error ? err.message : 'Please watch the full ad to continue.');
      } finally {
        setBusy(false);
      }
    },
    [session, adStartTimestamp, honeypot]
  );

  // Triggered when 3 ads on the current page are done and visitor clicks "Next Page"
  async function handleNextPage() {
    if (!session) return;
    setBusy(true);
    setError('');
    try {
      const nextState = await advanceVisitorPage(session.sessionToken, honeypot);
      setSession(nextState);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not move to the next page.');
    } finally {
      setBusy(false);
    }
  }

  // Triggered on Final Page when visitor clicks "Get Link"
  async function handleGetLink() {
    if (!session) return;
    setBusy(true);
    setError('');
    try {
      const result = await unlockDestinationLink(session.sessionToken, honeypot);
      setRedirectingUrl(result.originalUrl);
      window.location.href = result.originalUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not unlock link. Please try again.');
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="mx-auto flex min-h-[70vh] max-w-xl flex-col items-center justify-center px-4 text-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-300 border-t-indigo-600 dark:border-slate-700 dark:border-t-indigo-400" />
        <p className="mt-4 text-sm text-slate-600 dark:text-slate-400">
          Preparing your link...
        </p>
      </div>
    );
  }

  if (error && !session) {
    return (
      <div className="mx-auto flex min-h-[70vh] max-w-md items-center px-4">
        <div className="w-full rounded-xl border border-slate-200 bg-white p-6 text-center dark:border-slate-800 dark:bg-slate-900">
          <AlertCircle className="mx-auto h-8 w-8 text-red-600 dark:text-red-400" />
          <h1 className="mt-3 text-lg font-semibold text-slate-900 dark:text-white">
            Link unavailable
          </h1>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{error}</p>
          <div className="mt-6 flex justify-center gap-3">
            <button
              type="button"
              onClick={initSession}
              className="inline-flex h-10 cursor-pointer items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 text-sm font-medium text-slate-800 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <RotateCw className="h-4 w-4" />
              <span>Retry</span>
            </button>
            <button
              type="button"
              onClick={onExitHome}
              className="inline-flex h-10 cursor-pointer items-center rounded-lg bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-700"
            >
              Go Home
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!session) return null;

  // STEP A: Full-screen video ad immediately upon arrival
  if (session.stage === 'intro') {
    return (
      <>
        <input
          type="text"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          value={honeypot}
          onChange={(e) => setHoneypot(e.target.value)}
          className="hidden"
          aria-hidden="true"
        />
        <AdPlayer
          sessionToken={session.sessionToken}
          honeypot={honeypot}
          config={AD_CONFIG.fullscreenIntroVideoAd}
          variant="fullscreen"
          minWatchSeconds={session.minWatchSeconds}
          title="Opening Rewarded Ad"
          rewardHint="Page 1 of 3 will open automatically when this rewarded ad finishes."
          onComplete={handleIntroAdComplete}
          completing={busy}
        />
      </>
    );
  }

  // FINAL PAGE: Clickable Telegram promo image above "Get Link", and Ad slot below "Get Link"
  if (session.stage === 'final') {
    const promo = AD_CONFIG.finalTopPromo;
    const banner = AD_CONFIG.finalBannerAd;
    return (
      <main className="mx-auto max-w-2xl px-4 py-12 sm:px-6">
        <input
          type="text"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          value={honeypot}
          onChange={(e) => setHoneypot(e.target.value)}
          className="hidden"
          aria-hidden="true"
        />

        <div className="mb-6 flex items-center gap-2 text-xs font-medium text-slate-500 dark:text-slate-400">
          <span>Final Step</span>
          <span aria-hidden="true">·</span>
          <span>Link Ready</span>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-6 sm:p-8 dark:border-slate-800 dark:bg-slate-900">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
            Your destination link is ready
          </h1>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
            All ads are complete and your view has been counted. Click <strong className="font-semibold text-slate-900 dark:text-white">Get Link</strong> below to open your destination link.
          </p>

          {/* Clickable image above Get Link -> opens https://t.me/kamaolink */}
          {!promoImgFailed && promo.imageUrl && (
            <div className="mt-6 overflow-hidden rounded-lg border border-slate-200 bg-slate-100 dark:border-slate-800 dark:bg-slate-950">
              <a
                href={promo.clickThroughUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="block cursor-pointer"
                aria-label={promo.altText}
              >
                <img
                  src={promo.imageUrl}
                  alt={promo.altText}
                  referrerPolicy="no-referrer"
                  onError={() => setPromoImgFailed(true)}
                  className="mx-auto max-h-80 w-full object-contain"
                />
              </a>
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="mt-5 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Honest Get Link button */}
          <div className="mt-6">
            <button
              type="button"
              disabled={busy}
              onClick={handleGetLink}
              className="inline-flex h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-indigo-600 px-6 text-base font-semibold text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span>
                {redirectingUrl
                  ? 'Opening destination...'
                  : busy
                    ? 'Unlocking destination...'
                    : 'Get Link'}
              </span>
              <ExternalLink className="h-4 w-4" />
            </button>

            {redirectingUrl && (
              <p className="mt-3 text-center text-xs text-slate-500 dark:text-slate-400">
                If your browser does not redirect automatically,{' '}
                <a href={redirectingUrl} className="font-medium text-indigo-600 underline">
                  click here to open the destination
                </a>
                .
              </p>
            )}
          </div>

          {/* Banner Ad slot below Get Link */}
          <div className="mt-8 border-t border-slate-200 pt-6 dark:border-slate-800">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              {banner.label || 'Ad'}
            </p>

            {banner.customHtml.trim() ? (
              <div
                className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800"
                dangerouslySetInnerHTML={{ __html: banner.customHtml }}
              />
            ) : (
              <div className="overflow-hidden rounded-lg border border-slate-200 bg-slate-100 dark:border-slate-800 dark:bg-slate-950">
                {!bannerImgFailed && banner.imageUrl ? (
                  banner.clickThroughUrl ? (
                    <a
                      href={banner.clickThroughUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block"
                    >
                      <img
                        src={banner.imageUrl}
                        alt={banner.altText}
                        referrerPolicy="no-referrer"
                        onError={() => setBannerImgFailed(true)}
                        className="mx-auto max-h-80 w-full object-contain"
                      />
                    </a>
                  ) : (
                    <img
                      src={banner.imageUrl}
                      alt={banner.altText}
                      referrerPolicy="no-referrer"
                      onError={() => setBannerImgFailed(true)}
                      className="mx-auto max-h-80 w-full object-contain"
                    />
                  )
                ) : (
                  <div className="flex h-36 flex-col items-center justify-center px-4 text-center">
                    <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
                      Ad Slot
                    </span>
                    <span className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                      Banner ad space below Get Link (configure in src/config/ads.ts)
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </main>
    );
  }

  // PAGES 1, 2, AND 3
  const pageDone = session.adsWatchedOnPage >= session.adsPerPage;
  const pagePct = Math.round((session.adsWatchedOnPage / session.adsPerPage) * 100);

  return (
    <main className="mx-auto max-w-2xl px-4 py-12 sm:px-6">
      <input
        type="text"
        name="website"
        tabIndex={-1}
        autoComplete="off"
        value={honeypot}
        onChange={(e) => setHoneypot(e.target.value)}
        className="hidden"
        aria-hidden="true"
      />

      {/* Clean unboxed progress line: e.g. "Page 2 of 3 · Ad 1 of 3" */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-2 text-sm text-slate-600 dark:text-slate-400">
        <div className="flex items-center gap-2 font-medium tabular-nums text-slate-900 dark:text-white">
          <span>
            Page {session.pageNumber} of {session.totalPages}
          </span>
          <span aria-hidden="true" className="text-slate-400">
            ·
          </span>
          <span>
            Ad {session.adsWatchedOnPage} of {session.adsPerPage}
          </span>
        </div>

        <span className="inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
          <ShieldCheck className="h-3.5 w-3.5" />
          <span>Verified step</span>
        </span>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-6 sm:p-8 dark:border-slate-800 dark:bg-slate-900">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
          Page {session.pageNumber} of {session.totalPages}
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
          {pageDone
            ? 'All 3 rewarded ads on this page are complete. Click Next Page to continue.'
            : `Click Next to watch 1 full-screen rewarded video ad (${session.adsPerPage - session.adsWatchedOnPage} remaining on this page).`}
        </p>

        {/* Visual progress bar for the 3 ads on this page */}
        <div className="mt-5 grid grid-cols-3 gap-2" aria-label={`Page ${session.pageNumber} ad progress`}>
          {[1, 2, 3].map((slot) => (
            <div
              key={slot}
              className={`h-2 rounded-full transition-colors ${
                session.adsWatchedOnPage >= slot
                  ? 'bg-emerald-600 dark:bg-emerald-500'
                  : 'bg-slate-200 dark:bg-slate-800'
              }`}
            />
          ))}
        </div>
        <p className="mt-2 text-xs tabular-nums text-slate-500 dark:text-slate-400">
          {pagePct}% of Page {session.pageNumber} complete
        </p>

        {error && (
          <div
            role="alert"
            className="mt-5 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Full-screen Rewarded Video Ad shown when visitor clicks "Next" */}
        {watchingStepAd && (
          <AdPlayer
            sessionToken={session.sessionToken}
            honeypot={honeypot}
            config={AD_CONFIG.stepVideoAd}
            variant="fullscreen"
            minWatchSeconds={session.minWatchSeconds}
            title={`Rewarded Ad · Page ${session.pageNumber} (${session.adsWatchedOnPage + 1} of ${session.adsPerPage})`}
            rewardHint={`Returning to Page ${session.pageNumber} automatically once your reward unlocks.`}
            onComplete={handleStepAdComplete}
            completing={busy}
          />
        )}

        <div className="mt-8">
            {pageDone ? (
              <button
                type="button"
                disabled={busy}
                onClick={handleNextPage}
                className="inline-flex h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-emerald-600 px-6 text-base font-semibold text-white transition-colors hover:bg-emerald-700 disabled:opacity-60"
              >
                <span>{busy ? 'Loading next page...' : 'Next Page'}</span>
                <ArrowRight className="h-4 w-4" />
              </button>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={handleStartStepAd}
                className="inline-flex h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-indigo-600 px-6 text-base font-semibold text-white transition-colors hover:bg-indigo-700 disabled:opacity-60"
              >
                <span>Next</span>
                <ArrowRight className="h-4 w-4" />
              </button>
            )}
          </div>
      </div>
    </main>
  );
}
