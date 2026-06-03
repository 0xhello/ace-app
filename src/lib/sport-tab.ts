/**
 * Canonical sport-tab routing.
 *
 * The dashboard tabs are ALL / SOCCER / NBA / NFL / MLB / NHL / NCAAB. A game's
 * `sport` field is the Odds-API sport_key (e.g. "soccer_fifa_world_cup",
 * "baseball_mlb") — the RELIABLE routing key. The display `sport_title`
 * ("FIFA World Cup") is NOT reliable for routing: naive substring matching
 * meant World Cup games never matched "SOCCER" and silently vanished from the
 * Soccer tab. Always route on `sport` (sport_key); fall back to title only when
 * the key is missing.
 */
export type SportTab = "SOCCER" | "NBA" | "NFL" | "MLB" | "NHL" | "NCAAB";

const SOCCER_TITLE = /SOCCER|FIFA|WORLD CUP|PREMIER LEAGUE|LA ?LIGA|BUNDESLIGA|SERIE A|LIGUE 1|CHAMPIONS LEAGUE|EUROPA|UEFA|EPL|MLS|EREDIVISIE|PRIMEIRA/;

export function sportTab(
  sportKey: string | null | undefined,
  sportTitle?: string | null,
): SportTab | null {
  const k = (sportKey ?? "").toLowerCase();
  if (k.startsWith("soccer")) return "SOCCER";
  if (k.includes("ncaab") || k.includes("basketball_ncaa")) return "NCAAB";
  if (k.includes("basketball")) return "NBA";
  if (k.includes("americanfootball_ncaaf")) return null; // college football has no tab
  if (k.includes("americanfootball")) return "NFL";
  if (k.includes("baseball")) return "MLB";
  if (k.includes("icehockey")) return "NHL";

  // Fallback: derive from the display title only when no sport_key exists.
  const t = (sportTitle ?? "").toUpperCase();
  if (SOCCER_TITLE.test(t)) return "SOCCER";
  if (t.includes("NCAAB")) return "NCAAB";
  if (t.includes("NBA")) return "NBA";
  if (t.includes("NFL")) return "NFL";
  if (t.includes("MLB")) return "MLB";
  if (t.includes("NHL")) return "NHL";
  return null;
}
