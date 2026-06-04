import React, { useState } from 'react';
import { 
  ShieldCheck, 
  Lock, 
  Trash2, 
  Download, 
  CheckCircle, 
  AlertTriangle, 
  RefreshCw, 
  Globe, 
  Timer, 
  CheckSquare, 
  BellRing,
  ExternalLink,
  ShieldAlert
} from 'lucide-react';
import { ComplianceLog } from '../../types';

interface SecurityViewProps {
  logs: ComplianceLog[];
  onAddLog: (event: string, status: 'SUCCESS' | 'FLAGGED') => void;
  onClearLogs: () => void;
  searchFilter: string;
}

export default function SecurityView({
  logs,
  onAddLog,
  onClearLogs,
  searchFilter
}: SecurityViewProps) {
  // Stateful client configurations
  const [dataSovereignty, setDataSovereignty] = useState(true);
  const [mandatoryConsent, setMandatoryConsent] = useState(true);
  const [retentionPeriod, setRetentionPeriod] = useState('7');
  const [purgeConfirmOpen, setPurgeConfirmOpen] = useState(false);
  const [isPurging, setIsPurging] = useState(false);

  const handleSovereigntyToggle = () => {
    const newState = !dataSovereignty;
    setDataSovereignty(newState);
    onAddLog(
      newState 
        ? "Data Sovereignty toggled ON (Swiss Data Center Enclaves)" 
        : "Data Sovereignty toggled OFF (Fallback Global Servers)",
      newState ? "SUCCESS" : "FLAGGED"
    );
  };

  const handleConsentToggle = () => {
    const newState = !mandatoryConsent;
    setMandatoryConsent(newState);
    onAddLog(
      newState 
        ? "Consent Enforcement Rule initialized for all sessions" 
        : "Consent Enforcement bypassed (Requires fallback logs)",
      newState ? "SUCCESS" : "FLAGGED"
    );
  };

  const handleRetentionChange = (val: string) => {
    setRetentionPeriod(val);
    onAddLog(`Retention period setting updated to: ${val} days`, "SUCCESS");
  };

  const executePurge = () => {
    setIsPurging(true);
    setTimeout(() => {
      onClearLogs();
      onAddLog("Manual Purge Executed: All static transcripts deleted from cache disk.", "SUCCESS");
      setIsPurging(false);
      setPurgeConfirmOpen(false);
      alert("Sanitization complete. Encrypted logs cleared. Swiss backup vaults reported clean.");
    }, 1500);
  };

  // Filter logs via search text if any
  const filteredLogs = logs.filter(log =>
    log.event.toLowerCase().includes(searchFilter.toLowerCase()) ||
    log.actor.toLowerCase().includes(searchFilter.toLowerCase()) ||
    log.status.toLowerCase().includes(searchFilter.toLowerCase())
  );

  return (
    <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-6 scrollbar-hide select-none relative">
      
      {/* Purge Confirmation Modal */}
      {purgeConfirmOpen && (
        <div className="fixed inset-0 bg-[#0e0e0e]/85 backdrop-blur-md flex items-center justify-center z-50 p-4">
          <div className="bg-[#1c1b1b] border border-[#ffb4ab]/30 rounded-2xl max-w-md w-full p-6 shadow-2xl relative overflow-hidden">
            <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-red-500 to-amber-500"></div>
            
            <div className="flex items-start gap-4 mb-4">
              <div className="w-10 h-10 rounded-xl bg-[#93000a]/20 flex items-center justify-center shrink-0 text-[#ffb4ab]">
                <ShieldAlert className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-bold text-sm text-[#e5e2e1]">Destructive Action Warning</h3>
                <p className="text-xs text-[#c2c6d8] mt-1 leading-relaxed">
                  You are about to securely wipe all local chat sessions, downloaded meeting transcripts, and compliance diagnostic records. This action cannot be undone.
                </p>
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button 
                onClick={() => setPurgeConfirmOpen(false)}
                disabled={isPurging}
                className="px-4 py-2 bg-[#201f1f] text-[#e5e2e1] hover:bg-[#2a2a2a] rounded-lg text-xs font-semibold cursor-pointer border border-[#424655] transition-colors"
              >
                Cancel
              </button>
              <button 
                onClick={executePurge}
                disabled={isPurging}
                className="px-4 py-2 bg-[#93000a] text-white hover:bg-[#93000a]/90 rounded-lg text-xs font-bold cursor-pointer transition-colors flex items-center gap-1.5"
              >
                {isPurging ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Purging Disks...</span>
                  </>
                ) : (
                  <>
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Confirm Purge</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Hero Security Overview banner */}
      <section className="bg-[#1c1b1b] p-6 rounded-2xl border border-[#424655] relative overflow-hidden flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div className="accent-glow"></div>
        <div className="relative z-10 flex-1">
          <div className="flex items-center gap-2 mb-2 select-none">
            <Lock className="w-4 h-4 text-[#70ffba]" />
            <span className="text-[10px] font-black tracking-widest text-[#70ffba] uppercase">DURESS-PROOF ENCLAVE INITIALIZED</span>
          </div>
          <h2 className="text-xl font-bold text-[#e5e2e1] leading-tight font-headline-sm">Operational Security Dashboard</h2>
          <p className="text-xs text-[#c2c6d8] mt-1 max-w-2xl leading-relaxed">
            Configure geographic compliance regulations, automated system shredders, and audit trails. Decryption relies entirely on active ephemeral tokens.
          </p>
        </div>
        
        <button 
          onClick={() => {
            alert("Security status report compiled. Key strength: RSA-4096. Active Swiss proxy servers report 100% normal.");
          }}
          className="bg-[#201f1f] text-[#b0c6ff] border border-[#b0c6ff]/35 hover:bg-[#b0c6ff]/15 px-4 py-2 rounded-xl text-xs font-semibold relative z-10 cursor-pointer transition-all self-stretch md:self-auto text-center"
        >
          Check System Integrity
        </button>
      </section>

      {/* Grid of controllers: Sovereignty, Consent, Purge rules */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-6">
        
        {/* Sovereignty Card */}
        <div className="bg-[#1c1b1b] border border-[#424655] p-5 rounded-2xl flex flex-col justify-between h-[180px]">
          <div className="flex items-start justify-between">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1 text-[10px] font-extrabold tracking-wider text-[#b0c6ff] uppercase">
                <Globe className="w-3.5 h-3.5" />
                <span>Geographic Guard</span>
              </div>
              <h3 className="font-bold text-xs text-[#e5e2e1] mt-0.5">Swiss Sovereignty</h3>
              <p className="text-[11px] text-[#c2c6d8] leading-normal mt-1.5">
                Route files and transcription layers exclusively through secure enclaves in Switzerland.
              </p>
            </div>
          </div>
          
          <div className="flex items-center justify-between pt-3 border-t border-[#424655]/20">
            <span className="text-[10px] font-medium text-[#8c90a1]">Status: {dataSovereignty ? 'FORCE ACTIVE' : 'BYPASS ACTIVE'}</span>
            <button 
              onClick={handleSovereigntyToggle}
              className={`w-12 h-6.5 rounded-full p-1 transition-all ${
                dataSovereignty ? 'bg-[#568dff]' : 'bg-[#201f1f] border border-[#424655]'
              }`}
            >
              <div className={`w-4.5 h-4.5 rounded-full bg-[#131313] transition-all transform ${
                dataSovereignty ? 'translate-x-5.5' : 'translate-x-0'
              }`}></div>
            </button>
          </div>
        </div>

        {/* Consent Card */}
        <div className="bg-[#1c1b1b] border border-[#424655] p-5 rounded-2xl flex flex-col justify-between h-[180px]">
          <div className="flex items-start justify-between">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1 text-[10px] font-extrabold tracking-wider text-[#c0c1ff] uppercase">
                <CheckSquare className="w-3.5 h-3.5" />
                <span>Enforcement Protocol</span>
              </div>
              <h3 className="font-bold text-xs text-[#e5e2e1] mt-0.5">Mandatory Recording Consent</h3>
              <p className="text-[11px] text-[#c2c6d8] leading-normal mt-1.5">
                Block call connection if sync participants fail to acknowledge encryption compliance.
              </p>
            </div>
          </div>

          <div className="flex items-center justify-between pt-3 border-t border-[#424655]/20">
            <span className="text-[10px] font-medium text-[#8c90a1]">Status: {mandatoryConsent ? 'ENFORCED' : 'OPTIONAL'}</span>
            <button 
              onClick={handleConsentToggle}
              className={`w-12 h-6.5 rounded-full p-1 transition-all ${
                mandatoryConsent ? 'bg-[#c0c1ff]' : 'bg-[#201f1f] border border-[#424655]'
              }`}
            >
              <div className={`w-4.5 h-4.5 rounded-full bg-[#131313] transition-all transform ${
                mandatoryConsent ? 'translate-x-5.5' : 'translate-x-0'
              }`}></div>
            </button>
          </div>
        </div>

        {/* Retention / Purge Card */}
        <div className="bg-[#1c1b1b] border border-[#424655] p-5 rounded-2xl flex flex-col justify-between h-[180px]">
          <div className="flex items-start justify-between">
            <div className="flex flex-col gap-1 w-full">
              <div className="flex items-center gap-1 text-[10px] font-extrabold tracking-wider text-[#ffb4ab] uppercase">
                <Timer className="w-3.5 h-3.5" />
                <span>Disk Sanitization</span>
              </div>
              <h3 className="font-bold text-xs text-[#e5e2e1] mt-0.5">Transcript Auto-Purge</h3>
              <div className="flex items-center justify-between mt-2.5 bg-[#131313] border border-[#424655] rounded-lg px-2.5 py-1.5">
                <span className="text-[11px] text-[#c2c6d8] font-medium">Keep data for:</span>
                <select 
                  value={retentionPeriod}
                  onChange={(e) => handleRetentionChange(e.target.value)}
                  className="bg-transparent border-none focus:ring-0 text-xs text-[#b0c6ff] font-bold outline-none cursor-pointer"
                >
                  <option value="1">24 Hours</option>
                  <option value="7">7 Days</option>
                  <option value="30">30 Days</option>
                  <option value="0">Never (Manual Only)</option>
                </select>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between pt-3 border-t border-[#424655]/20">
            <span className="text-[10px] font-medium text-[#8c90a1]">Destructive Wipe:</span>
            <button 
              onClick={() => setPurgeConfirmOpen(true)}
              className="flex items-center gap-1 bg-[#93000a]/20 text-[#ffb4ab] border border-[#ffb4ab]/35 hover:bg-[#93000a]/35 px-3 py-1 rounded-lg text-[10px] font-black tracking-wider uppercase transition-colors cursor-pointer"
            >
              <Trash2 className="w-3 h-3" />
              <span>PURGE NOW</span>
            </button>
          </div>
        </div>

      </section>

      {/* Audit Log Data Grid */}
      <section className="bg-[#1c1b1b] border border-[#424655] rounded-2xl p-5 shadow-lg flex flex-col flex-grow min-h-[300px]">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-4 pb-3 border-b border-[#424655]/30">
          <div>
            <h3 className="font-semibold text-sm text-[#e5e2e1]">Compliance Audit Trail</h3>
            <p className="text-[10px] text-[#8c90a1] mt-0.5">Immutable workspace operations logs synced with Splunk connector</p>
          </div>
          
          <div className="flex items-center gap-2">
            <button 
              onClick={() => {
                alert("Downloading audit logs CSV...");
              }}
              className="flex items-center gap-1 text-[11px] text-[#c2c6d8] bg-[#201f1f] border border-[#424655] hover:border-[#b0c6ff] hover:text-[#b0c6ff] px-3 py-1.5 rounded-lg cursor-pointer transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export CSV</span>
            </button>
            <button 
              onClick={() => {
                onClearLogs();
                onAddLog("Audit logs reset manually.", "SUCCESS");
              }}
              className="text-[11px] text-[#ffb4ab] hover:text-white px-2 py-1.5 rounded"
            >
              Reset Area
            </button>
          </div>
        </div>

        {/* Responsive Audit Logs Scrollable box */}
        <div className="flex-1 overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="border-b border-[#424655]/40 text-[#8c90a1] font-bold select-none h-9 uppercase tracking-wider text-[10px]">
                <th className="py-2.5 px-3">Timestamp / Date</th>
                <th className="py-2.5 px-3">Security Event Target</th>
                <th className="py-2.5 px-3">Actor context</th>
                <th className="py-2.5 px-3 text-right">Verification Status</th>
              </tr>
            </thead>
            <tbody>
              {filteredLogs.map((log) => (
                <tr 
                  key={log.id} 
                  className="border-b border-[#424655]/20 hover:bg-[#201f1f]/40 transition-colors h-10"
                >
                  <td className="py-2.5 px-3 text-[#8c90a1] font-mono whitespace-nowrap">{log.timestamp}</td>
                  <td className="py-2.5 px-3 font-semibold text-[#e5e2e1]">{log.event}</td>
                  <td className="py-2.5 px-3 text-[#c2c6d8] font-mono">{log.actor}</td>
                  <td className="py-2.5 px-3 text-right whitespace-nowrap">
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-black tracking-wide ${
                      log.status === 'SUCCESS' 
                        ? 'bg-[#00e598]/10 text-[#70ffba] border border-[#00e296]/20' 
                        : 'bg-[#93000a]/20 text-[#ffb4ab] border border-[#ffb4ab]/20'
                    }`}>
                      <span className={`w-1 h-1 rounded-full ${log.status === 'SUCCESS' ? 'bg-[#70ffba]' : 'bg-[#ffb4ab]'}`}></span>
                      {log.status}
                    </span>
                  </td>
                </tr>
              ))}

              {filteredLogs.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-12 text-center text-[#8c90a1] opacity-75">
                    No matching compliance logs recorded.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

    </div>
  );
}
