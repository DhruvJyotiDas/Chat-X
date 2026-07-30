import { RealChatMessage, ExtractedItem } from '../types';

export function extractIntelligence(messages: RealChatMessage[]): ExtractedItem[] {
  const items: ExtractedItem[] = [];
  const recent = messages.slice(-30);
  recent.forEach(msg => {
    const t = msg.text;
    const meetRegex = /\b(?:meet|meeting|call|sync|standup|review|chat|catch\s*up)\b[^.!?\n]*?(?:at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)|(?:tomorrow|today|tonight))/gi;
    let m;
    while ((m = meetRegex.exec(t)) !== null) {
      items.push({ id: `${msg.id}-meet-${items.length}`, type: 'meeting', text: m[0].trim().slice(0, 80), time: m[1], confidence: 0.9 });
    }
    const deadlineRegex = /\b(?:by|due|before|deadline)\s+(?:(?:next\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|tomorrow|end\s+of\s+(?:day|week)|(?:\d{1,2}[\/\-]\d{1,2}))/gi;
    while ((m = deadlineRegex.exec(t)) !== null) {
      items.push({ id: `${msg.id}-dl-${items.length}`, type: 'deadline', text: m[0].trim().slice(0, 80), confidence: 0.85 });
    }
    const timeRegex = /\b(?:at|@)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/gi;
    while ((m = timeRegex.exec(t)) !== null) {
      if (!items.find(i => i.time === m![1])) {
        items.push({ id: `${msg.id}-time-${items.length}`, type: 'reminder', text: `Time noted: ${m[1]} — "${t.slice(0, 60)}"`, time: m[1], confidence: 0.8 });
      }
    }
    const actionRegex = /\b(?:need to|have to|must|will|going to|i'll|i will|remember to|don't forget(?:\s+to)?)\s+([a-z][^.!?\n]{4,50})/gi;
    while ((m = actionRegex.exec(t)) !== null) {
      items.push({ id: `${msg.id}-action-${items.length}`, type: 'action', text: m[0].trim().slice(0, 80), confidence: 0.75 });
    }
    const decisionRegex = /\b(?:decided|agreed|confirmed|let's go with|we'll use|final decision)\b[^.!?\n]{3,60}/gi;
    while ((m = decisionRegex.exec(t)) !== null) {
      items.push({ id: `${msg.id}-dec-${items.length}`, type: 'decision', text: m[0].trim().slice(0, 80), confidence: 0.85 });
    }
  });
  const seen = new Set<string>();
  return items.filter(i => { const key = i.text.slice(0, 30); if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 8);
}

export const ITEM_ICONS: Record<ExtractedItem['type'], string> = { meeting: '📅', deadline: '⏰', action: '✅', reminder: '🔔', decision: '💡' };
export const ITEM_COLORS: Record<ExtractedItem['type'], string> = {
  meeting: 'text-[#b0c6ff] bg-[#568dff]/10 border-[#568dff]/30',
  deadline: 'text-[#ffb4ab] bg-[#ffb4ab]/10 border-[#ffb4ab]/30',
  action: 'text-[#4dffb1] bg-[#4dffb1]/10 border-[#4dffb1]/30',
  reminder: 'text-[#ffd60a] bg-[#ffd60a]/10 border-[#ffd60a]/30',
  decision: 'text-[#c0c1ff] bg-[#c0c1ff]/10 border-[#c0c1ff]/30',
};
