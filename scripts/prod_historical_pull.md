# Prod historical pull — runbook

One-time job: populate `wc_historical_form` on prod with the cleaned StatsBomb data
(shootouts filtered, full-match country detection, name dedupe). Local DB already has
this; prod is empty until this is run.

No Odds API or API-Football credits are burned — pulls from
[github.com/statsbomb/open-data](https://github.com/statsbomb/open-data).

## How to run

You must be logged in to acebets.io as **admin**. Open the browser dev tools console on
any acebets.io page (so your admin session cookie is attached) and paste:

```js
const steps = ["wc2018", "wc2022", "euro2020", "euro2024", "dedupe", "status"];
for (const step of steps) {
  console.log(`\n========== ${step} ==========`);
  const t0 = Date.now();
  const res = await fetch("/api/ops/historical-pull", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ step }),
  });
  const out = await res.json();
  const wall = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`ok=${out.ok}  duration=${out.durationSec}s  wall=${wall}s  exit=${out.exitCode}`);
  if (out.output) console.log(out.output);
  if (!out.ok) { console.warn("STOPPED at step:", step); break; }
}
console.log("\n========== DONE ==========");
```

Expected runtime: ~12-15 minutes total. Each step prints its output as it finishes.

## What success looks like

After the `status` step, you should see something like:

```
Tournament         Players  Goals  Minutes
----------------  --------  -----  -------
Euro 2020              612    131   107767
Euro 2024              621    107   107618
WC 2018                737    157   134056
WC 2022                829    169   134904
```

Plus the top historical scorers (Ronaldo, Kane, Mbappe, Messi, etc).

## If something fails mid-pull

Each tournament step is idempotent (upserts by `(player_name, competition)`). Just
re-run the failed step alone:

```js
await fetch("/api/ops/historical-pull", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ step: "wc2022" }),  // or whichever step failed
}).then(r => r.json()).then(console.log);
```
