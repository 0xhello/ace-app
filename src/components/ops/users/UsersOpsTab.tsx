"use client";

import { useEffect, useState } from "react";
import { Users, PlusCircle, Copy, Check, RefreshCw } from "lucide-react";

interface InviteCode {
  id: number; code: string; label: string | null;
  used_by_email: string | null; used_at: string | null; created_at: string;
}

function SectionHead({ title, icon: Icon }: { title: string; icon: React.ElementType }) {
  return (
    <div className="flex items-center gap-2 mb-5">
      <Icon className="h-3.5 w-3.5 text-[#3ee68a]" />
      <p className="text-[11px] font-bold text-[#3ee68a] uppercase tracking-[0.2em]">{title}</p>
    </div>
  );
}

export default function UsersOpsTab() {
  const [inviteCodes,   setInviteCodes]   = useState<InviteCode[]>([]);
  const [loading,       setLoading]       = useState(true);
  const [inviteLoading, setInviteLoading] = useState(false);
  const [newCodeLabel,  setNewCodeLabel]  = useState("");
  const [copiedCode,    setCopiedCode]    = useState<string | null>(null);

  async function loadInviteCodes() {
    try {
      const r = await fetch("/api/auth/invite");
      const d = await r.json();
      if (d.codes) setInviteCodes(d.codes);
    } catch { /* silent */ }
    finally { setLoading(false); }
  }

  async function generateCode() {
    setInviteLoading(true);
    try {
      const r = await fetch("/api/auth/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: newCodeLabel || undefined }),
      });
      const d = await r.json();
      if (d.ok) { setNewCodeLabel(""); await loadInviteCodes(); }
    } finally {
      setInviteLoading(false);
    }
  }

  function copyCode(code: string) {
    const base = typeof window !== "undefined" ? window.location.origin : "";
    navigator.clipboard.writeText(`${base}/register?code=${code}`).catch(() => {
      navigator.clipboard.writeText(code);
    });
    setCopiedCode(code);
    setTimeout(() => setCopiedCode(null), 2000);
  }

  useEffect(() => { void loadInviteCodes(); }, []);

  return (
    <div className="flex-1 overflow-y-auto bg-[#0a0b0a]">
      <div className="max-w-[1200px] mx-auto px-6 py-7 space-y-5">

        {/* ══ HEADER ══════════════════════════════════════════════════════════ */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Users className="h-4 w-4 text-[#3ee68a]" />
            <h1 className="text-[18px] font-bold text-white tracking-tight">Access & Users</h1>
          </div>
          <button onClick={loadInviteCodes} className="flex items-center gap-1.5 text-[10px] text-[#4a524a] hover:text-[#9ca39a] transition-colors">
            <RefreshCw className="h-3 w-3" />
          </button>
        </div>

        {/* ══ INVITE CODES ════════════════════════════════════════════════════ */}
        <div className="rounded-xl border border-[#1e2220] bg-[#0d0f0d] p-5">
          <SectionHead title="Beta Access · Invite Codes" icon={Users} />

          <div className="flex items-center gap-2 mb-4">
            <input
              type="text"
              value={newCodeLabel}
              onChange={e => setNewCodeLabel(e.target.value)}
              onKeyDown={e => e.key === "Enter" && generateCode()}
              placeholder="Label (optional — e.g. friend name)"
              className="flex-1 rounded-lg border border-[#1e2220] bg-[#121412] text-white text-[11px] px-3 py-2 placeholder:text-[#3a4033] focus:outline-none focus:border-[#3ee68a]/40 transition-colors"
            />
            <button
              onClick={generateCode}
              disabled={inviteLoading}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#3ee68a]/10 border border-[#3ee68a]/20 text-[#3ee68a] text-[11px] font-bold hover:bg-[#3ee68a]/15 disabled:opacity-50 transition-colors whitespace-nowrap"
            >
              <PlusCircle className="h-3.5 w-3.5" />
              {inviteLoading ? "Generating…" : "Generate Code"}
            </button>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-8">
              <RefreshCw className="h-3.5 w-3.5 animate-spin text-[#3a4033]" />
            </div>
          ) : inviteCodes.length === 0 ? (
            <p className="text-[11px] text-[#3a4033] text-center py-6">No invite codes yet — generate one above.</p>
          ) : (
            <div className="space-y-2">
              {inviteCodes.map(c => (
                <div key={c.id} className="flex items-center gap-3 rounded-lg border border-[#1a1e1a] bg-[#0f110f] px-3 py-2.5">
                  <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${c.used_by_email ? "bg-[#3a4033]" : "bg-[#3ee68a]"}`} />
                  <span className="font-mono text-[11px] text-[#c4c7c0] tracking-widest flex-1">{c.code}</span>
                  {c.label && (
                    <span className="text-[10px] text-[#4a524a] truncate max-w-[140px]">{c.label}</span>
                  )}
                  {c.used_by_email ? (
                    <span className="text-[9px] text-[#3a4033] shrink-0">used · {c.used_by_email}</span>
                  ) : (
                    <button
                      onClick={() => copyCode(c.code)}
                      className="flex items-center gap-1 text-[10px] text-[#6b7068] hover:text-[#3ee68a] transition-colors shrink-0"
                      title="Copy invite link"
                    >
                      {copiedCode === c.code ? (
                        <><Check className="h-3 w-3 text-[#3ee68a]" /><span className="text-[#3ee68a]">Copied</span></>
                      ) : (
                        <><Copy className="h-3 w-3" />Copy link</>
                      )}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          <p className="text-[9px] text-[#2e3328] mt-4">
            Unused codes are shown in green · Invite link: {typeof window !== "undefined" ? window.location.origin : "app"}/register?code=…
          </p>
        </div>

      </div>
    </div>
  );
}
