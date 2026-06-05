"use client";

import { ArrowRight, Lock, Sparkles, X } from "lucide-react";

const PREVIEW_PROMPTS = [
  "Which edges are real versus noise?",
  "Show me the line move that matters.",
  "Explain why this pick is track-only.",
  "What changed since the last poll?",
];

const CAPABILITIES = [
  "Transparent reasoning over odds, injuries, movement, and model signals",
  "Clear source labels instead of black-box betting answers",
  "Action versus track-only language before anything reaches your slip",
];

export default function AskAce({ onClose }: { onClose: () => void }) {
  return (
    <>
      <div className="fixed inset-0 z-50 bg-[#070807]/80 backdrop-blur-md" onClick={onClose} />

      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div
          className="pointer-events-auto relative w-full max-w-[660px] overflow-hidden rounded-[28px] border border-white/10 bg-[linear-gradient(180deg,rgba(16,19,16,0.86),rgba(8,10,8,0.94))] shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_28px_90px_rgba(0,0,0,0.56)]"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="pointer-events-none absolute inset-0 opacity-70">
            <div className="absolute -top-28 right-8 h-56 w-56 rounded-full bg-[#3ee68a]/10 blur-3xl" />
            <div className="absolute bottom-0 left-0 h-44 w-72 rounded-full bg-white/[0.035] blur-3xl" />
            <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/18 to-transparent" />
          </div>

          <div className="relative flex items-center justify-between border-b border-white/[0.07] px-5 py-4">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-[#3ee68a]/20 bg-[#3ee68a]/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
                <Sparkles className="h-4 w-4 text-[#3ee68a]" />
              </div>
              <div>
                <p className="text-[13px] font-bold leading-tight text-white">Ask ACE</p>
                <p className="text-[9px] uppercase tracking-[0.2em] text-[#7f8a7d]">Transparent copilot preview</p>
              </div>
            </div>
            <button onClick={onClose} className="rounded-lg p-1.5 text-[#4d554b] transition-colors hover:bg-white/[0.04] hover:text-[#9ca39a] active:scale-[0.98]">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="relative grid gap-5 px-5 py-5 md:grid-cols-[1.2fr_0.8fr]">
            <div className="space-y-4">
              <div className="inline-flex items-center gap-2 rounded-full border border-[#3ee68a]/15 bg-[#3ee68a]/[0.07] px-3 py-1.5">
                <Lock className="h-3 w-3 text-[#3ee68a]" />
                <span className="text-[9px] font-bold uppercase tracking-[0.18em] text-[#bfeccc]">Coming soon</span>
              </div>

              <div>
                <h2 className="max-w-[13ch] text-[34px] font-semibold leading-[0.92] tracking-[-0.06em] text-white sm:text-[42px]">
                  A reasoning layer you can audit.
                </h2>
                <p className="mt-3 max-w-[46ch] text-[12px] leading-relaxed text-[#8b9388]">
                  Ask ACE is being held back until it can show real sources, real uncertainty, and no demo betting reads. The feature should feel like a transparent trading desk, not a chatbot making confident guesses.
                </p>
              </div>

              <div className="rounded-2xl border border-white/[0.08] bg-white/[0.035] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-xl">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <span className="text-[9px] font-bold uppercase tracking-[0.18em] text-[#6f786d]">Preview prompt</span>
                  <span className="rounded-full border border-[#2b332a] px-2 py-0.5 text-[8px] uppercase tracking-[0.14em] text-[#657063]">locked</span>
                </div>
                <div className="flex items-center gap-2 rounded-xl border border-[#1e241d] bg-[#0d100d]/80 px-3 py-2.5">
                  <p className="flex-1 text-[11px] text-[#d9ddd6]">What deserves action today, and what should only be tracked?</p>
                  <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#3ee68a]/10 text-[#3ee68a]">
                    <ArrowRight className="h-3.5 w-3.5" />
                  </div>
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <div className="rounded-2xl border border-white/[0.08] bg-[#101310]/70 p-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-xl">
                <p className="text-[9px] font-bold uppercase tracking-[0.18em] text-[#6f786d]">What it will do</p>
                <div className="mt-3 space-y-2.5">
                  {CAPABILITIES.map((item) => (
                    <div key={item} className="flex gap-2">
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#3ee68a]/70" />
                      <p className="text-[10px] leading-relaxed text-[#aeb6aa]">{item}</p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="grid gap-2">
                {PREVIEW_PROMPTS.map((prompt, index) => (
                  <div
                    key={prompt}
                    className="rounded-xl border border-[#20251f] bg-[#0e110e]/72 px-3 py-2.5 opacity-80"
                    style={{ transform: `translateX(${index % 2 === 0 ? "0" : "10"}px)` }}
                  >
                    <p className="text-[10px] leading-relaxed text-[#7f867c]">{prompt}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="relative border-t border-white/[0.07] px-5 py-3">
            <p className="text-center text-[8px] uppercase tracking-[0.18em] text-[#586057]">
              No fallback picks. No hidden demo mode. Real intelligence only.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
