import { X, Check } from 'lucide-react';
import { useMeeting } from '../../context/MeetingContext';
import Avatar from '../ui/Avatar';

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
        <div key={req.requestId} className="flex items-center gap-3 bg-white border border-[var(--ib-gray-100)] text-[var(--ib-gray-900)] rounded-xl px-3.5 py-3 shadow-[var(--ib-shadow-lg)]">
          <Avatar initials={req.userName.charAt(0).toUpperCase()} size="sm" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold truncate">{req.userName}</p>
            <p className="text-[10px] text-[var(--ib-gray-600)]">wants to join</p>
          </div>
          <button
            onClick={() => respondToJoinRequest(req.requestId, false)}
            title="Deny"
            aria-label={`Deny ${req.userName}`}
            className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center bg-[var(--ib-gray-100)] hover:bg-[var(--ib-gray-200)] text-[var(--ib-gray-800)] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
          <button
            onClick={() => respondToJoinRequest(req.requestId, true)}
            title="Admit"
            aria-label={`Admit ${req.userName}`}
            className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center bg-[var(--ib-blue-500)] hover:bg-[var(--ib-blue-800)] text-white transition-colors"
          >
            <Check className="w-4 h-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
