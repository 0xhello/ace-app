import Link from "next/link";
import { Activity, Clock3, CheckCircle2, ChevronRight } from "lucide-react";
import { fetchTrackedIntel } from "@/lib/intel-data";

export const dynamic = "force-dynamic";

function bucketFor(item: any): "active" | "quiet" | "completed" {
  if (item.summary?.toLowerCase().includes("no internal signals")) return "quiet";
  if (item.summary?.toLowerCase().includes("final")) return "completed";
  return "active";
}

function coverageLabel(item: any) {
  const injury = item.coverage?.injury_coverage ?? "none";
  const weather = item.coverage?.weather_coverage ?? "none";
  return `inj ${injury} · wx ${weather}`;
}

function Section({ title, icon: Icon, items }: { title: string; icon: any; items: any[] }) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2 px-1">
        <Icon className="h-4 w-4 text-[#00ff7f]" />
        <h2 className="text-[13px] font-semibold text-white">{title}</h2>
        <span className="text-[10px] font-mono text-[#3f3f46]">{items.length}</span>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        {items.map((item) => (
          <Link
            key={item.game_id}
            href={item.href}
            className="rounded-xl border border-[#141417] bg-[#0c0c0e] hover:border-[#1e1e24] transition-colors p-4"
          >
            <div className="flex items-start justify-between gap-3 mb-2">
              <div className="min-w-0">
                <p className="text-[13px] font-semibold text-white truncate">{item.matchup}</p>
                <p className="text-[10px] text-[#3f3f46] mt-0.5">{item.sport}</p>
              </div>
              <ChevronRight className="h-4 w-4 text-[#27272a] shrink-0" />
            </div>

            <div className="flex items-center gap-3 text-[10px] mb-2 flex-wrap">
              <span className="text-[#52525b]">{bucketFor(item) === "active" ? "Monitoring" : bucketFor(item) === "quiet" ? "Quiet" : "Completed"}</span>
              <span className="text-[#27272a]">•</span>
              <span className="text-[#00ff7f] font-mono">{item.signals_count} signals</span>
              {item.market_confidence?.ml?.credible && (
                <>
                  <span className="text-[#27272a]">•</span>
                  <span className="text-[#71717a]">ML {item.market_confidence.ml.pct}%</span>
                </>
              )}
              <span className="text-[#27272a]">•</span>
              <span className="text-[#3f3f46] uppercase">{coverageLabel(item)}</span>
            </div>

            <p className="text-[11px] text-[#a1a1aa] leading-relaxed">{item.summary}</p>
            {item.market_confidence?.ml?.credible && (
              <p className="mt-1.5 text-[10px] text-[#71717a] uppercase tracking-wider">{item.market_confidence.ml.lean} · {item.market_confidence.ml.pct}%</p>
            )}
            {!item.market_confidence?.ml?.credible && (
              <p className="mt-1.5 text-[10px] text-[#3f3f46] uppercase tracking-wider">No credible ML edge yet</p>
            )}
          </Link>
        ))}
      </div>
    </section>
  );
}

export default async function TrackedPage() {
  const tracked = await fetchTrackedIntel(12);
  const items = tracked.items || [];
  const active = items.filter((i: any) => bucketFor(i) === "active");
  const quiet = items.filter((i: any) => bucketFor(i) === "quiet");
  const completed = items.filter((i: any) => bucketFor(i) === "completed");

  return (
    <div className="flex-1 overflow-y-auto bg-[#09090b]">
      <div className="max-w-6xl mx-auto px-6 py-6 space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-[20px] font-bold text-white">Tracked</h1>
            <p className="text-[12px] text-[#52525b] mt-1">Monitor active games, quiet spots, and recent completions.</p>
          </div>
          <div className="flex items-center gap-4 text-[11px]">
            <div className="flex items-center gap-1.5 text-[#71717a]"><Activity className="h-3.5 w-3.5 text-[#00ff7f]" /> {active.length} active</div>
            <div className="flex items-center gap-1.5 text-[#71717a]"><Clock3 className="h-3.5 w-3.5 text-[#f59e0b]" /> {quiet.length} quiet</div>
            <div className="flex items-center gap-1.5 text-[#71717a]"><CheckCircle2 className="h-3.5 w-3.5 text-[#3b82f6]" /> {completed.length} completed</div>
          </div>
        </div>

        <Section title="Active games" icon={Activity} items={active} />
        <Section title="Quiet games" icon={Clock3} items={quiet} />
        <Section title="Completed games" icon={CheckCircle2} items={completed} />
      </div>
    </div>
  );
}
