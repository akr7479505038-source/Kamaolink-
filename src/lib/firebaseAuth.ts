/**
 * ============================================================================
 * FIREBASE GOOGLE SIGN-IN HELPER (src/lib/firebaseAuth.ts)
 * ============================================================================
 *
 * Uses GoogleAuthProvider with `prompt: 'select_account'` so mobile and desktop
 * users always see all Gmail accounts available on their device when clicking
 * "Login with Google".
 */

import { initializeApp, getApps } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';

const app = getApps().length > 0 ? getApps()[0] : initializeApp(firebaseConfig);
export const auth = getAuth(app);

function createGoogleProvider(loginHint?: string): GoogleAuthProvider {
  const provider = new GoogleAuthProvider();
  provider.addScope('https://www.googleapis.com/auth/userinfo.email');
  provider.addScope('https://www.googleapis.com/auth/userinfo.profile');
  provider.setCustomParameters(
    loginHint
      ? { prompt: 'select_account', login_hint: loginHint }
      : { prompt: 'select_account' }
  );
  return provider;
}

function formatGoogleAuthError(err: unknown): string {
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code?: unknown }).code)
      : '';

  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
    return 'Google sign-in was cancelled. Tap "Login with Google" and choose a Gmail account.';
  }
  if (code === 'auth/popup-blocked') {
    return 'Popup was blocked by your browser. Please allow popups and try again.';
  }
  if (code === 'auth/network-request-failed') {
    return 'Network error while connecting to Google. Please check your internet and try again.';
  }
  if (err instanceof Error && err.message) {
    return err.message;
  }
  return 'Could not sign in with Google. Please try again.';
}

export async function signInWithGooglePopup(): Promise<{
  idToken: string;
  email: string;
  name: string;
}> {
  try {
    const provider = createGoogleProvider();
    const result = await signInWithPopup(auth, provider);
    const idToken = await result.user.getIdToken(true);
    const email = (result.user.email || '').trim().toLowerCase();
    const name = (result.user.displayName || email.split('@')[0] || 'Creator').trim();

    if (!idToken || !email) {
      throw new Error('Could not read your Gmail address from Google.');
    }

    return { idToken, email, name };
  } catch (err) {
    throw new Error(formatGoogleAuthError(err));
  }
}

export async function reverifyGoogleIdentity(expectedEmail: string): Promise<string> {
  try {
    const provider = createGoogleProvider(expectedEmail);
    const result = await signInWithPopup(auth, provider);
    const signedEmail = (result.user.email || '').trim().toLowerCase();
    if (signedEmail !== expectedEmail.trim().toLowerCase()) {
      throw new Error(
        `Please select your signed-in Gmail account (${expectedEmail}) to confirm this change.`
      );
    }
    return await result.user.getIdToken(true);
  } catch (err) {
    throw new Error(formatGoogleAuthError(err));
  }
}

export async function signOutGoogle(): Promise<void> {
  try {
    await signOut(auth);
  } catch {
    // Ignore Firebase signOut errors during logout cleanup
  }
}
