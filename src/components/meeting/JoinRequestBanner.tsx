import { X, Check } from 'lucide-react';
import { useMeeting } from '../../context/MeetingContext';

// Knock-to-join (server/main.go's attemptRoomEntry): someone new joining via
// the room link/code no longer gets admitted on the spot once the call
// already has other people in it — they wait until one of the people
// already in the call accepts or rejects them.
//
// Rendered globally in App.tsx, not inside ActiveMeetingView, and gated on
// isInMeeting rather than "is the call screen actually mounted" — the call
// can be minimized to FloatingCallWindow while someone browses the rest of
// the app, and a knock at the door still needs to be answerable during that
// time, not only while looking straight at the call.
export default function JoinRequestBanner() {
  const { pendingJoinRequests, respondToJoinRequest } = useMeeting();
  if (pendingJoinRequests.length === 0) return null;

  return (
    <div className="fixed top-3 right-3 z-[100000] flex flex-col gap-2 w-[min(92vw,20rem)]">
      {pendingJoinRequests.map((req) => (
        <div key={req.requestId} className="flex items-center gap-3 bg-[#292a2d] border border-[#5f6368] text-[#e8eaed] rounded-xl px-3.5 py-3 shadow-2xl">
          <div className="w-8 h-8 rounded-full bg-[#8ab4f8]/20 flex items-center justify-center text-xs font-bold text-[#8ab4f8] shrink-0">
            {req.userName.charAt(0).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold truncate">{req.userName}</p>
            <p className="text-[10px] text-[#9aa0a6]">wants to join</p>
          </div>
          <button
            onClick={() => respondToJoinRequest(req.requestId, false)}
            title="Deny"
            aria-label={`Deny ${req.userName}`}
            className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center bg-[#3c4043] hover:bg-[#484a4d] text-[#e8eaed] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
          <button
            onClick={() => respondToJoinRequest(req.requestId, true)}
            title="Admit"
            aria-label={`Admit ${req.userName}`}
            className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center bg-[#8ab4f8] hover:bg-[#aecbfa] text-[#062e6f] transition-colors"
          >
            <Check className="w-4 h-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
