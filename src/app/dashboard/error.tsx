"use client";

import { useEffect } from "react";
import Link from "next/link";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Dashboard error:", error);
  }, [error]);

  return (
    <div className="flex-1 flex items-center justify-center bg-[#0a0b0a] px-6">
      <div className="text-center max-w-sm">
        <div className="inline-flex items-center justify-center h-12 w-12 rounded-2xl border border-[#ef4444]/20 bg-[#ef4444]/5 mb-6 mx-auto">
          <svg className="h-5 w-5 text-[#ef4444]/70" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
          </svg>
        </div>

        <p className="font-mono text-[9px] uppercase tracking-[0.28em] text-[#ef4444]/50 mb-3">Error</p>
        <h2 className="text-[1.4rem] font-semibold tracking-[-0.04em] text-white mb-3">
          Failed to load this page
        </h2>
        <p className="text-[0.88rem] leading-relaxed text-white/36 mb-6">
          Something went wrong on our end. Try refreshing or navigating back to the main board.
        </p>

        {error.digest && (
          <p className="font-mono text-[9px] text-white/14 mb-5">ref: {error.digest}</p>
        )}

        <div className="flex items-center justify-center gap-2.5">
          <button
            onClick={reset}
            className="rounded-lg bg-[#3ee68a]/10 border border-[#3ee68a]/20 text-[#3ee68a] text-[11px] font-bold px-4 py-2 hover:bg-[#3ee68a]/15 transition-colors"
          >
            Try again
          </button>
          <Link
            href="/dashboard"
            className="rounded-lg border border-[#1e2220] text-[#6b7068] text-[11px] px-4 py-2 hover:text-[#9ca39a] hover:border-[#2e332a] transition-colors"
          >
            Back to board
          </Link>
        </div>
      </div>
    </div>
  );
}
