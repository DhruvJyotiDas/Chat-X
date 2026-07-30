import React, { useState, useEffect } from 'react';
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
import DashboardView from './components/views/DashboardView';
import ChatsView from './components/views/ChatsView';
import DebriefView from './components/views/DebriefView';
import SecurityView from './components/views/SecurityView';
import SupportView from './components/views/SupportView';
import CallsView from './components/views/CallsView';
import CalendarView from './components/views/CalendarView';

// Meeting
import ActiveMeetingView from './components/meeting/ActiveMeetingView';

// Context
import { MeetingProvider, useMeeting } from './context/MeetingContext';
import { useChat } from './context/ChatContext';
import IncomingCallModal from './components/meeting/IncomingCallModal';
import CommandPalette from './components/CommandPalette';

// Types & data
import { AppView, ComplianceLog } from './types';
import { initialComplianceLogs } from './data';
import { useTheme } from './hooks/useTheme';

function AppContent({ pendingRoomCode }: { pendingRoomCode?: string }) {
  const { currentUser, isLoading } = useAuth();
  const { isInMeeting, joinMeeting } = useMeeting();
  const { incomingCall, dismissIncomingCall, notifyCallAccepted, notifyCallDeclined } = useChat();

  const [currentView, setCurrentView] = useState<AppView>('dashboard');
  const [logs, setLogs] = useState<ComplianceLog[]>(initialComplianceLogs);
  const [searchFilter, setSearchFilter] = useState('');
  const [autoJoinCode, setAutoJoinCode] = useState<string | undefined>(pendingRoomCode);

  useEffect(() => {
    if (isInMeeting) setCurrentView('active_meeting');
  }, [isInMeeting]);

  useEffect(() => {
    if (currentUser && autoJoinCode) {
      setCurrentView('debrief');
    }
  }, [currentUser, autoJoinCode]);

  const handleLeaveMeeting = () => {
    setCurrentView('debrief');
  };

  const handleAcceptCall = async () => {
    if (!incomingCall) return;
    notifyCallAccepted(incomingCall.fromId);
    dismissIncomingCall();
    try {
      await joinMeeting(incomingCall.roomId);
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
      <div className="min-h-screen bg-[#0e0e0e] flex items-center justify-center">
        <div className="w-8 h-8 rounded-full border-2 border-[#568dff] border-t-transparent animate-spin" />
      </div>
    );
  }

  if (!currentUser) {
    return <LoginPage pendingJoinCode={pendingRoomCode} />;
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

  const effectiveView: AppView = isInMeeting ? 'active_meeting' : currentView;

  return (
    <>
    <div className="min-h-screen text-[#e5e2e1] bg-[#0e0e0e] flex font-sans overflow-hidden w-full max-w-full">
      <Sidebar currentView={effectiveView} onViewChange={setCurrentView} isInMeeting={isInMeeting} />

      {/* FIXED: pl-0 on mobile, pl-[76px] on desktop to match the sidebar rail width */}
      <div className="flex-1 pl-0 md:pl-[76px] flex flex-col h-screen overflow-hidden w-full">
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
                <ActiveMeetingView onLeaveMeeting={handleLeaveMeeting} />
              )}

              {effectiveView === 'calendar' && <CalendarView />}

              {effectiveView === 'security' && (
                <SecurityView
                  logs={logs}
                  onAddLog={handleAddLog}
                  onClearLogs={handleClearLogs}
                  searchFilter={searchFilter}
                />
              )}

              {effectiveView === 'support' && <SupportView searchFilter={searchFilter} />}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>

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

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get('token');

    if (urlToken) {
      console.log("SSO: Processing new token from URL...");
      localStorage.setItem('ibconnect_jwt', urlToken);
      fetch(`/api/auth/me?token=${urlToken}`)
        .then(res => res.json())
        .then(user => {
          if (user && user.id) {
            localStorage.setItem('ibconnect_me', JSON.stringify({
              id: user.id,
              displayName: user.displayName,
              username: user.username,
              email: user.email,
              avatar: user.avatar
            }));
          }
        })
        .catch(e => console.error("SSO fetch error:", e))
        .finally(() => {
          window.history.replaceState({}, document.title, window.location.pathname);
          window.location.reload();
        });
    }
  }, []);

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
