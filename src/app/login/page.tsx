"use client";

import { useEffect, useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
      router.replace("/dashboard");
    }
  }, [router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    const result = await signIn("credentials", {
      email,
      password,
      redirect: false,
    });
    setLoading(false);
    if (result?.error) {
      setError("Invalid email or password");
    } else {
      router.push("/dashboard");
      router.refresh();
    }
  }

  return (
    <div className="min-h-screen bg-[#0a0b0a] flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex items-center gap-2.5 mb-8">
          <img src="/favicon.png" alt="ACE" className="h-8 w-8" />
          <span className="text-[17px] font-extrabold tracking-[0.25em] text-white">ACE</span>
          <span className="text-[8px] font-bold text-[#3ee68a] border border-[#3ee68a]/20 bg-[#3ee68a]/8 rounded px-1 py-[1px] tracking-widest uppercase">
            Beta
          </span>
        </div>

        <div className="rounded-xl border border-[#1e2220] bg-[#0d0f0d] p-6">
          <h1 className="text-[15px] font-bold text-white mb-1">Sign in</h1>
          <p className="text-[11px] text-[#6b7068] mb-5">Welcome back to ACE</p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-[10px] font-semibold text-[#6b7068] uppercase tracking-[0.12em] mb-1.5">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                placeholder="you@example.com"
                className="w-full rounded-lg border border-[#1e2220] bg-[#121412] text-white text-[12px] px-3 py-2.5 placeholder:text-[#3a4033] focus:outline-none focus:border-[#3ee68a]/40 focus:ring-1 focus:ring-[#3ee68a]/20 transition-colors"
              />
            </div>

            <div>
              <label className="block text-[10px] font-semibold text-[#6b7068] uppercase tracking-[0.12em] mb-1.5">
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                placeholder="••••••••"
                className="w-full rounded-lg border border-[#1e2220] bg-[#121412] text-white text-[12px] px-3 py-2.5 placeholder:text-[#3a4033] focus:outline-none focus:border-[#3ee68a]/40 focus:ring-1 focus:ring-[#3ee68a]/20 transition-colors"
              />
            </div>

            {error && (
              <p className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 rounded-lg bg-[#3ee68a] text-[#0a0b0a] text-[12px] font-bold tracking-wide hover:bg-[#57eba0] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? "Signing in…" : "Sign in"}
            </button>
          </form>

          <p className="text-[11px] text-[#3a4033] mt-4 text-center">
            Have an invite code?{" "}
            <Link href="/register" className="text-[#3ee68a] hover:text-[#57eba0] transition-colors">
              Create account
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
