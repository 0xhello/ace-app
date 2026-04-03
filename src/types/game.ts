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

export interface MarketOutcome {
  name: string;
  price: number;
  point?: number;
}

export interface BookOdds {
  sportsbook: BookKey;
  title: string;
  last_update: string;
  markets: {
    h2h?: MarketOutcome[];
    spreads?: MarketOutcome[];
    totals?: MarketOutcome[];
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
  scoreboard?: {
    state?: string;
    away_score?: string | number;
    home_score?: string | number;
    away_probables?: any[];
    home_probables?: any[];
    clock?: string | null;
    period?: number | null;
  };
}
