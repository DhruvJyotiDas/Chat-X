import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { Routes, Route } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';

// Auth
import { AuthProvider, useAuth } from './context/AuthContext';
import { ChatProvider } from './context/ChatContext';
import LoginPage from './components/auth/LoginPage';

// Layout
import Sidebar from './components/layout/Sidebar';
import TopBar from './components/layout/TopBar';

// Views
const DashboardView = React.lazy(() => import('./components/views/DashboardView'));
const ChatsView = React.lazy(() => import('./components/views/ChatsView'));
const DebriefView = React.lazy(() => import('./components/views/DebriefView'));
const SecurityView = React.lazy(() => import('./components/views/SecurityView'));
const SupportView = React.lazy(() => import('./components/views/SupportView'));
const CallsView = React.lazy(() => import('./components/views/CallsView'));
const CalendarView = React.lazy(() => import('./components/views/CalendarView'));
const InterviewView = React.lazy(() => import('./components/views/InterviewView'));

// Meeting
import ActiveMeetingView from './components/meeting/ActiveMeetingView';
import FloatingCallWindow from './components/meeting/FloatingCallWindow';
import JoinRequestBanner from './components/meeting/JoinRequestBanner';

// Context
import { MeetingProvider, useMeeting, readActiveMeeting } from './context/MeetingContext';
import PreJoinScreen from './components/meeting/PreJoinScreen';
import { useChat } from './context/ChatContext';
import IncomingCallModal from './components/meeting/IncomingCallModal';
import CommandPalette from './components/CommandPalette';

// Types & data
import { AppView, ComplianceLog } from './types';
import { useTheme } from './hooks/useTheme';
import { api } from './lib/api';

function ViewLoader() {
  return (
    <div className="flex flex-1 items-center justify-center bg-[#090a0d]">
      <div className="flex items-center gap-2 text-xs text-[#7d8598]">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#718cff] border-t-transparent" />
        Loading workspace…
      </div>
    </div>
  );
}

function AppContent({ pendingRoomCode }: { pendingRoomCode?: string }) {
  const { currentUser, isLoading, loginWithToken } = useAuth();
  const {
    isInMeeting, joinMeeting, rejoinMeeting, isRejoining,
    setUserName, meetingError, clearMeetingError,
    isMinimized, minimizeMeeting, expandMeeting,
    awaitingApproval, joinDeniedReason, clearJoinDenied,
  } = useMeeting();
  const { incomingCall, dismissIncomingCall, notifyCallAccepted, notifyCallDeclined } = useChat();

  const [currentView, setCurrentView] = useState<AppView>('dashboard');
  const [logs, setLogs] = useState<ComplianceLog[]>([]);
  const [searchFilter, setSearchFilter] = useState('');
  const ssoParams = new URLSearchParams(window.location.search);
  const ssoRequested = ssoParams.get('sso') === '1';
  // room is optional: ?sso=1 alone means "just sign in" (e.g. an intranet
  // "Connect" button with no meeting in mind); ?sso=1&room=CODE auto-joins
  // that room once signed in, same as before.
  const ssoRoomCode = ssoRequested ? ssoParams.get('room')?.trim() : undefined;
  const launchRoomCode = pendingRoomCode || ssoRoomCode;
  const ssoLaunch = !pendingRoomCode && ssoRequested;
  const [autoJoinCode, setAutoJoinCode] = useState<string | undefined>(launchRoomCode);

  // A reload mid-call must land back in the call, not on the dashboard. This is
  // the one-shot redial: sessionStorage still knows which room this tab was in
  // (see MeetingContext.persistActiveMeeting), so we redial it before rendering
  // any of the normal app chrome. Guests included — the record is auth-agnostic.
  const [rejoinTarget] = useState<string | null>(() => {
    const saved = readActiveMeeting();
    if (!saved) return null;
    // A stale record from another room shouldn't hijack an explicit /:roomCode link.
    if (launchRoomCode && saved.roomId !== launchRoomCode.toUpperCase()) return null;
    return saved.roomId;
  });
  // 'pending' only covers the in-flight redial. It must settle to 'idle' on success
  // and on leave, otherwise the spinner below would also swallow the normal
  // post-call return to the app (the rejoin target outlives the meeting itself).
  const [rejoinState, setRejoinState] = useState<'idle' | 'pending' | 'failed'>(
    () => (rejoinTarget ? 'pending' : 'idle'),
  );
  const rejoinFailed = rejoinState === 'failed';
  const rejoinAttemptedRef = useRef(false);
  // Set when a guest on the lobby screen opts to sign in instead.
  const [forceLogin, setForceLogin] = useState(false);

  useEffect(() => {
    if (isLoading || isInMeeting || !rejoinTarget || rejoinAttemptedRef.current) return;
    rejoinAttemptedRef.current = true;
    rejoinMeeting(rejoinTarget)
      .then(() => setRejoinState('idle'))
      .catch(() => setRejoinState('failed'));
  }, [isLoading, isInMeeting, rejoinTarget, rejoinMeeting]);

  // Entering a room from a share link (no prior session in this tab). Applies the
  // mic/camera choices made in the lobby once the real meeting stream exists.
  const handlePreJoin = useCallback(async (
    name: string,
    opts: { muted: boolean; videoOff: boolean },
    code: string,
    asGuest: boolean,
  ) => {
    clearMeetingError();
    if (asGuest) setUserName(name, true);
    try {
      // The lobby's choices are applied *while* the stream is acquired, not by
      // toggling afterwards. Toggling after the fact meant "join with camera off"
      // still opened the camera, released it, and then renegotiated with every
      // peer — and it read `isVideoOff` from a closure captured before the join,
      // which initMedia's audio-only fallback could have changed underneath it.
      await joinMeeting(code, undefined, false, { muted: opts.muted, videoOff: opts.videoOff });
    } catch {
      // surfaced through meetingError on the lobby screen
    }
  }, [clearMeetingError, setUserName, joinMeeting]);

  // Completes the "Continue with IB" redirect: IB Account sends the browser
  // back here with ?code&state (see LoginPage.tsx for the redirect out, and
  // server/main.go's handleOIDCCallback for the token exchange this posts to).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const oauthError = params.get('error');
    if (!code && !oauthError) return;

    window.history.replaceState({}, document.title, window.location.pathname);
    if (oauthError) {
      console.error('IB Account sign-in error:', oauthError);
      return;
    }

    const state = params.get('state');
    const expectedState = sessionStorage.getItem('ib_oidc_state');
    const verifier = sessionStorage.getItem('ib_oidc_verifier');
    const nonce = sessionStorage.getItem('ib_oidc_nonce');
    const pendingJoinCode = sessionStorage.getItem('ib_oidc_pending_join_code');
    sessionStorage.removeItem('ib_oidc_state');
    sessionStorage.removeItem('ib_oidc_verifier');
    sessionStorage.removeItem('ib_oidc_nonce');
    sessionStorage.removeItem('ib_oidc_pending_join_code');

    if (!state || state !== expectedState || !verifier || !nonce) {
      console.error('IB Account sign-in: state mismatch, aborting');
      return;
    }

    api.oidcCallback(code!, verifier, nonce)
      .then(({ token, user }) => {
        loginWithToken(token, user);
        if (pendingJoinCode) setAutoJoinCode(pendingJoinCode);
      })
      .catch(e => console.error('IB Account sign-in failed:', e));
  }, [loginWithToken]);

  // Where to drop the user when they minimise the call — wherever they were before
  // joining, rather than an arbitrary default.
  const viewBeforeMeetingRef = useRef<AppView>('dashboard');
  useEffect(() => {
    if (currentView !== 'active_meeting') viewBeforeMeetingRef.current = currentView;
  }, [currentView]);

  useEffect(() => {
    if (isInMeeting) setCurrentView('active_meeting');
  }, [isInMeeting]);

  const handleMinimizeMeeting = useCallback(() => {
    minimizeMeeting();
    setCurrentView(viewBeforeMeetingRef.current);
  }, [minimizeMeeting]);

  const handleExpandMeeting = useCallback(() => {
    expandMeeting();
    setCurrentView('active_meeting');
  }, [expandMeeting]);

  // A signed-in user who opens a meeting link (directly, or after being bounced
  // through IB Account sign-in) goes straight into the room. Guests get the lobby
  // instead — see the PreJoinScreen branch below. Falls back to the Meetings page
  // with the code prefilled if the room turns out to be gone.
  const linkCode = launchRoomCode?.trim().toUpperCase();
  const linkJoinRef = useRef(false);
  useEffect(() => {
    const target = linkCode ?? autoJoinCode;
    if (!currentUser || !target || isInMeeting || rejoinTarget || linkJoinRef.current) return;
    linkJoinRef.current = true;
    joinMeeting(target).catch(() => setCurrentView('debrief'));
  }, [currentUser, linkCode, autoJoinCode, isInMeeting, rejoinTarget, joinMeeting]);

  const handleLeaveMeeting = () => {
    setCurrentView('debrief');
  };

  const handleAcceptCall = async () => {
    if (!incomingCall) return;
    notifyCallAccepted(incomingCall.fromId);
    dismissIncomingCall();
    try {
      await joinMeeting(incomingCall.roomId, undefined, false, incomingCall.callType === 'audio' ? { muted: false, videoOff: true } : undefined);
      setCurrentView('active_meeting');
    } catch {
      // error shown via MeetingContext.meetingError
    }
  };

  const handleDeclineCall = () => {
    if (!incomingCall) return;
    notifyCallDeclined(incomingCall.fromId);
    dismissIncomingCall();
  };

  if (isLoading) {
    return (
      <div className="min-h-dvh bg-[#0e0e0e] flex items-center justify-center">
        <div className="w-8 h-8 rounded-full border-2 border-[#568dff] border-t-transparent animate-spin" />
      </div>
    );
  }

  // Guests live entirely inside the call — no sidebar, no top bar, nothing else in
  // the product is available to them. Rendering the meeting bare also keeps the
  // app shell's currentUser assumptions (avatars, compliance log actor) intact.
  if (!currentUser && isInMeeting) {
    return (
      <>
        <ActiveMeetingView onLeaveMeeting={() => { window.location.href = '/'; }} />
        <JoinRequestBanner />
      </>
    );
  }

  // Redialling the room a reload interrupted.
  if (!isInMeeting && rejoinState === 'pending') {
    return (
      <div className="min-h-dvh bg-[#111] flex flex-col items-center justify-center gap-3 text-[#e8eaed]">
        <div className="w-8 h-8 rounded-full border-2 border-[#8ab4f8] border-t-transparent animate-spin" />
        <p className="text-sm text-[#9aa0a6]">
          Rejoining <span className="font-mono font-bold text-[#8ab4f8]">{rejoinTarget}</span>…
        </p>
      </div>
    );
  }

  // Knock-to-join (server/main.go's attemptRoomEntry): a room that already has
  // other people in it doesn't admit a new, never-before-seen identity on the
  // spot any more — someone already inside has to accept them first. Same
  // screen regardless of guest vs signed-in, since the knock itself doesn't
  // distinguish the two. isInMeeting flips true the moment someone accepts,
  // which naturally falls through past this block on the next render.
  if (!isInMeeting && awaitingApproval) {
    return (
      <div className="min-h-dvh bg-[#111] flex flex-col items-center justify-center gap-3 text-[#e8eaed] px-4 text-center">
        <div className="w-10 h-10 rounded-full border-2 border-[#8ab4f8] border-t-transparent animate-spin" />
        <p className="text-base font-semibold">Waiting to be let in…</p>
        <p className="text-sm text-[#9aa0a6] max-w-xs">Someone in the meeting needs to accept you before you can join.</p>
      </div>
    );
  }

  if (!isInMeeting && joinDeniedReason) {
    return (
      <div className="min-h-dvh bg-[#111] flex flex-col items-center justify-center gap-3 text-[#e8eaed] px-4 text-center">
        <div className="w-12 h-12 rounded-full bg-[#3c1f1f] flex items-center justify-center text-2xl">🚫</div>
        <p className="text-base font-semibold">
          {joinDeniedReason === 'timed_out' ? 'Nobody let you in' : "You weren't let into this meeting"}
        </p>
        <p className="text-sm text-[#9aa0a6] max-w-xs">
          {joinDeniedReason === 'timed_out'
            ? 'Nobody in the meeting responded in time. Ask them to expect your request, then try again.'
            : 'Someone in the meeting turned down your request to join.'}
        </p>
        <button
          onClick={clearJoinDenied}
          className="mt-2 px-4 py-2 rounded-lg bg-[#8ab4f8] text-[#062e6f] font-semibold text-sm hover:bg-[#aecbfa] transition-colors"
        >
          Try again
        </button>
      </div>
    );
  }

  // Anyone with just a share link: name in, camera check, join. No account needed.
  if (!currentUser && linkCode && !forceLogin && !ssoLaunch) {
    return (
      <PreJoinScreen
        roomCode={linkCode}
        error={rejoinFailed ? 'That meeting has ended.' : meetingError}
        onJoin={(name, opts) => handlePreJoin(name, opts, linkCode, true)}
        onSignIn={() => setForceLogin(true)}
      />
    );
  }

  if (!currentUser) {
    return <LoginPage pendingJoinCode={linkCode} autoStart={ssoLaunch} />;
  }

  const handleAddLog = (event: string, status: 'SUCCESS' | 'FLAGGED') => {
    setLogs(prev => [{
      id: `log-${Date.now()}`,
      timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
      event,
      actor: currentUser.displayName,
      status,
    }, ...prev]);
  };

  const handleClearLogs = () => setLogs([]);

  const effectiveView: AppView = isInMeeting && !isMinimized
    ? 'active_meeting'
    : (currentView === 'active_meeting' ? viewBeforeMeetingRef.current : currentView);

  return (
    <>
    <div className="min-h-dvh text-[#e5e2e1] bg-[#0e0e0e] flex font-sans overflow-hidden w-full max-w-full">
      <Sidebar currentView={effectiveView} onViewChange={setCurrentView} isInMeeting={isInMeeting} />

      {/* FIXED: pl-0 on mobile, pl-[76px] on desktop to match the sidebar rail width */}
      <div className="flex-1 pl-0 md:pl-[76px] flex flex-col h-dvh overflow-hidden w-full">
        {effectiveView !== 'active_meeting' && (
          <TopBar
            currentView={effectiveView}
            onViewChange={setCurrentView}
            searchFilter={searchFilter}
            onSearchChange={setSearchFilter}
            onNewChatClicked={() => setCurrentView('chats')}
          />
        )}

        <div className="flex-1 flex overflow-hidden">
          <AnimatePresence mode="wait">
            <motion.div
              key={effectiveView}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.12, ease: 'easeOut' }}
              className="flex-grow flex overflow-hidden"
            >
              <React.Suspense fallback={<ViewLoader />}>
              {effectiveView === 'dashboard' && (
                <DashboardView
                  onNavigate={setCurrentView}
                  onJoinMeeting={() => setCurrentView('active_meeting')}
                />
              )}

              {effectiveView === 'chats' && (
                <ChatsView
                  onJoinMeeting={() => setCurrentView('active_meeting')}
                  searchFilter={searchFilter}
                />
              )}

              {effectiveView === 'calls' && (
                <CallsView onJoinMeeting={() => setCurrentView('active_meeting')} />
              )}

              {effectiveView === 'debrief' && (
                <DebriefView
                  onJoinMeeting={() => setCurrentView('active_meeting')}
                  autoJoinCode={autoJoinCode}
                  onAutoJoinConsumed={() => setAutoJoinCode(undefined)}
                />
              )}

              {effectiveView === 'active_meeting' && (
                <ActiveMeetingView onLeaveMeeting={handleLeaveMeeting} onMinimize={handleMinimizeMeeting} />
              )}

              {effectiveView === 'calendar' && <CalendarView />}
              {effectiveView === 'interview' && <InterviewView />}

              {effectiveView === 'security' && (
                <SecurityView
                  logs={logs}
                  onAddLog={handleAddLog}
                  onClearLogs={handleClearLogs}
                  searchFilter={searchFilter}
                />
              )}

              {effectiveView === 'support' && <SupportView searchFilter={searchFilter} />}
              </React.Suspense>
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>

    {isInMeeting && isMinimized && <FloatingCallWindow onExpand={handleExpandMeeting} />}
    {isInMeeting && <JoinRequestBanner />}

    {incomingCall && !isInMeeting && (
      <IncomingCallModal
        call={incomingCall}
        onAccept={handleAcceptCall}
        onDecline={handleDeclineCall}
      />
    )}

    <CommandPalette onNavigate={setCurrentView} onJoinMeeting={() => setCurrentView('active_meeting')} />
    </>
  );
}

function RoomCodeRoute() {
  const { roomCode } = useParams<{ roomCode: string }>();
  return <AppContent pendingRoomCode={roomCode} />;
}

export default function App() {
  useTheme();

  return (
    <AuthProvider>
      <MeetingProvider>
        <ChatProvider>
          <Routes>
            <Route path="/:roomCode" element={<RoomCodeRoute />} />
            <Route path="/" element={<AppContent />} />
          </Routes>
        </ChatProvider>
      </MeetingProvider>
    </AuthProvider>
  );
}
