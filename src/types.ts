export type AppView = 'chats' | 'debrief' | 'active_meeting' | 'security' | 'support' | 'calls' | 'calendar';

export interface IBUser {
  id: string;
  username: string;
  displayName: string;
  email: string;
  avatar?: string;
  bio?: string;
  status: 'online' | 'offline' | 'idle';
  createdAt: string;
}

export interface RealChatMessage {
  id: string;
  threadId: string;
  senderId: string;
  senderName: string;
  senderAvatar?: string;
  text: string;
  time: string;
  timestamp: number;
  isBold?: boolean;
  fileAttachment?: {
    name: string;
    size: number;
    type: string;
    dataUrl?: string;
  };
}

export interface RealChatThread {
  id: string;
  type: 'dm' | 'group';
  name: string;
  avatar?: string;
  participants: string[];
  lastMessage: string;
  lastTimestamp: number;
  unreadCount?: number;
}

export interface CalendarEvent {
  id: string;
  title: string;
  date: string;
  startTime: string;
  endTime?: string;
  description?: string;
  color: string;
  creatorId: string;
}

export interface CallRecord {
  id: string;
  type: 'incoming' | 'outgoing' | 'missed';
  callType: 'video' | 'audio';
  participantId: string;
  participantName: string;
  participantAvatar?: string;
  duration?: string;
  timestamp: number;
  roomId?: string;
}

export interface ExtractedItem {
  id: string;
  type: 'meeting' | 'deadline' | 'action' | 'reminder' | 'decision';
  text: string;
  time?: string;
  confidence: number;
}

// Legacy types for meeting/debrief/security/support views
export interface Participant {
  id: string;
  name: string;
  avatar: string;
  status?: string;
  isSpeaking?: boolean;
  isMuted?: boolean;
  videoSrc?: string;
  dataAlt?: string;
}

export interface ActionItem {
  id: string;
  title: string;
  priority: 'URGENT' | 'NORMAL' | 'LOW';
  assignee: {
    name: string;
    avatar: string;
  };
  dueDate: string;
  completed: boolean;
}

export interface ChatMessage {
  id: string;
  sender: string;
  senderName: string;
  avatar?: string;
  time: string;
  text: string;
  topic?: string;
  translation?: string;
}

export interface ChatThread {
  id: string;
  name: string;
  avatar?: string;
  initials?: string;
  lastMessage: string;
  time: string;
  unreadCount?: number;
  onlineStatus?: 'online' | 'offline' | 'idle';
  isGroup?: boolean;
  messages: ChatMessage[];
}

export interface ComplianceLog {
  id: string;
  timestamp: string;
  event: string;
  actor: string;
  status: 'SUCCESS' | 'FLAGGED' | 'PENDING';
}

export interface FAQItem {
  id: string;
  question: string;
  answer: string;
}

export interface FAQCategory {
  id: string;
  title: string;
  icon: string;
  items: string[];
}
