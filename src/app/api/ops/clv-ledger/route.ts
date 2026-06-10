/**
 * /api/ops/clv-ledger — the Sharp Lens receipts.
 *
 *   GET  → summary + flags (open and graded, newest first)
 *   POST → run a ledger tick off the cached board (record new flags, refresh
 *          sharp fair, grade past-kickoff flags). The scheduler runs this
 *          automatically every 10 minutes; POST is the manual/ops trigger.
 *
 * Read-token gated through middleware. No Odds API spend — reads the board cache.
 */
import { NextResponse } from "next/server";
import { clvLedgerRead, clvLedgerTickFromCache } from "@/lib/clv-ledger";

export const dynamic = "force-dynamic";

export async function GET() {
  const { summary, flags } = await clvLedgerRead();
  return NextResponse.json({ ok: true, summary, flags: flags.slice(0, 200) });
}

export async function POST() {
  const result = await clvLedgerTickFromCache();
  const { summary } = await clvLedgerRead();
  return NextResponse.json({ ok: true, tick: result, summary });
}
