"use client";

import { useState, useRef, useEffect } from "react";
import { Sparkles, X, ArrowRight, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

const QUICK_PROMPTS = [
  "What's the sharpest bet on the board right now?",
  "How do I build a +EV parlay tonight?",
  "Explain line movement on today's games",
  "Where's the best value on totals?",
];

const COPILOT_PROMPTS = [
  "Best live edge",
  "Highest-confidence read",
  "Biggest line move",
];

interface Message {
  role: "user" | "ace";
  text: string;
  demo?: boolean;
}

export default function AskAce({ onClose }: { onClose: () => void }) {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function ask(question: string) {
    if (!question.trim() || loading) return;
    setInput("");
    setMessages((prev) => [...prev, { role: "user", text: question }]);
    setLoading(true);
    try {
      const res = await fetch("/api/ask-ace", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const data = await res.json();
      setMessages((prev) => [...prev, { role: "ace", text: data.answer, demo: data.demo }]);
    } catch {
      setMessages((prev) => [...prev, { role: "ace", text: "Couldn't reach ACE right now. Check your connection and try again." }]);
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      ask(input);
    }
  }

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div
          className="pointer-events-auto w-full max-w-[620px] rounded-[24px] border border-[#2a3027] bg-[linear-gradient(180deg,rgba(11,13,11,0.98),rgba(9,10,9,0.98))] shadow-[0_24px_80px_rgba(0,0,0,0.5)] flex flex-col overflow-hidden"
          style={{ maxHeight: "82vh" }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-[#1f241d] shrink-0">
            <div className="flex items-center gap-2.5">
              <div className="h-7 w-7 rounded-lg bg-[#3ee68a]/10 flex items-center justify-center">
                <Sparkles className="h-3.5 w-3.5 text-[#3ee68a]" />
              </div>
              <div>
                <p className="text-[13px] font-bold text-white leading-tight">Ask ACE</p>
                <p className="text-[9px] text-[#758071] leading-tight uppercase tracking-[0.18em]">Betting intelligence copilot</p>
              </div>
            </div>
            <button onClick={onClose} className="text-[#3a4033] hover:text-[#6b7068] transition-colors">
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Conversation */}
          <div className="flex-1 overflow-y-auto min-h-0 p-4 space-y-3">
            {messages.length === 0 ? (
              <div className="space-y-4">
                <div className="ace-panel px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="ace-label mb-1">Copilot mode</p>
                      <p className="text-[13px] font-semibold text-white">Use ACE like a fast trading desk, not a generic chatbot.</p>
                      <p className="mt-1.5 text-[11px] text-[#7b8378] leading-relaxed">Ask for best edge, market confidence, line movement, or what deserves action versus tracking.</p>
                    </div>
                    <div className="hidden sm:flex flex-wrap justify-end gap-1.5 max-w-[180px]">
                      {COPILOT_PROMPTS.map((prompt) => (
                        <button
                          key={prompt}
                          onClick={() => ask(prompt)}
                          className="ace-chip hover:border-[#3a4336] hover:text-white transition-colors"
                        >
                          {prompt}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {QUICK_PROMPTS.map((p) => (
                    <button
                      key={p}
                      onClick={() => ask(p)}
                      className="text-left px-3 py-3 rounded-xl border border-[#20251f] bg-[#121412] hover:border-[#2e332a] hover:bg-[#161a16] transition-all"
                    >
                      <p className="text-[10px] text-[#b6bbb3] leading-relaxed">{p}</p>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((m, i) => (
                <div key={i} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
                  {m.role === "ace" && (
                    <div className="h-5 w-5 rounded-md bg-[#3ee68a]/10 flex items-center justify-center mr-2 mt-0.5 shrink-0">
                      <Sparkles className="h-2.5 w-2.5 text-[#3ee68a]" />
                    </div>
                  )}
                  <div
                    className={cn(
                      "max-w-[80%] rounded-xl px-3.5 py-2.5",
                      m.role === "user"
                        ? "bg-[#22251f] text-[11px] text-white"
                        : "bg-[#121412] border border-[#22251f] text-[11px] text-[#d4d7d0] leading-relaxed"
                    )}
                  >
                    {m.text}
                    {m.demo && (
                      <p className="text-[8px] text-[#3a4033] mt-1">Demo mode — add ANTHROPIC_API_KEY for live answers</p>
                    )}
                  </div>
                </div>
              ))
            )}

            {loading && (
              <div className="flex justify-start">
                <div className="h-5 w-5 rounded-md bg-[#3ee68a]/10 flex items-center justify-center mr-2 mt-0.5 shrink-0">
                  <Sparkles className="h-2.5 w-2.5 text-[#3ee68a]" />
                </div>
                <div className="bg-[#121412] border border-[#22251f] rounded-xl px-3.5 py-2.5 flex items-center gap-2">
                  <Loader2 className="h-3 w-3 text-[#6b7068] animate-spin" />
                  <span className="text-[10px] text-[#6b7068]">Analyzing…</span>
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div className="shrink-0 border-t border-[#1f241d] p-3">
            <div className="flex items-end gap-2 bg-[#121412] border border-[#22251f] rounded-xl px-3 py-2 focus-within:border-[#2e332a] transition-colors">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask about any game, line, or betting concept..."
                rows={1}
                className="flex-1 bg-transparent outline-none text-[11px] text-white placeholder:text-[#3a4033] resize-none leading-relaxed"
                style={{ maxHeight: 80 }}
              />
              <button
                onClick={() => ask(input)}
                disabled={!input.trim() || loading}
                className={cn(
                  "shrink-0 h-6 w-6 rounded-md flex items-center justify-center transition-all",
                  input.trim() && !loading
                    ? "bg-[#3ee68a]/15 text-[#3ee68a] hover:bg-[#3ee68a]/25"
                    : "text-[#3a4033]"
                )}
              >
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
            <p className="text-[8px] text-[#556053] text-center mt-1.5 uppercase tracking-[0.16em]">Enter to send · Shift+Enter for new line · Esc to close</p>
          </div>
        </div>
      </div>
    </>
  );
}
