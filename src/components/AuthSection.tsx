/**
 * ============================================================================
 * GOOGLE SIGN-IN WELCOME SCREEN (src/components/AuthSection.tsx)
 * ============================================================================
 *
 * Replaces email/password login & signup with a single "Login with Google"
 * option that displays all Gmail accounts on the user's device and restores
 * all saved links, views, and earnings for that Gmail.
 */

import { useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { loginWithGoogle } from '../lib/api';
import type { User } from '../types';

interface AuthSectionProps {
  onAuthenticated: (user: User) => void;
}

export function AuthSection({ onAuthenticated }: AuthSectionProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleGoogleLogin() {
    setError('');
    setLoading(true);
    try {
      const user = await loginWithGoogle();
      onAuthenticated(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to sign in with Google.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="mx-auto flex min-h-[calc(100vh-5rem)] max-w-5xl items-center px-4 py-12 sm:px-6">
      <div className="grid w-full items-center gap-12 lg:grid-cols-12">
        <div className="lg:col-span-7">
          <div className="mb-4 flex items-center gap-2.5 text-sm font-semibold text-slate-700 dark:text-slate-300">
            <img
              src="/assets/aistudio/IMG-20261118-WA3662_544ab66e.jpg"
              alt="Kamaolink official logo"
              className="h-7 w-7 rounded-md object-cover shrink-0"
            />
            <span>Kamaolink · Official Kamao Link Platform</span>
          </div>

          <h1 className="max-w-xl text-balance text-4xl font-bold tracking-tight text-slate-900 sm:text-5xl dark:text-white">
            Kamaolink — Shorten any link and earn when visitors view it.
          </h1>
          <p className="mt-5 max-w-xl text-base leading-relaxed text-slate-600 sm:text-lg dark:text-slate-300">
            Welcome to <strong className="font-semibold text-slate-900 dark:text-white">Kamaolink</strong>{' '}
            (Kamao Link). Sign in with your Gmail account in one tap — your Kamaolink short links,
            verified India views, and INR earnings stay saved automatically to your Gmail every
            time you log back in.
          </p>

          {error && (
            <div
              role="alert"
              className="mt-6 flex max-w-md items-start gap-2.5 rounded-lg border border-red-200 bg-red-50 p-3.5 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="mt-8 flex flex-col items-start gap-3">
            <button
              type="button"
              disabled={loading}
              onClick={handleGoogleLogin}
              className="inline-flex h-12 cursor-pointer items-center justify-center gap-3 rounded-lg border border-slate-300 bg-white px-6 text-base font-semibold text-slate-900 shadow-xs transition-colors hover:bg-slate-50 whitespace-nowrap shrink-0 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-indigo-600 dark:border-slate-700 dark:bg-slate-900 dark:text-white dark:hover:bg-slate-800"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 48 48"
                className="h-5 w-5 shrink-0"
              >
                <path
                  fill="#EA4335"
                  d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
                />
                <path
                  fill="#4285F4"
                  d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
                />
                <path
                  fill="#FBBC05"
                  d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
                />
                <path
                  fill="#34A853"
                  d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
                />
              </svg>
              <span>{loading ? 'Connecting to Google...' : 'Login with Google'}</span>
            </button>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Tap above to choose from all Gmail accounts signed in on your device for Kamaolink.
            </p>
          </div>
        </div>

        <div className="lg:col-span-5">
          <div className="rounded-xl border border-slate-200 bg-white p-6 sm:p-8 dark:border-slate-800 dark:bg-slate-900">
            <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
              How Kamaolink creators earn
            </h2>
            <ol className="mt-5 space-y-5 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              <li>
                <span className="font-semibold text-slate-900 dark:text-white">
                  01. Paste and shorten on Kamaolink
                </span>
                <p className="mt-1">Turn any web link into a clean Kamaolink short link in one click.</p>
              </li>
              <li>
                <span className="font-semibold text-slate-900 dark:text-white">
                  02. Visitors watch short ads
                </span>
                <p className="mt-1">
                  Visitors pass through honest, clearly labelled ad steps on Kamao Link before
                  reaching the destination link.
                </p>
              </li>
              <li>
                <span className="font-semibold text-slate-900 dark:text-white">
                  03. Saved to your Gmail on Kamaolink
                </span>
                <p className="mt-1">
                  Your pending balance, total earned, and bank details stay tied to your Gmail on
                  Kamaolink even if you log out and sign back in later.
                </p>
              </li>
            </ol>
          </div>
        </div>
      </div>
    </section>
  );
}
