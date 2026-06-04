import React, { useState, useRef } from 'react';
import { Hexagon, Eye, EyeOff, User, Mail, Lock, Camera } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

export default function LoginPage() {
  const { login, signup } = useAuth();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [avatarPreview, setAvatarPreview] = useState<string | undefined>();
  const [avatarData, setAvatarData] = useState<string | undefined>();
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { setError('Profile pic must be under 2MB'); return; }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const data = ev.target?.result as string;
      setAvatarPreview(data);
      setAvatarData(data);
    };
    reader.readAsDataURL(file);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!email || !password) { setError('Email and password are required'); return; }
    if (mode === 'signup' && (!username || !displayName)) { setError('All fields are required'); return; }
    if (password.length < 6) { setError('Password must be at least 6 characters'); return; }

    setLoading(true);
    try {
      if (mode === 'login') {
        await login(email, password);
      } else {
        await signup(username, displayName, email, password, avatarData);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0e0e0e] flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-[#0066FF] flex items-center justify-center shadow-[0_0_30px_rgba(0,102,255,0.4)] mb-4">
            <Hexagon className="w-8 h-8 text-white stroke-[2]" />
          </div>
          <h1 className="text-2xl font-bold text-[#e5e2e1]">IB Connect</h1>
          <p className="text-sm text-[#8c90a1] mt-1">Secure Enterprise Communication</p>
        </div>

        {/* Card */}
        <div className="bg-[#131313] border border-[#424655] rounded-2xl p-8 shadow-2xl">
          {/* Tab toggle */}
          <div className="flex bg-[#0e0e0e] rounded-xl p-1 mb-6">
            <button
              onClick={() => { setMode('login'); setError(''); }}
              className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-all ${mode === 'login' ? 'bg-[#568dff] text-[#002661]' : 'text-[#8c90a1] hover:text-[#e5e2e1]'}`}
            >
              Sign In
            </button>
            <button
              onClick={() => { setMode('signup'); setError(''); }}
              className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-all ${mode === 'signup' ? 'bg-[#568dff] text-[#002661]' : 'text-[#8c90a1] hover:text-[#e5e2e1]'}`}
            >
              Create Account
            </button>
          </div>

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            {/* Avatar upload (signup only) */}
            {mode === 'signup' && (
              <div className="flex justify-center mb-2">
                <div className="relative">
                  <div
                    onClick={() => fileRef.current?.click()}
                    className="w-20 h-20 rounded-full bg-[#201f1f] border-2 border-dashed border-[#424655] hover:border-[#568dff] cursor-pointer flex items-center justify-center overflow-hidden transition-colors"
                  >
                    {avatarPreview ? (
                      <img src={avatarPreview} alt="Avatar" className="w-full h-full object-cover" />
                    ) : (
                      <div className="flex flex-col items-center text-[#8c90a1]">
                        <Camera className="w-5 h-5 mb-1" />
                        <span className="text-[9px]">Upload</span>
                      </div>
                    )}
                  </div>
                  <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleAvatarChange} />
                </div>
              </div>
            )}

            {mode === 'signup' && (
              <>
                <div className="relative">
                  <User className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#8c90a1]" />
                  <input
                    type="text"
                    placeholder="Username (e.g. john_doe)"
                    value={username}
                    onChange={e => setUsername(e.target.value.replace(/\s/g, '').toLowerCase())}
                    className="w-full bg-[#0e0e0e] border border-[#424655] rounded-xl pl-10 pr-4 py-3 text-sm text-[#e5e2e1] placeholder-[#8c90a1]/60 focus:border-[#568dff] focus:ring-1 focus:ring-[#568dff] outline-none transition-all"
                    autoComplete="username"
                  />
                </div>
                <div className="relative">
                  <User className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#8c90a1]" />
                  <input
                    type="text"
                    placeholder="Display Name (e.g. John Doe)"
                    value={displayName}
                    onChange={e => setDisplayName(e.target.value)}
                    className="w-full bg-[#0e0e0e] border border-[#424655] rounded-xl pl-10 pr-4 py-3 text-sm text-[#e5e2e1] placeholder-[#8c90a1]/60 focus:border-[#568dff] focus:ring-1 focus:ring-[#568dff] outline-none transition-all"
                    autoComplete="name"
                  />
                </div>
              </>
            )}

            <div className="relative">
              <Mail className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#8c90a1]" />
              <input
                type="email"
                placeholder="Email address"
                value={email}
                onChange={e => setEmail(e.target.value)}
                className="w-full bg-[#0e0e0e] border border-[#424655] rounded-xl pl-10 pr-4 py-3 text-sm text-[#e5e2e1] placeholder-[#8c90a1]/60 focus:border-[#568dff] focus:ring-1 focus:ring-[#568dff] outline-none transition-all"
                autoComplete="email"
              />
            </div>

            <div className="relative">
              <Lock className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#8c90a1]" />
              <input
                type={showPw ? 'text' : 'password'}
                placeholder="Password (min 6 chars)"
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="w-full bg-[#0e0e0e] border border-[#424655] rounded-xl pl-10 pr-10 py-3 text-sm text-[#e5e2e1] placeholder-[#8c90a1]/60 focus:border-[#568dff] focus:ring-1 focus:ring-[#568dff] outline-none transition-all"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              />
              <button
                type="button"
                onClick={() => setShowPw(v => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[#8c90a1] hover:text-[#e5e2e1]"
              >
                {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>

            {error && (
              <div className="bg-[#93000a]/20 border border-[#ffb4ab]/30 rounded-xl px-4 py-3 text-xs text-[#ffb4ab]">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-[#568dff] text-[#002661] font-bold py-3 rounded-xl hover:bg-[#568dff]/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed mt-2"
            >
              {loading ? 'Please wait...' : mode === 'login' ? 'Sign In' : 'Create Account'}
            </button>
          </form>

          {mode === 'login' && (
            <p className="text-center text-xs text-[#8c90a1] mt-4">
              Don't have an account?{' '}
              <button onClick={() => { setMode('signup'); setError(''); }} className="text-[#b0c6ff] hover:text-[#568dff] font-semibold">
                Create one
              </button>
            </p>
          )}
        </div>

        <p className="text-center text-[10px] text-[#8c90a1]/50 mt-6">
          IB Connect · End-to-End Encrypted · Your data stays on this device
        </p>
      </div>
    </div>
  );
}
