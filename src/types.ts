/**
 * Shared TypeScript types used across the frontend.
 */

export interface User {
  id: number;
  name: string;
  email: string;
  createdAt: string;
}

export interface AdAnalyticsTotals {
  totalLinkClicks: number;
  adImpressions: number;
  adStarted: number;
  adCompleted: number;
  adSkipped: number;
  adFailed: number;
  validAdViews: number;
  invalidViews: number;
  duplicateViews: number;
  botDetections: number;
}

export interface ShortLink extends AdAnalyticsTotals {
  id: number;
  code: string;
  originalUrl: string;
  clicks: number;
  paidClicks: number;
  earningsPaise: number;
  countViews: boolean;
  createdAt: string;
}

export interface LinksSummary extends AdAnalyticsTotals {
  totalLinks: number;
  totalClicks: number;
  totalPaidClicks: number;
  totalEarnedPaise: number;
  links: ShortLink[];
}

export type AdEventType =
  | 'impression'
  | 'start'
  | 'firstQuartile'
  | 'midpoint'
  | 'thirdQuartile'
  | 'complete'
  | 'skip'
  | 'fail'
  | 'invalid';

export type AdSourceType = 'vast' | 'video' | 'provider_api' | 'placeholder';

export interface AdEventRecord {
  id: number;
  adAttemptId: string;
  eventType: AdEventType;
  adSource: AdSourceType;
  status: 'accepted' | 'rejected';
  reason: string | null;
  createdAt: number;
}

export interface LinkAnalyticsDetail {
  link: ShortLink;
  recentEvents: AdEventRecord[];
}

export interface ResolvedVastPayload {
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

export interface BankAccountMasked {
  accountHolderName: string;
  maskedAccountNumber: string;
  ifscCode: string;
  hasUpiId: boolean;
  maskedUpiId: string | null;
  updatedAt: string;
}

export interface PayoutHistoryItem {
  id: string;
  date: string;
  amountPaise: number;
  status: 'Pending' | 'Paid';
  windowLabel: string;
  bankMasked: string;
}

export interface WalletSummary {
  totalEarnedPaise: number;
  totalPaidPaise: number;
  pendingBalancePaise: number;
  minimumPayoutPaise: number;
  bankUnlockPaise: number;
  bankUnlocked: boolean;
  bankAccount: BankAccountMasked | null;
  payouts: PayoutHistoryItem[];
}

export interface AdminEligiblePayout {
  userId: number;
  name: string;
  email: string;
  totalViews: number;
  paidViews: number;
  pendingBalancePaise: number;
  totalEarnedPaise: number;
  totalPaidPaise: number;
  bankDetails: {
    accountHolderName: string;
    accountNumber: string;
    ifscCode: string;
    upiId: string | null;
  };
}

export interface AdminPaidRecord {
  id: number;
  userId: number;
  userName: string;
  userEmail: string;
  amountPaise: number;
  windowLabel: string;
  bankMasked: string;
  referenceNote: string | null;
  paidAt: string;
}

export interface AdminPendingBalanceUser {
  userId: number;
  name: string;
  email: string;
  totalViews: number;
  paidViews: number;
  pendingBalancePaise: number;
  totalEarnedPaise: number;
  totalPaidPaise: number;
  hasBankDetails: boolean;
}

export interface AdminUserSummary {
  userId: number;
  name: string;
  email: string;
  totalLinks: number;
  totalViews: number;
  paidViews: number;
  pendingBalancePaise: number;
  totalEarnedPaise: number;
  totalPaidPaise: number;
  payoutEligiblePaise: number;
  isTwoHundredComplete: boolean;
  hasBankDetails: boolean;
  createdAt: string;
}

export interface AdminUserDetail {
  user: AdminUserSummary;
  stats: {
    totalLinkClicks: number;
    totalViews: number;
    paidViews: number;
    invalidViews: number;
    duplicateViews: number;
    botDetections: number;
  };
  bankDetails: {
    accountHolderName: string;
    accountNumber: string;
    ifscCode: string;
    upiId: string | null;
    updatedAt: string;
  } | null;
  links: ShortLink[];
  payouts: Array<{
    id: number;
    amountPaise: number;
    status: string;
    windowLabel: string;
    bankMasked: string;
    referenceNote: string | null;
    createdAt: string;
    paidAt: string | null;
  }>;
}

export interface AdminPayoutOverview {
  adminEmail: string;
  platformStats: {
    totalUsers: number;
    totalLinks: number;
    totalLinkClicks: number;
    totalViews: number;
    totalPaidViews: number;
    adImpressions: number;
    adStarted: number;
    adCompleted: number;
    adSkipped: number;
    adFailed: number;
    validAdViews: number;
    invalidViews: number;
    duplicateViews: number;
    botDetections: number;
  };
  allUsers: AdminUserSummary[];
  pendingUsers: AdminPendingBalanceUser[];
  eligibleUsers: AdminEligiblePayout[];
  recentPaid: AdminPaidRecord[];
}

export type VisitorStage = 'intro' | 'page1' | 'page2' | 'page3' | 'final';

export interface VisitorSessionState {
  sessionToken: string;
  code: string;
  stage: VisitorStage;
  pageNumber: number;
  adsWatchedOnPage: number;
  totalPages: number;
  adsPerPage: number;
  minWatchSeconds: number;
  viewCounted?: boolean;
  canProceedToNextPage: boolean;
}
