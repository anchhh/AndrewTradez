const STORAGE_KEY = 'estly-auth-creds';

export interface Creds {
  user: string;
  pass: string;
}

function encode(creds: Creds): string {
  return btoa(unescape(encodeURIComponent(`${creds.user}:${creds.pass}`)));
}

export function getStoredCreds(): Creds | null {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function setStoredCreds(creds: Creds) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(creds));
}

export function clearStoredCreds() {
  sessionStorage.removeItem(STORAGE_KEY);
}

export function authHeader(): Record<string, string> {
  const creds = getStoredCreds();
  if (!creds) return {};
  return { Authorization: `Basic ${encode(creds)}` };
}

export async function isAuthRequired(): Promise<boolean> {
  const res = await fetch('/api/auth/status');
  const body = await res.json();
  return Boolean(body.auth_required);
}

export async function verifyCreds(creds: Creds): Promise<boolean> {
  const res = await fetch('/api/health', { headers: { Authorization: `Basic ${encode(creds)}` } });
  return res.status === 200;
}

// Dispatched by api.ts whenever a request comes back 401 (e.g. the
// password was changed on the server while this tab already had a
// session), so the app can drop back to the login screen.
export const AUTH_REQUIRED_EVENT = 'estly-auth-required';
