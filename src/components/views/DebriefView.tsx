import React, { useState } from 'react';
import {
  CheckCircle,
  Clock,
  Download,
  ExternalLink,
  Video,
  Plus,
  Bolt,
  Calendar,
  ChevronRight,
  ThumbsUp,
  ThumbsDown,
  Quote,
  Sparkles,
  Link2,
  Lock,
  AlertCircle,
} from 'lucide-react';
import { ActionItem } from '../../types';
import { useMeeting } from '../../context/MeetingContext';
import GuestNameModal from '../meeting/GuestNameModal';
import ScheduleMeetingModal from '../meeting/ScheduleMeetingModal';

interface DebriefViewProps {
  actionItems: ActionItem[];
  onToggleActionItem: (id: string) => void;
  onJoinMeeting: () => void;
  searchFilter: string;
}

export default function DebriefView({
  actionItems,
  onToggleActionItem,
  onJoinMeeting,
  searchFilter,
}: DebriefViewProps) {
  const { user, setUserName, createMeeting, joinMeeting, meetingError, clearMeetingError, scheduledMeetings } =
    useMeeting();

  const [meetingCode, setMeetingCode] = useState('');
  const [hasRated, setHasRated] = useState<'up' | 'down' | null>(null);
  const [selectedLanguage, setSelectedLanguage] = useState('English (US)');
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [showGuestModal, setShowGuestModal] = useState(false);
  const [pendingAction, setPendingAction] = useState<'create' | 'join' | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const needsGuestName = () => !sessionStorage.getItem('ibconnect_user_name') && user.name === 'David';

  const triggerCreate = async (name?: string) => {
    if (name) setUserName(name, true);
    setIsLoading(true);
    clearMeetingError();
    try {
      await createMeeting();
      onJoinMeeting();
    } catch {
      // error shown via meetingError
    } finally {
      setIsLoading(false);
    }
  };

  const triggerJoin = async (code: string, name?: string) => {
    if (name) setUserName(name, true);
    setIsLoading(true);
    clearMeetingError();
    try {
      await joinMeeting(code);
      onJoinMeeting();
    } catch {
      // error shown via meetingError
    } finally {
      setIsLoading(false);
    }
  };

  const handleInstantOrCreate = () => {
    // If no custom name set, prompt for guest name first
    if (needsGuestName()) {
      setPendingAction('create');
      setShowGuestModal(true);
    } else {
      triggerCreate();
    }
  };

  const handleJoinWithCode = () => {
    if (!meetingCode.trim()) {
      alert('Please enter a meeting code first.');
      return;
    }
    if (needsGuestName()) {
      setPendingAction('join');
      setShowGuestModal(true);
    } else {
      triggerJoin(meetingCode.trim().toUpperCase());
    }
  };

  const handleGuestConfirm = (name: string) => {
    setShowGuestModal(false);
    if (pendingAction === 'create') {
      triggerCreate(name);
    } else if (pendingAction === 'join') {
      triggerJoin(meetingCode.trim().toUpperCase(), name);
    }
    setPendingAction(null);
  };

  const filteredActionItems = actionItems.filter(
    (item) =>
      item.title.toLowerCase().includes(searchFilter.toLowerCase()) ||
      item.assignee.name.toLowerCase().includes(searchFilter.toLowerCase())
  );

  const pendingCount = actionItems.filter((item) => !item.completed).length;

  return (
    <div className="flex-1 overflow-y-auto p-6 flex flex-col lg:flex-row gap-6 scrollbar-hide select-none">

      {/* Guest Name Modal */}
      {showGuestModal && (
        <GuestNameModal
          action={pendingAction === 'create' ? 'create' : 'join'}
          meetingCode={pendingAction === 'join' ? meetingCode : null}
          onConfirm={handleGuestConfirm}
          onCancel={() => { setShowGuestModal(false); setPendingAction(null); }}
        />
      )}

      {/* Schedule Meeting Modal */}
      {showScheduleModal && (
        <ScheduleMeetingModal onClose={() => setShowScheduleModal(false)} />
      )}

      {/* Left/Center Column */}
      <div className="flex-1 flex flex-col gap-6 max-w-[860px]">

        {/* Error banner */}
        {meetingError && (
          <div className="bg-[#93000a]/20 border border-[#ffb4ab]/30 rounded-xl p-4 flex items-center gap-3">
            <AlertCircle className="w-4 h-4 text-[#ffb4ab] shrink-0" />
            <p className="text-xs text-[#ffb4ab] flex-1">{meetingError}</p>
            <button onClick={clearMeetingError} className="text-[#ffb4ab] hover:text-white cursor-pointer text-xs font-bold">✕</button>
          </div>
        )}

        {/* Recap Banner */}
        <div className="bg-[#1c1b1b] border border-[#424655] shadow-md rounded-2xl p-6 relative overflow-hidden flex flex-col sm:flex-row justify-between items-start gap-4">
          <div className="relative z-10 flex-1">
            <div className="flex flex-wrap items-center gap-3 mb-2">
              <span className="px-2.5 py-1 rounded-full bg-[#00e598]/10 text-[#70ffba] border border-[#00e296]/30 text-[10px] font-bold tracking-wider uppercase">
                COMPLETED
              </span>
              <span className="text-[#c2c6d8] text-xs flex items-center gap-1">
                <Clock className="w-3.5 h-3.5 text-[#8c90a1]" />
                Oct 24, 2023 • 45m duration
              </span>
            </div>
            <h2 className="text-2xl font-bold text-[#e5e2e1] mb-2 leading-tight">
              Q3 Product Strategy Sync
            </h2>
            <p className="text-[#c2c6d8] text-sm max-w-2xl leading-relaxed">
              Executive alignment on Q4 roadmap adjustments. Primary focus on accelerating AI feature integration.
            </p>
          </div>

          <div className="flex sm:flex-col lg:flex-row gap-2 relative z-10 shrink-0 w-full sm:w-auto">
            <button
              onClick={() => alert('Transcript download compiled.')}
              className="flex-1 flex items-center justify-center gap-2 px-3 py-2 border border-[#424655] rounded-lg hover:bg-[#201f1f] text-[#e5e2e1] hover:text-[#b0c6ff] transition-all text-xs font-semibold cursor-pointer"
            >
              <Download className="w-4 h-4" />
              Transcript
            </button>
            <button
              onClick={() => alert('Action items exported to Jira.')}
              className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-[#b0c6ff] text-[#002d6f] rounded-lg hover:bg-[#b0c6ff]/90 transition-all text-xs font-bold cursor-pointer"
            >
              <ExternalLink className="w-4 h-4" />
              Export to Jira
            </button>
          </div>
        </div>

        {/* Action Items Checklist */}
        <div className="bg-[#1c1b1b] border border-[#424655] shadow-md rounded-2xl p-5 flex flex-col h-[320px]">
          <div className="flex justify-between items-center mb-4">
            <h3 className="font-semibold text-sm text-[#e5e2e1] flex items-center gap-2">
              <CheckCircle className="w-4 h-4 text-[#c0c1ff]" />
              Action Items Checklist
            </h3>
            <span className="text-xs text-[#8c90a1] bg-[#131313] px-2.5 py-1 rounded-full border border-[#424655]/40 font-mono">
              {pendingCount} Pending
            </span>
          </div>

          <div className="flex-1 overflow-y-auto pr-1 space-y-3 scrollbar-hide">
            {filteredActionItems.map((item) => (
              <div
                key={item.id}
                onClick={() => onToggleActionItem(item.id)}
                className={`p-3 border rounded-xl hover:border-[#b0c6ff]/30 transition-all group cursor-pointer ${
                  item.completed
                    ? 'border-[#424655]/30 bg-[#201f1f]/30 opacity-60'
                    : 'border-[#424655]/60 bg-[#201f1f]'
                }`}
              >
                <div className="flex justify-between items-start mb-2">
                  <div className="flex items-center gap-2.5">
                    <input
                      type="checkbox"
                      checked={item.completed}
                      onChange={() => {}}
                      className="rounded text-[#568dff] focus:ring-[#568dff] bg-[#131313] border-[#424655] cursor-pointer"
                    />
                    <span className={`text-xs text-[#e5e2e1] font-medium transition-all ${item.completed ? 'line-through text-[#8c90a1]' : ''}`}>
                      {item.title}
                    </span>
                  </div>
                  <span className={`px-2 py-0.5 rounded text-[9px] font-black tracking-wide ${
                    item.priority === 'URGENT'
                      ? 'bg-[#93000a]/20 text-[#ffb4ab] border border-[#ffb4ab]/20'
                      : item.priority === 'NORMAL'
                      ? 'bg-[#201f1f] text-[#c2c6d8] border border-[#424655]'
                      : 'bg-[#00e598]/10 text-[#70ffba]'
                  }`}>
                    {item.priority}
                  </span>
                </div>

                <div className="flex items-center justify-between mt-3 pl-6">
                  <div className="flex items-center gap-2">
                    {item.assignee.avatar ? (
                      <img alt={item.assignee.name} className="w-5 h-5 rounded-full border border-[#424655]/60" src={item.assignee.avatar} />
                    ) : (
                      <div className="w-5 h-5 rounded-full bg-[#8083ff]/10 text-[#c0c1ff] flex items-center justify-center font-bold text-[8px]">MK</div>
                    )}
                    <span className="text-[10px] text-[#c2c6d8]">{item.assignee.name}</span>
                  </div>
                  <span className="text-[10px] text-[#8c90a1] flex items-center gap-1">
                    <Calendar className="w-3 h-3" />
                    Due {item.dueDate}
                  </span>
                </div>
              </div>
            ))}
            {filteredActionItems.length === 0 && (
              <div className="h-full flex items-center justify-center">
                <p className="text-xs text-[#8c90a1]">No matching action items found.</p>
              </div>
            )}
          </div>
        </div>

        {/* Meeting Management Widget */}
        <div className="bg-[#1c1b1b] border border-[#424655] shadow-md rounded-2xl p-6 flex flex-col gap-5">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-[#568dff]/10 flex items-center justify-center">
                <Video className="w-4 h-4 text-[#b0c6ff]" />
              </div>
              <div>
                <h3 className="font-semibold text-sm text-[#e5e2e1] leading-none">Meeting Management</h3>
                <p className="text-[11px] text-[#8c90a1] mt-1">Start or join your secure cloud sync sessions</p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {/* Create New — generates a code and starts meeting as host */}
              <button
                onClick={handleInstantOrCreate}
                disabled={isLoading}
                className="flex items-center gap-1 bg-[#568dff]/10 text-[#b0c6ff] border border-[#568dff]/30 hover:bg-[#568dff]/20 font-semibold text-xs py-2 px-3 rounded-lg cursor-pointer transition-all shrink-0 disabled:opacity-50"
              >
                <Plus className="w-3.5 h-3.5" />
                {isLoading ? 'Creating...' : 'Create New'}
              </button>
              {/* Instant — same as Create New */}
              <button
                onClick={handleInstantOrCreate}
                disabled={isLoading}
                className="flex items-center gap-1 bg-[#201f1f] text-[#e5e2e1] border border-[#424655] hover:bg-[#2a2a2a] font-semibold text-xs py-2 px-3 rounded-lg cursor-pointer transition-all shrink-0 disabled:opacity-50"
              >
                <Bolt className="w-3.5 h-3.5 text-[#70ffba]" />
                {isLoading ? '...' : 'Instant'}
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5 items-end">
            {/* Join with Code */}
            <div className="flex flex-col gap-2">
              <label className="text-[9px] font-bold tracking-wider text-[#8c90a1] uppercase ml-1">Join with Code</label>
              <div className="relative flex items-center bg-[#131313] rounded-xl border border-[#424655] focus-within:border-[#568dff] focus-within:ring-1 focus-within:ring-[#568dff] transition-all">
                <Link2 className="w-4 h-4 text-[#8c90a1] absolute left-3.5" />
                <input
                  type="text"
                  placeholder="e.g. ABCD-1234"
                  className="w-full pl-10 pr-20 py-2.5 bg-transparent border-none text-xs text-[#e5e2e1] placeholder-[#8c90a1]/70 outline-none uppercase"
                  value={meetingCode}
                  onChange={(e) => setMeetingCode(e.target.value.toUpperCase())}
                  onKeyDown={(e) => e.key === 'Enter' && handleJoinWithCode()}
                />
                <button
                  onClick={handleJoinWithCode}
                  disabled={isLoading || !meetingCode.trim()}
                  className="absolute right-1.5 bg-[#568dff]/10 text-[#b0c6ff] hover:bg-[#568dff]/20 px-3 py-1.5 rounded-lg text-[10px] font-bold tracking-wider transition-colors cursor-pointer disabled:opacity-40"
                >
                  {isLoading ? '...' : 'JOIN'}
                </button>
              </div>
            </div>

            {/* Upcoming Meeting */}
            <div className="flex flex-col gap-2">
              <label className="text-[9px] font-bold tracking-wider text-[#8c90a1] uppercase ml-1">
                {scheduledMeetings.length > 0 ? 'Scheduled Meetings' : 'Upcoming for You'}
              </label>
              {scheduledMeetings.length > 0 ? (
                <div className="space-y-1.5 max-h-24 overflow-y-auto">
                  {scheduledMeetings.map((sm) => (
                    <div
                      key={sm.id}
                      onClick={() => { setMeetingCode(sm.code); }}
                      className="p-2 rounded-xl bg-[#201f1f] border border-[#424655] hover:border-[#b0c6ff]/40 transition-colors group cursor-pointer flex items-center justify-between"
                    >
                      <div className="flex items-center gap-2">
                        <Calendar className="w-3.5 h-3.5 text-[#b0c6ff]" />
                        <div>
                          <p className="text-xs font-semibold text-[#e5e2e1] truncate">{sm.title}</p>
                          <p className="text-[9px] text-[#8c90a1]">{sm.date} {sm.time} · {sm.code}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div
                  onClick={handleInstantOrCreate}
                  className="p-2.5 rounded-xl bg-[#201f1f] border border-[#424655] hover:border-[#b0c6ff]/40 transition-colors group cursor-pointer flex items-center justify-between"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-[#568dff]/10 flex items-center justify-center shrink-0">
                      <Calendar className="w-4 h-4 text-[#b0c6ff]" />
                    </div>
                    <div>
                      <span className="text-xs font-semibold text-[#e5e2e1] leading-snug">Q4 Roadmap Review</span>
                      <p className="text-[10px] text-[#8c90a1]">Today, 4:00 PM</p>
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-[#8c90a1] group-hover:text-[#b0c6ff] transition-all" />
                </div>
              )}
            </div>
          </div>

          <div className="pt-3 border-t border-[#424655]/20 flex flex-wrap justify-between items-center gap-2">
            <span className="text-xs text-[#8c90a1]">Need to configure scheduled syncs?</span>
            <button
              onClick={() => setShowScheduleModal(true)}
              className="text-[#b0c6ff] hover:text-[#568dff] font-bold text-xs flex items-center gap-1 cursor-pointer"
            >
              <Calendar className="w-3.5 h-3.5" />
              Schedule a Meeting
            </button>
          </div>
        </div>
      </div>

      {/* Right Column: Transcript */}
      <div className="w-full lg:w-85 flex-shrink-0 flex flex-col gap-6">

        <div className="bg-[#1c1b1b] border border-[#424655] shadow-md rounded-xl p-4 flex items-center justify-between">
          <span className="text-xs text-[#c2c6d8] font-semibold">Rate meeting quality</span>
          <div className="flex gap-2">
            <button
              onClick={() => setHasRated('up')}
              className={`w-8 h-8 rounded border flex items-center justify-center transition-all cursor-pointer ${
                hasRated === 'up'
                  ? 'bg-[#00e598]/20 text-[#70ffba] border-[#70ffba]'
                  : 'bg-transparent border-[#424655] text-[#8c90a1] hover:text-[#70ffba] hover:border-[#70ffba]'
              }`}
            >
              <ThumbsUp className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setHasRated('down')}
              className={`w-8 h-8 rounded border flex items-center justify-center transition-all cursor-pointer ${
                hasRated === 'down'
                  ? 'bg-[#93000a]/20 text-[#ffb4ab] border-[#ffb4ab]'
                  : 'bg-transparent border-[#424655] text-[#8c90a1] hover:text-[#ffb4ab] hover:border-[#ffb4ab]'
              }`}
            >
              <ThumbsDown className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div className="bg-[#1c1b1b] border border-[#424655] shadow-lg rounded-2xl flex-1 flex flex-col overflow-hidden min-h-[460px]">
          <div className="p-4 border-b border-[#424655] flex justify-between items-center bg-[#2a2a2a]/40">
            <h3 className="font-semibold text-xs text-[#e5e2e1] flex items-center gap-1.5 uppercase tracking-wider">
              <Quote className="w-4 h-4 text-[#c0c1ff] transform rotate-180" />
              Smart Transcript
            </h3>
            <select
              className="text-[11px] bg-[#131313] border border-[#424655] rounded px-2 py-1 text-[#c2c6d8] outline-none focus:border-[#b0c6ff] font-mono"
              value={selectedLanguage}
              onChange={(e) => setSelectedLanguage(e.target.value)}
            >
              <option>English (US)</option>
              <option>Spanish (ES)</option>
              <option>French (FR)</option>
            </select>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-5 bg-[#1c1b1b]/30 scrollbar-hide">
            <div className="relative pl-3.5 border-l-2 border-[#c0c1ff] mb-4 bg-[#c0c1ff]/5 p-3 rounded-r-xl border-dashed">
              <div className="flex items-center gap-1.5 mb-1.5 text-[#c0c1ff]">
                <Sparkles className="w-3.5 h-3.5 animate-pulse" />
                <span className="text-[9px] font-black tracking-widest uppercase">INTELLIGENCE INSIGHT</span>
              </div>
              <p className="text-xs text-[#c2c6d8] leading-relaxed">
                The discussions heavily skewed toward Q4 server rate-limit constraints. Consider reviewing historical spend logs before the next sync.
              </p>
            </div>

            <div className="flex gap-3">
              <img alt="David" className="w-8 h-8 rounded-full border border-[#424655]/60 flex-shrink-0 mt-1 object-cover"
                src="https://lh3.googleusercontent.com/aida-public/AB6AXuCvRD13_qzzAV0V2PpVLuJEFkyfFks-DVev33Wxbw5NAmWV_HfRvdQuVImFR02oROpkBI9sAp-4LYIElKI7Saitu633GWwDHutJV2oJZxzXszB3aRyMuoiEhXn7wkuUfgY5we2LTSpz7V4PmFLsfVW_SOkMdXimckkqtPFW2U8tfV47nlyWa5b1cMtbHHPYr1SNZLP_DM8n6_5TvMOji2K5F9T2NX3ywfB7k0D_5eqCBqhiAw-G2S9Ewia0MloW1AcdN9MXkIJTDHIZ" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2 mb-1">
                  <span className="font-semibold text-xs text-[#e5e2e1]">David (You)</span>
                  <span className="text-[10px] text-[#8c90a1] font-mono">10:02 AM</span>
                </div>
                <div className="bg-[#201f1f] border border-[#424655]/40 rounded-2xl rounded-tl-none p-3 shadow-sm">
                  <p className="text-xs text-[#e5e2e1] leading-relaxed">
                    Let's look at the integration timeline. I'm concerned about the API limits we hit last week during load testing.
                  </p>
                </div>
              </div>
            </div>

            <div className="flex gap-3">
              <img alt="Sarah" className="w-8 h-8 rounded-full border border-[#424655]/60 flex-shrink-0 mt-1 object-cover"
                src="https://lh3.googleusercontent.com/aida-public/AB6AXuDSOb1gtLOioHpppdOZaKQA7QZaZmDxvoLIplK2Zl29P75KrHyBVWYqE7UnLv1QbJ6ZxVAk_yytFGMf4ami7-JVnBCOmGEmkOhj0E1LttJdRK8SylicZKPBsDVeGSuapMV0WktU0JI_huOLnql1hbaYfWzeSOHv-iyzcBgdtX1dDJ86hblDYo5nae7cNKM5Hu5Cknbj1slnlfJ4k7C8ddl8ASinBbYzTO20zEJVUQJI4P0TEB3fbh12IdG94bxoBZOlVYbYA20Lw9W6" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2 mb-1">
                  <span className="font-semibold text-xs text-[#e5e2e1]">Sarah J.</span>
                  <span className="text-[10px] text-[#8c90a1] font-mono">10:04 AM</span>
                  <span className="px-1.5 py-0.5 rounded text-[9px] bg-[#00e598]/10 text-[#70ffba] border border-[#00e296]/20 ml-2 font-black">TOPIC: TIMELINE</span>
                </div>
                <div className="bg-[#2a2a2a] border border-[#424655]/40 rounded-2xl rounded-tl-none p-3 shadow-sm">
                  <p className="text-xs text-[#e5e2e1] leading-relaxed">
                    I can <span className="bg-[#568dff]/20 text-[#b0c6ff] font-bold px-1.5 py-0.5 rounded border border-[#568dff]/30">finalize the AI API integration spec</span> by Thursday. We'll need backend support to increase the rate limits.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
