/**
 * ============================================================================
 * AD CONFIGURATION FILE (EDIT THIS FILE TO ADD YOUR REAL ADS)
 * ============================================================================
 *
 * Non-coder guide:
 * 1. Paste your ad provider's IAB VAST XML tag URL into `vastTagUrl` (or direct
 *    MP4/WebM URL into `videoUrl`) to activate verified advertisement event
 *    tracking (Impressions, Started, Completed, Skipped, Failed, Valid Views).
 * 2. Official Provider SDK / Tracking API:
 *    External ad network scripts can also emit verified events directly via
 *    `window.LinkMintAdTracker` (see src/lib/adProvider.ts).
 * 3. IMPORTANT: When `vastTagUrl` and `videoUrl` are both empty (placeholder
 *    preview mode), no fake impressions or fake ad views are ever counted.
 */

export interface VideoAdSlotConfig {
  /** Paste an IAB VAST 2.0/3.0/4.x XML URL from your ad provider, or leave "" */
  vastTagUrl: string;
  /** Or paste a direct MP4/WebM video ad URL, or leave "" */
  videoUrl: string;
  /** Where the user goes if they click the video ad (optional) */
  clickThroughUrl: string;
  /** Minimum seconds the visitor must watch before completion is accepted */
  durationSeconds: number;
  /** Optional: seconds before Skip Ad appears (VAST skipoffset overrides this) */
  skipAfterSeconds?: number;
  /** Label shown on the ad (keep as "Ad" for honest design) */
  label: string;
}

export interface BannerAdSlotConfig {
  /** Image URL for the Final Page banner ad */
  imageUrl: string;
  /** Destination URL when a visitor clicks the banner ad */
  clickThroughUrl: string;
  /** Optional provider impression pixel URL for real banner tracking */
  impressionTrackingUrl?: string;
  /** Accessible description of the banner image */
  altText: string;
  /** Optional: paste raw HTML banner snippet from an ad network (overrides imageUrl if non-empty) */
  customHtml: string;
  /** Label shown above the banner (keep as "Ad" for honest design) */
  label: string;
}

export const AD_CONFIG = {
  /**
   * STEP A: Full-screen muted video ad shown immediately when someone opens a short link.
   */
  fullscreenIntroVideoAd: {
    vastTagUrl: '',
    videoUrl: '',
    clickThroughUrl: '',
    durationSeconds: 4,
    skipAfterSeconds: 0,
    label: 'Ad',
  } satisfies VideoAdSlotConfig,

  /**
   * PAGES 1, 2, 3: Full-screen Rewarded Video Ads shown each time the visitor clicks "Next".
   * Paste your rewarded VAST tag or MP4 URL here when ready.
   */
  stepVideoAd: {
    vastTagUrl: '',
    videoUrl: '',
    clickThroughUrl: '',
    durationSeconds: 4,
    skipAfterSeconds: 0,
    label: 'Ad',
  } satisfies VideoAdSlotConfig,

  /**
   * FINAL PAGE (TOP): Clickable image shown above the "Get Link" button -> opens Telegram.
   */
  finalTopPromo: {
    imageUrl: 'https://i.ibb.co/9mDqYHFM/IMG-20261118-WA0507.jpg',
    clickThroughUrl: 'https://t.me/kamaolink',
    altText: 'Join Kamaolink on Telegram',
  },

  /**
   * FINAL PAGE (BOTTOM): Banner ad slot shown below the "Get Link" button.
   */
  finalBannerAd: {
    imageUrl: '',
    clickThroughUrl: '',
    impressionTrackingUrl: '',
    altText: 'Sponsored banner advertisement',
    customHtml: '',
    label: 'Ad',
  } satisfies BannerAdSlotConfig,
};
