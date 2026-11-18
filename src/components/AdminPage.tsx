/**
 * ============================================================================
 * OWNER ADMIN PAYOUT PAGE (src/components/AdminPage.tsx)
 * ============================================================================
 */

import { useEffect, useState, type FormEvent } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Eye,
  EyeOff,
  LogOut,
  Search,
  Shield,
  Trash2,
  X,
} from 'lucide-react';
import {
  approveAdminPendingBalance,
  deleteAdminUser,
  fetchAdminPayouts,
  fetchAdminSession,
  fetchAdminUserDetail,
  loginAdmin,
  logoutAdmin,
  markAdminPayoutPaid,
  updateAdminUserBalances,
} from '../lib/api';
import {
  MINIMUM_PAYOUT_INR,
  formatInrFromPaise,
  getNextPaymentWindowInfo,
} from '../config/rates';
import type { AdminPayoutOverview, AdminUserDetail } from '../types';

interface AdminPageProps {
  onBackHome: () => void;
}

function paiseToInputRupees(paise: number): string {
  return (paise / 100).toFixed(2);
}

function parseRupeesToPaise(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const num = Number(trimmed);
  if (!Number.isFinite(num) || num < 0 || num > 10_000_000) return null;
  return Math.round(num * 100);
}

export function AdminPage({ onBackHome }: AdminPageProps) {
  const [checking, setChecking] = useState(true);
  const [adminEmail, setAdminEmail] = useState<string | null>(null);

  const [emailInput, setEmailInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [authError, setAuthError] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);

  const [overview, setOverview] = useState<AdminPayoutOverview | null>(null);
  const [loadingPayouts, setLoadingPayouts] = useState(false);
  const [actionError, setActionError] = useState('');
  const [actionSuccess, setActionSuccess] = useState('');
  const [approvingUserId, setApprovingUserId] = useState<number | null>(null);
  const [markingUserId, setMarkingUserId] = useState<number | null>(null);
  const [confirmDeleteUserId, setConfirmDeleteUserId] = useState<number | null>(null);
  const [deletingUserId, setDeletingUserId] = useState<number | null>(null);
  const [refNotes, setRefNotes] = useState<Record<number, string>>({});
  const [userSearch, setUserSearch] = useState('');

  // Selected user detail inspector state
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);
  const [userDetail, setUserDetail] = useState<AdminUserDetail | null>(null);
  const [loadingUserDetail, setLoadingUserDetail] = useState(false);
  const [userDetailError, setUserDetailError] = useState('');

  // Editable balances in rupees
  const [pendingInput, setPendingInput] = useState('0.00');
  const [totalInput, setTotalInput] = useState('0.00');
  const [paidInput, setPaidInput] = useState('0.00');
  const [savingBalances, setSavingBalances] = useState(false);
  const [balanceSaveMsg, setBalanceSaveMsg] = useState('');
  const [balanceSaveErr, setBalanceSaveErr] = useState('');

  const windowInfo = getNextPaymentWindowInfo();

  async function loadPayouts() {
    setLoadingPayouts(true);
    setActionError('');
    try {
      const data = await fetchAdminPayouts();
      setOverview(data);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to load payouts.');
    } finally {
      setLoadingPayouts(false);
    }
  }

  async function openUserDetail(userId: number) {
    setSelectedUserId(userId);
    setLoadingUserDetail(true);
    setUserDetailError('');
    setBalanceSaveMsg('');
    setBalanceSaveErr('');
    try {
      const detail = await fetchAdminUserDetail(userId);
      setUserDetail(detail);
      setPendingInput(paiseToInputRupees(detail.user.pendingBalancePaise));
      setTotalInput(paiseToInputRupees(detail.user.totalEarnedPaise));
      setPaidInput(paiseToInputRupees(detail.user.totalPaidPaise));
    } catch (err) {
      setUserDetailError(err instanceof Error ? err.message : 'Unable to load user details.');
      setUserDetail(null);
    } finally {
      setLoadingUserDetail(false);
    }
  }

  function closeUserDetail() {
    setSelectedUserId(null);
    setUserDetail(null);
    setUserDetailError('');
    setBalanceSaveMsg('');
    setBalanceSaveErr('');
  }

  useEffect(() => {
    let active = true;
    fetchAdminSession()
      .then((res) => {
        if (!active) return;
        setAdminEmail(res.adminEmail);
        if (res.adminEmail) {
          loadPayouts();
        }
      })
      .finally(() => {
        if (active) setChecking(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function handleAdminLogin(e: FormEvent) {
    e.preventDefault();
    setAuthError('');
    setLoggingIn(true);
    try {
      const res = await loginAdmin({ email: emailInput, password: passwordInput });
      setAdminEmail(res.adminEmail);
      setPasswordInput('');
      await loadPayouts();
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Invalid admin credentials.');
    } finally {
      setLoggingIn(false);
    }
  }

  async function handleAdminLogout() {
    await logoutAdmin();
    setAdminEmail(null);
    setOverview(null);
    closeUserDetail();
  }

  async function handleApprovePending(userId: number, userName: string, amountPaise: number) {
    setActionError('');
    setActionSuccess('');
    setApprovingUserId(userId);
    try {
      await approveAdminPendingBalance(userId);
      setActionSuccess(
        `Added ${formatInrFromPaise(amountPaise)} from pending balance to Total Earned for ${userName}.`
      );
      await loadPayouts();
      if (selectedUserId === userId) {
        await openUserDetail(userId);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to approve pending balance.');
    } finally {
      setApprovingUserId(null);
    }
  }

  async function handleMarkPaid(
    userId: number,
    userName: string,
    amountPaise: number,
    allowWithoutBank = false
  ) {
    setActionError('');
    setActionSuccess('');
    setMarkingUserId(userId);
    try {
      await markAdminPayoutPaid(userId, refNotes[userId] || '', allowWithoutBank);
      setActionSuccess(
        `Completed ${formatInrFromPaise(amountPaise)} payout for ${userName}. Wallet and payout history updated.`
      );
      await loadPayouts();
      if (selectedUserId === userId) {
        await openUserDetail(userId);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to complete payout.');
    } finally {
      setMarkingUserId(null);
    }
  }

  async function handleSaveBalances(e: FormEvent) {
    e.preventDefault();
    if (!userDetail) return;

    setBalanceSaveMsg('');
    setBalanceSaveErr('');

    const pendingBalancePaise = parseRupeesToPaise(pendingInput);
    const totalEarnedPaise = parseRupeesToPaise(totalInput);
    const totalPaidPaise = parseRupeesToPaise(paidInput);

    if (
      pendingBalancePaise === null ||
      totalEarnedPaise === null ||
      totalPaidPaise === null
    ) {
      setBalanceSaveErr('Please enter valid non-negative rupee amounts (e.g. 200 or 125.50).');
      return;
    }

    setSavingBalances(true);
    try {
      await updateAdminUserBalances(userDetail.user.userId, {
        pendingBalancePaise,
        totalEarnedPaise,
        totalPaidPaise,
      });
      setBalanceSaveMsg('User balances updated.');
      await Promise.all([loadPayouts(), openUserDetail(userDetail.user.userId)]);
    } catch (err) {
      setBalanceSaveErr(err instanceof Error ? err.message : 'Failed to update balances.');
    } finally {
      setSavingBalances(false);
    }
  }

  function adjustInputRupees(
    current: string,
    deltaRupees: number,
    setter: (next: string) => void
  ) {
    const parsed = Number(current);
    const base = Number.isFinite(parsed) ? parsed : 0;
    const next = Math.max(0, base + deltaRupees);
    setter(next.toFixed(2));
  }

  async function handleDeleteUser(userId: number, userName: string, userEmail: string) {
    setActionError('');
    setActionSuccess('');
    setDeletingUserId(userId);
    try {
      await deleteAdminUser(userId);
      setConfirmDeleteUserId(null);
      if (selectedUserId === userId) {
        closeUserDetail();
      }
      setActionSuccess(`Deleted user ${userName} (${userEmail}) and all their links/payouts.`);
      await loadPayouts();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to delete user.');
    } finally {
      setDeletingUserId(null);
    }
  }

  if (checking) {
    return (
      <div className="flex min-h-[70vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-300 border-t-indigo-600 dark:border-slate-700 dark:border-t-indigo-400" />
      </div>
    );
  }

  if (!adminEmail) {
    return (
      <main className="mx-auto flex min-h-[calc(100vh-8rem)] max-w-md items-center px-4 py-10">
        <div className="w-full rounded-xl border border-slate-200 bg-white p-6 sm:p-8 dark:border-slate-800 dark:bg-slate-900">
          <button
            type="button"
            onClick={onBackHome}
            className="inline-flex cursor-pointer items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
          >
            <ArrowLeft className="h-4 w-4" />
            <span>Back to site</span>
          </button>

          <div className="mt-5 flex items-center gap-2.5">
            <Shield className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
            <h1 className="text-xl font-bold text-slate-900 dark:text-white">
              Admin Login
            </h1>
          </div>
          <p className="mt-1.5 text-sm text-slate-600 dark:text-slate-400">
            Sign in with your private owner credentials to manage users and payouts.
          </p>

          {authError && (
            <div
              role="alert"
              className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{authError}</span>
            </div>
          )}

          <form onSubmit={handleAdminLogin} className="mt-6 space-y-4">
            <div>
              <label
                htmlFor="admin-email"
                className="block text-sm font-medium text-slate-700 dark:text-slate-200"
              >
                Admin email
              </label>
              <input
                id="admin-email"
                type="email"
                required
                value={emailInput}
                onChange={(e) => setEmailInput(e.target.value)}
                placeholder="owner@example.com"
                className="mt-1.5 h-11 w-full rounded-lg border border-slate-300 bg-white px-3.5 text-sm text-slate-900 focus:border-indigo-600 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-white"
              />
            </div>

            <div>
              <label
                htmlFor="admin-password"
                className="block text-sm font-medium text-slate-700 dark:text-slate-200"
              >
                Admin password
              </label>
              <div className="relative mt-1.5">
                <input
                  id="admin-password"
                  type={showPassword ? 'text' : 'password'}
                  required
                  value={passwordInput}
                  onChange={(e) => setPasswordInput(e.target.value)}
                  placeholder="Enter admin password"
                  className="h-11 w-full rounded-lg border border-slate-300 bg-white pr-11 pl-3.5 text-sm text-slate-900 focus:border-indigo-600 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-white"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((p) => !p)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute inset-y-0 right-0 flex w-11 cursor-pointer items-center justify-center text-slate-500"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loggingIn}
              className="inline-flex h-11 w-full cursor-pointer items-center justify-center rounded-lg bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60"
            >
              {loggingIn ? 'Signing in...' : 'Open Admin Payouts'}
            </button>
          </form>
        </div>
      </main>
    );
  }

  const filteredUsers = (overview?.allUsers || []).filter((u) => {
    const q = userSearch.trim().toLowerCase();
    if (!q) return true;
    return u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q);
  });

  return (
    <main className="mx-auto max-w-5xl space-y-8 px-4 py-10 sm:px-6">
      <div className="flex flex-col justify-between gap-4 border-b border-slate-200 pb-6 sm:flex-row sm:items-center dark:border-slate-800">
        <div>
          <button
            type="button"
            onClick={onBackHome}
            className="inline-flex cursor-pointer items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
          >
            <ArrowLeft className="h-4 w-4" />
            <span>Back to main site</span>
          </button>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl dark:text-white">
            Owner Payout Dashboard
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Signed in as {adminEmail} · Next payment window: {windowInfo.label}
          </p>
        </div>

        <button
          type="button"
          onClick={handleAdminLogout}
          className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 text-sm font-medium text-slate-800 hover:bg-slate-100 whitespace-nowrap shrink-0 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
        >
          <LogOut className="h-4 w-4" />
          <span>Admin Logout</span>
        </button>
      </div>

      {actionError && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{actionError}</span>
        </div>
      )}

      {actionSuccess && (
        <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-200">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{actionSuccess}</span>
        </div>
      )}

      {overview && (
        <section className="space-y-4" aria-label="Platform ads count summary">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
              <p className="text-xs text-slate-500 dark:text-slate-400">Clicks</p>
              <p className="mt-1 font-mono text-xl font-bold tabular-nums text-slate-900 dark:text-white">
                {overview.platformStats.totalLinkClicks}
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
              <p className="text-xs text-slate-500 dark:text-slate-400">Views (all ads watched)</p>
              <p className="mt-1 font-mono text-xl font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
                {overview.platformStats.totalViews}
              </p>
              <p className="mt-0.5 text-xs tabular-nums text-slate-500 dark:text-slate-400">
                Paid India views: {overview.platformStats.totalPaidViews}
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
              <p className="text-xs text-slate-500 dark:text-slate-400">Invalid & blocked</p>
              <p className="mt-1 font-mono text-xl font-bold tabular-nums text-amber-700 dark:text-amber-400">
                {overview.platformStats.invalidViews}
              </p>
              <p className="mt-0.5 text-xs tabular-nums text-slate-500 dark:text-slate-400">
                Duplicates: {overview.platformStats.duplicateViews} · Bots: {overview.platformStats.botDetections}
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
              <p className="text-xs text-slate-500 dark:text-slate-400">Users & links</p>
              <p className="mt-1 font-mono text-xl font-bold tabular-nums text-slate-900 dark:text-white">
                {overview.platformStats.totalUsers} / {overview.platformStats.totalLinks}
              </p>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                Creators · Short links
              </p>
            </div>
          </div>
        </section>
      )}

      {/* All Creators List (click any user for views, links, bank, payouts & balance edit) */}
      <section className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-col justify-between gap-3 border-b border-slate-200 px-5 py-4 sm:flex-row sm:items-center dark:border-slate-800">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-white">
              Users ({overview?.allUsers.length ?? 0})
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Click any user to view links, views, earnings, bank details, payouts, or adjust balances. Users with ₹{MINIMUM_PAYOUT_INR}+ get a green tick and Complete option.
            </p>
          </div>

          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="search"
              value={userSearch}
              onChange={(e) => setUserSearch(e.target.value)}
              placeholder="Search name or Gmail..."
              className="h-9 w-full rounded-lg border border-slate-300 bg-white pr-3 pl-9 text-xs text-slate-900 focus:border-indigo-600 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-white"
            />
          </div>
        </div>

        {loadingPayouts ? (
          <div className="p-5">
            <div className="h-16 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800" />
          </div>
        ) : filteredUsers.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-slate-600 dark:text-slate-400">
            No matching users found.
          </div>
        ) : (
          <div className="divide-y divide-slate-200 dark:divide-slate-800">
            {filteredUsers.map((u) => (
              <div
                key={u.userId}
                role="button"
                tabIndex={0}
                onClick={() => openUserDetail(u.userId)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openUserDetail(u.userId);
                  }
                }}
                className="flex cursor-pointer flex-col justify-between gap-3 px-5 py-4 transition-colors hover:bg-slate-50 sm:flex-row sm:items-center dark:hover:bg-slate-800/40"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-base font-semibold text-slate-900 dark:text-white">
                      {u.name}
                    </span>
                    {u.isTwoHundredComplete && (
                      <CheckCircle2
                        aria-label="₹200+ completed"
                        className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400"
                      />
                    )}
                    <span className="truncate text-xs text-slate-600 dark:text-slate-400">
                      {u.email}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-400">
                    <span className="font-mono tabular-nums">
                      Views: <strong className="text-slate-900 dark:text-white">{u.totalViews}</strong>
                    </span>
                    <span className="font-mono tabular-nums">
                      Links: <strong className="text-slate-900 dark:text-white">{u.totalLinks}</strong>
                    </span>
                    <span className="font-mono tabular-nums">
                      Pending:{' '}
                      <strong className="text-amber-700 dark:text-amber-400">
                        {formatInrFromPaise(u.pendingBalancePaise)}
                      </strong>
                    </span>
                    <span className="font-mono tabular-nums">
                      Total:{' '}
                      <strong className="text-slate-900 dark:text-white">
                        {formatInrFromPaise(u.totalEarnedPaise)}
                      </strong>
                    </span>
                    <span className="font-mono tabular-nums">
                      Paid:{' '}
                      <strong className="text-emerald-700 dark:text-emerald-400">
                        {formatInrFromPaise(u.totalPaidPaise)}
                      </strong>
                    </span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  {u.isTwoHundredComplete && (
                    <button
                      type="button"
                      disabled={markingUserId === u.userId}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleMarkPaid(u.userId, u.name, u.payoutEligiblePaise, true);
                      }}
                      className="inline-flex h-9 cursor-pointer items-center justify-center rounded-lg bg-emerald-600 px-3.5 text-xs font-semibold text-white hover:bg-emerald-700 whitespace-nowrap disabled:opacity-60"
                    >
                      {markingUserId === u.userId ? 'Completing...' : 'Complete'}
                    </button>
                  )}

                  {confirmDeleteUserId === u.userId ? (
                    <div
                      className="flex items-center gap-1.5"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        disabled={deletingUserId === u.userId}
                        onClick={() => handleDeleteUser(u.userId, u.name, u.email)}
                        className="inline-flex h-9 cursor-pointer items-center justify-center rounded-lg bg-red-600 px-3 text-xs font-semibold text-white hover:bg-red-700 whitespace-nowrap disabled:opacity-60"
                      >
                        {deletingUserId === u.userId ? 'Deleting...' : 'Confirm Delete'}
                      </button>
                      <button
                        type="button"
                        disabled={deletingUserId === u.userId}
                        onClick={() => setConfirmDeleteUserId(null)}
                        className="inline-flex h-9 cursor-pointer items-center justify-center rounded-lg border border-slate-300 bg-white px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      aria-label={`Delete ${u.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDeleteUserId(u.userId);
                      }}
                      className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 text-xs font-medium text-red-600 hover:bg-red-50 whitespace-nowrap dark:border-red-900/60 dark:bg-slate-900 dark:text-red-400 dark:hover:bg-red-950/40"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      <span>Delete</span>
                    </button>
                  )}

                  <span className="text-xs font-medium text-indigo-600 dark:text-indigo-400">
                    View details →
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Pending Balances waiting for Admin Approval to Total Earned */}
      <section className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-col justify-between gap-1 border-b border-slate-200 px-5 py-4 sm:flex-row sm:items-center dark:border-slate-800">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-white">
              Pending creator balances (add to Total Earned)
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Completed ad views credit Pending balance first. Approve here to move them to Total Earned.
            </p>
          </div>
          <span className="font-mono text-xs tabular-nums text-slate-500 dark:text-slate-400">
            {overview?.pendingUsers.length ?? 0} pending
          </span>
        </div>

        {loadingPayouts ? (
          <div className="p-5">
            <div className="h-14 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800" />
          </div>
        ) : !overview || overview.pendingUsers.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-slate-600 dark:text-slate-400">
            No pending creator balances waiting for approval right now.
          </div>
        ) : (
          <div className="divide-y divide-slate-200 dark:divide-slate-800">
            {overview.pendingUsers.map((entry) => (
              <div
                key={entry.userId}
                className="flex flex-col justify-between gap-4 p-5 sm:flex-row sm:items-center"
              >
                <div className="space-y-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-base font-semibold text-slate-900 dark:text-white">
                      {entry.name}
                    </span>
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      ({entry.email})
                    </span>
                    <span className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
                      · {entry.totalViews} views ({entry.paidViews} paid India)
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-4 text-xs text-slate-600 dark:text-slate-300">
                    <span>
                      Pending:{' '}
                      <strong className="font-mono text-sm font-bold tabular-nums text-amber-700 dark:text-amber-400">
                        {formatInrFromPaise(entry.pendingBalancePaise)}
                      </strong>
                    </span>
                    <span>
                      Total Earned:{' '}
                      <span className="font-mono font-medium tabular-nums text-slate-900 dark:text-white">
                        {formatInrFromPaise(entry.totalEarnedPaise)}
                      </span>
                    </span>
                    <span>
                      Bank: {entry.hasBankDetails ? 'Added' : 'Not added'}
                    </span>
                  </div>
                </div>

                <button
                  type="button"
                  disabled={approvingUserId === entry.userId}
                  onClick={() =>
                    handleApprovePending(entry.userId, entry.name, entry.pendingBalancePaise)
                  }
                  className="inline-flex h-10 cursor-pointer items-center justify-center rounded-lg bg-indigo-600 px-5 text-sm font-semibold text-white hover:bg-indigo-700 whitespace-nowrap shrink-0 disabled:opacity-60"
                >
                  {approvingUserId === entry.userId ? 'Approving...' : 'Add to Total Earned'}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Eligible Creators List */}
      <section className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-col justify-between gap-1 border-b border-slate-200 px-5 py-4 sm:flex-row sm:items-center dark:border-slate-800">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-white">
              Users eligible for payout (₹{MINIMUM_PAYOUT_INR}+ & bank added)
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Send the bank/UPI transfer manually, then click Complete.
            </p>
          </div>
          <span className="font-mono text-xs tabular-nums text-slate-500 dark:text-slate-400">
            {overview?.eligibleUsers.length ?? 0} eligible
          </span>
        </div>

        {loadingPayouts ? (
          <div className="p-5">
            <div className="h-14 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800" />
          </div>
        ) : !overview || overview.eligibleUsers.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-slate-600 dark:text-slate-400">
            No users currently meet both conditions (payable balance ≥ ₹{MINIMUM_PAYOUT_INR} and
            bank details saved).
          </div>
        ) : (
          <div className="divide-y divide-slate-200 dark:divide-slate-800">
            {overview.eligibleUsers.map((entry) => (
              <div
                key={entry.userId}
                className="flex flex-col justify-between gap-4 p-5 lg:flex-row lg:items-center"
              >
                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-base font-semibold text-slate-900 dark:text-white">
                      {entry.name}
                    </span>
                    <CheckCircle2
                      aria-label="₹200+ completed"
                      className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400"
                    />
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      ({entry.email})
                    </span>
                    <span className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
                      · {entry.totalViews} views ({entry.paidViews} paid)
                    </span>
                  </div>

                  <p className="font-mono text-xl font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
                    {formatInrFromPaise(entry.pendingBalancePaise)}
                  </p>

                  <div className="grid gap-x-6 gap-y-1 pt-1 text-xs text-slate-600 sm:grid-cols-2 dark:text-slate-300">
                    <div>
                      Account holder:{' '}
                      <span className="font-medium text-slate-900 dark:text-white">
                        {entry.bankDetails.accountHolderName}
                      </span>
                    </div>
                    <div>
                      IFSC:{' '}
                      <span className="font-mono font-medium text-slate-900 dark:text-white">
                        {entry.bankDetails.ifscCode}
                      </span>
                    </div>
                    <div>
                      Account number:{' '}
                      <span className="font-mono font-semibold text-slate-900 dark:text-white">
                        {entry.bankDetails.accountNumber}
                      </span>
                    </div>
                    <div>
                      UPI ID:{' '}
                      <span className="font-mono text-slate-900 dark:text-white">
                        {entry.bankDetails.upiId || 'Not provided'}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex flex-col gap-2 sm:flex-row sm:items-center shrink-0">
                  <input
                    type="text"
                    placeholder="UTR / ref note (optional)"
                    value={refNotes[entry.userId] || ''}
                    onChange={(e) =>
                      setRefNotes((prev) => ({ ...prev, [entry.userId]: e.target.value }))
                    }
                    className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-xs text-slate-900 focus:border-indigo-600 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-white"
                  />
                  <button
                    type="button"
                    disabled={markingUserId === entry.userId}
                    onClick={() =>
                      handleMarkPaid(entry.userId, entry.name, entry.pendingBalancePaise, false)
                    }
                    className="inline-flex h-10 cursor-pointer items-center justify-center rounded-lg bg-emerald-600 px-5 text-sm font-semibold text-white hover:bg-emerald-700 whitespace-nowrap shrink-0 disabled:opacity-60"
                  >
                    {markingUserId === entry.userId ? 'Completing...' : 'Complete'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Recent Paid Payouts */}
      <section className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="border-b border-slate-200 px-5 py-4 dark:border-slate-800">
          <h2 className="text-base font-semibold text-slate-900 dark:text-white">
            Completed payouts
          </h2>
        </div>

        {!overview || overview.recentPaid.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-slate-600 dark:text-slate-400">
            No completed payouts recorded yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs font-medium text-slate-500 dark:border-slate-800 dark:text-slate-400">
                  <th className="px-5 py-3">Date</th>
                  <th className="px-5 py-3">User</th>
                  <th className="px-5 py-3">Account</th>
                  <th className="px-5 py-3">Window</th>
                  <th className="px-5 py-3 text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {overview.recentPaid.map((row) => (
                  <tr key={row.id}>
                    <td className="px-5 py-3 text-slate-700 dark:text-slate-300">
                      {new Date(row.paidAt).toLocaleDateString('en-IN', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </td>
                    <td className="px-5 py-3 font-medium text-slate-900 dark:text-white">
                      {row.userName}
                    </td>
                    <td className="px-5 py-3 font-mono text-xs text-slate-600 dark:text-slate-400">
                      {row.bankMasked}
                    </td>
                    <td className="px-5 py-3 text-xs text-slate-600 dark:text-slate-400">
                      {row.windowLabel}
                    </td>
                    <td className="px-5 py-3 text-right font-mono font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">
                      {formatInrFromPaise(row.amountPaise)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Clicked User Full Inspector Modal */}
      {selectedUserId !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs"
          onClick={closeUserDetail}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="User details"
            onClick={(e) => e.stopPropagation()}
            className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 dark:border-slate-800 dark:bg-slate-900"
          >
            <div className="flex items-start justify-between gap-4 border-b border-slate-200 pb-4 dark:border-slate-800">
              <div className="min-w-0">
                {userDetail ? (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-xl font-bold text-slate-900 dark:text-white">
                        {userDetail.user.name}
                      </h2>
                      {userDetail.user.isTwoHundredComplete && (
                        <CheckCircle2
                          aria-label="₹200+ completed"
                          className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400"
                        />
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-sm text-slate-600 dark:text-slate-400">
                      {userDetail.user.email}
                    </p>
                  </>
                ) : (
                  <h2 className="text-lg font-bold text-slate-900 dark:text-white">
                    User Details
                  </h2>
                )}
              </div>

              <button
                type="button"
                onClick={closeUserDetail}
                aria-label="Close user details"
                className="inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {loadingUserDetail ? (
              <div className="space-y-3 py-8">
                <div className="h-12 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800" />
                <div className="h-24 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800" />
              </div>
            ) : userDetailError ? (
              <div className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{userDetailError}</span>
              </div>
            ) : userDetail ? (
              <div className="mt-5 space-y-6">
                {/* Summary stats */}
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
                    <p className="text-xs text-slate-500 dark:text-slate-400">Total clicks</p>
                    <p className="mt-1 font-mono text-lg font-bold tabular-nums text-slate-900 dark:text-white">
                      {userDetail.stats.totalLinkClicks}
                    </p>
                  </div>
                  <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
                    <p className="text-xs text-slate-500 dark:text-slate-400">Total views</p>
                    <p className="mt-1 font-mono text-lg font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
                      {userDetail.stats.totalViews}
                    </p>
                  </div>
                  <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
                    <p className="text-xs text-slate-500 dark:text-slate-400">Paid India views</p>
                    <p className="mt-1 font-mono text-lg font-bold tabular-nums text-slate-900 dark:text-white">
                      {userDetail.stats.paidViews}
                    </p>
                  </div>
                  <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
                    <p className="text-xs text-slate-500 dark:text-slate-400">Short links</p>
                    <p className="mt-1 font-mono text-lg font-bold tabular-nums text-slate-900 dark:text-white">
                      {userDetail.links.length}
                    </p>
                  </div>
                </div>

                {/* Complete Payout Action when ₹200+ */}
                {userDetail.user.isTwoHundredComplete && (
                  <div className="flex flex-col justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50/70 p-4 sm:flex-row sm:items-center dark:border-emerald-900/50 dark:bg-emerald-950/30">
                    <div>
                      <p className="text-sm font-semibold text-emerald-900 dark:text-emerald-200">
                        ₹{MINIMUM_PAYOUT_INR}+ Payout Ready ({formatInrFromPaise(userDetail.user.payoutEligiblePaise)})
                      </p>
                      <p className="text-xs text-emerald-800/80 dark:text-emerald-300/80">
                        Click Complete to record payout and update Paid balance.
                      </p>
                    </div>
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <input
                        type="text"
                        placeholder="UTR / ref note"
                        value={refNotes[userDetail.user.userId] || ''}
                        onChange={(e) =>
                          setRefNotes((prev) => ({
                            ...prev,
                            [userDetail.user.userId]: e.target.value,
                          }))
                        }
                        className="h-9 rounded-lg border border-emerald-300 bg-white px-3 text-xs text-slate-900 focus:border-emerald-600 focus:outline-none dark:border-emerald-800 dark:bg-slate-950 dark:text-white"
                      />
                      <button
                        type="button"
                        disabled={markingUserId === userDetail.user.userId}
                        onClick={() =>
                          handleMarkPaid(
                            userDetail.user.userId,
                            userDetail.user.name,
                            userDetail.user.payoutEligiblePaise,
                            true
                          )
                        }
                        className="inline-flex h-9 cursor-pointer items-center justify-center rounded-lg bg-emerald-600 px-4 text-xs font-semibold text-white hover:bg-emerald-700 whitespace-nowrap disabled:opacity-60"
                      >
                        {markingUserId === userDetail.user.userId ? 'Completing...' : 'Complete'}
                      </button>
                    </div>
                  </div>
                )}

                {/* Edit Pending / Total / Paid Balance */}
                <form
                  onSubmit={handleSaveBalances}
                  className="rounded-xl border border-slate-200 p-4 dark:border-slate-800"
                >
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
                    Adjust balances (₹)
                  </h3>
                  <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                    Increase or decrease Total balance, Pending balance, and Paid balance directly.
                  </p>

                  {balanceSaveErr && (
                    <p className="mt-2 text-xs text-red-600 dark:text-red-400">{balanceSaveErr}</p>
                  )}
                  {balanceSaveMsg && (
                    <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-400">
                      {balanceSaveMsg}
                    </p>
                  )}

                  <div className="mt-3 grid gap-4 sm:grid-cols-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
                        Pending balance (₹)
                      </label>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={pendingInput}
                        onChange={(e) => setPendingInput(e.target.value)}
                        className="mt-1 h-10 w-full rounded-lg border border-slate-300 bg-white px-3 font-mono text-sm tabular-nums text-slate-900 focus:border-indigo-600 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-white"
                      />
                      <div className="mt-1.5 flex gap-1.5">
                        <button
                          type="button"
                          onClick={() => adjustInputRupees(pendingInput, -10, setPendingInput)}
                          className="cursor-pointer rounded border border-slate-300 px-2 py-0.5 font-mono text-xs text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                        >
                          -₹10
                        </button>
                        <button
                          type="button"
                          onClick={() => adjustInputRupees(pendingInput, 10, setPendingInput)}
                          className="cursor-pointer rounded border border-slate-300 px-2 py-0.5 font-mono text-xs text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                        >
                          +₹10
                        </button>
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
                        Total balance / earned (₹)
                      </label>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={totalInput}
                        onChange={(e) => setTotalInput(e.target.value)}
                        className="mt-1 h-10 w-full rounded-lg border border-slate-300 bg-white px-3 font-mono text-sm tabular-nums text-slate-900 focus:border-indigo-600 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-white"
                      />
                      <div className="mt-1.5 flex gap-1.5">
                        <button
                          type="button"
                          onClick={() => adjustInputRupees(totalInput, -10, setTotalInput)}
                          className="cursor-pointer rounded border border-slate-300 px-2 py-0.5 font-mono text-xs text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                        >
                          -₹10
                        </button>
                        <button
                          type="button"
                          onClick={() => adjustInputRupees(totalInput, 10, setTotalInput)}
                          className="cursor-pointer rounded border border-slate-300 px-2 py-0.5 font-mono text-xs text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                        >
                          +₹10
                        </button>
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
                        Paid balance (₹)
                      </label>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={paidInput}
                        onChange={(e) => setPaidInput(e.target.value)}
                        className="mt-1 h-10 w-full rounded-lg border border-slate-300 bg-white px-3 font-mono text-sm tabular-nums text-slate-900 focus:border-indigo-600 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-white"
                      />
                      <div className="mt-1.5 flex gap-1.5">
                        <button
                          type="button"
                          onClick={() => adjustInputRupees(paidInput, -10, setPaidInput)}
                          className="cursor-pointer rounded border border-slate-300 px-2 py-0.5 font-mono text-xs text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                        >
                          -₹10
                        </button>
                        <button
                          type="button"
                          onClick={() => adjustInputRupees(paidInput, 10, setPaidInput)}
                          className="cursor-pointer rounded border border-slate-300 px-2 py-0.5 font-mono text-xs text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                        >
                          +₹10
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 flex justify-end">
                    <button
                      type="submit"
                      disabled={savingBalances}
                      className="inline-flex h-9 cursor-pointer items-center justify-center rounded-lg bg-indigo-600 px-4 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-60"
                    >
                      {savingBalances ? 'Saving...' : 'Save Balances'}
                    </button>
                  </div>
                </form>

                {/* Bank Account Details */}
                <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
                    Bank account details
                  </h3>
                  {!userDetail.bankDetails ? (
                    <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                      Bank account not added yet.
                    </p>
                  ) : (
                    <div className="mt-3 grid gap-2 text-xs text-slate-600 sm:grid-cols-2 dark:text-slate-300">
                      <div>
                        Account holder:{' '}
                        <span className="font-medium text-slate-900 dark:text-white">
                          {userDetail.bankDetails.accountHolderName}
                        </span>
                      </div>
                      <div>
                        IFSC:{' '}
                        <span className="font-mono font-medium text-slate-900 dark:text-white">
                          {userDetail.bankDetails.ifscCode}
                        </span>
                      </div>
                      <div>
                        Account number:{' '}
                        <span className="font-mono font-semibold text-slate-900 dark:text-white">
                          {userDetail.bankDetails.accountNumber}
                        </span>
                      </div>
                      <div>
                        UPI ID:{' '}
                        <span className="font-mono text-slate-900 dark:text-white">
                          {userDetail.bankDetails.upiId || 'Not provided'}
                        </span>
                      </div>
                    </div>
                  )}
                </div>

                {/* Short Links */}
                <div className="rounded-xl border border-slate-200 dark:border-slate-800">
                  <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
                      Short links ({userDetail.links.length})
                    </h3>
                  </div>
                  {userDetail.links.length === 0 ? (
                    <p className="px-4 py-5 text-xs text-slate-500 dark:text-slate-400">
                      No links created yet.
                    </p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <thead>
                          <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800 dark:text-slate-400">
                            <th className="px-4 py-2.5">Code / URL</th>
                            <th className="px-4 py-2.5 text-right">Clicks</th>
                            <th className="px-4 py-2.5 text-right">Views</th>
                            <th className="px-4 py-2.5 text-right">Paid</th>
                            <th className="px-4 py-2.5 text-right">Earnings</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                          {userDetail.links.map((link) => (
                            <tr key={link.id}>
                              <td className="max-w-xs px-4 py-2.5">
                                <p className="font-mono font-semibold text-indigo-600 dark:text-indigo-400">
                                  /s/{link.code}
                                </p>
                                <p className="truncate text-slate-500 dark:text-slate-400">
                                  {link.originalUrl}
                                </p>
                              </td>
                              <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                                {link.totalLinkClicks}
                              </td>
                              <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-900 dark:text-white">
                                {link.clicks}
                              </td>
                              <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                                {link.paidClicks}
                              </td>
                              <td className="px-4 py-2.5 text-right font-mono font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">
                                {formatInrFromPaise(link.earningsPaise)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {/* User Payout History */}
                <div className="rounded-xl border border-slate-200 dark:border-slate-800">
                  <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
                      Payout history ({userDetail.payouts.length})
                    </h3>
                  </div>
                  {userDetail.payouts.length === 0 ? (
                    <p className="px-4 py-5 text-xs text-slate-500 dark:text-slate-400">
                      No payouts recorded for this user yet.
                    </p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <thead>
                          <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800 dark:text-slate-400">
                            <th className="px-4 py-2.5">Date</th>
                            <th className="px-4 py-2.5">Account</th>
                            <th className="px-4 py-2.5">Window</th>
                            <th className="px-4 py-2.5">Status</th>
                            <th className="px-4 py-2.5 text-right">Amount</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                          {userDetail.payouts.map((p) => (
                            <tr key={p.id}>
                              <td className="px-4 py-2.5 text-slate-700 dark:text-slate-300">
                                {new Date(p.paidAt || p.createdAt).toLocaleDateString('en-IN', {
                                  day: 'numeric',
                                  month: 'short',
                                  year: 'numeric',
                                })}
                              </td>
                              <td className="px-4 py-2.5 font-mono text-slate-600 dark:text-slate-400">
                                {p.bankMasked}
                              </td>
                              <td className="px-4 py-2.5 text-slate-600 dark:text-slate-400">
                                {p.windowLabel}
                              </td>
                              <td className="px-4 py-2.5 capitalize text-slate-700 dark:text-slate-300">
                                {p.status}
                              </td>
                              <td className="px-4 py-2.5 text-right font-mono font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">
                                {formatInrFromPaise(p.amountPaise)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {/* Danger Zone: Delete User */}
                <div className="flex flex-col justify-between gap-3 rounded-xl border border-red-200 bg-red-50/50 p-4 sm:flex-row sm:items-center dark:border-red-900/50 dark:bg-red-950/20">
                  <div>
                    <h3 className="text-sm font-semibold text-red-900 dark:text-red-200">
                      Delete user account
                    </h3>
                    <p className="text-xs text-red-800/80 dark:text-red-300/80">
                      Permanently deletes this user, their short links, views, bank details, and payout history.
                    </p>
                  </div>

                  {confirmDeleteUserId === userDetail.user.userId ? (
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        disabled={deletingUserId === userDetail.user.userId}
                        onClick={() =>
                          handleDeleteUser(
                            userDetail.user.userId,
                            userDetail.user.name,
                            userDetail.user.email
                          )
                        }
                        className="inline-flex h-9 cursor-pointer items-center justify-center rounded-lg bg-red-600 px-4 text-xs font-semibold text-white hover:bg-red-700 whitespace-nowrap disabled:opacity-60"
                      >
                        {deletingUserId === userDetail.user.userId
                          ? 'Deleting...'
                          : 'Confirm Delete'}
                      </button>
                      <button
                        type="button"
                        disabled={deletingUserId === userDetail.user.userId}
                        onClick={() => setConfirmDeleteUserId(null)}
                        className="inline-flex h-9 cursor-pointer items-center justify-center rounded-lg border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteUserId(userDetail.user.userId)}
                      className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-red-300 bg-white px-4 text-xs font-semibold text-red-600 hover:bg-red-50 whitespace-nowrap shrink-0 dark:border-red-800 dark:bg-slate-900 dark:text-red-400 dark:hover:bg-red-950/40"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      <span>Delete User</span>
                    </button>
                  )}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </main>
  );
}

