/**
 * Team logo URL helper.
 * Uses ESPN CDN dark logos which work well on our dark background.
 * Falls back gracefully if sport/team not mapped.
 */

const SPORT_TO_LEAGUE: Record<string, string> = {
  "basketball_nba": "nba",
  "americanfootball_nfl": "nfl",
  "baseball_mlb": "mlb",
  "icehockey_nhl": "nhl",
  "basketball_ncaab": "ncaa",
  "americanfootball_ncaaf": "ncaa",
  // Display name variants
  "NBA": "nba",
  "NFL": "nfl",
  "MLB": "mlb",
  "NHL": "nhl",
  "NCAAB": "ncaa",
  "NCAAF": "ncaa",
};

// Map ACE team display names → ESPN abbreviations (lowercase)
// This mirrors the backend mappings.py but only the abbreviations needed for logo URLs
const TEAM_ABBR: Record<string, string> = {
  // NBA
  "Atlanta Hawks": "atl", "Boston Celtics": "bos", "Brooklyn Nets": "bkn", "Charlotte Hornets": "cha",
  "Chicago Bulls": "chi", "Cleveland Cavaliers": "cle", "Dallas Mavericks": "dal", "Denver Nuggets": "den",
  "Detroit Pistons": "det", "Golden State Warriors": "gs", "Houston Rockets": "hou", "Indiana Pacers": "ind",
  "LA Clippers": "lac", "Los Angeles Lakers": "lal", "Memphis Grizzlies": "mem", "Miami Heat": "mia",
  "Milwaukee Bucks": "mil", "Minnesota Timberwolves": "min", "New Orleans Pelicans": "no",
  "New York Knicks": "ny", "Oklahoma City Thunder": "okc", "Orlando Magic": "orl",
  "Philadelphia 76ers": "phi", "Phoenix Suns": "phx", "Portland Trail Blazers": "por",
  "Sacramento Kings": "sac", "San Antonio Spurs": "sa", "Toronto Raptors": "tor",
  "Utah Jazz": "utah", "Washington Wizards": "wsh",
  // NFL
  "Arizona Cardinals": "ari", "Atlanta Falcons": "atl", "Baltimore Ravens": "bal", "Buffalo Bills": "buf",
  "Carolina Panthers": "car", "Chicago Bears": "chi", "Cincinnati Bengals": "cin", "Cleveland Browns": "cle",
  "Dallas Cowboys": "dal", "Denver Broncos": "den", "Detroit Lions": "det", "Green Bay Packers": "gb",
  "Houston Texans": "hou", "Indianapolis Colts": "ind", "Jacksonville Jaguars": "jax",
  "Kansas City Chiefs": "kc", "Las Vegas Raiders": "lv", "Los Angeles Chargers": "lac",
  "Los Angeles Rams": "lar", "Miami Dolphins": "mia", "Minnesota Vikings": "min",
  "New England Patriots": "ne", "New Orleans Saints": "no", "New York Giants": "nyg",
  "New York Jets": "nyj", "Philadelphia Eagles": "phi", "Pittsburgh Steelers": "pit",
  "San Francisco 49ers": "sf", "Seattle Seahawks": "sea", "Tampa Bay Buccaneers": "tb",
  "Tennessee Titans": "ten", "Washington Commanders": "wsh",
  // MLB
  "Arizona Diamondbacks": "ari", "Athletics": "ath", "Atlanta Braves": "atl", "Baltimore Orioles": "bal",
  "Boston Red Sox": "bos", "Chicago Cubs": "chc", "Chicago White Sox": "chw", "Cincinnati Reds": "cin",
  "Cleveland Guardians": "cle", "Colorado Rockies": "col", "Detroit Tigers": "det", "Houston Astros": "hou",
  "Kansas City Royals": "kc", "Los Angeles Angels": "laa", "Los Angeles Dodgers": "lad",
  "Miami Marlins": "mia", "Milwaukee Brewers": "mil", "Minnesota Twins": "min",
  "New York Mets": "nym", "New York Yankees": "nyy", "Philadelphia Phillies": "phi",
  "Pittsburgh Pirates": "pit", "San Diego Padres": "sd", "San Francisco Giants": "sf",
  "Seattle Mariners": "sea", "St. Louis Cardinals": "stl", "Tampa Bay Rays": "tb",
  "Texas Rangers": "tex", "Toronto Blue Jays": "tor", "Washington Nationals": "wsh",
  // NHL
  "Anaheim Ducks": "ana", "Boston Bruins": "bos", "Buffalo Sabres": "buf", "Calgary Flames": "cgy",
  "Carolina Hurricanes": "car", "Chicago Blackhawks": "chi", "Colorado Avalanche": "col",
  "Columbus Blue Jackets": "cbj", "Dallas Stars": "dal", "Detroit Red Wings": "det",
  "Edmonton Oilers": "edm", "Florida Panthers": "fla", "Los Angeles Kings": "la",
  "Minnesota Wild": "min", "Montreal Canadiens": "mtl", "Nashville Predators": "nsh",
  "New Jersey Devils": "nj", "New York Islanders": "nyi", "New York Rangers": "nyr",
  "Ottawa Senators": "ott", "Philadelphia Flyers": "phi", "Pittsburgh Penguins": "pit",
  "San Jose Sharks": "sj", "Seattle Kraken": "sea", "St. Louis Blues": "stl",
  "Tampa Bay Lightning": "tb", "Toronto Maple Leafs": "tor", "Utah Mammoth": "utah",
  "Vancouver Canucks": "van", "Vegas Golden Knights": "vgk", "Washington Capitals": "wsh",
  "Winnipeg Jets": "wpg",
};

export function getTeamLogoUrl(teamName: string, sportKey: string): string | null {
  const league = SPORT_TO_LEAGUE[sportKey];
  const abbr = TEAM_ABBR[teamName];
  if (!league || !abbr) return null;
  return `https://a.espncdn.com/i/teamlogos/${league}/500-dark/${abbr}.png`;
}
