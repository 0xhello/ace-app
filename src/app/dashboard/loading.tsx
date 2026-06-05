export default function DashboardLoading() {
  return (
    <div className="flex-1 overflow-hidden bg-[#0a0b0a] text-white">
      <div className="flex h-full animate-pulse">
        <div className="flex-1 min-w-0">
          <div className="border-b border-[#1b201a] px-6 py-4 flex items-center justify-between">
            <div>
              <div className="h-4 w-24 rounded bg-[#161a16]" />
              <div className="mt-2 h-2.5 w-40 rounded bg-[#111511]" />
            </div>
            <div className="h-8 w-28 rounded-xl bg-[#111511]" />
          </div>

          <div className="px-5 py-4 space-y-3">
            <div className="h-2.5 w-32 rounded bg-[#161a16]" />
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="rounded-2xl border border-[#171d16] bg-[#0d0f0d] px-5 py-4">
                <div className="grid items-center gap-3" style={{ gridTemplateColumns: "minmax(240px,1.2fr) repeat(3,84px) 28px" }}>
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-14 rounded bg-[#141814]" />
                    <div className="flex-1 space-y-2">
                      <div className="h-3.5 w-44 rounded bg-[#161a16]" />
                      <div className="h-3.5 w-36 rounded bg-[#141814]" />
                      <div className="h-2.5 w-28 rounded bg-[#111511]" />
                    </div>
                  </div>
                  {[0, 1, 2].map((c) => (
                    <div key={c} className="space-y-1.5">
                      <div className="h-9 rounded-md bg-[#101310]" />
                      <div className="h-9 rounded-md bg-[#101310]" />
                    </div>
                  ))}
                  <div className="h-5 w-5 rounded bg-[#111511]" />
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="hidden lg:block w-11 border-l border-[#1b201a] bg-[#090a09]" />
      </div>
    </div>
  );
}
