export type Sport = "NBA" | "NFL" | "MLB" | "NHL" | "NCAAB" | "NCAAF";

export type BookKey =
  | "fanduel"
  | "draftkings"
  | "betmgm"
  | "caesars"
  | "pointsbet"
  | "bet365"
  | "bovada"
  | "mybookieag";

export interface BookOdds {
  sportsbook: BookKey;
  title: string;
  last_update: string;
  markets: {
    h2h?: { name: string; price: number }[];
    spreads?: { name: string; price: number; point: number }[];
    totals?: { name: string; price: number; point: number }[];
  };
}

export interface Game {
  id: string;
  sport: string;
  sport_title: string;
  home_team: string;
  away_team: string;
  commence_time: string;
  status: "live" | "upcoming" | "final";
  best_moneyline: Record<string, number>;
  bookmakers: BookOdds[];
  num_books: number;
  fetched_at: string;
}
