/**
 * Intentional loading state for the game match-center. Mirrors the real page
 * layout (scoreboard hero + research sections) so the transition from the board
 * is deliberate — no flash of the old side panel, no layout jump.
 */
export default function GamePageLoading() {
  return (
    <div className="flex-1 overflow-y-auto bg-[#0a0b0a] text-white">
      <div className="max-w-[860px] mx-auto px-4 md:px-6 py-5 pb-24 animate-pulse">
        <div className="h-3 w-14 rounded bg-[#161a16] mb-4" />

        {/* hero skeleton */}
        <div className="rounded-3xl border border-[#1f261d] bg-[#0c0e0c] overflow-hidden">
          <div className="flex items-center justify-between px-6 pt-5 pb-4">
            <div className="h-2.5 w-24 rounded bg-[#161a16]" />
            <div className="h-2.5 w-20 rounded bg-[#161a16]" />
          </div>
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-4 px-6 pb-6">
            {[0, 1, 2].map((i) => (
              <div key={i} className={i === 1 ? "flex flex-col items-center gap-2" : "flex flex-col items-center gap-2.5"}>
                {i === 1 ? (
                  <div className="h-5 w-10 rounded bg-[#161a16]" />
                ) : (
                  <>
                    <div className="h-12 w-12 rounded-xl bg-[#141814]" />
                    <div className="h-4 w-24 rounded bg-[#161a16]" />
                    <div className="h-3 w-12 rounded bg-[#141814]" />
                  </>
                )}
              </div>
            ))}
          </div>
          <div className="h-10 border-t border-[#161a16] bg-[#0a0c0a]" />
        </div>

        {/* section skeletons */}
        <div className="mt-7 space-y-7">
          {[0, 1, 2].map((i) => (
            <div key={i}>
              <div className="h-2.5 w-28 rounded bg-[#161a16] mb-3" />
              <div className="h-24 rounded-2xl border border-[#1b201a] bg-[#0d0f0d]" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
