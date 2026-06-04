import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';

// Auth
import { AuthProvider, useAuth } from './context/AuthContext';
import { ChatProvider } from './context/ChatContext';
import LoginPage from './components/auth/LoginPage';

// Layout
import Sidebar from './components/layout/Sidebar';
import TopBar from './components/layout/TopBar';

// Views
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

// Types & data
import { AppView, ActionItem, ComplianceLog } from './types';
import { initialActionItems, initialComplianceLogs } from './data';

function AppContent() {
  const { currentUser, isLoading } = useAuth();
  const { isInMeeting } = useMeeting();

  const [currentView, setCurrentView] = useState<AppView>('chats');
  const [actionItems, setActionItems] = useState<ActionItem[]>(initialActionItems);
  const [logs, setLogs] = useState<ComplianceLog[]>(initialComplianceLogs);
  const [searchFilter, setSearchFilter] = useState('');

  useEffect(() => {
    if (isInMeeting) setCurrentView('active_meeting');
  }, [isInMeeting]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#0e0e0e] flex items-center justify-center">
        <div className="w-8 h-8 rounded-full border-2 border-[#568dff] border-t-transparent animate-spin" />
      </div>
    );
  }

  if (!currentUser) return <LoginPage />;

  const handleToggleActionItem = (id: string) => {
    setActionItems(prev =>
      prev.map(item => {
        if (item.id === id) {
          const next = !item.completed;
          handleAddLog(`Action Item ${next ? 'resolved' : 'reopened'}: "${item.title}"`, 'SUCCESS');
          return { ...item, completed: next };
        }
        return item;
      })
    );
  };

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

  return (
    <div className="min-h-screen text-[#e5e2e1] bg-[#0e0e0e] flex font-sans overflow-hidden">
      <Sidebar currentView={currentView} onViewChange={setCurrentView} />

      <div className="flex-1 pl-[72px] flex flex-col h-screen overflow-hidden">
        {currentView !== 'active_meeting' && (
          <TopBar
            currentView={currentView}
            onViewChange={setCurrentView}
            searchFilter={searchFilter}
            onSearchChange={setSearchFilter}
            onNewChatClicked={() => setCurrentView('chats')}
          />
        )}

        <div className="flex-1 flex overflow-hidden">
          <AnimatePresence mode="wait">
            <motion.div
              key={currentView}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.12, ease: 'easeOut' }}
              className="flex-grow flex overflow-hidden"
            >
              {currentView === 'chats' && (
                <ChatsView
                  onJoinMeeting={() => setCurrentView('active_meeting')}
                  searchFilter={searchFilter}
                />
              )}

              {currentView === 'calls' && (
                <CallsView onJoinMeeting={() => setCurrentView('active_meeting')} />
              )}

              {currentView === 'debrief' && (
                <DebriefView
                  actionItems={actionItems}
                  onToggleActionItem={handleToggleActionItem}
                  onJoinMeeting={() => setCurrentView('active_meeting')}
                  searchFilter={searchFilter}
                />
              )}

              {currentView === 'active_meeting' && (
                <ActiveMeetingView onLeaveMeeting={() => setCurrentView('debrief')} />
              )}

              {currentView === 'calendar' && <CalendarView />}

              {currentView === 'security' && (
                <SecurityView
                  logs={logs}
                  onAddLog={handleAddLog}
                  onClearLogs={handleClearLogs}
                  searchFilter={searchFilter}
                />
              )}

              {currentView === 'support' && <SupportView searchFilter={searchFilter} />}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <MeetingProvider>
        <ChatProvider>
          <AppContent />
        </ChatProvider>
      </MeetingProvider>
    </AuthProvider>
  );
}
