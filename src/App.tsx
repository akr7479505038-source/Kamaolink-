/**
 * ============================================================================
 * ROOT APPLICATION (src/App.tsx)
 * ============================================================================
 *
 * Manages:
 * - Light & Dark mode state (saved in localStorage)
 * - Persistent login session check on startup
 * - Switching between Welcome/Auth, Home Page, /s/:code Visitor Flow, and /admin
 */

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { AdminPage } from './components/AdminPage';
import { AuthSection } from './components/AuthSection';
import { HomePage } from './components/HomePage';
import { Navbar } from './components/Navbar';
import { VisitorFlow } from './components/VisitorFlow';
import { fetchCurrentUser, logoutUser } from './lib/api';
import type { User } from './types';

function extractShortCodeFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/s\/([a-zA-Z0-9_-]+)\/?$/);
  return match ? match[1] : null;
}

function isAdminPath(pathname: string): boolean {
  return /^\/admin\/?$/.test(pathname);
}

const OWNER_ADMIN_EMAIL = 'akr7479505038@gmail.com';
const REQUIRED_ADMIN_CLICKS = 10;
const REQUIRED_HOLD_MS = 5000;
const GESTURE_IDLE_RESET_MS = 90_000;

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [visitorCode, setVisitorCode] = useState<string | null>(() =>
    extractShortCodeFromPath(window.location.pathname)
  );
  const [adminView, setAdminView] = useState<boolean>(() =>
    isAdminPath(window.location.pathname)
  );

  const [darkMode, setDarkMode] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('linkmint_theme');
      if (saved === 'dark') return true;
      if (saved === 'light') return false;
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch {
      return false;
    }
  });

  // Secret owner admin trigger state (10 clicks + 5s touch)
  const gestureRef = useRef({
    clicks: 0,
    holdCompleted: false,
    activePointerId: null as number | null,
    startX: 0,
    startY: 0,
    startTime: 0,
    holdSatisfiedThisPress: false,
  });
  const holdTimerRef = useRef<number | null>(null);
  const idleResetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    try {
      localStorage.setItem('linkmint_theme', darkMode ? 'dark' : 'light');
    } catch {
      // Ignore storage errors
    }
  }, [darkMode]);

  useEffect(() => {
    const onPopState = () => {
      setVisitorCode(extractShortCodeFromPath(window.location.pathname));
      setAdminView(isAdminPath(window.location.pathname));
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    try {
      const origin = window.location.origin;
      const pageUrl = origin + window.location.pathname;
      const logoUrl = `${origin}/assets/aistudio/IMG-20261118-WA3662_544ab66e.jpg`;

      let canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
      if (!canonical) {
        canonical = document.createElement('link');
        canonical.rel = 'canonical';
        document.head.appendChild(canonical);
      }
      canonical.href = pageUrl;

      let ogUrl = document.querySelector<HTMLMetaElement>('meta[property="og:url"]');
      if (!ogUrl) {
        ogUrl = document.createElement('meta');
        ogUrl.setAttribute('property', 'og:url');
        document.head.appendChild(ogUrl);
      }
      ogUrl.content = pageUrl;

      const ldScript = document.querySelector<HTMLScriptElement>(
        'script[type="application/ld+json"]'
      );
      if (ldScript) {
        ldScript.textContent = JSON.stringify({
          '@context': 'https://schema.org',
          '@graph': [
            {
              '@type': 'WebSite',
              name: 'Kamaolink',
              alternateName: ['Kamao Link', 'kamao link', 'Kamaolink Official'],
              url: origin,
            },
            {
              '@type': 'Organization',
              name: 'Kamaolink',
              alternateName: ['Kamao Link', 'kamao link'],
              url: origin,
              logo: {
                '@type': 'ImageObject',
                url: logoUrl,
                width: 512,
                height: 512,
              },
            },
            {
              '@type': 'WebApplication',
              name: 'Kamaolink',
              alternateName: ['Kamao Link', 'kamao link'],
              url: origin,
              image: logoUrl,
              applicationCategory: 'UtilitiesApplication',
              operatingSystem: 'All',
              description:
                'Kamaolink (Kamao Link) URL shortener where Indian creators earn INR per verified view.',
              offers: {
                '@type': 'Offer',
                price: '0',
                priceCurrency: 'INR',
              },
            },
          ],
        });
      }
    } catch {
      // Ignore DOM head update errors
    }

    return () => {
      if (holdTimerRef.current !== null) window.clearTimeout(holdTimerRef.current);
      if (idleResetTimerRef.current !== null) window.clearTimeout(idleResetTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (visitorCode || adminView) {
      setCheckingAuth(false);
      return;
    }
    let active = true;
    fetchCurrentUser()
      .then((currentUser) => {
        if (active) setUser(currentUser);
      })
      .catch(() => {
        if (active) setUser(null);
      })
      .finally(() => {
        if (active) setCheckingAuth(false);
      });
    return () => {
      active = false;
    };
  }, [visitorCode, adminView]);

  async function handleLogout() {
    try {
      await logoutUser();
    } finally {
      setUser(null);
    }
  }

  function openVisitorFlow(code: string) {
    window.history.pushState({}, '', `/s/${code}`);
    setAdminView(false);
    setVisitorCode(code);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function openAdminPage() {
    window.history.pushState({}, '', '/admin');
    setVisitorCode(null);
    setAdminView(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function exitToHome() {
    window.history.pushState({}, '', '/');
    setVisitorCode(null);
    setAdminView(false);
    setCheckingAuth(true);
    fetchCurrentUser()
      .then((u) => setUser(u))
      .finally(() => setCheckingAuth(false));
  }

  function resetGestureProgress() {
    gestureRef.current.clicks = 0;
    gestureRef.current.holdCompleted = false;
    gestureRef.current.activePointerId = null;
    gestureRef.current.holdSatisfiedThisPress = false;
    if (holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    if (idleResetTimerRef.current !== null) {
      window.clearTimeout(idleResetTimerRef.current);
      idleResetTimerRef.current = null;
    }
  }

  function scheduleIdleReset() {
    if (idleResetTimerRef.current !== null) {
      window.clearTimeout(idleResetTimerRef.current);
    }
    idleResetTimerRef.current = window.setTimeout(() => {
      resetGestureProgress();
    }, GESTURE_IDLE_RESET_MS);
  }

  function maybeUnlockAdmin() {
    const g = gestureRef.current;
    if (g.clicks >= REQUIRED_ADMIN_CLICKS && g.holdCompleted) {
      resetGestureProgress();
      openAdminPage();
    }
  }

  function handleFooterPointerDown(e: ReactPointerEvent<HTMLElement>) {
    if (adminView) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    if (holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }

    const g = gestureRef.current;
    g.activePointerId = e.pointerId;
    g.startX = e.clientX;
    g.startY = e.clientY;
    g.startTime = Date.now();
    g.holdSatisfiedThisPress = false;

    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Ignore pointer capture unsupported errors
    }

    holdTimerRef.current = window.setTimeout(() => {
      holdTimerRef.current = null;
      if (gestureRef.current.activePointerId === e.pointerId) {
        gestureRef.current.holdCompleted = true;
        gestureRef.current.holdSatisfiedThisPress = true;
        scheduleIdleReset();
        maybeUnlockAdmin();
      }
    }, REQUIRED_HOLD_MS);
  }

  function handleFooterPointerMove(e: ReactPointerEvent<HTMLElement>) {
    const g = gestureRef.current;
    if (g.activePointerId !== e.pointerId) return;
    const dist = Math.hypot(e.clientX - g.startX, e.clientY - g.startY);
    if (dist > 25 && holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }

  function handleFooterPointerUp(e: ReactPointerEvent<HTMLElement>) {
    if (holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }

    const g = gestureRef.current;
    if (g.activePointerId !== e.pointerId) return;
    g.activePointerId = null;

    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      // Ignore pointer release errors
    }

    if (adminView) return;

    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    const dist = Math.hypot(dx, dy);
    const duration = Date.now() - g.startTime;

    if (g.holdSatisfiedThisPress || (duration >= REQUIRED_HOLD_MS && dist <= 25)) {
      g.holdCompleted = true;
      scheduleIdleReset();
      maybeUnlockAdmin();
      return;
    }

    if (dist < 24 && duration < 800) {
      g.clicks += 1;
      scheduleIdleReset();
      maybeUnlockAdmin();
    }
  }

  function handleFooterPointerCancel(e: ReactPointerEvent<HTMLElement>) {
    if (holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    if (gestureRef.current.activePointerId === e.pointerId) {
      gestureRef.current.activePointerId = null;
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 transition-colors duration-200 dark:bg-slate-950 dark:text-slate-100">
      <Navbar
        user={user}
        darkMode={darkMode}
        onToggleDarkMode={() => setDarkMode((prev) => !prev)}
        onLogout={handleLogout}
        onNavigateHome={exitToHome}
        hideNavLinks={Boolean(visitorCode) || adminView}
      />

      {adminView ? (
        <AdminPage onBackHome={exitToHome} />
      ) : visitorCode ? (
        <VisitorFlow code={visitorCode} onExitHome={exitToHome} />
      ) : checkingAuth ? (
        <div className="flex min-h-[70vh] items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-300 border-t-indigo-600 dark:border-slate-700 dark:border-t-indigo-400" />
        </div>
      ) : user ? (
        <HomePage user={user} onOpenVisitorTest={openVisitorFlow} />
      ) : (
        <AuthSection onAuthenticated={(loggedInUser) => setUser(loggedInUser)} />
      )}

      <footer
        onPointerDown={handleFooterPointerDown}
        onPointerMove={handleFooterPointerMove}
        onPointerUp={handleFooterPointerUp}
        onPointerCancel={handleFooterPointerCancel}
        onContextMenu={(e) => e.preventDefault()}
        className="touch-manipulation select-none border-t border-slate-200 px-4 py-6 text-center text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400"
      >
        <span>Kamaolink (Kamao Link) · India-only RPM payouts</span>
        {user && user.email.trim().toLowerCase() === OWNER_ADMIN_EMAIL && !adminView && (
          <>
            <span aria-hidden="true" className="mx-2">
              ·
            </span>
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onPointerUp={(e) => e.stopPropagation()}
              onClick={openAdminPage}
              className="cursor-pointer font-medium text-indigo-600 hover:underline dark:text-indigo-400"
            >
              Admin
            </button>
          </>
        )}
      </footer>
    </div>
  );
}
