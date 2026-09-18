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
    <div className="min-h-screen bg-[#0e0e0e] flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-[#0066FF] flex items-center justify-center shadow-[0_0_30px_rgba(0,102,255,0.4)] mb-4">
            <BrandMark className="w-8 h-8" />
          </div>
          <h1 className="text-2xl font-bold text-[#e5e2e1]">IB Connect</h1>
          <p className="text-sm text-[#8c90a1] mt-1">Secure Enterprise Communication</p>
          {pendingJoinCode && (
            <div className="mt-3 px-3 py-2 rounded-lg bg-[#568dff]/10 border border-[#568dff]/30 text-xs text-[#b0c6ff] text-center">
              Sign in to join meeting <span className="font-mono font-bold">{pendingJoinCode}</span>
            </div>
          )}
        </div>

        <div className="bg-[#131313] border border-[#424655] rounded-2xl p-8 shadow-2xl flex flex-col items-center">
          <p className="text-sm text-[#8c90a1] text-center mb-6">
            One secure IB identity signs you into every IB application. IB Connect never sees your password.
          </p>
          <button
            type="button"
            onClick={continueWithIB}
            className="group relative w-full flex items-center justify-center gap-3 bg-[#0066FF] text-white font-bold py-3.5 rounded-xl hover:bg-[#0052cc] transition-colors overflow-hidden"
          >
            <BrandMark className="w-5 h-5" />
            <span className="tracking-wide">Continue with IB</span>
          </button>
        </div>

        <p className="text-center text-[10px] text-[#8c90a1]/50 mt-6">
          IB Connect · One account across IB applications
        </p>
      </div>
    </div>
  );
}
