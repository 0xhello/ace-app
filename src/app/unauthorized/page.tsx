import Link from "next/link";
import { ShieldOff } from "lucide-react";

export default function UnauthorizedPage() {
  return (
    <div className="min-h-screen bg-[#07080a] flex items-center justify-center px-6">
      <div className="text-center max-w-md">
        {/* Logo */}
        <div className="flex items-center justify-center gap-2.5 mb-10">
          <img src="/favicon.png" alt="ACE" className="h-7 w-7 opacity-60" />
          <span className="text-[13px] font-extrabold tracking-[0.28em] text-white/50">ACE</span>
        </div>

        {/* Icon */}
        <div className="inline-flex items-center justify-center h-14 w-14 rounded-2xl border border-[#ef4444]/20 bg-[#ef4444]/5 mb-7 mx-auto">
          <ShieldOff className="h-6 w-6 text-[#ef4444]/70" />
        </div>

        <p className="font-mono text-[9px] uppercase tracking-[0.32em] text-[#ef4444]/50 mb-4">Access denied</p>

        <h1 className="text-[2.6rem] font-semibold leading-[0.92] tracking-[-0.07em] text-white mb-4">
          You don't have<br />access to this.
        </h1>

        <p className="text-[0.95rem] leading-relaxed text-white/36 mb-8 max-w-[34ch] mx-auto">
          This area is restricted to admin accounts. If you think this is a mistake, contact the team.
        </p>

        <div className="flex items-center justify-center gap-3">
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-2 rounded-full bg-[#3ee68a] px-6 py-3 text-[13px] font-semibold text-black transition hover:bg-[#57eba0] active:scale-[0.98]"
          >
            Back to dashboard
          </Link>
          <Link
            href="/"
            className="inline-flex items-center gap-2 rounded-full border border-white/[0.1] px-6 py-3 text-[13px] text-white/48 transition hover:border-white/[0.2] hover:text-white"
          >
            Home
          </Link>
        </div>

        <p className="mt-10 font-mono text-[9px] uppercase tracking-[0.24em] text-white/16">
          ACE · Intelligence terminal
        </p>
      </div>
    </div>
  );
}
