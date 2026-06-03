import { cn } from "@/lib/utils";
import type { PickTier, TierInfo } from "@/lib/market-tier";

/**
 * TierBadge — the honest "Proven / Experimental / No edge" chip.
 * Single visual source so every surface labels picks identically.
 */
const STYLES: Record<PickTier, string> = {
  proven:       "bg-[#3ee68a]/12 text-[#3ee68a] border-[#3ee68a]/25",
  experimental: "bg-[#f5c062]/12 text-[#f5c062] border-[#f5c062]/25",
  avoid:        "bg-[#6b7068]/12 text-[#9ca39a] border-[#6b7068]/25",
};

export function TierBadge({
  tier,
  className,
  title,
}: {
  tier: TierInfo;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title ?? tier.blurb}
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-[2px] text-[9px] font-bold uppercase tracking-[0.12em] border whitespace-nowrap",
        STYLES[tier.tier],
        className,
      )}
    >
      {tier.tier === "proven" && (
        <span className="h-1 w-1 rounded-full bg-[#3ee68a]" />
      )}
      {tier.label}
    </span>
  );
}

export default TierBadge;
