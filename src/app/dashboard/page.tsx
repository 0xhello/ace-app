import { Suspense } from "react";
import GamesFeed from "./GamesFeed";

export const revalidate = 60;

export default function DashboardPage() {
  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Today's Games</h1>
          <p className="text-ace-muted text-sm mt-0.5">Live odds from 40+ sportsbooks</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-ace-muted bg-ace-card border border-ace-border px-3 py-1.5 rounded-full">
          <span className="h-1.5 w-1.5 rounded-full bg-ace-green animate-pulse" />
          Auto-refreshing
        </div>
      </div>

      <Suspense fallback={<GamesSkeleton />}>
        <GamesFeed />
      </Suspense>
    </div>
  );
}

function GamesSkeleton() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="bg-ace-card border border-ace-border rounded-xl p-4 animate-pulse">
          <div className="h-3 bg-ace-border rounded w-1/3 mb-4" />
          <div className="space-y-3">
            <div className="flex justify-between">
              <div className="h-4 bg-ace-border rounded w-1/2" />
              <div className="h-4 bg-ace-border rounded w-16" />
            </div>
            <div className="flex justify-between">
              <div className="h-4 bg-ace-border rounded w-1/2" />
              <div className="h-4 bg-ace-border rounded w-16" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
