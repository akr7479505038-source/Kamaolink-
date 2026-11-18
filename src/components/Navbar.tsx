/**
 * ============================================================================
 * TOP NAVIGATION BAR (src/components/Navbar.tsx)
 * ============================================================================
 */

import { Moon, Sun, LogOut } from 'lucide-react';
import type { User } from '../types';

interface NavbarProps {
  user: User | null;
  darkMode: boolean;
  onToggleDarkMode: () => void;
  onLogout: () => void;
  onNavigateHome: () => void;
  hideNavLinks?: boolean;
}

export function Navbar({
  user,
  darkMode,
  onToggleDarkMode,
  onLogout,
  onNavigateHome,
  hideNavLinks = false,
}: NavbarProps) {
  return (
    <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-white/95 backdrop-blur-sm dark:border-slate-800/80 dark:bg-slate-950/95">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-8 px-4 sm:px-6">
        {/* Zone 1: Brand logo + wordmark */}
        <button
          type="button"
          onClick={onNavigateHome}
          className="inline-flex cursor-pointer items-center gap-2.5 text-xl font-bold tracking-tight text-slate-900 transition-colors hover:text-indigo-600 whitespace-nowrap shrink-0 dark:text-white dark:hover:text-indigo-400"
        >
          <img
            src="/assets/aistudio/IMG-20261118-WA3662_544ab66e.jpg"
            alt="Kamaolink logo"
            className="h-8 w-8 rounded-lg object-cover shrink-0"
          />
          <span>Kamaolink</span>
        </button>

        {/* Zone 2: Concise single-line navigation links */}
        {user && !hideNavLinks ? (
          <nav
            aria-label="Page sections"
            className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600 dark:text-slate-300"
          >
            <a
              href="#shorten"
              className="hover:text-slate-900 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0 dark:hover:text-white"
            >
              Shorten
            </a>
            <a
              href="#wallet"
              className="hover:text-slate-900 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0 dark:hover:text-white"
            >
              Wallet
            </a>
            <a
              href="#rpm-rates"
              className="hover:text-slate-900 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0 dark:hover:text-white"
            >
              Rates
            </a>
            <a
              href="#how-it-works"
              className="hover:text-slate-900 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0 dark:hover:text-white"
            >
              How It Works
            </a>
            <a
              href="#faq"
              className="hover:text-slate-900 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0 dark:hover:text-white"
            >
              FAQ
            </a>
          </nav>
        ) : (
          <div className="hidden md:block" />
        )}

        {/* Zone 3: Theme switcher + primary Logout action */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={onToggleDarkMode}
            aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
            title={darkMode ? 'Light mode' : 'Dark mode'}
            className="inline-flex h-10 w-10 cursor-pointer items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-700 transition-colors hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-indigo-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            {darkMode ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>

          {user && !hideNavLinks && (
            <button
              type="button"
              onClick={onLogout}
              className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-medium text-white transition-colors hover:bg-slate-800 whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-indigo-600 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200"
            >
              <LogOut className="h-4 w-4" />
              <span>Logout</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
