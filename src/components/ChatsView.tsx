import React, { useState } from 'react';
import { 
  Paperclip, 
  Sparkles, 
  Bold, 
  Send, 
  FileText, 
  Download, 
  Video, 
  PlusCircle, 
  MapPin, 
  Calendar, 
  Search, 
  Bell, 
  CheckCircle,
  Filter,
  Check
} from 'lucide-react';
import { ChatThread, ChatMessage } from '../types';

interface ChatsViewProps {
  threads: ChatThread[];
  onSendMessage: (threadId: string, text: string) => void;
  onJoinMeeting: () => void;
  searchFilter: string;
}

export default function ChatsView({ 
  threads, 
  onSendMessage, 
  onJoinMeeting,
  searchFilter 
}: ChatsViewProps) {
  const [selectedThreadId, setSelectedThreadId] = useState('sarah-jenkins');
  const [inputText, setInputText] = useState('');

  // Find active thread
  const activeThread = threads.find(t => t.id === selectedThreadId) || threads[0];

  const handleSend = () => {
    if (!inputText.trim()) return;
    onSendMessage(selectedThreadId, inputText.trim());
    setInputText('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Filter threads based on header search if any
  const filteredThreads = threads.filter(t => 
    t.name.toLowerCase().includes(searchFilter.toLowerCase()) || 
    t.lastMessage.toLowerCase().includes(searchFilter.toLowerCase())
  );

  return (
    <div className="flex-1 flex overflow-hidden h-full">
      {/* Threads list (Left sidebar pane) */}
      <aside className="w-80 flex-shrink-0 flex flex-col border-r border-[#424655] bg-[#0e0e0e] overflow-y-auto select-none">
        <div className="p-4 border-b border-[#424655] flex justify-between items-center bg-[#131313]/50 sticky top-0 z-10">
          <h2 className="font-semibold text-sm text-[#e5e2e1]">Active Threads</h2>
          <button 
            className="text-[#8c90a1] hover:text-[#b0c6ff] transition-colors p-1 rounded hover:bg-[#201f1f] cursor-pointer"
            onClick={() => alert("Threads filters: showing all unread and pinned.")}
          >
            <Filter className="w-4 h-4" />
          </button>
        </div>

        <div className="flex flex-col mt-2 gap-1 px-2">
          {filteredThreads.map((thread) => {
            const isSelected = thread.id === selectedThreadId;
            return (
              <div
                key={thread.id}
                onClick={() => setSelectedThreadId(thread.id)}
                className={`p-3 rounded-xl flex items-start gap-3 cursor-pointer border transition-all ${
                  isSelected 
                    ? 'bg-[#568dff]/15 border-[#568dff]/50' 
                    : 'bg-transparent border-transparent hover:bg-[#1c1b1b]'
                }`}
              >
                <div className="relative flex-shrink-0">
                  {thread.avatar ? (
                    <img 
                      alt={thread.name} 
                      className="w-10 h-10 rounded-full object-cover" 
                      src={thread.avatar} 
                    />
                  ) : (
                    <div className="w-10 h-10 rounded-xl bg-[#8083ff]/10 text-[#c0c1ff] flex items-center justify-center font-bold text-xs">
                      {thread.initials || 'TR'}
                    </div>
                  )}
                  {thread.onlineStatus === 'online' && (
                    <div className="absolute bottom-0 right-0 w-3 h-3 bg-[#00e296] rounded-full border-2 border-[#0e0e0e]"></div>
                  )}
                  {thread.onlineStatus === 'offline' && (
                    <div className="absolute bottom-0 right-0 w-3 h-3 bg-[#ffb4ab] rounded-full border-2 border-[#0e0e0e]"></div>
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex justify-between items-baseline mb-0.5">
                    <span className="font-semibold text-sm text-[#e5e2e1] truncate">{thread.name}</span>
                    <span className={`text-[10px] ${isSelected ? 'text-[#b0c6ff]' : 'text-[#8c90a1]'}`}>{thread.time}</span>
                  </div>
                  <div className="flex justify-between items-center gap-1">
                    <p className="text-xs text-[#c2c6d8] truncate max-w-[150px]">{thread.lastMessage}</p>
                    {thread.unreadCount && thread.unreadCount > 0 && !isSelected && (
                      <span className="flex-shrink-0 w-4.5 h-4.5 bg-[#568dff] text-[#002661] rounded-full flex items-center justify-center font-bold text-[9px]">
                        {thread.unreadCount}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </aside>

      {/* Main chat log window (Center column) */}
      <main className="flex-1 bg-[#0e0e0e] flex flex-col overflow-hidden relative">
        <div className="flex-1 overflow-y-auto p-5 pb-36 scrollbar-hide">
          <div className="flex justify-center mb-6">
            <div className="bg-[#201f1f] px-4 py-1.5 rounded-full text-[10px] uppercase font-bold tracking-wider text-[#c2c6d8] border border-[#424655]/40 select-none">
              Today, October 24th
            </div>
          </div>

          <div className="flex flex-col gap-6">
            {activeThread.messages.map((msg, i) => {
              const isMe = msg.sender === 'user';
              return (
                <div key={msg.id || i}>
                  <div className={`flex gap-3 ${isMe ? 'flex-row-reverse' : 'flex-row'}`}>
                    {/* Speaker Avatar */}
                    {msg.avatar ? (
                      <img 
                        alt={msg.senderName} 
                        className="w-8 h-8 rounded-full object-cover flex-shrink-0 mt-1 ring-1 ring-[#424655]" 
                        src={msg.avatar} 
                      />
                    ) : (
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 mt-1 text-xs font-bold leading-none ${
                        isMe ? 'bg-[#568dff] text-[#002661]' : 'bg-[#201f1f] text-[#c0c1ff]'
                      }`}>
                        {isMe ? 'ME' : msg.senderName.substring(0, 2).toUpperCase()}
                      </div>
                    )}

                    {/* Speech box wrapper */}
                    <div className={`flex flex-col gap-1 max-w-[80%] ${isMe ? 'items-end' : 'items-start'}`}>
                      <div className={`flex items-baseline gap-2 ${isMe ? 'flex-row-reverse' : 'flex-row'}`}>
                        <span className="font-semibold text-xs text-[#e5e2e1]">{msg.senderName}</span>
                        <span className="text-[10px] text-[#8c90a1]">{msg.time}</span>
                      </div>

                      <div className={`p-3.5 rounded-2xl border text-sm ${
                        isMe 
                          ? 'bg-[#568dff] text-[#002661] border-[#568dff] rounded-tr-sm shadow-md' 
                          : 'bg-[#201f1f] text-[#e5e2e1] border-[#424655]/40 rounded-tl-sm shadow-sm'
                      }`}>
                        {msg.text}
                      </div>
                    </div>
                  </div>

                  {/* Document Attachment Node matching Snippet 6 */}
                  {isMe && i === 1 && selectedThreadId === 'sarah-jenkins' && (
                    <div className="flex gap-4 mb-2 flex-row-reverse mt-2">
                      <div className="w-8 h-8 opacity-0"></div>
                      <div className="flex flex-col gap-2 max-w-[80%] w-[420px]">
                        <div 
                          onClick={() => alert("Downloading secure file: Competitor_Supply_Chain_Anomaly.pdf (Size: 4.8MB). Authenticated in your Swiss Cloud node.")}
                          className="bg-[#131313] p-4 rounded-xl border border-[#424655] shadow-sm hover:shadow-md hover:border-[#b0c6ff]/50 transition-all cursor-pointer flex gap-3 items-center group relative overflow-hidden"
                        >
                          <div className="absolute left-0 top-0 bottom-0 w-1 bg-[#c0c1ff]"></div>
                          <div className="w-10 h-10 rounded-lg bg-[#8083ff]/20 flex items-center justify-center text-[#c0c1ff]">
                            <FileText className="w-5 h-5" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-[9px] text-[#c0c1ff] bg-[#c0c1ff]/15 px-2 py-0.5 rounded-sm uppercase font-bold tracking-wider">AI Intelligence</span>
                              <span className="text-[10px] text-[#8c90a1]">Attached Document</span>
                            </div>
                            <h4 className="font-bold text-xs text-[#e5e2e1] truncate group-hover:text-[#b0c6ff] transition-colors">
                              Competitor_Supply_Chain_Anomaly.pdf
                            </h4>
                          </div>
                          <Download className="w-4 h-4 text-[#8c90a1] group-hover:text-[#b0c6ff] transition-colors" />
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Dynamic chat interactive compose panel */}
        <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-[#0e0e0e] via-[#0e0e0e] to-transparent pt-10">
          <div className="relative bg-[#131313] rounded-xl border border-[#424655] shadow-lg focus-within:border-[#568dff] focus-within:ring-1 focus-within:ring-[#568dff] transition-all flex flex-col">
            <textarea
              className="w-full bg-transparent border-none focus:ring-0 resize-none py-3.5 px-4 text-xs text-[#e5e2e1] placeholder-[#8c90a1]/70 max-h-32 h-11 outline-none"
              placeholder="Type a message or use '/' for AI commands..."
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            <div className="flex justify-between items-center px-3 py-2 border-t border-[#424655]/30 bg-[#1c1b1b]/50 rounded-b-xl">
              <div className="flex gap-1.5">
                <button 
                  onClick={() => alert("File attachment upload. Drag & drop files or click to add files under 100MB.")}
                  className="w-8 h-8 flex items-center justify-center rounded-lg text-[#8c90a1] hover:bg-[#201f1f] hover:text-[#b0c6ff] transition-colors cursor-pointer" 
                  title="Attach file"
                >
                  <Paperclip className="w-4 h-4" />
                </button>
                <button 
                  onClick={() => alert("Triggering local generative AI prompt enhancer. Enter the context you want to summarize.")}
                  className="w-8 h-8 flex items-center justify-center rounded-lg text-[#8c90a1] hover:bg-[#201f1f] hover:text-[#c0c1ff] transition-colors cursor-pointer" 
                  title="AI Assist"
                >
                  <Sparkles className="w-4 h-4 text-[#c0c1ff]" />
                </button>
                <button 
                  onClick={() => alert("Bold markdown text added.")}
                  className="w-8 h-8 flex items-center justify-center rounded-lg text-[#8c90a1] hover:bg-[#201f1f] transition-colors cursor-pointer" 
                  title="Format Bold"
                >
                  <Bold className="w-4 h-4" />
                </button>
              </div>

              <button 
                onClick={handleSend}
                className="bg-[#568dff] text-[#002661] w-8 h-8 rounded-lg flex items-center justify-center hover:bg-[#568dff]/90 cursor-pointer transition-colors shadow-sm"
              >
                <Send className="w-3.5 h-3.5 stroke-[2.5]" />
              </button>
            </div>
          </div>
        </div>
      </main>

      {/* Intelligence & Agenda (Right side column) */}
      <aside className="w-80 flex-shrink-0 flex flex-col border-l border-[#424655] bg-[#1c1b1b] overflow-y-auto select-none">
        <div className="p-4 border-b border-[#424655] sticky top-0 bg-[#1c1b1b]/95 backdrop-blur-md z-10 flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-[#c0c1ff]" />
          <h3 className="font-semibold text-sm text-[#e5e2e1]">Intelligence &amp; Agenda</h3>
        </div>

        <div className="p-4 flex flex-col gap-6">
          {/* Active meeting block */}
          <div>
            <h4 className="text-[10px] font-bold tracking-wider text-[#8c90a1] uppercase mb-3">Active Meetings</h4>
            <div className="bg-[#568dff]/10 border border-[#b0c6ff]/20 p-4 rounded-xl flex flex-col gap-3 shadow-md relative overflow-hidden">
              <div className="absolute top-0 right-0 w-24 h-24 bg-gradient-to-bl from-[#568dff]/10 to-transparent rounded-bl-full pointer-events-none"></div>
              <div className="flex items-center justify-between">
                <span className="font-semibold text-xs text-[#e5e2e1]">Daily Standup</span>
                <span className="bg-[#568dff]/20 text-[#b0c6ff] px-2 py-0.5 rounded text-[9px] uppercase font-black tracking-wider animate-pulse border border-[#568dff]/30">Live</span>
              </div>
              <div className="flex justify-between items-center mt-1">
                <div className="flex -space-x-1.5">
                  <img alt="Member" className="w-6 h-6 rounded-full border-2 border-[#1c1b1b] object-cover" src="https://lh3.googleusercontent.com/aida-public/AB6AXuCo0kLj3Le2eR0OMi0N1rZg3lR45flPJAdiOCpAF7lv_WWBnPgafvQ14CPTsRzZZs1Gw1pR0IhMEe_7y0MkuX2-9oC4_jqXbwtzsWsCWYHaWeQgfMoieTDggvn5qXuk5u8Dl0xr8neI62Aj4Khe6mYrHLO81crS_Mp2D0bKNspkEAHOvelfxfLGsj2nzUMCCBMH_42wSr38sxELoPouq3xwzl8k8Y3lWBJlPH67a3iiMkA7YJdLeOEnHB7JcoIlQ6AjM5wrxH3j0Ngg" />
                  <img alt="Member" className="w-6 h-6 rounded-full border-2 border-[#1c1b1b] object-cover" src="https://lh3.googleusercontent.com/aida-public/AB6AXuDDnU7odt7LmTnVMom2mFbxQvT0dzKKk06gVmGpUEjMVUhlaI_MuuxVP9xLlKCGs0P1WtCvTdasWrvBiEWPN2DDWwCMYLQS_5BDaeXp4z6XUzZMHdR0IcWSce_v4CmgWwKkVxoBPDJFfjXZm4yWRa7mNF-v8AiIuPgZf8e0WIAzUX8itrzNghwIqHfMAyGdRQaYqrycqytSJGSpW6khk6UOdKnPpLXWkEM8Jememlxf1ShTTzByxZKi1e_-IpsZsPmMFZG_a_R7ZyP4" />
                  <div className="w-6 h-6 rounded-full border-2 border-[#1c1b1b] bg-[#353534] flex items-center justify-center text-[8px] font-bold text-[#c2c6d8]">+2</div>
                </div>
                
                <button 
                  onClick={onJoinMeeting}
                  className="bg-[#568dff] text-[#002661] hover:bg-[#568dff]/90 font-bold px-3 py-1.5 rounded-lg text-xs transition-colors shadow-sm flex items-center gap-1 cursor-pointer"
                >
                  <Video className="w-3.5 h-3.5" />
                  <span>Quick Join</span>
                </button>
              </div>
            </div>
          </div>

          {/* Schedule Meeting action trigger */}
          <div>
            <h4 className="text-[10px] font-bold tracking-wider text-[#8c90a1] uppercase mb-3">Quick Scheduling</h4>
            <button 
              onClick={() => alert("Creating meeting scheduler module. Input prospective synchronization times.")}
              className="w-full bg-transparent text-[#e5e2e1] p-3 rounded-xl border border-dashed border-[#424655] hover:border-[#b0c6ff]/50 hover:text-[#b0c6ff] transition-all flex items-center justify-center gap-2 group cursor-pointer"
            >
              <PlusCircle className="w-4 h-4 text-[#b0c6ff]" />
              <span className="font-semibold text-xs">Create New Meeting</span>
            </button>
          </div>

          {/* Chronological Agenda items matching Snippet 6 */}
          <div>
            <h4 className="text-[10px] font-bold tracking-wider text-[#8c90a1] uppercase mb-4">Chronological Agenda</h4>
            
            <div className="relative pl-5 flex flex-col gap-6 before:content-[''] before:absolute before:left-2 before:top-2 before:bottom-2 before:w-[1px] before:bg-[#424655]/40 text-xs">
              
              {/* Event 1 */}
              <div className="relative">
                {/* Visual marker */}
                <div className="absolute -left-[24.5px] top-1 w-3.5 h-3.5 rounded-full bg-[#568dff]/20 flex items-center justify-center z-10">
                  <div className="w-1.5 h-1.5 rounded-full bg-[#b0c6ff]"></div>
                </div>
                
                <span className="text-[10px] text-[#b0c6ff] font-bold tracking-wider block mb-1 flex items-center gap-2">
                  11:30 AM - 12:30 PM
                  <span className="bg-[#568dff]/15 text-[#b0c6ff] px-1.5 py-0.5 rounded text-[8px] uppercase font-bold tracking-widest">Up Next</span>
                </span>
                
                <div className="bg-[#131313] p-3.5 rounded-xl border-l-[3.5px] border-l-[#568dff] border-y border-r border-[#424655]/60 shadow-sm relative overflow-hidden group hover:border-[#568dff]/35 transition-colors">
                  <h5 className="font-semibold text-[#e5e2e1] mb-0.5">Q3 Board Review Prep</h5>
                  <p className="text-[11px] text-[#c2c6d8] truncate">Review finalized slides with Sarah &amp; Exec team.</p>
                </div>
              </div>

              {/* Event 2 */}
              <div className="relative">
                {/* Visual marker */}
                <div className="absolute -left-[22px] top-1 w-2.5 h-2.5 rounded-full bg-[#201f1f] border border-[#8c90a1] z-10"></div>
                
                <span className="text-[10px] text-[#8c90a1] font-medium tracking-wider block mb-1">
                  02:00 PM - 03:00 PM
                </span>
                
                <div className="bg-[#131313] p-3.5 rounded-xl border border-[#424655]/60 hover:border-[#424655] transition-colors cursor-pointer group">
                  <h5 className="font-semibold text-xs text-[#e5e2e1] group-hover:text-[#b0c6ff] transition-colors">Vendor Negotiation: AlphaTech</h5>
                  <p className="text-[11px] text-[#c2c6d8] flex items-center gap-1 mt-1">
                    <MapPin className="w-3 h-3 text-[#b0c6ff]" />
                    <span>Room 4B / Hybrid</span>
                  </p>
                </div>
              </div>

            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}
