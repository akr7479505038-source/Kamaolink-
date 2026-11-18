/**
 * ============================================================================
 * REUSABLE FULL-SCREEN REWARDED VIDEO AD PLAYER (src/components/AdPlayer.tsx)
 * ============================================================================
 *
 * Official VAST / Provider Tracking & Backend Verification Flow:
 * 1. Resolves IAB VAST 2.0/3.0/4.x tags via `/api/vast/resolve` (if vastTagUrl is set)
 *    or loads direct MP4/WebM (`videoUrl`), or listens to official ad provider
 *    events via `window.LinkMintAdTracker`.
 * 2. Registers a one-time `adAttemptId` on the backend (`/api/visit/ad-attempt`).
 * 3. Emits genuine DOM/VAST lifecycle events (`impression`, `start`, quartiles,
 *    `complete`, `skip`, `fail`) once per attempt, firing both official VAST
 *    beacons and backend verification (`/api/visit/ad-event`).
 * 4. When no ad provider is configured (placeholder preview), clearly displays
 *    preview mode and NEVER generates fake ad views or fake impressions.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, FastForward, Volume2, VolumeX } from 'lucide-react';
import type { VideoAdSlotConfig } from '../config/ads';
import { adProviderTracker, dispatchVastBeacons } from '../lib/adProvider';
import { resolveVastTagClient, startAdAttempt, trackAdEvent } from '../lib/api';
import type { AdEventType, AdSourceType, ResolvedVastPayload } from '../types';

interface AdPlayerProps {
  sessionToken: string;
  honeypot?: string;
  config: VideoAdSlotConfig;
  variant?: 'fullscreen' | 'inline';
  minWatchSeconds: number;
  title?: string;
  rewardHint?: string;
  onComplete: (adAttemptId?: string) => void;
  completing?: boolean;
}

export function AdPlayer({
  sessionToken,
  honeypot = '',
  config,
  variant = 'fullscreen',
  minWatchSeconds,
  title = 'Rewarded Video',
  rewardHint,
  onComplete,
  completing = false,
}: AdPlayerProps) {
  const durationSec = Math.max(minWatchSeconds, config.durationSeconds || minWatchSeconds);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [resolvedVideoUrl, setResolvedVideoUrl] = useState<string>(config.videoUrl || '');
  const [resolvedClickUrl, setResolvedClickUrl] = useState<string>(config.clickThroughUrl || '');
  const [skipAfterSec, setSkipAfterSec] = useState<number>(config.skipAfterSeconds || 0);
  const [vastPayload, setVastPayload] = useState<ResolvedVastPayload | null>(null);
  const [adSource, setAdSource] = useState<AdSourceType>(() => {
    if (config.vastTagUrl) return 'vast';
    if (config.videoUrl) return 'video';
    return 'placeholder';
  });
  const [ready, setReady] = useState(false);
  const [finished, setFinished] = useState(false);
  const [muted, setMuted] = useState(true);
  const [adErrorMsg, setAdErrorMsg] = useState('');

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const attemptIdRef = useRef<string>('');
  const firedEventsRef = useRef<Set<AdEventType>>(new Set());
  const hasCompletedRef = useRef(false);
  const vastPayloadRef = useRef<ResolvedVastPayload | null>(null);

  useEffect(() => {
    vastPayloadRef.current = vastPayload;
  }, [vastPayload]);

  // Send a deduplicated event to official VAST beacons + backend verification
  const emitVerifiedEvent = useCallback(
    async (eventType: AdEventType) => {
      if (firedEventsRef.current.has(eventType)) return;
      firedEventsRef.current.add(eventType);

      const vp = vastPayloadRef.current;
      if (vp) {
        if (eventType === 'impression') dispatchVastBeacons(vp.impressions);
        else if (eventType === 'start') dispatchVastBeacons(vp.tracking.start);
        else if (eventType === 'firstQuartile') dispatchVastBeacons(vp.tracking.firstQuartile);
        else if (eventType === 'midpoint') dispatchVastBeacons(vp.tracking.midpoint);
        else if (eventType === 'thirdQuartile') dispatchVastBeacons(vp.tracking.thirdQuartile);
        else if (eventType === 'complete') dispatchVastBeacons(vp.tracking.complete);
        else if (eventType === 'skip') dispatchVastBeacons(vp.tracking.skip);
        else if (eventType === 'fail') dispatchVastBeacons(vp.errors);
      }

      const attemptId = attemptIdRef.current;
      if (!attemptId) return;

      try {
        await trackAdEvent({
          sessionToken,
          adAttemptId: attemptId,
          eventType,
          honeypot,
        });
      } catch {
        // Backend rejects tampered/bot/out-of-order events; keep UI resilient
      }
    },
    [sessionToken, honeypot]
  );

  // Initialize VAST resolution + register backend adAttemptId
  useEffect(() => {
    let active = true;
    firedEventsRef.current = new Set();
    hasCompletedRef.current = false;
    attemptIdRef.current = '';
    setElapsedMs(0);
    setFinished(false);
    setAdErrorMsg('');

    async function setupAd() {
      let source: AdSourceType = config.vastTagUrl
        ? 'vast'
        : config.videoUrl
          ? 'video'
          : 'placeholder';
      let nextVideoUrl = config.videoUrl || '';
      let nextClickUrl = config.clickThroughUrl || '';
      let nextSkipSec = config.skipAfterSeconds || 0;
      let vastFailed = false;

      if (config.vastTagUrl) {
        try {
          const parsed = await resolveVastTagClient(config.vastTagUrl, honeypot);
          if (!active) return;
          setVastPayload(parsed);
          vastPayloadRef.current = parsed;

          if (parsed.hasAd && parsed.mediaUrl) {
            nextVideoUrl = parsed.mediaUrl;
            if (parsed.clickThroughUrl) nextClickUrl = parsed.clickThroughUrl;
            if (parsed.skipAfterSeconds !== null) nextSkipSec = parsed.skipAfterSeconds;
          } else {
            vastFailed = true;
          }
        } catch {
          vastFailed = true;
        }
      }

      if (!active) return;
      setAdSource(source);
      setResolvedVideoUrl(nextVideoUrl);
      setResolvedClickUrl(nextClickUrl);
      setSkipAfterSec(nextSkipSec);

      try {
        const attempt = await startAdAttempt({
          sessionToken,
          adSource: source,
          providerName: source === 'vast' ? 'IAB_VAST' : source === 'video' ? 'Direct_Video' : 'Preview',
          honeypot,
        });
        if (!active) return;
        attemptIdRef.current = attempt.adAttemptId;
      } catch {
        // Keep flow safe if attempt registration fails
      }

      if (!active) return;

      if (vastFailed) {
        setAdErrorMsg('Ad provider returned no playable ad (recorded as Failed event).');
        await emitVerifiedEvent('fail');
        if (!hasCompletedRef.current) {
          hasCompletedRef.current = true;
          setFinished(true);
          onComplete(attemptIdRef.current || undefined);
        }
        return;
      }

      setReady(true);
    }

    setupAd();

    return () => {
      active = false;
    };
  }, [config.vastTagUrl, config.videoUrl, config.clickThroughUrl, config.skipAfterSeconds, sessionToken, honeypot, emitVerifiedEvent, onComplete]);

  // Listen to official third-party Ad Provider SDK bridge (`window.LinkMintAdTracker`)
  useEffect(() => {
    const unsubscribe = adProviderTracker.subscribe(async ({ eventType }) => {
      await emitVerifiedEvent(eventType);
      if (
        (eventType === 'complete' || eventType === 'skip' || eventType === 'fail') &&
        !hasCompletedRef.current
      ) {
        hasCompletedRef.current = true;
        setFinished(true);
        onComplete(attemptIdRef.current || undefined);
      }
    });
    return unsubscribe;
  }, [emitVerifiedEvent, onComplete]);

  // Placeholder preview timer (only when no real VAST/Video is playing; never emits fake views)
  useEffect(() => {
    if (!ready || resolvedVideoUrl) return;

    const totalMs = durationSec * 1000;
    const startTime = performance.now();

    const interval = window.setInterval(async () => {
      const elapsed = Math.min(totalMs, performance.now() - startTime);
      setElapsedMs(elapsed);

      if (elapsed >= totalMs && !hasCompletedRef.current) {
        hasCompletedRef.current = true;
        setFinished(true);
        window.clearInterval(interval);
        onComplete(attemptIdRef.current || undefined);
      }
    }, 80);

    return () => window.clearInterval(interval);
  }, [ready, resolvedVideoUrl, durationSec, onComplete]);

  // Animated Canvas preview when no real video URL is configured
  useEffect(() => {
    if (resolvedVideoUrl || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId = 0;
    const start = performance.now();

    const draw = (now: number) => {
      const t = (now - start) / 1000;
      const w = canvas.width;
      const h = canvas.height;

      const bg = ctx.createLinearGradient(0, 0, w, h);
      bg.addColorStop(0, '#090d1a');
      bg.addColorStop(1, '#172038');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      ctx.save();
      ctx.translate(w / 2, h / 2);
      for (let i = 0; i < 5; i++) {
        const radius = 64 + i * 44 + Math.sin(t * 1.4 + i) * 12;
        ctx.beginPath();
        ctx.arc(Math.cos(t * 0.5 + i) * 28, Math.sin(t * 0.6 + i) * 16, radius, 0, Math.PI * 2);
        ctx.strokeStyle = i % 2 === 0 ? 'rgba(99, 102, 241, 0.38)' : 'rgba(16, 185, 129, 0.25)';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.restore();

      ctx.fillStyle = '#f8fafc';
      ctx.font = '600 28px system-ui, -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Rewarded Ad Slot (Preview Mode)', w / 2, h / 2 - 14);

      ctx.fillStyle = '#94a3b8';
      ctx.font = '400 16px system-ui, -apple-system, sans-serif';
      ctx.fillText(
        'Paste a real VAST tag URL or MP4 ad in src/config/ads.ts to count genuine ad views',
        w / 2,
        h / 2 + 24
      );

      animId = requestAnimationFrame(draw);
    };

    animId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animId);
  }, [resolvedVideoUrl]);

  // Real <video> DOM event handlers -> official VAST & backend verification
  async function handleVideoPlaying() {
    await emitVerifiedEvent('impression');
    await emitVerifiedEvent('start');
  }

  function handleVideoTimeUpdate() {
    const video = videoRef.current;
    if (!video || !video.duration) return;
    const currentMs = video.currentTime * 1000;
    const effectiveTotalMs = Math.max(durationSec * 1000, video.duration * 1000);
    setElapsedMs(Math.min(effectiveTotalMs, currentMs));

    const pct = video.currentTime / video.duration;
    if (pct >= 0.25) emitVerifiedEvent('firstQuartile');
    if (pct >= 0.5) emitVerifiedEvent('midpoint');
    if (pct >= 0.75) emitVerifiedEvent('thirdQuartile');
  }

  async function handleVideoEnded() {
    if (hasCompletedRef.current) return;
    const video = videoRef.current;
    const watchedMs = video ? video.currentTime * 1000 : durationSec * 1000;

    // Wait if video ended before server-required minimum watch duration
    const requiredMs = durationSec * 1000;
    if (watchedMs < requiredMs) {
      await new Promise((r) => setTimeout(r, requiredMs - watchedMs));
    }

    hasCompletedRef.current = true;
    setFinished(true);
    setElapsedMs(Math.max(elapsedMs, requiredMs));
    await emitVerifiedEvent('complete');
    onComplete(attemptIdRef.current || undefined);
  }

  async function handleVideoError() {
    if (hasCompletedRef.current) return;
    hasCompletedRef.current = true;
    setAdErrorMsg('Video advertisement failed to load.');
    await emitVerifiedEvent('fail');
    onComplete(attemptIdRef.current || undefined);
  }

  async function handleSkipAd() {
    if (hasCompletedRef.current) return;
    hasCompletedRef.current = true;
    setFinished(true);
    await emitVerifiedEvent('skip');
    onComplete(attemptIdRef.current || undefined);
  }

  function handleSponsorClick() {
    if (vastPayload?.clickTracking.length) {
      dispatchVastBeacons(vastPayload.clickTracking);
    }
  }

  function toggleMute() {
    const nextMuted = !muted;
    setMuted(nextMuted);
    if (videoRef.current) {
      videoRef.current.muted = nextMuted;
    }
  }

  const videoDurationSec =
    resolvedVideoUrl && videoRef.current?.duration && Number.isFinite(videoRef.current.duration)
      ? Math.max(durationSec, videoRef.current.duration)
      : durationSec;
  const progressPct = Math.min(100, (elapsedMs / (videoDurationSec * 1000)) * 100);
  const secondsLeft = Math.max(0, Math.ceil((videoDurationSec * 1000 - elapsedMs) / 1000));
  const elapsedSeconds = Math.floor(elapsedMs / 1000);
  const canSkip =
    Boolean(resolvedVideoUrl) && skipAfterSec > 0 && elapsedSeconds >= skipAfterSec && !finished;

  const wrapperClass =
    variant === 'fullscreen'
      ? 'fixed inset-0 z-50 flex h-dvh w-screen flex-col justify-between bg-slate-950 text-white'
      : 'relative overflow-hidden rounded-xl border border-slate-200 bg-slate-950 text-white dark:border-slate-800';

  return (
    <div className={wrapperClass} role="region" aria-label="Rewarded Advertisement">
      {/* Top Ad Header Bar */}
      <div className="relative z-10 flex items-center justify-between bg-slate-950/90 px-4 py-3.5 backdrop-blur-sm sm:px-6">
        <div className="flex items-center gap-3 text-xs sm:text-sm">
          <span className="font-semibold uppercase tracking-wide text-amber-300">
            {config.label || 'Ad'}
          </span>
          <span aria-hidden="true" className="text-slate-500">
            ·
          </span>
          <span className="text-slate-200">{title}</span>
          <span aria-hidden="true" className="hidden text-slate-500 sm:inline">
            ·
          </span>
          <span className="hidden text-xs text-slate-400 sm:inline">
            {adSource === 'placeholder' ? 'Preview (uncounted)' : `${adSource.toUpperCase()} verified`}
          </span>
        </div>

        <div className="flex items-center gap-4 text-xs sm:text-sm text-slate-300">
          {resolvedVideoUrl ? (
            <button
              type="button"
              onClick={toggleMute}
              className="inline-flex cursor-pointer items-center gap-1.5 text-slate-300 hover:text-white"
            >
              {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
              <span>{muted ? 'Muted' : 'Sound on'}</span>
            </button>
          ) : (
            <span className="inline-flex items-center gap-1.5" title="Autoplay muted">
              <VolumeX className="h-4 w-4" />
              <span>Muted</span>
            </span>
          )}
          <span className="font-mono font-semibold tabular-nums text-emerald-400">
            {completing || finished ? 'Reward unlocked' : `Reward in ${secondsLeft}s`}
          </span>
        </div>
      </div>

      {/* Full-screen Video Surface */}
      <div
        className={
          variant === 'fullscreen'
            ? 'relative flex flex-1 items-center justify-center overflow-hidden bg-black'
            : 'relative aspect-video w-full overflow-hidden bg-black'
        }
      >
        {resolvedVideoUrl ? (
          <video
            ref={videoRef}
            src={resolvedVideoUrl}
            autoPlay
            muted={muted}
            playsInline
            onPlaying={handleVideoPlaying}
            onTimeUpdate={handleVideoTimeUpdate}
            onEnded={handleVideoEnded}
            onError={handleVideoError}
            className="h-full w-full bg-black object-contain"
          />
        ) : (
          <canvas
            ref={canvasRef}
            width={1280}
            height={720}
            className="h-full w-full object-cover"
          />
        )}

        {canSkip && (
          <button
            type="button"
            onClick={handleSkipAd}
            className="absolute right-4 top-4 inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-slate-900/90 px-3.5 py-2 text-xs font-semibold text-white hover:bg-slate-800 sm:right-6 sm:top-6"
          >
            <span>Skip Ad</span>
            <FastForward className="h-3.5 w-3.5" />
          </button>
        )}

        {resolvedClickUrl && (
          <a
            href={resolvedClickUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={handleSponsorClick}
            className="absolute right-4 bottom-4 inline-flex items-center gap-1.5 rounded-lg bg-slate-900/90 px-3.5 py-2 text-xs font-medium text-white hover:bg-slate-800 sm:right-6 sm:bottom-6"
          >
            <span>Visit Sponsor</span>
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
      </div>

      {/* Bottom Reward Progress Bar */}
      <div className="relative z-10 bg-slate-950/95 px-4 py-3.5 sm:px-6">
        <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
          <div
            className="h-full bg-emerald-500 transition-[width] duration-100 ease-linear"
            style={{ width: `${progressPct}%` }}
          />
        </div>
        <p className="mt-2.5 text-center text-xs text-slate-300">
          {adErrorMsg
            ? adErrorMsg
            : completing
              ? 'Verifying ad event completion...'
              : adSource === 'placeholder'
                ? 'Preview Mode: no real ad provider configured in src/config/ads.ts (no fake views counted).'
                : rewardHint || 'Watch the full rewarded video ad to continue automatically.'}
        </p>
      </div>
    </div>
  );
}
