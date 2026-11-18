/**
 * ============================================================================
 * OFFICIAL AD PROVIDER & VAST BEACON BRIDGE (src/lib/adProvider.ts)
 * ============================================================================
 *
 * 1. Dispatches official IAB VAST tracking beacons (<Impression>, <Tracking>,
 *    <Error>, <ClickTracking>) via sendBeacon / keepalive fetch.
 * 2. Exposes `window.LinkMintAdTracker` so third-party ad provider SDKs
 *    (e.g., Google IMA SDK, Adsterra, ExoClick, or custom VAST wrappers)
 *    can emit official verified ad events directly into the active AdPlayer.
 */

import type { AdEventType } from '../types';

export interface ProviderEventPayload {
  eventType: AdEventType;
  providerName?: string;
}

type ProviderEventListener = (payload: ProviderEventPayload) => void;

export interface LinkMintAdTrackerApi {
  emit: (eventType: AdEventType, providerName?: string) => void;
  subscribe: (listener: ProviderEventListener) => () => void;
}

declare global {
  interface Window {
    LinkMintAdTracker?: LinkMintAdTrackerApi;
  }
}

const listeners = new Set<ProviderEventListener>();

export const adProviderTracker: LinkMintAdTrackerApi = {
  emit(eventType, providerName) {
    listeners.forEach((fn) => {
      try {
        fn({ eventType, providerName });
      } catch {
        // Keep listener dispatch isolated
      }
    });
  },
  subscribe(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

if (typeof window !== 'undefined' && !window.LinkMintAdTracker) {
  window.LinkMintAdTracker = adProviderTracker;
}

/**
 * Fires official VAST tracking pixel URLs without blocking playback.
 */
export function dispatchVastBeacons(urls: string[]): void {
  if (!urls || urls.length === 0) return;
  for (const rawUrl of urls) {
    const url = rawUrl.trim();
    if (!url || (!url.startsWith('https://') && !url.startsWith('http://'))) continue;
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        const ok = navigator.sendBeacon(url);
        if (ok) continue;
      }
    } catch {
      // Fallback to fetch below
    }
    try {
      fetch(url, { mode: 'no-cors', keepalive: true }).catch(() => {
        // Ignore network errors from third-party ad beacons
      });
    } catch {
      const img = new Image();
      img.referrerPolicy = 'no-referrer';
      img.src = url;
    }
  }
}
