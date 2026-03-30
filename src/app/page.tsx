import Link from "next/link";

export default function Home() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-4">
      <div className="text-center max-w-2xl">
        <div className="inline-flex items-center gap-2 bg-ace-card border border-ace-border rounded-full px-4 py-1.5 text-sm text-ace-muted mb-8">
          <span className="h-2 w-2 rounded-full bg-ace-green animate-pulse" />
          Live odds from 40+ sportsbooks
        </div>

        <h1 className="text-5xl font-bold tracking-tight mb-4">
          Bet smarter with{" "}
          <span className="text-ace-gold">ACE</span>
        </h1>

        <p className="text-ace-muted text-lg mb-10 leading-relaxed">
          AI-powered sports betting intelligence. Real-time odds comparison, line movement alerts,
          parlay builder, and predictive analytics — all in one place.
        </p>

        <div className="flex items-center justify-center gap-4">
          <Link
            href="/dashboard"
            className="bg-ace-gold text-black font-semibold px-6 py-3 rounded-xl hover:bg-yellow-400 transition-colors"
          >
            Open Dashboard
          </Link>
          <Link
            href="/dashboard"
            className="border border-ace-border text-white px-6 py-3 rounded-xl hover:bg-ace-card transition-colors"
          >
            View Live Odds
          </Link>
        </div>
      </div>
    </main>
  );
}
