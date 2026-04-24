import { BookKey, BookOdds, Game, MarketOutcome } from "@/types/game";

function makeBook(
  sportsbook: BookKey,
  title: string,
  h2h: MarketOutcome[],
  spreads: MarketOutcome[],
  totals: MarketOutcome[]
): BookOdds {
  return {
    sportsbook,
    title,
    last_update: new Date().toISOString(),
    markets: { h2h, spreads, totals },
  };
}

function makeGame({
  id,
  sport,
  sportTitle,
  away,
  home,
  status,
  commenceOffsetHours,
  bookmakers,
  scoreboard,
}: {
  id: string;
  sport: string;
  sportTitle: string;
  away: string;
  home: string;
  status: "live" | "upcoming" | "final";
  commenceOffsetHours: number;
  bookmakers: BookOdds[];
  scoreboard?: Game["scoreboard"];
}): Game {
  const bestAway = Math.max(...bookmakers.flatMap((b) => (b.markets.h2h || []).filter((o) => o.name === away).map((o) => o.price)));
  const bestHome = Math.max(...bookmakers.flatMap((b) => (b.markets.h2h || []).filter((o) => o.name === home).map((o) => o.price)));

  return {
    id,
    sport,
    sport_title: sportTitle,
    away_team: away,
    home_team: home,
    commence_time: new Date(Date.now() + commenceOffsetHours * 60 * 60 * 1000).toISOString(),
    status,
    best_moneyline: { away: bestAway, home: bestHome },
    bookmakers,
    num_books: bookmakers.length,
    fetched_at: new Date().toISOString(),
    scoreboard,
  };
}

export function getMockGames(): Game[] {
  return [
    makeGame({
      id: "okc-lal-demo",
      sport: "basketball_nba",
      sportTitle: "NBA",
      away: "Oklahoma City Thunder",
      home: "Los Angeles Lakers",
      status: "live",
      commenceOffsetHours: -2,
      scoreboard: {
        state: "in",
        away_score: 58,
        home_score: 51,
        clock: "8:32",
        period: 2,
      },
      bookmakers: [
        makeBook(
          "draftkings",
          "DraftKings",
          [
            { name: "Oklahoma City Thunder", price: -218 },
            { name: "Los Angeles Lakers", price: +182 },
          ],
          [
            { name: "Oklahoma City Thunder", price: -110, point: -6.5 },
            { name: "Los Angeles Lakers", price: -110, point: 6.5 },
          ],
          [
            { name: "Over", price: -108, point: 224 },
            { name: "Under", price: -112, point: 224 },
          ]
        ),
        makeBook(
          "fanduel",
          "FanDuel",
          [
            { name: "Oklahoma City Thunder", price: -215 },
            { name: "Los Angeles Lakers", price: +178 },
          ],
          [
            { name: "Oklahoma City Thunder", price: -105, point: -6.5 },
            { name: "Los Angeles Lakers", price: -115, point: 6.5 },
          ],
          [
            { name: "Over", price: -106, point: 224.5 },
            { name: "Under", price: -114, point: 224.5 },
          ]
        ),
        makeBook(
          "betmgm",
          "BetMGM",
          [
            { name: "Oklahoma City Thunder", price: -220 },
            { name: "Los Angeles Lakers", price: +185 },
          ],
          [
            { name: "Oklahoma City Thunder", price: -112, point: -7 },
            { name: "Los Angeles Lakers", price: -108, point: 7 },
          ],
          [
            { name: "Over", price: -110, point: 223.5 },
            { name: "Under", price: -110, point: 223.5 },
          ]
        ),
      ],
    }),
    makeGame({
      id: "bos-mia-demo",
      sport: "basketball_nba",
      sportTitle: "NBA",
      away: "Boston Celtics",
      home: "Miami Heat",
      status: "upcoming",
      commenceOffsetHours: 3,
      bookmakers: [
        makeBook(
          "fanduel",
          "FanDuel",
          [
            { name: "Boston Celtics", price: -138 },
            { name: "Miami Heat", price: +118 },
          ],
          [
            { name: "Boston Celtics", price: -110, point: -3.5 },
            { name: "Miami Heat", price: -110, point: 3.5 },
          ],
          [
            { name: "Over", price: -108, point: 218.5 },
            { name: "Under", price: -112, point: 218.5 },
          ]
        ),
        makeBook(
          "draftkings",
          "DraftKings",
          [
            { name: "Boston Celtics", price: -140 },
            { name: "Miami Heat", price: +120 },
          ],
          [
            { name: "Boston Celtics", price: -105, point: -4 },
            { name: "Miami Heat", price: -115, point: 4 },
          ],
          [
            { name: "Over", price: -110, point: 219 },
            { name: "Under", price: -110, point: 219 },
          ]
        ),
        makeBook(
          "bet365",
          "bet365",
          [
            { name: "Boston Celtics", price: -135 },
            { name: "Miami Heat", price: +115 },
          ],
          [
            { name: "Boston Celtics", price: -108, point: -3.5 },
            { name: "Miami Heat", price: -112, point: 3.5 },
          ],
          [
            { name: "Over", price: -105, point: 218 },
            { name: "Under", price: -115, point: 218 },
          ]
        ),
      ],
    }),
    makeGame({
      id: "kc-buf-demo",
      sport: "americanfootball_nfl",
      sportTitle: "NFL",
      away: "Kansas City Chiefs",
      home: "Buffalo Bills",
      status: "upcoming",
      commenceOffsetHours: 7,
      bookmakers: [
        makeBook(
          "draftkings",
          "DraftKings",
          [
            { name: "Kansas City Chiefs", price: +126 },
            { name: "Buffalo Bills", price: -148 },
          ],
          [
            { name: "Kansas City Chiefs", price: -110, point: 3 },
            { name: "Buffalo Bills", price: -110, point: -3 },
          ],
          [
            { name: "Over", price: -110, point: 47.5 },
            { name: "Under", price: -110, point: 47.5 },
          ]
        ),
        makeBook(
          "fanduel",
          "FanDuel",
          [
            { name: "Kansas City Chiefs", price: +124 },
            { name: "Buffalo Bills", price: -146 },
          ],
          [
            { name: "Kansas City Chiefs", price: -105, point: 3.5 },
            { name: "Buffalo Bills", price: -115, point: -3.5 },
          ],
          [
            { name: "Over", price: -108, point: 48 },
            { name: "Under", price: -112, point: 48 },
          ]
        ),
        makeBook(
          "caesars",
          "Caesars",
          [
            { name: "Kansas City Chiefs", price: +130 },
            { name: "Buffalo Bills", price: -150 },
          ],
          [
            { name: "Kansas City Chiefs", price: -110, point: 3 },
            { name: "Buffalo Bills", price: -110, point: -3 },
          ],
          [
            { name: "Over", price: -105, point: 47.5 },
            { name: "Under", price: -115, point: 47.5 },
          ]
        ),
      ],
    }),
    makeGame({
      id: "lad-sd-demo",
      sport: "baseball_mlb",
      sportTitle: "MLB",
      away: "Los Angeles Dodgers",
      home: "San Diego Padres",
      status: "upcoming",
      commenceOffsetHours: 1,
      bookmakers: [
        makeBook(
          "betmgm",
          "BetMGM",
          [
            { name: "Los Angeles Dodgers", price: -155 },
            { name: "San Diego Padres", price: +132 },
          ],
          [
            { name: "Los Angeles Dodgers", price: +145, point: -1.5 },
            { name: "San Diego Padres", price: -165, point: 1.5 },
          ],
          [
            { name: "Over", price: -108, point: 8.5 },
            { name: "Under", price: -112, point: 8.5 },
          ]
        ),
        makeBook(
          "fanduel",
          "FanDuel",
          [
            { name: "Los Angeles Dodgers", price: -150 },
            { name: "San Diego Padres", price: +126 },
          ],
          [
            { name: "Los Angeles Dodgers", price: +148, point: -1.5 },
            { name: "San Diego Padres", price: -170, point: 1.5 },
          ],
          [
            { name: "Over", price: -105, point: 9 },
            { name: "Under", price: -115, point: 9 },
          ]
        ),
        makeBook(
          "draftkings",
          "DraftKings",
          [
            { name: "Los Angeles Dodgers", price: -158 },
            { name: "San Diego Padres", price: +134 },
          ],
          [
            { name: "Los Angeles Dodgers", price: +142, point: -1.5 },
            { name: "San Diego Padres", price: -162, point: 1.5 },
          ],
          [
            { name: "Over", price: -110, point: 8.5 },
            { name: "Under", price: -110, point: 8.5 },
          ]
        ),
      ],
    }),
    makeGame({
      id: "nyr-tor-demo",
      sport: "icehockey_nhl",
      sportTitle: "NHL",
      away: "New York Rangers",
      home: "Toronto Maple Leafs",
      status: "live",
      commenceOffsetHours: -1,
      scoreboard: {
        state: "in",
        away_score: 2,
        home_score: 3,
        clock: "11:14",
        period: 3,
      },
      bookmakers: [
        makeBook(
          "bet365",
          "bet365",
          [
            { name: "New York Rangers", price: +118 },
            { name: "Toronto Maple Leafs", price: -138 },
          ],
          [
            { name: "New York Rangers", price: -110, point: 1.5 },
            { name: "Toronto Maple Leafs", price: -110, point: -1.5 },
          ],
          [
            { name: "Over", price: -105, point: 6.5 },
            { name: "Under", price: -115, point: 6.5 },
          ]
        ),
        makeBook(
          "draftkings",
          "DraftKings",
          [
            { name: "New York Rangers", price: +120 },
            { name: "Toronto Maple Leafs", price: -140 },
          ],
          [
            { name: "New York Rangers", price: -108, point: 1.5 },
            { name: "Toronto Maple Leafs", price: -112, point: -1.5 },
          ],
          [
            { name: "Over", price: -108, point: 6 },
            { name: "Under", price: -112, point: 6 },
          ]
        ),
        makeBook(
          "fanduel",
          "FanDuel",
          [
            { name: "New York Rangers", price: +115 },
            { name: "Toronto Maple Leafs", price: -135 },
          ],
          [
            { name: "New York Rangers", price: -105, point: 1.5 },
            { name: "Toronto Maple Leafs", price: -115, point: -1.5 },
          ],
          [
            { name: "Over", price: -110, point: 6.5 },
            { name: "Under", price: -110, point: 6.5 },
          ]
        ),
      ],
    }),
  ];
}
