import { useEffect, useRef } from 'react';
import { generatePKCE, randomState } from '../../lib/pkce';
import BrandMark from '../BrandMark';
import { config } from '../../config';

// One secure IB identity across every IB application — IB Connect never
// collects or sees a password itself; see App.tsx's `code`/`state` callback
// effect for the other half of this flow, and server/main.go's
// handleOIDCCallback for the server-side token exchange. Host-specific values
// come from src/config.ts — REDIRECT_URI in particular must match the
// backend's IB_ACCOUNT_REDIRECT_URI exactly.
const { issuer: IB_ACCOUNT_ISSUER, clientId: IB_ACCOUNT_CLIENT_ID, redirectUri: REDIRECT_URI } = config.ibAccount;

export default function LoginPage({ pendingJoinCode, autoStart = false }: { pendingJoinCode?: string; autoStart?: boolean }) {
  const startedRef = useRef(false);

  const continueWithIB = async () => {
    const { verifier, challenge } = await generatePKCE();
    const state = randomState();
    const nonce = randomState();
    sessionStorage.setItem('ib_oidc_state', state);
    sessionStorage.setItem('ib_oidc_verifier', verifier);
    sessionStorage.setItem('ib_oidc_nonce', nonce);
    if (pendingJoinCode) sessionStorage.setItem('ib_oidc_pending_join_code', pendingJoinCode);

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: IB_ACCOUNT_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: 'openid profile email',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    window.location.href = `${IB_ACCOUNT_ISSUER}/oauth/authorize?${params.toString()}`;
  };

  useEffect(() => {
    if (!autoStart || startedRef.current) return;
    startedRef.current = true;
    void continueWithIB();
  }, [autoStart]);

  return (
    <div className="min-h-dvh bg-[var(--ib-surface)] flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-[var(--ib-blue-500)] flex items-center justify-center shadow-[0_0_30px_rgba(0,102,255,0.4)] mb-4">
            <BrandMark className="w-8 h-8" />
          </div>
          <h1 className="text-2xl font-bold text-[var(--ib-text)]">IB Connect</h1>
          <p className="text-sm text-[var(--ib-text-muted)] mt-1">Secure Enterprise Communication</p>
          {pendingJoinCode && (
            <div className="mt-3 px-3 py-2 rounded-lg bg-[var(--ib-blue-50)] border border-[var(--ib-blue-100)] text-xs text-[var(--ib-blue-600)] text-center">
              Sign in to join meeting <span className="font-mono font-bold">{pendingJoinCode}</span>
            </div>
          )}
        </div>

        <div className="bg-[var(--ib-surface-raised)] border border-[var(--ib-border)] rounded-2xl p-8 shadow-[var(--ib-shadow-lg)] flex flex-col items-center">
          <p className="text-sm text-[var(--ib-text-muted)] text-center mb-6">
            One secure IB identity signs you into every IB application. IB Connect never sees your password.
          </p>
          <button
            type="button"
            onClick={continueWithIB}
            className="group relative w-full min-h-[44px] flex items-center justify-center gap-3 bg-[var(--ib-blue-500)] text-white font-bold py-3.5 rounded-xl hover:bg-[var(--ib-blue-600)] transition-colors overflow-hidden cursor-pointer"
          >
            <BrandMark className="w-5 h-5" />
            <span className="tracking-wide">Continue with IB</span>
          </button>
        </div>

        <p className="text-center text-[10px] text-[var(--ib-text-muted)] mt-6">
          IB Connect · One account across IB applications
        </p>
      </div>
    </div>
  );
}
