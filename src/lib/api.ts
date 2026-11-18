/**
 * ============================================================================
 * API CLIENT HELPER (src/lib/api.ts)
 * ============================================================================
 */

import type {
  AdEventType,
  AdSourceType,
  AdminPayoutOverview,
  AdminUserDetail,
  BankAccountMasked,
  LinkAnalyticsDetail,
  LinksSummary,
  ResolvedVastPayload,
  ShortLink,
  User,
  VisitorSessionState,
  WalletSummary,
} from '../types';

const TOKEN_STORAGE_KEY = 'linkmint_session_token';
const ADMIN_TOKEN_STORAGE_KEY = 'linkmint_admin_token';

export function getSavedToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function saveToken(token: string | null): void {
  try {
    if (token) {
      localStorage.setItem(TOKEN_STORAGE_KEY, token);
    } else {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    }
  } catch {
    // Ignore storage errors
  }
}

export function getSavedAdminToken(): string | null {
  try {
    return localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function saveAdminToken(token: string | null): void {
  try {
    if (token) {
      localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, token);
    } else {
      localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
    }
  } catch {
    // Ignore storage errors
  }
}

async function apiRequest<T>(
  url: string,
  options: RequestInit = {},
  extraHeaders: Record<string, string> = {}
): Promise<T> {
  const token = getSavedToken();
  const adminToken = getSavedAdminToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...extraHeaders,
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  if (adminToken) {
    headers['x-admin-authorization'] = `Bearer ${adminToken}`;
  }

  const response = await fetch(url, {
    ...options,
    credentials: 'include',
    headers: {
      ...headers,
      ...(options.headers as Record<string, string> | undefined),
    },
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || 'Request failed. Please try again.');
  }

  return data as T;
}

import { signInWithGooglePopup, signOutGoogle } from './firebaseAuth';

// ----------------------------------------------------------------------------
// AUTHENTICATION API CALLS (GOOGLE SIGN-IN ONLY)
// ----------------------------------------------------------------------------

export async function fetchCurrentUser(): Promise<User | null> {
  const data = await apiRequest<{ user: User | null }>('/api/auth/me');
  if (!data.user) {
    saveToken(null);
  }
  return data.user;
}

export async function loginWithGoogle(): Promise<User> {
  const { idToken } = await signInWithGooglePopup();
  const data = await apiRequest<{ user: User; sessionToken: string }>('/api/auth/google', {
    method: 'POST',
    body: JSON.stringify({ idToken }),
  });
  saveToken(data.sessionToken);
  return data.user;
}

export async function logoutUser(): Promise<void> {
  try {
    await apiRequest<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
  } finally {
    await signOutGoogle();
    saveToken(null);
  }
}

// ----------------------------------------------------------------------------
// SHORT LINKS, WALLET & BANK ACCOUNT API CALLS
// ----------------------------------------------------------------------------

export async function fetchMyLinks(): Promise<LinksSummary> {
  return apiRequest<LinksSummary>('/api/links');
}

export async function fetchLinkAnalytics(id: number): Promise<LinkAnalyticsDetail> {
  return apiRequest<LinkAnalyticsDetail>(`/api/links/${id}/analytics`);
}

export async function createShortLink(
  originalUrl: string,
  countViews = true
): Promise<ShortLink> {
  const data = await apiRequest<{ link: ShortLink }>('/api/links', {
    method: 'POST',
    body: JSON.stringify({ originalUrl, countViews }),
  });
  return data.link;
}

export async function toggleLinkViewCounting(
  id: number,
  countViews: boolean
): Promise<ShortLink> {
  const data = await apiRequest<{ link: ShortLink }>(`/api/links/${id}/view-counting`, {
    method: 'PATCH',
    body: JSON.stringify({ countViews }),
  });
  return data.link;
}

export async function deleteShortLink(id: number): Promise<void> {
  await apiRequest<{ ok: boolean }>(`/api/links/${id}`, { method: 'DELETE' });
}

export async function fetchWalletSummary(): Promise<WalletSummary> {
  return apiRequest<WalletSummary>('/api/wallet');
}

export async function saveBankAccount(payload: {
  accountHolderName: string;
  accountNumber: string;
  confirmAccountNumber: string;
  ifscCode: string;
  upiId?: string;
  googleIdToken?: string;
}): Promise<BankAccountMasked> {
  const data = await apiRequest<{ bankAccount: BankAccountMasked }>('/api/bank', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return data.bankAccount;
}

// ----------------------------------------------------------------------------
// VISITOR FLOW & AD EVENT TRACKING API CALLS
// ----------------------------------------------------------------------------

const VISIT_HEADERS = { 'x-linkmint-client': 'web' };

function getClientSignals() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return { webdriver: false, zeroScreen: false };
  }
  return {
    webdriver: Boolean((navigator as Navigator & { webdriver?: boolean }).webdriver),
    zeroScreen: window.screen.width === 0 || window.screen.height === 0,
  };
}

export async function resolveVastTagClient(
  vastTagUrl: string,
  honeypot = ''
): Promise<ResolvedVastPayload> {
  return apiRequest<ResolvedVastPayload>(
    '/api/vast/resolve',
    {
      method: 'POST',
      body: JSON.stringify({
        vastTagUrl,
        website: honeypot,
        clientSignals: getClientSignals(),
      }),
    },
    VISIT_HEADERS
  );
}

export async function startVisitorSession(
  code: string,
  honeypot = ''
): Promise<VisitorSessionState> {
  return apiRequest<VisitorSessionState>(
    '/api/visit/start',
    {
      method: 'POST',
      body: JSON.stringify({
        code,
        website: honeypot,
        clientSignals: getClientSignals(),
      }),
    },
    VISIT_HEADERS
  );
}

export async function startAdAttempt(payload: {
  sessionToken: string;
  adSource: AdSourceType;
  providerName?: string;
  honeypot?: string;
}): Promise<{ adAttemptId: string; adSource: AdSourceType; requiredWatchSeconds: number }> {
  return apiRequest(
    '/api/visit/ad-attempt',
    {
      method: 'POST',
      body: JSON.stringify({
        sessionToken: payload.sessionToken,
        adSource: payload.adSource,
        providerName: payload.providerName,
        website: payload.honeypot || '',
        clientSignals: getClientSignals(),
      }),
    },
    VISIT_HEADERS
  );
}

export async function trackAdEvent(payload: {
  sessionToken: string;
  adAttemptId: string;
  eventType: AdEventType;
  honeypot?: string;
}): Promise<{
  recorded: boolean;
  duplicateEvent?: boolean;
  validView?: boolean;
  invalidReason?: string;
  ignoredPlaceholder?: boolean;
}> {
  return apiRequest(
    '/api/visit/ad-event',
    {
      method: 'POST',
      body: JSON.stringify({
        sessionToken: payload.sessionToken,
        adAttemptId: payload.adAttemptId,
        eventType: payload.eventType,
        website: payload.honeypot || '',
        clientSignals: getClientSignals(),
      }),
    },
    VISIT_HEADERS
  );
}

export async function completeVisitorAd(
  sessionToken: string,
  honeypot = '',
  adAttemptId?: string
): Promise<VisitorSessionState> {
  return apiRequest<VisitorSessionState>(
    '/api/visit/complete-ad',
    {
      method: 'POST',
      body: JSON.stringify({
        sessionToken,
        adAttemptId,
        website: honeypot,
        clientSignals: getClientSignals(),
      }),
    },
    VISIT_HEADERS
  );
}

export async function advanceVisitorPage(
  sessionToken: string,
  honeypot = ''
): Promise<VisitorSessionState> {
  return apiRequest<VisitorSessionState>(
    '/api/visit/next-page',
    {
      method: 'POST',
      body: JSON.stringify({
        sessionToken,
        website: honeypot,
        clientSignals: getClientSignals(),
      }),
    },
    VISIT_HEADERS
  );
}

export async function unlockDestinationLink(
  sessionToken: string,
  honeypot = ''
): Promise<{ originalUrl: string; countedView: boolean; countedEarning: boolean }> {
  return apiRequest<{ originalUrl: string; countedView: boolean; countedEarning: boolean }>(
    '/api/visit/get-link',
    {
      method: 'POST',
      body: JSON.stringify({
        sessionToken,
        website: honeypot,
        clientSignals: getClientSignals(),
      }),
    },
    VISIT_HEADERS
  );
}

// ----------------------------------------------------------------------------
// ADMIN API CALLS (OWNER ONLY)
// ----------------------------------------------------------------------------

export async function fetchAdminSession(): Promise<{
  adminEmail: string | null;
  usingDefaultPassword: boolean;
}> {
  const data = await apiRequest<{ adminEmail: string | null; usingDefaultPassword: boolean }>(
    '/api/admin/me'
  );
  if (!data.adminEmail) {
    saveAdminToken(null);
  }
  return data;
}

export async function loginAdmin(payload: {
  email: string;
  password: string;
}): Promise<{ adminEmail: string }> {
  const data = await apiRequest<{ adminEmail: string; adminToken: string }>('/api/admin/login', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  saveAdminToken(data.adminToken);
  return { adminEmail: data.adminEmail };
}

export async function logoutAdmin(): Promise<void> {
  await apiRequest<{ ok: boolean }>('/api/admin/logout', { method: 'POST' });
  saveAdminToken(null);
}

export async function fetchAdminPayouts(): Promise<AdminPayoutOverview> {
  return apiRequest<AdminPayoutOverview>('/api/admin/payouts');
}

export async function fetchAdminUserDetail(userId: number): Promise<AdminUserDetail> {
  return apiRequest<AdminUserDetail>(`/api/admin/users/${userId}`);
}

export async function updateAdminUserBalances(
  userId: number,
  payload: {
    pendingBalancePaise: number;
    totalEarnedPaise: number;
    totalPaidPaise: number;
  }
): Promise<{
  ok: boolean;
  pendingBalancePaise: number;
  totalEarnedPaise: number;
  totalPaidPaise: number;
}> {
  return apiRequest<{
    ok: boolean;
    pendingBalancePaise: number;
    totalEarnedPaise: number;
    totalPaidPaise: number;
  }>(`/api/admin/users/${userId}/balances`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export async function approveAdminPendingBalance(
  userId: number
): Promise<{ ok: boolean; approvedPaise: number }> {
  return apiRequest<{ ok: boolean; approvedPaise: number }>(
    `/api/admin/pending/${userId}/approve`,
    {
      method: 'POST',
    }
  );
}

export async function markAdminPayoutPaid(
  userId: number,
  referenceNote = '',
  allowWithoutBank = false
): Promise<{ ok: boolean; paidPaise: number }> {
  return apiRequest<{ ok: boolean; paidPaise: number }>(
    `/api/admin/payouts/${userId}/mark-paid`,
    {
      method: 'POST',
      body: JSON.stringify({ referenceNote, allowWithoutBank }),
    }
  );
}

export async function deleteAdminUser(userId: number): Promise<{
  ok: boolean;
  deletedUserId: number;
  deletedEmail: string;
  deletedName: string;
}> {
  return apiRequest<{
    ok: boolean;
    deletedUserId: number;
    deletedEmail: string;
    deletedName: string;
  }>(`/api/admin/users/${userId}`, {
    method: 'DELETE',
  });
}
