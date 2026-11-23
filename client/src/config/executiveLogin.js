// config/executiveLogin.js
// Executives (sub-admins of one pickup point) log in on their own pages, not on the admin login page:
//   /executive/hauz-khas/login   for the Hauz Khas executive
//   /executive/patel-chowk/login for the Patel Chowk executive
//   /executive/login             for either (no pickup point is checked before the login)

import { PICKUP_PODS } from './pickupPods';

// Where an executive logged in on this browser. It is remembered so that logging out, or a session that has run out,
// brings the executive back to their own login page instead of the admin one.
export const EXECUTIVE_LOGIN_KEY = 'executiveLoginPath';

// 'Hauz Khas' -> 'hauz-khas'
export const podSlug = (pod) =>
  String((pod && pod.shortName) || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

export const podForSlug = (slug) => {
  const wanted = String(slug || '').toLowerCase();
  return (wanted && PICKUP_PODS.find((pod) => podSlug(pod) === wanted)) || null;
};

// The login page of a pickup point's executive (the common one when no pod is given)
export const executiveLoginPath = (pod) => (pod ? `/executive/${podSlug(pod)}/login` : '/executive/login');

export const rememberExecutiveLogin = (path) => {
  try {
    localStorage.setItem(EXECUTIVE_LOGIN_KEY, path);
  } catch (error) {
    // storage not available: logging out then simply ends on the admin login page
  }
};

export const forgetExecutiveLogin = () => {
  try {
    localStorage.removeItem(EXECUTIVE_LOGIN_KEY);
  } catch (error) {
    // nothing to forget
  }
};

// Where the app sends someone whose session is gone (they logged out, or the token is missing or has run out): the
// executive login page used on this browser, else the admin login page. The admin login page itself never redirects:
// typing /admin/login always shows the admin login.
export const loginPathAfterSessionEnds = () => rememberedExecutiveLogin() || '/admin/login';

export const rememberedExecutiveLogin = () => {
  try {
    const path = localStorage.getItem(EXECUTIVE_LOGIN_KEY);
    // only one of our own executive login pages is ever followed
    return path && /^\/executive(\/[a-z0-9-]+)?\/login$/.test(path) ? path : null;
  } catch (error) {
    return null;
  }
};
