export type AppView = 'dashboard' | 'chats' | 'debrief' | 'active_meeting' | 'security' | 'support' | 'calls' | 'calendar' | 'interview';

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

// ─── Virtual Interview ───────────────────────────────────────────────────────
// The model runs on a separate GPU VM (see gpu/CONTRACT.md); these are the
// shapes the Go backend returns after talking to it.

export interface SocialLink {
  platform: 'linkedin' | 'github' | 'gitlab' | 'stackoverflow' | 'leetcode' | 'kaggle'
    | 'medium' | 'devto' | 'behance' | 'dribbble' | 'twitter' | 'youtube' | 'portfolio' | 'other';
  url: string;
  handle?: string;
}

export interface GitHubRepo {
  name: string; description?: string; language?: string; stars: number; url: string;
}

export interface GitHubProfile {
  login: string; name?: string; bio?: string; avatarUrl?: string;
  company?: string; location?: string; blog?: string;
  publicRepos: number; followers: number; createdAt?: string;
  topLanguages: string[]; topRepos: GitHubRepo[]; totalStars: number;
  fetchedAt: string;
  /** Set when enrichment was skipped — rate limit, unknown user, network. Not an error. */
  unavailable?: string;
}

export interface InterviewProfile {
  id: string; fileName: string;
  fullName?: string; email?: string; phone?: string;
  headline?: string; location?: string; summary?: string;
  skills: string[]; links: SocialLink[]; github?: GitHubProfile;
  createdAt: string;
}

export type Seniority = 'intern' | 'junior' | 'mid' | 'senior' | 'staff';
export type InterviewKind = 'technical' | 'behavioral' | 'mixed' | 'system_design';
export type InterviewStatus = 'created' | 'in_progress' | 'completed';

export interface InterviewQuestion {
  id: string; index: number; text: string; category: string;
  rationale?: string; expectedPoints?: string[];
}

export interface InterviewAnswer {
  questionId: string; transcript: string; durationSec: number;
  scores: Record<string, number>; overall: number;
  strengths: string[]; improvements: string[]; feedback: string;
  fillerWords: number; wordsPerMinute: number; answeredAt: string;
}

export interface InterviewReport {
  overall: number; scores?: Record<string, number>;
  verdict: string; summary: string;
  strengths: string[]; improvements: string[]; focus_areas: string[];
}

export interface InterviewSession {
  id: string; profileId: string;
  role: string; seniority: Seniority; kind: InterviewKind; status: InterviewStatus;
  overallScore?: number; report?: InterviewReport;
  questions: InterviewQuestion[]; answers: InterviewAnswer[];
  createdAt: string; completedAt?: string;
}

export interface InterviewEngineStatus {
  configured: boolean; ready: boolean; speech: boolean;
  model?: string; detail?: string;
}
