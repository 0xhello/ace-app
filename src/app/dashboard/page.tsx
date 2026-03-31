import { Suspense } from "react";
import GamesFeed from "./GamesFeed";

export const dynamic = "force-dynamic";

export default function DashboardPage() {
  return (
    <Suspense fallback={<GamesSkeleton />}>
      <GamesFeed />
    </Suspense>
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
