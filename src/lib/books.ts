export const BOOK_META: Record<string, { short: string; color: string; name: string }> = {
  fanduel:       { short: "FD",   color: "#1493FF", name: "FanDuel" },
  draftkings:    { short: "DK",   color: "#53D337", name: "DraftKings" },
  betmgm:        { short: "MGM",  color: "#C4A962", name: "BetMGM" },
  caesars:       { short: "CZR",  color: "#7B5E35", name: "Caesars" },
  pointsbet:     { short: "PB",   color: "#ED1C24", name: "PointsBet" },
  bet365:        { short: "365",  color: "#027B5B", name: "Bet365" },
  bovada:        { short: "BOV",  color: "#E87722", name: "Bovada" },
  mybookieag:    { short: "MB",   color: "#8B5CF6", name: "MyBookie" },
  williamhill_us:{ short: "WH",   color: "#00205B", name: "William Hill" },
  betonlineag:   { short: "BOL",  color: "#E63946", name: "BetOnline" },
  espnbet:       { short: "ESPN", color: "#D00027", name: "ESPN Bet" },
  hardrockbet:   { short: "HR",   color: "#D4AF37", name: "Hard Rock" },
  unibet_us:     { short: "UB",   color: "#007B5E", name: "Unibet" },
  barstool:      { short: "BS",   color: "#FF6900", name: "Barstool" },
};

export function bookMeta(key: string) {
  return BOOK_META[key] ?? { short: key.slice(0, 3).toUpperCase(), color: "#52525b", name: key };
}
