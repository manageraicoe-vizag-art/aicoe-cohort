import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export const configured = !SUPABASE_URL.includes('YOUR-PROJECT');

const headers = (token) => ({
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${token || SUPABASE_ANON_KEY}`,
  'Content-Type': 'application/json',
});

/** Call a server function. Throws an Error with a message fit to show the user. */
export async function callFn(name, body, token) {
  let r;
  try {
    r = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, { method: 'POST', headers: headers(token), body: JSON.stringify(body) });
  } catch (e) {
    throw new Error('Could not reach the server. Check your internet connection and try again.');
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.ok) throw new Error(d.error || d.message || `Server error (${r.status}). Please try again.`);
  return d;
}

/** Read a public table (settings, active colleges). */
export async function readPublic(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: headers() });
  if (!r.ok) throw new Error('Could not load the page data. Please refresh.');
  return r.json();
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function fileToBase64(f) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(f); });
}
