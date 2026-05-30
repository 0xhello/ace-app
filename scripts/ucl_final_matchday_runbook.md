# UCL Final Matchday Runbook — PSG vs Arsenal · Sat May 30

Live runbook with timeline triggers for the investor demo. All steps
hit prod endpoints; nothing needs to run on your laptop. Each command
is either a browser URL (logged in to acebets.io as admin) or a curl
one-liner you can run from any terminal.

## Timeline

| Time (ET) | Event | Action |
|---|---|---|
| Now | Pre-game prep | Publish picks (one-time) |
| T-90 (~10:30 AM) | Confirmed XI window opens | Re-sync lineups, verify Dembélé still starting |
| T-30 (~11:30 AM) | Closing line snap | Worker auto-fires; no action |
| T+0 (12:00 PM) | Kickoff | No action — picks locked at opening price |
| T+45 (~12:45 PM) | Halftime | (Optional) Check live state via ops dashboard |
| T+90+ (~14:00 PM) | Fulltime | Wait ~30 min for Sportmonks events to populate, then manual grade |
| T+120 (~14:30 PM) | Settled | Refresh ops dashboard — W/L for every pick |

---

## Step 1 — Publish the picks (one-time, before game)

If not done already: open acebets.io console and paste the script from
`scripts/ucl_final_picks_publish.md`. Confirms 4 picks land.

```bash
# Verify they're in prod (public endpoint, no auth)
curl -s "https://ace-app-production-71e8.up.railway.app/api/picks/history?limit=20" | python3 -m json.tool | head -40
```

Expected: 4 UCL final picks visible with `model_version=v2_post_m21`,
each with sensible capped stake_units (1.0 / 0.5 / 0.25 / 0.25).

---

## Step 2 — T-90: Confirmed XI verification

Re-syncs the Sportmonks fixture cache so the dashboard reflects
confirmed XI (not just projected). If a key player (Dembélé, Saka) is
benched at the last minute, demote the corresponding pick.

```bash
# Hit the sync-slate endpoint (read-token gated; add your token)
curl -s "https://ace-app-production-71e8.up.railway.app/api/ops/sportmonks/sync-slate?days=1&force=true&ops_token=YOUR_TOKEN"
```

Then in the ops dashboard, open the Sportmonks Fixture panel for UCL
final. Verify:
- `lineups_player_count` = 22 (both teams' XIs confirmed)
- Dembélé and Saka both listed with `is_starter=True`

If either is benched, manually adjust the pick (delete or demote)
before kickoff.

---

## Step 3 — T-30: Closing line snap

**No action.** The worker's `capture_closing_prices` job fires
automatically within the 30-min window of kickoff, snapping the
current best price as `closing_price` for CLV measurement. Verify
later from the Approved Picks panel — each pick should show a
`closing_price` field populated by kickoff time.

---

## Step 4 — T+90+: Fulltime grading

**Wait 20-30 minutes after fulltime** for Sportmonks to write the
events list (goal scorers, minutes) and xGFixture stats. The hourly
worker `sync_slate` will pull these into the cache automatically.

Once events are populated, trigger the manual grade:

```bash
# Hit the grade endpoint (read-token gated)
curl -s "https://ace-app-production-71e8.up.railway.app/api/ops/soccer/grade-approved-picks?ops_token=YOUR_TOKEN"
```

Expected response (success):

```json
{
  "ok": true,
  "graded": 4,
  "skipped_no_result": 0,
  "durationSec": 2,
  "exitCode": 0
}
```

If `graded` is 0, Sportmonks events likely haven't synced yet. Wait
5-10 minutes and re-run. The endpoint is idempotent.

If `graded` is between 1 and 4, the game-level picks (Over 2.5, BTTS)
settled but the Sportmonks events fetch is still empty for the
player-prop picks. Wait and re-run.

---

## Step 5 — Refresh the dashboard

Once `graded` returns 4, refresh the Soccer Ops dashboard. Every pick
in the Approved Picks panel should now show:
- `graded_status`: won / lost / push
- `pnl_units`: signed profit/loss in units
- `closing_price`: snapped at T-30
- `clv_pp`: closing-line value in points

The dashboard's bankroll-curve / summary stats will also update.

---

## Troubleshooting

**"Auto-grading happened automatically — nothing for me to do"**
Means the worker beat you to it (the hourly `sync_slate` followed by
the daily `grade_approved_picks` tick). All good — picks landed
settled without your involvement.

**`graded` keeps returning 0 hours after fulltime**
Sportmonks events include may have failed to populate. Check the
fixture cache directly:

```bash
curl -s "https://ace-app-production-71e8.up.railway.app/api/ops/sportmonks/sync-slate?days=1&force=true&ops_token=YOUR_TOKEN"
```

This forces a re-fetch even if the refresh policy says it's not due.

**One pick still "open" after `graded=4`**
Should not happen — but if it does, the bet_label may not have
extracted the player name cleanly (e.g. unusual punctuation). Check
the rationale_json on the row and grade it manually from the ops
dashboard's Approve Picks panel.

---

## What the investor sees on the dashboard at each timeline point

| Time | Dashboard state |
|---|---|
| Pre-game | 4 picks "open", thesis + edge + capped stake displayed per card |
| Halftime | Same — picks locked at opening, no live changes |
| Fulltime+30 | All 4 picks settled: ✓ won (green) or ✗ lost (red), pnl in units |
| Steady | Bankroll-curve chart shows the day's swing |

**Key narrative beats:**
1. "Here's the 4-pick slate the model surfaced this morning"
2. "Each pick has a thesis, a Sportmonks cross-check, and a leakage-aware capped stake"
3. (Mid-game): "Picks are locked at opening price; we don't adjust mid-match"
4. (Post-fulltime): "Auto-grade just settled them — here's the W/L and pnl"
5. "The model_version filter means new picks compound forward; legacy noise stays out of the displayed record"
