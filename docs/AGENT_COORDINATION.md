# Agent Coordination — Bob ↔ Claude Code

Purpose: keep Pixl out of the relay loop. Bob handles product direction / sanity checks; Claude Code handles implementation / tests / commits.

## Roles

### Bob
- Translate Pixl's priorities into concrete acceptance criteria.
- Keep launch scope disciplined.
- Call out drift, stale state, confusing UX, or unverified claims.
- Maintain this coordination doc when a priority changes.

### Claude Code
- Implement repo changes.
- Run verification: typecheck, tests, local route checks, screenshots when useful.
- Commit completed work with clear commit messages.
- Update this doc with status, blockers, commit hashes, and decisions needed.

## Communication format

### Bob → Claude Code
Use this shape:

```text
PRIORITY:
ACCEPTANCE CRITERIA:
DO NOT:
VERIFY:
REPORT BACK:
```

### Claude Code → Bob/Pixl
Use this shape:

```text
DONE:
VERIFIED:
COMMIT:
BLOCKED:
NEXT DECISION:
```

Keep updates short. No long implementation logs unless requested.

## Current priority override — 2026-06-03

Pixl is overwhelmed by stale/unclear pick state across Ops and consumer dashboard. Pause new polish/R&D unless it directly fixes this.

### PRIORITY
Audit and clean all pick surfaces before continuing F3/M49/M47.

### ACCEPTANCE CRITERIA
1. Ops pages must not show old/stale bets as active.
2. Demo/fallback/default picks must be removed or clearly labeled as demo/fallback.
3. Empty states must clearly say when there are no active/current picks.
4. Consumer dashboard sport tabs must be verified:
   - Soccer picks only show in Soccer tab and All tab.
   - Soccer picks must not show in MLB/NBA/NFL/NHL/NCAAB tabs.
   - Other sports should not leak into Soccer.
   - All tab should show best/featured picks across sports, not an unfiltered confusing dump.
5. Create/confirm one source-of-truth map:
   - where Ops picks come from
   - where consumer dashboard picks come from
   - which statuses can show publicly
   - active vs graded vs stale vs experimental

### DO NOT
- Do not proceed to F3/M49/M47 until stale pick/display confusion is audited or explicitly waived by Pixl.
- Do not leave fallback picks that look real.
- Do not call a page fixed based only on typecheck if stale data is still visible.

### VERIFY
- `npm run typecheck` or equivalent TypeScript check.
- Local route/page verification for affected Ops and consumer dashboard pages.
- If possible, include screenshots or explicit observed states.

### REPORT BACK
Give Pixl a concise summary:
- surfaces audited
- stale/demo sources found
- fixes made
- remaining ambiguity/blockers
- commit hash
