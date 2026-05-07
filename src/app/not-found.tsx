import Link from "next/link";

export default function NotFound() {
  return (
    <div className="min-h-screen bg-[#07080a] flex items-center justify-center px-6">
      <div className="text-center max-w-md">
        {/* Logo */}
        <div className="flex items-center justify-center gap-2.5 mb-10">
          <img src="/favicon.png" alt="ACE" className="h-7 w-7 opacity-60" />
          <span className="text-[13px] font-extrabold tracking-[0.28em] text-white/50">ACE</span>
        </div>

        <p className="font-mono text-[9px] uppercase tracking-[0.32em] text-[#3ee68a]/50 mb-5">404</p>

        <h1 className="text-[3rem] font-semibold leading-[0.9] tracking-[-0.07em] text-white mb-4">
          Page not found.
        </h1>

        <p className="text-[0.95rem] leading-relaxed text-white/36 mb-8 max-w-[32ch] mx-auto">
          This page doesn't exist or was moved. Check the URL or head back to the dashboard.
        </p>

        <div className="flex items-center justify-center gap-3">
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-2 rounded-full bg-[#3ee68a] px-6 py-3 text-[13px] font-semibold text-black transition hover:bg-[#57eba0] active:scale-[0.98]"
          >
            Go to dashboard
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
