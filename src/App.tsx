import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import Sidebar from './components/Sidebar';
import TopBar from './components/TopBar';
import ChatsView from './components/ChatsView';
import DebriefView from './components/DebriefView';
import ActiveMeetingView from './components/ActiveMeetingView';
import SecurityView from './components/SecurityView';
import SupportView from './components/SupportView';

// Types & Preset content
import { AppView, ActionItem, ChatThread, ComplianceLog, ChatMessage } from './types';
import { 
  initialParticipants, 
  initialActionItems, 
  initialThreads, 
  initialComplianceLogs 
} from './data';

export default function App() {
  const [currentView, setCurrentView] = useState<AppView>('chats');
  const [actionItems, setActionItems] = useState<ActionItem[]>(initialActionItems);
  const [threads, setThreads] = useState<ChatThread[]>(initialThreads);
  const [logs, setLogs] = useState<ComplianceLog[]>(initialComplianceLogs);
  const [searchFilter, setSearchFilter] = useState('');
  const [unreadCount, setUnreadCount] = useState(2);

  // Auto replying module matching interactive requirements
  const handleSendMessage = (threadId: string, text: string) => {
    // 1. Append user message
    const newMessage: ChatMessage = {
      id: `user-msg-${Date.now()}`,
      sender: 'user',
      senderName: 'You (David)',
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      text: text
    };

    setThreads(prevThreads => 
      prevThreads.map(t => {
        if (t.id === threadId) {
          return {
            ...t,
            lastMessage: text,
            time: 'Just now',
            messages: [...t.messages, newMessage]
          };
        }
        return t;
      })
    );

    // 2. Simulate smart replies after 1.5s
    setTimeout(() => {
      let replyText = "Understood. Re-orienting key files under Swiss Vault structures now. Let me know when you are ready to quick-sync!";
      const lowerText = text.toLowerCase();
      
      if (lowerText.includes('sync') || lowerText.includes('join') || lowerText.includes('meeting') || lowerText.includes('call')) {
        replyText = "Perfect! The Daily Standup room is already active in Zurich-West enclave. Click 'Quick Join' on your right side to join immediately!";
      } else if (lowerText.includes('spec') || lowerText.includes('api') || lowerText.includes('competitor')) {
        replyText = "Reviewing the anomaly PDF sheet right now. The rate limits could definitely be adjusted on Zurich Node A. Let's make sure compliance security signs off first.";
      } else if (lowerText.includes('security') || lowerText.includes('swiss') || lowerText.includes('residency') || lowerText.includes('gdpr')) {
        replyText = "Operational Sovereignty reports are green. I've logged the compliance state change under the 'Security' console tab.";
      }

      const activeUser = threadId === 'sarah-jenkins' ? 'sarah' : 'marcus';
      const activeName = threadId === 'sarah-jenkins' ? 'Sarah Jenkins' : 'Marcus Chen';
      const activeAvatar = threadId === 'sarah-jenkins' 
        ? 'https://lh3.googleusercontent.com/aida-public/AB6AXuDIKHdL_gKET2TRMf6MHT6iXkz974_ytMmi0_bn0GaOgs1PyWBcZ5nSkivDyyPci9eUggBLyAcnMrX8A4NJyYdsUhsWZ59Z-AjE_oRC4ZlrYsSxRGRm5RobO6VUq69HuAkpDhB0niFNbcOWA2A6vk2c_ZTynM97aidb0fnn6HzkF0GDa7h7pWYwJ3oYxZMmfXSrNGFPIcg6fd1UAvnUQozXXnHeIa7D2fuN0FttkfQzivgS6_wegaZ81e4PBDU22WzDirqkkGZGCZOP'
        : 'https://lh3.googleusercontent.com/aida-public/AB6AXuB8s9eCpTvJEBy0c5ajO3bIHrjgfAlY8ScVJDw3dE36Or-xCTHhUgUzGW2GdtQyTALJQ3W3xmahPQwuJ-aEyxDd9JaaaZigG034zpxMuhJHhM11JKSo3f2c17xu9iDVZB3x4am_67VeCE4GegYRHl75a7jGaq_genBoPQEJ2C2wwEjsg1FiCn1bTSH5GAw2PiPSQ1WcCoJF2yqK8GY0AaNO_bkQ0fckuyZLTwKkkNTY3pUOvvoAqaBXivV_qKx-ip88OFboAe8xZ4q5';

      const replyMessage: ChatMessage = {
        id: `reply-msg-${Date.now()}`,
        sender: activeUser,
        senderName: activeName,
        avatar: activeAvatar,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        text: replyText
      };

      setThreads(prevThreads => 
        prevThreads.map(t => {
          if (t.id === threadId) {
            return {
              ...t,
              unreadCount: t.id !== currentView ? (t.unreadCount || 0) + 1 : 0,
              lastMessage: replyText,
              time: 'Just now',
              messages: [...t.messages, replyMessage]
            };
          }
          return t;
        })
      );

      // Trigger badge change if in another view
      if (currentView !== 'chats') {
        setUnreadCount(prev => prev + 1);
      }
    }, 1500);
  };

  // Mark all messages as read when switching into chats view
  useEffect(() => {
    if (currentView === 'chats') {
      setUnreadCount(0);
      setThreads(prev => prev.map(t => t.id === 'sarah-jenkins' ? { ...t, unreadCount: 0 } : t));
    }
  }, [currentView]);

  const handleToggleActionItem = (id: string) => {
    setActionItems(prev => prev.map(item => {
      if (item.id === id) {
        const nextState = !item.completed;
        const logMsg = nextState 
          ? `Action Item resolved: "${item.title}" (Assigned: ${item.assignee.name})`
          : `Action Item reopened: "${item.title}"`;
        
        handleAddLog(logMsg, "SUCCESS");
        return { ...item, completed: nextState };
      }
      return item;
    }));
  };

  const handleAddLog = (event: string, status: 'SUCCESS' | 'FLAGGED') => {
    const newLog: ComplianceLog = {
      id: `log-${Date.now()}`,
      timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19) + ' UTC',
      event: event,
      actor: 'SYS_DAEM',
      status: status
    };
    setLogs(prev => [newLog, ...prev]);
  };

  const handleClearLogs = () => {
    setLogs([]);
  };

  const handleNewChatClicked = () => {
    setCurrentView('chats');
    const inputMsg = prompt("Create new messaging secure socket session with team. Enter participant name or channel prefix:");
    if (inputMsg && inputMsg.trim()) {
      const newThreadId = `init-thread-${Date.now()}`;
      const newThread: ChatThread = {
        id: newThreadId,
        name: inputMsg,
        initials: inputMsg.substring(0, 3).toUpperCase(),
        lastMessage: "Secure channel initiated.",
        time: "Just now",
        messages: [
          {
            id: `msg-init-${Date.now()}`,
            sender: 'system',
            senderName: 'SYSTEM',
            time: 'Just now',
            text: `This cryptographic workspace channel has been successfully initiated by David. Standard compliance rules are enforced.`
          }
        ]
      };
      setThreads(prev => [newThread, ...prev]);
      alert(`Cryptographic channel socket matching "${inputMsg}" initialized.`);
    }
  };

  return (
    <div className="min-h-screen text-[#e5e2e1] bg-[#131313] flex font-sans overflow-hidden">
      
      {/* Fixed Vertical Navigation Drawer */}
      <Sidebar 
        currentView={currentView} 
        onViewChange={setCurrentView} 
        unreadCount={unreadCount} 
      />

      {/* Main workspace (offsetting 72px for the fixed sidebar width) */}
      <div className="flex-1 pl-18 flex flex-col h-screen overflow-hidden">
        
        {/* Top Header Controls bar */}
        <TopBar 
          currentView={currentView}
          onViewChange={setCurrentView}
          searchFilter={searchFilter}
          onSearchChange={setSearchFilter}
          onNewChatClicked={handleNewChatClicked}
        />

        {/* Dynamic Route views with standard transition fade animations */}
        <div className="flex-1 flex overflow-hidden">
          <AnimatePresence mode="wait">
            <motion.div
              key={currentView}
              initial={{ opacity: 0, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -3 }}
              transition={{ duration: 0.15, ease: 'easeOut' }}
              className="flex-grow flex overflow-hidden"
            >
              {currentView === 'chats' && (
                <ChatsView 
                  threads={threads}
                  onSendMessage={handleSendMessage}
                  onJoinMeeting={() => setCurrentView('active_meeting')}
                  searchFilter={searchFilter}
                />
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
                <ActiveMeetingView 
                  participants={initialParticipants}
                  onLeaveMeeting={() => setCurrentView('debrief')}
                />
              )}

              {currentView === 'security' && (
                <SecurityView 
                  logs={logs}
                  onAddLog={handleAddLog}
                  onClearLogs={handleClearLogs}
                  searchFilter={searchFilter}
                />
              )}

              {currentView === 'support' && (
                <SupportView 
                  searchFilter={searchFilter}
                />
              )}
            </motion.div>
          </AnimatePresence>
        </div>

      </div>
    </div>
  );
}
