import { computeAceLean } from "@/lib/ace-leans";
const mk = (book: string, sel: Record<string, number>) => ({
  sportsbook: book, title: book, last_update: "", markets: { h2h: Object.entries(sel).map(([name, price]) => ({ name, price })) },
});
const base: any = {
  id: "g1", sport: "soccer_fifa_world_cup", sport_title: "FIFA World Cup",
  home_team: "Home", away_team: "Away", commence_time: new Date(Date.now() + 86400000).toISOString(),
  status: "upcoming",
  bookmakers: [
    mk("pinnacle", { Home: -150, Draw: 280, Away: 400 }),
    mk("fanduel",  { Home: -155, Draw: 290, Away: 500 }),
    mk("betrivers",{ Home: -150, Draw: 285, Away: 550 }),
    mk("betmgm",   { Home: -160, Draw: 275, Away: 520 }),
  ],
};
const log = (label: string, lean: any) => console.log(label.padEnd(20), lean ? `Tier ${lean.tier} | ${lean.selection} ${lean.price}@${lean.book} gap=${lean.gapPp.toFixed(1)}pp ev=${lean.evidence.map((e:any)=>e.type).join(",")}` : "null (no signal)");
log("systematic only:", computeAceLean(base, {}));
log("+injuries:", computeAceLean(base, { injuries: { home: ["Star GK", "CB Two"], away: [] } }));
log("+movement:", computeAceLean(base, { injuries: { home: ["Star GK"], away: [] }, movement: { ml_away: "down", ml_home: null } as any }));
const weak = { ...base, bookmakers: [mk("pinnacle",{Home:-150,Draw:280,Away:400}), mk("fanduel",{Home:-150,Draw:280,Away:430})] };
log("weak gap:", computeAceLean(weak as any, { injuries: { home: ["X"], away: [] } }));
const noSharp = { ...base, bookmakers: base.bookmakers.slice(1) };
log("no sharp book:", computeAceLean(noSharp as any, {}));
const liveGame = { ...base, status: "live" };
log("live (page gates):", computeAceLean(liveGame as any, {}));
