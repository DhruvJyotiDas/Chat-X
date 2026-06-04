import React, { useState, useEffect } from 'react';
import { 
  Mic, 
  MicOff, 
  Video, 
  VideoOff, 
  ScreenShare, 
  PhoneOff, 
  Sparkles, 
  CheckCircle2, 
  Volume2, 
  HelpCircle,
  Clock,
  AlertTriangle,
  Lightbulb
} from 'lucide-react';
import { Participant } from '../types';

interface ActiveMeetingViewProps {
  participants: Participant[];
  onLeaveMeeting: () => void;
}

export default function ActiveMeetingView({ participants, onLeaveMeeting }: ActiveMeetingViewProps) {
  const [micOn, setMicOn] = useState(true);
  const [videoOn, setVideoOn] = useState(true);
  const [screenShared, setScreenShared] = useState(false);
  const [speakingStates, setSpeakingStates] = useState<Record<string, boolean>>({
    sarah: true,
    marcus: false,
    elena: false,
    you: false
  });
  const [langTranslation, setLangTranslation] = useState('EN -> FR');

  const [tasks, setTasks] = useState([
    {
      id: 'task-live-1',
      title: 'Reallocate backend resources',
      priority: 'CRITICAL',
      assignee: 'Sarah Chen',
      avatar: 'https://lh3.googleusercontent.com/aida-public/AB6AXuBGEOawsX0o6MuV4EL54ByXH9yiXHXLU5yL3OUnIEhg9bV4ALNiB9YQ8NwbIvIEwxLxeJ_QIIdG6oyU3LIAqonERTbuGzmgNkXIw8tTMsdZEbGdUHLhseONnz3o5tbt8YfTtOD9llQ-R8yj4YY-YiQveQTQItESBg08adgO2lwIivaU2LprrnIO2ydyKS04Q1U8ka1q-9-tTLKiT2PCrkIHAypKkuUy3MFGsZOF_nMQOKKNtSh1B0mNnQNA_UQNllBuo5DlFa9qGqmW'
    },
    {
      id: 'task-live-2',
      title: 'Complete security audits',
      priority: 'HIGH',
      assignee: 'Marcus Thorne',
      avatar: 'https://lh3.googleusercontent.com/aida-public/AB6AXuCkyEn5GtP02xcLxiLJnh8qxaxmXEHig97BLz2vf184dSYofkcDoBdwa9oNPIQAUjcMCU9oY7kqCP3Ze_nPt2GWJZXn5ObcjbaSdTUnPryzh5pLihSxFY5vrPAcb8wxEcthwJ-QArPNSd1GLjE_9nw_3XqmFbjOclStSelu1JY2W02acFOswn7KS1Ge40A-_F1ho5JqrwlpiMPSc_PlOH36MvN5VewakhVFN_pIgUL0oW0Uw8CcGMH1SBer4axCZQ124uLb9CSC4sA6'
    }
  ]);

  // Simulate speaking pulses
  useEffect(() => {
    const handler = setInterval(() => {
      setSpeakingStates(prev => {
        const sarahChance = Math.random() > 0.3;
        const userChance = !micOn ? false : Math.random() > 0.8;
        return {
          sarah: sarahChance,
          marcus: false,
          elena: Math.random() > 0.9,
          you: userChance
        };
      });
    }, 3000);

    return () => clearInterval(handler);
  }, [micOn]);

  const toggleMic = () => {
    setMicOn(!micOn);
  };

  const toggleVideo = () => {
    setVideoOn(!videoOn);
  };

  const handleShareScreen = () => {
    setScreenShared(!screenShared);
    alert(screenShared ? "Screen contribution disabled." : "Sharing terminal window: Security Enclave C-9. Stream mapped at 60fps.");
  };

  return (
    <div className="flex-1 flex overflow-hidden h-full bg-[#0e0e0e] select-none">
      
      {/* Live Transcript Pane (Left Side Pane) */}
      <section className="w-80 flex-shrink-0 flex flex-col border-r border-[#424655] bg-[#131313]/55 backdrop-blur-md">
        <div className="p-4 border-b border-[#424655]/50 flex justify-between items-center bg-[#1c1b1b]/50">
          <h2 className="font-semibold text-xs text-[#e5e2e1] uppercase tracking-wider">Live Transcript</h2>
          <select 
            className="text-[10px] bg-[#201f1f] border border-[#424655] rounded px-1.5 py-0.5 text-[#b0c6ff] outline-none font-bold"
            value={langTranslation}
            onChange={(e) => {
              setLangTranslation(e.target.value);
              alert(`Spoken stream target changed to: ${e.target.value}`);
            }}
          >
            <option>{"EN -> FR"}</option>
            <option>{"EN -> ES"}</option>
            <option>{"EN -> DE"}</option>
          </select>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-6 scrollbar-hide text-xs">
          
          {/* AI Live suggestion bubble */}
          <div className="flex flex-col gap-1.5 relative pl-3 border-l-2 border-[#8083ff]">
            <span className="text-[10px] font-black tracking-widest text-[#c0c1ff] flex items-center gap-1">
              <Sparkles className="w-3.5 h-3.5 animate-pulse" />
              <span>INTELLIGENCE AGENT</span>
            </span>
            <div className="bg-[#201f1f] border border-[#424655]/65 p-3 rounded-r-xl rounded-bl-xl text-[#c2c6d8] leading-relaxed">
              Analyzing discussion... Q3 Projections are the main focus. Suggesting opening the 'Q3 Financials' document.
            </div>
          </div>

          {/* Transcript Sarah Chen */}
          <div className="flex gap-3">
            <img 
              alt="Sarah" 
              className="w-8 h-8 rounded-full border border-[#424655] shrink-0 mt-1 object-cover" 
              src="https://lh3.googleusercontent.com/aida-public/AB6AXuDGVjBqicIJW6dpKfYDD7M89acyGcm_r2gNeDi8xZsno3oe5M3mz8BW0yBwPLw1VsSGpG6d8Cav9lxLOREhkmWSvp9F7CdE08g2KHC0kUqmaqzAtmmiJGdW1Fl2oGw3YFwjLbCqELnZQ3xG3wxc-IBgLgU9-bQOxZEzUu_rArYY58Ylc5vKkCNg0fsO5nsevSlN9-aXNwJRexI6deG5SjMe1NqtoiZEP2xF7Mw3AdXTkuNWWPJGqaC4AQ8lz1g8-25Oc-sh9yuP_16x" 
            />
            <div>
              <div className="flex items-baseline gap-2 mb-1">
                <span className="font-semibold text-xs text-[#e5e2e1]">Sarah Chen</span>
                <span className="text-[9px] text-[#8c90a1] font-mono">10:02 AM</span>
              </div>
              <div className="bg-[#2a2a2a] p-3 rounded-r-xl rounded-bl-xl text-[#e5e2e1] leading-relaxed">
                Let's review the integration timeline. I believe we can accelerate phase two if we reallocate the backend resources.
              </div>
              <div className="mt-1 text-[10px] text-[#8c90a1] italic">
                Translation (FR): Passons en revue le calendrier d'intégration...
              </div>
            </div>
          </div>

          {/* Transcript Marcus Chen */}
          <div className="flex gap-3">
            <img 
              alt="Marcus" 
              className="w-8 h-8 rounded-full border border-[#424655] shrink-0 mt-1 object-cover" 
              src="https://lh3.googleusercontent.com/aida-public/AB6AXuDzxW7HkSZeGgOD3-Zqg9fDpDv4CioI2H2mBWtUz72HyNw0i4oFG2zK_4vpD_-1kKQQSG_MzsJwCiKTVcobaEXX16MKg5Pm27yH-4lVL20u7XB6WeJ_tEVwpyi2P8Xz4kR83F650kdGJDmAOvtQksoSAmDZIc5T8jnAW9yUsMd34ePIxmr91-CP72hhtQ0Xg6ufFGxBcV7bYfEWp8d6FVUTsR2VGguyc8N3jPW0vu4yDv2fDiI0fQMC3CpwMBINzShTENWoCw_1j738" 
            />
            <div>
              <div className="flex items-baseline gap-2 mb-1">
                <span className="font-semibold text-xs text-[#e5e2e1]">Marcus Thorne</span>
                <span className="text-[9px] text-[#8c90a1] font-mono">10:04 AM</span>
              </div>
              <div className="bg-[#2a2a2a] p-3 rounded-r-xl rounded-bl-xl text-[#e5e2e1] leading-relaxed">
                I agree, but we need to ensure local sandbox security audits are completed first. We cannot compromise on encryption compliance.
              </div>
            </div>
          </div>

        </div>
      </section>

      {/* Center Pane: Active webcam grid matching Snippet 5 */}
      <section className="flex-1 flex flex-col relative bg-[#131313]/10">
        
        {/* Responsive Grid layout */}
        <div className="flex-1 p-4 grid grid-cols-1 sm:grid-cols-2 grid-rows-4 sm:grid-rows-2 gap-4 pb-24">
          
          {/* Tile 1: Sarah Chen */}
          <div className={`relative rounded-xl overflow-hidden bg-[#201f1f] border-2 transition-all shadow-md ${
            speakingStates.sarah 
              ? 'border-[#b0c6ff] shadow-[0_0_15px_rgba(176,198,255,0.2)]' 
              : 'border-[#424655]'
          }`}>
            <img 
              alt="Sarah Video" 
              className="w-full h-full object-cover" 
              src="https://lh3.googleusercontent.com/aida-public/AB6AXuCo0kLj3Le2eR0OMi0N1rZg3lR45flPJAdiOCpAF7lv_WWBnPgafvQ14CPTsRzZZs1Gw1pR0IhMEe_7y0MkuX2-9oC4_jqXbwtzsWsCWYHaWeQgfMoieTDggvn5qXuk5u8Dl0xr8neI62Aj4Khe6mYrHLO81crS_Mp2D0bKNspkEAHOvelfxfLGsj2nzUMCCBMH_42wSr38sxELoPouq3xwzl8k8Y3lWBJlPH67a3iiMkA7YJdLeOEnHB7JcoIlQ6AjM5wrxH3j0Ngg" 
            />
            
            <div className="absolute top-3 left-3 bg-[#131313]/85 backdrop-blur-md px-2.5 py-1.5 rounded-lg flex items-center gap-2 border border-[#424655]/50 scale-90">
              <span className={`w-2 h-2 rounded-full ${speakingStates.sarah ? 'bg-[#00e296] animate-pulse' : 'bg-[#8c90a1]'}`}></span>
              <span className="text-xs font-semibold text-[#e5e2e1]">Sarah Chen</span>
            </div>
            
            <div className="absolute top-3 right-3 flex gap-2 scale-90">
              <div className="bg-[#131313]/85 backdrop-blur-md px-2 py-1 rounded-lg border border-[#424655]/50 flex items-center gap-1">
                <Volume2 className="w-3.5 h-3.5 text-[#b0c6ff]" />
                <span className="text-[10px] font-bold text-[#b0c6ff] tracking-tight uppercase">Confident</span>
              </div>
            </div>
          </div>

          {/* Tile 2: Marcus Thorne */}
          <div className="relative rounded-xl overflow-hidden bg-[#201f1f] border border-[#424655] shadow-md">
            <img 
              alt="Marcus Video" 
              className="w-full h-full object-cover opacity-90" 
              src="https://lh3.googleusercontent.com/aida-public/AB6AXuDDnU7odt7LmTnVMom2mFbxQvT0dzKKk06gVmGpUEjMVUhlaI_MuuxVP9xLlKCGs0P1WtCvTdasWrvBiEWPN2DDWwCMYLQS_5BDaeXp4z6XUzZMHdR0IcWSce_v4CmgWwKkVxoBPDJFfjXZm4yWRa7mNF-v8AiIuPgZf8e0WIAzUX8itrzNghwIqHfMAyGdRQaYqrycqytSJGSpW6khk6UOdKnPpLXWkEM8Jememlxf1ShTTzByxZKi1e_-IpsZsPmMFZG_a_R7ZyP4" 
            />
            
            <div className="absolute top-3 left-3 bg-[#131313]/85 backdrop-blur-md px-2.5 py-1.5 rounded-lg flex items-center gap-2 border border-[#424655]/50 scale-90">
              <span className="text-xs font-semibold text-[#e5e2e1]">Marcus Thorne</span>
            </div>
            
            <div className="absolute bottom-3 right-3 bg-[#131313]/85 backdrop-blur-md p-1.5 rounded-lg border border-[#ffb4ab]/30">
              <MicOff className="w-3.5 h-3.5 text-[#ffb4ab]" />
            </div>
          </div>

          {/* Tile 3: Elena Rostova */}
          <div className="relative rounded-xl overflow-hidden bg-[#201f1f] border border-[#424655] shadow-md">
            <img 
              alt="Elena Video" 
              className="w-full h-full object-cover opacity-85" 
              src="https://lh3.googleusercontent.com/aida-public/AB6AXuDLRKlPgkxN4lpnLkJJZ5TQjA3B51BgvRj2PW3KnnZT98n8awwH6If-h4cJqbivE9eVzvg8UYXY2udE3ZylCrCFzThymTkm5pC5uRVsrZVia9wuol2HVO_pWWlTHVdWyjVTpJlxyglSig1lGX6_taK-Ubv6mhbt9Sz1M0f36iFI34cn1q6qr7ZxOo_QotsHiCwwhzX0L5KXEe0m8pLw2LS5wU9NlB0bZW4kljye5ha3z9af9xNaPiCCOIWluINlRy9xMiL92GhIOdBr" 
            />
            
            <div className="absolute top-3 left-3 bg-[#131313]/85 backdrop-blur-md px-2.5 py-1.5 rounded-lg flex items-center gap-2 border border-[#424655]/50 scale-90">
              <span className="text-xs font-semibold text-[#e5e2e1]">Elena Rostova</span>
            </div>

            <div className="absolute top-3 right-3 flex gap-2 scale-90">
              <div className="bg-[#93000a]/35 backdrop-blur-md px-2 py-1 rounded-lg border border-[#ffb4ab]/25 flex items-center gap-1">
                <AlertTriangle className="w-3.5 h-3.5 text-[#ffb4ab]" />
                <span className="text-[10px] font-bold text-[#ffb4ab] uppercase tracking-tight">Low Light</span>
              </div>
            </div>
          </div>

          {/* Tile 4: David You local stream source overlay */}
          <div className="relative rounded-xl overflow-hidden bg-[#201f1f] border border-[#424655] shadow-md">
            {videoOn ? (
              <img 
                alt="You Video" 
                className="w-full h-full object-cover" 
                src="https://lh3.googleusercontent.com/aida-public/AB6AXuCOkRMHyUX4qXKDeIqQ1cwtFidq525FUpVO1II9eABdzVmfcrxCHxlWf2oSifN9FGwcHc1W6Qc8WAQicNjJ5YCe2lUpd4GCRmmkzR0HZDdVQrsTKRs5topztIMy2JhmYrOe3yYMbbVUy32l9ypH_j0WkQQJNFokstSvc8bYUuof5Fw18a0WBq336ogQEi0jbM92VDl1KNTzPyw7GWx37rIWSth-ugO_dIU0KUCP2sfpSvUVtx6rJJ4ZCZYclh62aoLSAEOJ0FEs--hF" 
              />
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center bg-[#131313] text-[#8c90a1] animate-pulse">
                <VideoOff className="w-10 h-10 mb-2 stroke-[1.5]" />
                <span className="text-xs font-semibold select-none">Camera Disabled</span>
              </div>
            )}
            
            <div className="absolute top-3 left-3 bg-[#131313]/85 backdrop-blur-md px-2.5 py-1.5 rounded-lg flex items-center gap-2 border border-[#424655]/50 scale-90">
              <span className={`w-2 h-2 rounded-full ${speakingStates.you ? 'bg-[#00e296] animate-pulse' : 'bg-[#8c90a1]'}`}></span>
              <span className="text-xs font-semibold text-[#e5e2e1]">You (David)</span>
            </div>

            {!micOn && (
              <div className="absolute bottom-3 right-3 bg-[#131313]/85 backdrop-blur-md p-1.5 rounded-lg border border-[#ffb4ab]/30">
                <MicOff className="w-3.5 h-3.5 text-[#ffb4ab]" />
              </div>
            )}
          </div>

        </div>

        {/* Floating Controls Bar */}
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-[#131313]/90 backdrop-blur-xl border border-[#424655] p-2.5 rounded-2xl shadow-xl flex items-center gap-3 z-10 select-none scale-90 sm:scale-100">
          <button 
            onClick={toggleMic}
            className={`w-12 h-12 flex items-center justify-center rounded-xl transition-colors cursor-pointer ${
              micOn ? 'bg-[#1c1b1b] text-[#e5e2e1] hover:bg-[#201f1f]' : 'bg-[#93000a]/20 text-[#ffb4ab] border border-[#ffb4ab]/20'
            }`}
            title={micOn ? "Mute Microphone" : "Unmute Microphone"}
          >
            {micOn ? <Mic className="w-5 h-5" /> : <MicOff className="w-5 h-5" />}
          </button>
          
          <button 
            onClick={toggleVideo}
            className={`w-12 h-12 flex items-center justify-center rounded-xl transition-colors cursor-pointer ${
              videoOn ? 'bg-[#1c1b1b] text-[#e5e2e1] hover:bg-[#201f1f]' : 'bg-[#93000a]/20 text-[#ffb4ab] border border-[#ffb4ab]/20'
            }`}
            title={videoOn ? "Stop video stream" : "Start video stream"}
          >
            {videoOn ? <Video className="w-5 h-5" /> : <VideoOff className="w-5 h-5" />}
          </button>

          <button 
            onClick={handleShareScreen}
            className={`w-12 h-12 flex items-center justify-center rounded-xl transition-colors cursor-pointer ${
              screenShared ? 'bg-[#568dff]/20 text-[#b0c6ff] border border-[#568dff]/30' : 'bg-[#1c1b1b] text-[#e5e2e1] hover:bg-[#201f1f]'
            }`}
            title="Present Screen"
          >
            <ScreenShare className="w-5 h-5" />
          </button>

          <div className="w-[1px] h-8 bg-[#424655] mx-1"></div>

          <button 
            onClick={onLeaveMeeting}
            className="px-5 h-12 flex items-center justify-center rounded-xl bg-[#ffb4ab]/15 text-[#ffb4ab] hover:bg-[#ffb4ab]/25 hover:text-white transition-colors font-bold text-xs gap-1.5 cursor-pointer border border-[#ffb4ab]/25"
            title="Leave Call Workspace"
          >
            <PhoneOff className="w-4 h-4" />
            <span>Leave</span>
          </button>
        </div>
      </section>

      {/* Right Pane: Intelligence Task Panel */}
      <section className="w-80 flex-shrink-0 flex flex-col border-l border-[#424655] bg-[#1c1b1b]">
        <div className="p-4 border-b border-[#424655]/50 flex justify-between items-center bg-[#1c1b1b]/50 select-none">
          <h2 className="font-semibold text-xs text-[#e5e2e1] uppercase tracking-wider">Active Intelligence</h2>
          <Sparkles className="w-4 h-4 text-[#b0c6ff]" />
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div className="text-[10px] font-bold tracking-wider text-[#8c90a1] uppercase mb-1">EXTRACTED TASKS</div>

          {tasks.map((task) => (
            <div 
              key={task.id}
              className="bg-[#131313] border border-[#424655]/60 rounded-xl p-4 hover:border-[#b0c6ff]/30 transition-all select-none"
            >
              <div className="flex justify-between items-start mb-2 gap-1">
                <span className="font-bold text-xs text-[#e5e2e1] leading-snug">{task.title}</span>
                <span className={`px-1.5 py-0.5 rounded text-[8px] font-black tracking-wider ${
                  task.priority === 'CRITICAL' 
                    ? 'bg-[#93000a]/20 text-[#ffb4ab] border border-[#ffb4ab]/20' 
                    : 'bg-[#568dff]/10 text-[#b0c6ff] border border-[#568dff]/20'
                }`}>
                  {task.priority}
                </span>
              </div>
              <div className="flex items-center gap-2 mt-3 pl-0.5">
                <img alt={task.assignee} className="w-5 h-5 rounded-full object-cover" src={task.avatar} />
                <span className="text-[10px] text-[#c2c6d8] font-semibold">Assigned: {task.assignee}</span>
              </div>
            </div>
          ))}

          {/* Quick AI tips */}
          <div className="bg-[#201f1f]/50 p-4 border border-[#424655]/30 rounded-xl flex items-start gap-2.5 mt-2">
            <Lightbulb className="w-4.5 h-4.5 text-[#70ffba] shrink-0 mt-0.5" />
            <div className="flex flex-col gap-0.5">
              <span className="text-[10px] font-black uppercase text-[#70ffba] tracking-wider select-none">AI Insight Tip</span>
              <p className="text-[11px] text-[#c2c6d8] leading-relaxed">
                Clicking tasks allows immediate validation of assigned specs inside your compliance records automatically.
              </p>
            </div>
          </div>
        </div>
      </section>

    </div>
  );
}
