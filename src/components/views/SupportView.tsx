import React, { useState } from 'react';
import { 
  HelpCircle, 
  Search, 
  BookOpen, 
  ClipboardCheck, 
  Globe, 
  Lock, 
  FileCheck, 
  ShieldAlert, 
  ChevronRight, 
  X,
  Send,
  CheckCircle2,
  Lightbulb
} from 'lucide-react';
import { faqCategories, FAQAnswers, featuredGuides } from '../../data';

interface SupportViewProps {
  searchFilter: string;
}

export default function SupportView({ searchFilter }: SupportViewProps) {
  // Frequently asked states
  const [selectedQuestion, setSelectedQuestion] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'all' | 'billing' | 'compliance'>('all');
  
  // Submit Audit states
  const [auditReason, setAuditReason] = useState('');
  const [auditType, setAuditType] = useState('GDPR Residency Audit');
  const [auditRegion, setAuditRegion] = useState('Swiss Vault Alpha');
  const [auditFormSubmitted, setAuditFormSubmitted] = useState(false);

  const handleSubmitAudit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!auditReason.trim()) {
      alert("Please provide a brief justification scope for the compliance audit.");
      return;
    }
    setAuditFormSubmitted(true);
    setTimeout(() => {
      alert(`GDPR/Swiss compliance audit dispatched securely to your workspace auditor team. Reference ticket ID: #SEC-${Math.floor(Math.random() * 9000) + 1000}.`);
    }, 200);
  };

  const handleResetAuditForm = () => {
    setAuditReason('');
    setAuditFormSubmitted(false);
  };

  // Collect all FAQ questions from categories
  const allFAQQuestions = faqCategories.flatMap(cat => cat.items);

  // Search filter matching
  const matchedQuestions = allFAQQuestions.filter(q => 
    q.toLowerCase().includes(searchFilter.toLowerCase()) ||
    (FAQAnswers[q] && FAQAnswers[q].toLowerCase().includes(searchFilter.toLowerCase()))
  );

  return (
    <div className="flex-grow overflow-y-auto p-6 flex flex-col xl:flex-row gap-6 scrollbar-hide select-none">
      
      {/* FAQ Detail Slider Modal Overlay (Simulated sidebar slide) */}
      {selectedQuestion && (
        <div className="fixed inset-0 bg-[#0e0e0e]/75 backdrop-blur-sm z-50 flex justify-end">
          <div className="w-full max-w-lg bg-[#1c1b1b] border-l border-[#424655] h-full p-6 flex flex-col justify-between shadow-2xl relative select-text">
            <div>
              <div className="flex justify-between items-start mb-6">
                <div className="flex items-center gap-2 bg-[#568dff]/15 px-3 py-1 rounded-full text-[10px] uppercase font-extrabold tracking-wider text-[#b0c6ff] border border-[#568dff]/30">
                  Knowledge Base Answer
                </div>
                <button 
                  onClick={() => setSelectedQuestion(null)}
                  className="w-8 h-8 rounded-full bg-[#201f1f] border border-[#424655] hover:border-[#ffb4ab] hover:text-[#ffb4ab] flex items-center justify-center transition-colors cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <h3 className="text-lg font-bold text-[#e5e2e1] leading-snug mb-4">
                {selectedQuestion}
              </h3>
              
              <div className="h-[1px] bg-[#424655]/40 mb-6"></div>

              <div className="text-sm text-[#c2c6d8] leading-relaxed space-y-4">
                <p>{FAQAnswers[selectedQuestion] || "No documentation has been uploaded for this spec in this Swiss Cloud Node version."}</p>
                
                <div className="bg-[#131313] p-4 rounded-xl border border-[#424655]/50 flex gap-3 items-start">
                  <Lightbulb className="w-5 h-5 text-[#70ffba] shrink-0 mt-0.5" />
                  <div className="text-xs">
                    <span className="font-bold text-[#e5e2e1] block mb-1">Audit Trail Information</span>
                    All reading queries on privacy-related FAQ articles are cryptographically cached in your session log for compliance.
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-8 pt-4 border-t border-[#424655]/30">
              <button 
                onClick={() => {
                  alert("FAQ link copied to Clipboard. Relayed security signoff.");
                  setSelectedQuestion(null);
                }}
                className="w-full bg-[#568dff] text-[#002661] hover:bg-[#568dff]/90 py-2.5 rounded-xl font-bold text-xs transition-colors cursor-pointer"
              >
                Copy Reference Link
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Left/Middle Pane: FAQs and Featured docs */}
      <div className="flex-1 flex flex-col gap-6 max-w-[860px]">
        
        {/* Help Header Block */}
        <div className="bg-gradient-to-r from-[#201f1f] to-[#1c1b1b] p-6 rounded-2xl border border-[#424655] relative overflow-hidden">
          <div className="accent-glow"></div>
          
          <div className="relative z-10">
            <BookOpen className="w-8 h-8 text-[#b0c6ff] mb-3" />
            <h2 className="text-xl font-bold text-[#e5e2e1]">Interactive Knowledge Base</h2>
            <p className="text-xs text-[#c2c6d8] mt-1 max-w-xl leading-relaxed">
              Quickly reference system guides, encryption parameters, data residency regions, and GDPR compliance workflows.
            </p>
          </div>
        </div>

        {/* FAQs by Category Grid */}
        <div className="bg-[#1c1b1b] border border-[#424655] p-5 rounded-2xl shadow-md">
          <h3 className="font-semibold text-sm text-[#e5e2e1] mb-4 flex items-center gap-2">
            <HelpCircle className="w-4 h-4 text-[#c0c1ff]" />
            <span>Search Documentation Categories</span>
          </h3>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {faqCategories.map((cat) => (
              <div 
                key={cat.id} 
                className="bg-[#131313] p-4 rounded-xl border border-[#424655]/60 hover:border-[#b0c6ff]/40 transition-colors flex flex-col justify-between"
              >
                <div>
                  <h4 className="font-bold text-xs text-[#e5e2e1] mb-2 uppercase tracking-wide flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#568dff]"></span>
                    {cat.title}
                  </h4>
                  <ul className="space-y-1.5 pl-3">
                    {cat.items.map((item) => (
                      <li key={item}>
                        <button
                          onClick={() => setSelectedQuestion(item)}
                          className="text-left text-xs text-[#c2c6d8] hover:text-[#b0c6ff] hover:underline transition-all block truncate max-w-xs cursor-pointer py-0.5"
                        >
                          • {item}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Featured Guides Recaps matching Snippet 3 */}
        <div className="bg-[#1c1b1b] border border-[#424655] p-5 rounded-2xl shadow-md">
          <h3 className="font-semibold text-sm text-[#e5e2e1] mb-4">Featured Security Guides</h3>
          
          <div className="flex flex-col gap-4">
            {featuredGuides.map((guide) => (
              <div 
                key={guide.id}
                className="p-4 bg-[#131313] rounded-xl border border-[#424655]/60 flex items-start gap-3 select-text"
              >
                <div className="w-8 h-8 rounded-lg bg-[#c0c1ff]/10 flex items-center justify-center shrink-0 text-[#c0c1ff]">
                  <BookOpen className="w-4 h-4" />
                </div>
                <div>
                  <h4 className="font-semibold text-xs text-[#e5e2e1]">{guide.title}</h4>
                  <p className="text-[11px] text-[#c2c6d8] mt-1 pr-4 leading-relaxed">{guide.detail}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

      </div>

      {/* Right Column: Submit Audit forms */}
      <div className="w-full xl:w-85 shrink-0">
        
        <div className="bg-[#1c1b1b] border border-[#424655] shadow-lg rounded-2xl p-5 sticky top-20 flex flex-col gap-4">
          <div className="flex items-center gap-3 pb-3 border-b border-[#424655]/30">
            <div className="w-9 h-9 bg-[#568dff]/10 rounded-lg flex items-center justify-center text-[#568dff]">
              <ClipboardCheck className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-bold text-xs text-[#e5e2e1] uppercase tracking-wide">Request Compliance Audit</h3>
              <p className="text-[10px] text-[#8c90a1] mt-0.5">Dispatched to workspace verification auditors</p>
            </div>
          </div>

          {auditFormSubmitted ? (
            <div className="bg-[#00e598]/5 border border-[#00e598]/20 p-5 rounded-xl flex flex-col items-center justify-center text-center py-8">
              <div className="w-10 h-10 rounded-full bg-[#00e598]/10 text-[#70ffba] flex items-center justify-center mb-3">
                <CheckCircle2 className="w-5 h-5" />
              </div>
              <h4 className="font-bold text-xs text-[#e5e2e1]">Audit Scheduled Successfully</h4>
              <p className="text-[11px] text-[#c2c6d8] mt-1.5 leading-relaxed">
                The Security Officer team has received this request. They will sign off on encryption keys in Zurich Node B inside the hour.
              </p>
              <button 
                onClick={handleResetAuditForm}
                className="mt-5 text-xs font-bold text-[#b0c6ff] hover:text-[#568dff] cursor-pointer"
              >
                Submit New Request
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmitAudit} className="flex flex-col gap-4.5">
              
              {/* Selector 1 */}
              <div className="flex flex-col gap-1.5">
                <label className="text-[9px] font-extrabold tracking-wider text-[#8c90a1] uppercase">Audit Target Framework</label>
                <select 
                  className="bg-[#131313] border border-[#424655] rounded-lg px-3 py-2 text-xs text-[#e5e2e1] focus:border-[#b0c6ff] outline-none"
                  value={auditType}
                  onChange={(e) => setAuditType(e.target.value)}
                >
                  <option>GDPR Residency Audit</option>
                  <option>SOC 2 Type II Validation</option>
                  <option>ISO-27001 Key Rotation Review</option>
                  <option>HIPAA PHI Purge Audit</option>
                </select>
              </div>

              {/* Selector 2 */}
              <div className="flex flex-col gap-1.5">
                <label className="text-[9px] font-extrabold tracking-wider text-[#8c90a1] uppercase">Anchor Node Vault</label>
                <select 
                  className="bg-[#131313] border border-[#424655] rounded-lg px-3 py-2 text-xs text-[#e5e2e1] focus:border-[#b0c6ff] outline-none"
                  value={auditRegion}
                  onChange={(e) => setAuditRegion(e.target.value)}
                >
                  <option>Swiss Vault Alpha</option>
                  <option>EU Enclave Central-1</option>
                  <option>US Encrypted Node West</option>
                </select>
              </div>

              {/* Text justification */}
              <div className="flex flex-col gap-1.5">
                <label className="text-[9px] font-extrabold tracking-wider text-[#8c90a1] uppercase">Scope Alignment / Justification</label>
                <textarea 
                  className="bg-[#131313] border border-[#424655] rounded-lg px-3 py-2 text-xs text-[#e5e2e1] focus:border-l-2 focus:border-l-[#568dff] focus:border-y focus:border-r focus:border-y-[#424655]/40 outline-none h-24 placeholder-[#8c90a1]/60 resize-none"
                  placeholder="Justify context for target audit validation..."
                  value={auditReason}
                  onChange={(e) => setAuditReason(e.target.value)}
                />
              </div>

              <button 
                type="submit"
                className="w-full bg-[#568dff] text-[#002661] hover:bg-[#568dff]/90 py-2.5 rounded-xl font-bold text-xs transition-colors flex items-center justify-center gap-1.5 cursor-pointer mt-2"
              >
                <Send className="w-3.5 h-3.5" />
                <span>Submit Secure Protocol</span>
              </button>

            </form>
          )}

          <div className="pt-2 text-[10px] text-[#8c90a1] border-t border-[#424655]/20 flex items-center gap-1.5">
            <Globe className="w-3 px-0.5 text-[#568dff]" />
            <span>Audits audited inside 24h compliance SLAs.</span>
          </div>
        </div>

      </div>

    </div>
  );
}
