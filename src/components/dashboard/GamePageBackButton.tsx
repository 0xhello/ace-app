"use client";

import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";

export default function GamePageBackButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => {
        if (typeof window !== "undefined" && window.history.length > 1) router.back();
        else router.push("/dashboard");
      }}
      onMouseEnter={() => router.prefetch("/dashboard")}
      className="inline-flex items-center gap-1.5 text-[11px] text-[#6b7068] hover:text-[#c4c7c0] transition-colors mb-4"
    >
      <ArrowLeft className="h-3.5 w-3.5" /> Board
    </button>
  );
}
