/**
 * ============================================================================
 * IAB VAST 2.0 / 3.0 / 4.x XML PARSER & RESOLVER (server/vast.ts)
 * ============================================================================
 *
 * Fetches and resolves VAST XML ad tags (including <Wrapper> redirects up to
 * 3 hops), extracting official tracking URLs:
 * - <Impression>
 * - <Error>
 * - <Tracking event="start|firstQuartile|midpoint|thirdQuartile|complete|skip|mute|unmute|pause|resume">
 * - <MediaFile> (MP4/WebM)
 * - <ClickThrough> and <ClickTracking>
 * - skipoffset attribute
 */

import net from 'net';

export interface ParsedVastResponse {
  hasAd: boolean;
  mediaUrl: string;
  mediaMimeType: string;
  skipAfterSeconds: number | null;
  clickThroughUrl: string;
  impressions: string[];
  errors: string[];
  clickTracking: string[];
  tracking: {
    start: string[];
    firstQuartile: string[];
    midpoint: string[];
    thirdQuartile: string[];
    complete: string[];
    skip: string[];
  };
}

function isSafeExternalUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '0.0.0.0' ||
      host.endsWith('.local') ||
      host.endsWith('.internal')
    ) {
      return false;
    }
    if (net.isIP(host)) {
      if (
        host.startsWith('10.') ||
        host.startsWith('192.168.') ||
        host.startsWith('169.254.') ||
        host.startsWith('127.') ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
        host.startsWith('fc') ||
        host.startsWith('fd') ||
        host.startsWith('fe80:')
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function cleanXmlValue(raw: string): string {
  const withoutCdata = raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .trim();
  return withoutCdata
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function extractAllTags(xml: string, tagName: string): string[] {
  const regex = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
  const results: string[] = [];
  let match: RegExpExecArray | null = null;
  while ((match = regex.exec(xml)) !== null) {
    const val = cleanXmlValue(match[1]);
    if (val && isSafeExternalUrl(val)) {
      results.push(val);
    }
  }
  return results;
}

function extractTrackingByEvent(xml: string, eventName: string): string[] {
  const regex = new RegExp(
    `<Tracking\\b[^>]*\\bevent\\s*=\\s*["']${eventName}["'][^>]*>([\\s\\S]*?)<\\/Tracking>`,
    'gi'
  );
  const results: string[] = [];
  let match: RegExpExecArray | null = null;
  while ((match = regex.exec(xml)) !== null) {
    const val = cleanXmlValue(match[1]);
    if (val && isSafeExternalUrl(val)) {
      results.push(val);
    }
  }
  return results;
}

function parseSkipOffset(xml: string): number | null {
  const match = xml.match(/<Linear\b[^>]*\bskipoffset\s*=\s*["']([^"']+)["']/i);
  if (!match) return null;
  const raw = match[1].trim();
  if (/^\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw)) {
    const [hh, mm, ss] = raw.split(':').map(Number);
    return Math.max(1, Math.round(hh * 3600 + mm * 60 + ss));
  }
  return null;
}

function extractBestMediaFile(xml: string): { url: string; mimeType: string } {
  const regex = /<MediaFile\b([^>]*)>([\s\S]*?)<\/MediaFile>/gi;
  const candidates: Array<{ url: string; mimeType: string; score: number }> = [];
  let match: RegExpExecArray | null = null;

  while ((match = regex.exec(xml)) !== null) {
    const attrs = match[1] || '';
    const url = cleanXmlValue(match[2]);
    if (!url || !isSafeExternalUrl(url)) continue;

    const typeMatch = attrs.match(/\btype\s*=\s*["']([^"']+)["']/i);
    const mimeType = (typeMatch?.[1] || '').toLowerCase();

    let score = 1;
    if (mimeType.includes('mp4')) score = 10;
    else if (mimeType.includes('webm')) score = 8;
    else if (mimeType.startsWith('video/')) score = 5;

    candidates.push({ url, mimeType: mimeType || 'video/mp4', score });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] ? { url: candidates[0].url, mimeType: candidates[0].mimeType } : { url: '', mimeType: '' };
}

export async function resolveVastTag(vastUrl: string, maxHops = 3): Promise<ParsedVastResponse> {
  const merged: ParsedVastResponse = {
    hasAd: false,
    mediaUrl: '',
    mediaMimeType: '',
    skipAfterSeconds: null,
    clickThroughUrl: '',
    impressions: [],
    errors: [],
    clickTracking: [],
    tracking: {
      start: [],
      firstQuartile: [],
      midpoint: [],
      thirdQuartile: [],
      complete: [],
      skip: [],
    },
  };

  let currentUrl = vastUrl.trim();
  const visitedUrls = new Set<string>();

  for (let hop = 0; hop <= maxHops; hop++) {
    if (!isSafeExternalUrl(currentUrl) || visitedUrls.has(currentUrl)) {
      break;
    }
    visitedUrls.add(currentUrl);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    let xmlText = '';

    try {
      const response = await fetch(currentUrl, {
        signal: controller.signal,
        headers: {
          Accept: 'application/xml, text/xml, */*',
        },
      });
      if (!response.ok) {
        break;
      }
      xmlText = await response.text();
      if (xmlText.length > 512_000) {
        break;
      }
    } finally {
      clearTimeout(timer);
    }

    merged.impressions.push(...extractAllTags(xmlText, 'Impression'));
    merged.errors.push(...extractAllTags(xmlText, 'Error'));
    merged.clickTracking.push(...extractAllTags(xmlText, 'ClickTracking'));
    merged.tracking.start.push(...extractTrackingByEvent(xmlText, 'start'));
    merged.tracking.firstQuartile.push(...extractTrackingByEvent(xmlText, 'firstQuartile'));
    merged.tracking.midpoint.push(...extractTrackingByEvent(xmlText, 'midpoint'));
    merged.tracking.thirdQuartile.push(...extractTrackingByEvent(xmlText, 'thirdQuartile'));
    merged.tracking.complete.push(...extractTrackingByEvent(xmlText, 'complete'));
    merged.tracking.skip.push(...extractTrackingByEvent(xmlText, 'skip'));

    if (merged.skipAfterSeconds === null) {
      merged.skipAfterSeconds = parseSkipOffset(xmlText);
    }

    if (!merged.clickThroughUrl) {
      const clicks = extractAllTags(xmlText, 'ClickThrough');
      if (clicks[0]) merged.clickThroughUrl = clicks[0];
    }

    // Follow <VASTAdTagURI> if this XML is a <Wrapper>
    const wrapperMatch = xmlText.match(/<VASTAdTagURI\b[^>]*>([\s\S]*?)<\/VASTAdTagURI>/i);
    if (wrapperMatch) {
      const nextUrl = cleanXmlValue(wrapperMatch[1]);
      if (nextUrl && isSafeExternalUrl(nextUrl)) {
        currentUrl = nextUrl;
        continue;
      }
    }

    const bestMedia = extractBestMediaFile(xmlText);
    if (bestMedia.url) {
      merged.hasAd = true;
      merged.mediaUrl = bestMedia.url;
      merged.mediaMimeType = bestMedia.mimeType;
    }
    break;
  }

  // Deduplicate beacon URLs
  merged.impressions = [...new Set(merged.impressions)];
  merged.errors = [...new Set(merged.errors)];
  merged.clickTracking = [...new Set(merged.clickTracking)];
  merged.tracking.start = [...new Set(merged.tracking.start)];
  merged.tracking.firstQuartile = [...new Set(merged.tracking.firstQuartile)];
  merged.tracking.midpoint = [...new Set(merged.tracking.midpoint)];
  merged.tracking.thirdQuartile = [...new Set(merged.tracking.thirdQuartile)];
  merged.tracking.complete = [...new Set(merged.tracking.complete)];
  merged.tracking.skip = [...new Set(merged.tracking.skip)];

  return merged;
}
