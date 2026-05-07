"use client";

import { useState, useEffect } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Suspense } from "react";

function RegisterForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [inviteCode, setInviteCode] = useState(searchParams.get("code") ?? "");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const code = searchParams.get("code");
    if (code) setInviteCode(code);
  }, [searchParams]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }

    setLoading(true);
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, invite_code: inviteCode || undefined }),
    });
    const data = await res.json();
    if (!res.ok) {
      setLoading(false);
      setError(data.error ?? "Registration failed");
      return;
    }

    // Auto sign-in after registration
    const result = await signIn("credentials", {
      email,
      password,
      redirect: false,
    });
    setLoading(false);
    if (result?.error) {
      router.push("/login");
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
          <h1 className="text-[15px] font-bold text-white mb-1">Create account</h1>
          <p className="text-[11px] text-[#6b7068] mb-5">Beta access — invite only</p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-[10px] font-semibold text-[#6b7068] uppercase tracking-[0.12em] mb-1.5">
                Invite Code
              </label>
              <input
                type="text"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
                placeholder="XXXXXXXXXXXXXX"
                className="w-full rounded-lg border border-[#1e2220] bg-[#121412] text-white text-[12px] px-3 py-2.5 placeholder:text-[#3a4033] focus:outline-none focus:border-[#3ee68a]/40 focus:ring-1 focus:ring-[#3ee68a]/20 transition-colors font-mono tracking-widest"
              />
            </div>

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
                autoComplete="new-password"
                placeholder="min 8 characters"
                className="w-full rounded-lg border border-[#1e2220] bg-[#121412] text-white text-[12px] px-3 py-2.5 placeholder:text-[#3a4033] focus:outline-none focus:border-[#3ee68a]/40 focus:ring-1 focus:ring-[#3ee68a]/20 transition-colors"
              />
            </div>

            <div>
              <label className="block text-[10px] font-semibold text-[#6b7068] uppercase tracking-[0.12em] mb-1.5">
                Confirm Password
              </label>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                autoComplete="new-password"
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
              {loading ? "Creating account…" : "Create account"}
            </button>
          </form>

          <p className="text-[11px] text-[#3a4033] mt-4 text-center">
            Already have an account?{" "}
            <Link href="/login" className="text-[#3ee68a] hover:text-[#57eba0] transition-colors">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}

export default function RegisterPage() {
  return (
    <Suspense>
      <RegisterForm />
    </Suspense>
  );
}
