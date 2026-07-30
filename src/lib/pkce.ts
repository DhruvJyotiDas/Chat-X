// PKCE (RFC 7636) helpers for the "Continue with IB" OIDC flow — generated
// entirely client-side since the browser is the party that starts the
// /oauth/authorize redirect (see LoginPage.tsx and the App.tsx callback effect).

function base64url(bytes: Uint8Array): string {
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomState(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(24)));
}

export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = base64url(new Uint8Array(digest));
  return { verifier, challenge };
}
