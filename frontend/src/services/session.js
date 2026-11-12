export const SESSION_KEY = 'gatelab.customer.session';

export function readSession() {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
  } catch (_) {
    return null;
  }
}

export function readSessionToken() {
  const session = readSession();
  return session && typeof session.token === 'string' ? session.token : null;
}
