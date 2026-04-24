type SportSlug = "nba" | "nfl" | "mlb" | "nhl" | "default";

const BOOK_URLS: Record<string, Partial<Record<SportSlug, string>>> = {
  fanduel: {
    default: "https://sportsbook.fanduel.com",
    nba: "https://sportsbook.fanduel.com/navigation/sport?sport=Basketball",
    nfl: "https://sportsbook.fanduel.com/navigation/sport?sport=American+Football",
    mlb: "https://sportsbook.fanduel.com/navigation/sport?sport=Baseball",
    nhl: "https://sportsbook.fanduel.com/navigation/sport?sport=Ice+Hockey",
  },
  draftkings: {
    default: "https://sportsbook.draftkings.com",
    nba: "https://sportsbook.draftkings.com/leagues/basketball/nba",
    nfl: "https://sportsbook.draftkings.com/leagues/football/nfl",
    mlb: "https://sportsbook.draftkings.com/leagues/baseball/mlb",
    nhl: "https://sportsbook.draftkings.com/leagues/hockey/nhl",
  },
  betmgm: {
    default: "https://sports.betmgm.com/en/sports",
    nba: "https://sports.betmgm.com/en/sports/basketball-6",
    nfl: "https://sports.betmgm.com/en/sports/football-11",
    mlb: "https://sports.betmgm.com/en/sports/baseball-23",
    nhl: "https://sports.betmgm.com/en/sports/hockey-12",
  },
  caesars:        { default: "https://sportsbook.caesars.com/us/nj/bet" },
  pointsbet:      { default: "https://pointsbet.com/sports" },
  bet365:         { default: "https://www.bet365.com" },
  espnbet: {
    default: "https://espnbet.com",
    nba: "https://espnbet.com/sport/basketball/organization/usa/competition/nba",
    nfl: "https://espnbet.com/sport/american-football/organization/usa/competition/nfl",
  },
  hardrockbet:    { default: "https://hardrockbet.com" },
  bovada:         { default: "https://www.bovada.lv/sports" },
  unibet_us:      { default: "https://www.unibet.com/betting" },
  mybookieag:     { default: "https://mybookie.ag/sportsbook" },
  betonlineag:    { default: "https://www.betonline.ag/sportsbook" },
  williamhill_us: { default: "https://www.williamhill.com/us/nj/bet" },
  barstool:       { default: "https://barstoolsports.com/sportsbook" },
};

function sportSlug(sportTitle: string): SportSlug {
  const t = sportTitle.toLowerCase();
  if (t.includes("basketball")) return "nba";
  if (t.includes("football")) return "nfl";
  if (t.includes("baseball")) return "mlb";
  if (t.includes("hockey")) return "nhl";
  return "default";
}

export function bookDeepLink(bookKey: string, sportTitle: string): string {
  const book = BOOK_URLS[bookKey];
  if (!book) return "";
  const slug = sportSlug(sportTitle);
  return book[slug] ?? book.default ?? "";
}
