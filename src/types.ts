/**
 * Types and interfaces for IB Connect dashboard application.
 */

export type AppView = 'chats' | 'debrief' | 'active_meeting' | 'security' | 'support';

export interface Participant {
  id: string;
  name: string;
  avatar: string;
  status?: string; // e.g., 'Confident', 'Low Light', 'Speaking', 'Muted'
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
  sender: 'user' | 'sarah' | 'marcus' | 'system';
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
