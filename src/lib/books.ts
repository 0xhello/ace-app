export const BOOK_META: Record<string, { short: string; color: string; name: string; domain: string }> = {
  fanduel:        { short: "FD",   color: "#1493FF", name: "FanDuel",      domain: "fanduel.com" },
  draftkings:     { short: "DK",   color: "#53D337", name: "DraftKings",   domain: "draftkings.com" },
  betmgm:         { short: "MGM",  color: "#C4A962", name: "BetMGM",       domain: "betmgm.com" },
  caesars:        { short: "CZR",  color: "#7B5E35", name: "Caesars",      domain: "caesars.com" },
  pointsbet:      { short: "PB",   color: "#ED1C24", name: "PointsBet",    domain: "pointsbet.com" },
  bet365:         { short: "365",  color: "#027B5B", name: "Bet365",       domain: "bet365.com" },
  bovada:         { short: "BOV",  color: "#E87722", name: "Bovada",       domain: "bovada.lv" },
  mybookieag:     { short: "MB",   color: "#8B5CF6", name: "MyBookie",     domain: "mybookie.ag" },
  williamhill_us: { short: "WH",   color: "#00205B", name: "William Hill", domain: "williamhill.com" },
  betonlineag:    { short: "BOL",  color: "#E63946", name: "BetOnline",    domain: "betonline.ag" },
  espnbet:        { short: "ESPN", color: "#D00027", name: "ESPN Bet",     domain: "espnbet.com" },
  hardrockbet:    { short: "HR",   color: "#D4AF37", name: "Hard Rock",    domain: "hardrockbet.com" },
  unibet_us:      { short: "UB",   color: "#007B5E", name: "Unibet",       domain: "unibet.com" },
  barstool:       { short: "BS",   color: "#FF6900", name: "Barstool",     domain: "barstoolsports.com" },
};

export function bookMeta(key: string) {
  return BOOK_META[key] ?? { short: key.slice(0, 3).toUpperCase(), color: "#52525b", name: key, domain: "" };
}

export function bookLogoUrl(key: string): string {
  const domain = BOOK_META[key]?.domain;
  if (!domain) return "";
  return `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
}
