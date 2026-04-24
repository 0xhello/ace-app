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
      <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div
          className="pointer-events-auto w-full max-w-[540px] rounded-2xl border border-[#2e332a] bg-[#0a0b0a] shadow-2xl flex flex-col overflow-hidden"
          style={{ maxHeight: "80vh" }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-[#22251f] shrink-0">
            <div className="flex items-center gap-2.5">
              <div className="h-7 w-7 rounded-lg bg-[#3ee68a]/10 flex items-center justify-center">
                <Sparkles className="h-3.5 w-3.5 text-[#3ee68a]" />
              </div>
              <div>
                <p className="text-[13px] font-bold text-white leading-tight">Ask ACE</p>
                <p className="text-[9px] text-[#6b7068] leading-tight">Betting intelligence assistant</p>
              </div>
            </div>
            <button onClick={onClose} className="text-[#3a4033] hover:text-[#6b7068] transition-colors">
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Conversation */}
          <div className="flex-1 overflow-y-auto min-h-0 p-4 space-y-3">
            {messages.length === 0 ? (
              <div className="space-y-3">
                <p className="text-[11px] text-[#6b7068] text-center pt-2">
                  Ask about odds, edges, sharp money, or anything on the board.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {QUICK_PROMPTS.map((p) => (
                    <button
                      key={p}
                      onClick={() => ask(p)}
                      className="text-left px-3 py-2.5 rounded-xl border border-[#22251f] bg-[#121412] hover:border-[#2e332a] hover:bg-[#161a16] transition-all"
                    >
                      <p className="text-[10px] text-[#9ca39a] leading-relaxed">{p}</p>
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
          <div className="shrink-0 border-t border-[#22251f] p-3">
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
            <p className="text-[8px] text-[#3a4033] text-center mt-1.5">Enter to send · Shift+Enter for new line · Esc to close</p>
          </div>
        </div>
      </div>
    </>
  );
}
