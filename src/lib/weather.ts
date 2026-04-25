// Open-Meteo weather integration — free, no API key required.
// Only applied to outdoor NFL and MLB games; indoor/dome venues return null.

import { Game } from "@/types/game";

interface StadiumInfo {
  lat: number;
  lng: number;
  outdoor: boolean; // false = dome or full retractable roof
}

// Keyed by franchise keyword that appears in team names from the Odds API
const NFL_STADIUMS: Record<string, StadiumInfo> = {
  "Bills":       { lat: 42.7738,  lng: -78.7870,  outdoor: true  },
  "Patriots":    { lat: 42.0909,  lng: -71.2643,  outdoor: true  },
  "Giants":      { lat: 40.8135,  lng: -74.0745,  outdoor: true  },
  "Jets":        { lat: 40.8135,  lng: -74.0745,  outdoor: true  },
  "Eagles":      { lat: 39.9008,  lng: -75.1675,  outdoor: true  },
  "Commanders":  { lat: 38.9077,  lng: -76.8645,  outdoor: true  },
  "Ravens":      { lat: 39.2780,  lng: -76.6227,  outdoor: true  },
  "Steelers":    { lat: 40.4468,  lng: -80.0158,  outdoor: true  },
  "Browns":      { lat: 41.5061,  lng: -81.6995,  outdoor: true  },
  "Bears":       { lat: 41.8623,  lng: -87.6167,  outdoor: true  },
  "Packers":     { lat: 44.5013,  lng: -88.0622,  outdoor: true  },
  "Bengals":     { lat: 39.0955,  lng: -84.5160,  outdoor: true  },
  "Chiefs":      { lat: 39.0489,  lng: -94.4839,  outdoor: true  },
  "49ers":       { lat: 37.4033,  lng: -121.9694, outdoor: true  },
  "Seahawks":    { lat: 47.5952,  lng: -122.3316, outdoor: true  },
  "Broncos":     { lat: 39.7439,  lng: -105.0201, outdoor: true  },
  "Titans":      { lat: 36.1665,  lng: -86.7713,  outdoor: true  },
  "Panthers":    { lat: 35.2258,  lng: -80.8528,  outdoor: true  },
  "Buccaneers":  { lat: 27.9759,  lng: -82.5033,  outdoor: true  },
  "Jaguars":     { lat: 30.3238,  lng: -81.6373,  outdoor: true  },
  // Dome / retractable — weather irrelevant
  "Colts":       { lat: 39.7601,  lng: -86.1639,  outdoor: false },
  "Lions":       { lat: 42.3400,  lng: -83.0456,  outdoor: false },
  "Vikings":     { lat: 44.9736,  lng: -93.2575,  outdoor: false },
  "Cowboys":     { lat: 32.7473,  lng: -97.0945,  outdoor: false },
  "Texans":      { lat: 29.6847,  lng: -95.4107,  outdoor: false },
  "Cardinals":   { lat: 33.5276,  lng: -112.2626, outdoor: false },
  "Falcons":     { lat: 33.7554,  lng: -84.4009,  outdoor: false },
  "Saints":      { lat: 29.9511,  lng: -90.0812,  outdoor: false },
  "Rams":        { lat: 33.9534,  lng: -118.3392, outdoor: false },
  "Chargers":    { lat: 33.9534,  lng: -118.3392, outdoor: false },
  "Raiders":     { lat: 36.0909,  lng: -115.1833, outdoor: false },
  "Dolphins":    { lat: 25.9580,  lng: -80.2389,  outdoor: false },
};

const MLB_STADIUMS: Record<string, StadiumInfo> = {
  // Outdoor
  "Yankees":     { lat: 40.8296,  lng: -73.9262,  outdoor: true  },
  "Mets":        { lat: 40.7571,  lng: -73.8458,  outdoor: true  },
  "Red Sox":     { lat: 42.3467,  lng: -71.0972,  outdoor: true  },
  "Cubs":        { lat: 41.9484,  lng: -87.6553,  outdoor: true  },
  "White Sox":   { lat: 41.8300,  lng: -87.6339,  outdoor: true  },
  "Cardinals":   { lat: 38.6226,  lng: -90.1928,  outdoor: true  },
  "Pirates":     { lat: 40.4468,  lng: -80.0057,  outdoor: true  },
  "Phillies":    { lat: 39.9057,  lng: -75.1665,  outdoor: true  },
  "Nationals":   { lat: 38.8730,  lng: -77.0074,  outdoor: true  },
  "Giants":      { lat: 37.7786,  lng: -122.3893, outdoor: true  },
  "Dodgers":     { lat: 34.0739,  lng: -118.2400, outdoor: true  },
  "Angels":      { lat: 33.8003,  lng: -117.8827, outdoor: true  },
  "Athletics":   { lat: 37.7516,  lng: -122.2005, outdoor: true  },
  "Rangers":     { lat: 32.7512,  lng: -97.0832,  outdoor: true  },
  "Rockies":     { lat: 39.7559,  lng: -104.9942, outdoor: true  },
  "Padres":      { lat: 32.7076,  lng: -117.1570, outdoor: true  },
  "Royals":      { lat: 39.0517,  lng: -94.4803,  outdoor: true  },
  "Tigers":      { lat: 42.3390,  lng: -83.0485,  outdoor: true  },
  "Indians":     { lat: 41.4960,  lng: -81.6852,  outdoor: true  },
  "Guardians":   { lat: 41.4960,  lng: -81.6852,  outdoor: true  },
  "Orioles":     { lat: 39.2839,  lng: -76.6218,  outdoor: true  },
  "Twins":       { lat: 44.9817,  lng: -93.2781,  outdoor: true  },
  // Retractable / dome
  "Astros":      { lat: 29.7573,  lng: -95.3555,  outdoor: false },
  "Rays":        { lat: 27.7683,  lng: -82.6534,  outdoor: false },
  "Blue Jays":   { lat: 43.6414,  lng: -79.3894,  outdoor: false },
  "Diamondbacks":{ lat: 33.4453,  lng: -112.0667, outdoor: false },
  "Brewers":     { lat: 43.0280,  lng: -87.9712,  outdoor: false },
  "Marlins":     { lat: 25.7781,  lng: -80.2197,  outdoor: false },
};

// ── Open-Meteo fetch ────────────────────────────────────────────────────────

export interface WeatherData {
  wind_mph: number;
  precip_prob: number;     // percentage 0-100
  temp_f: number;
  impact: "none" | "low" | "moderate" | "high";
  detail: string;          // human-readable summary
  // Betting modifiers (applied to confidence score)
  total_modifier: number;  // negative = under pressure, positive = over pressure
  ml_modifier: number;     // small modifier for game tightness
}

async function fetchOpenMeteo(lat: number, lng: number, gameTimeIso: string): Promise<WeatherData | null> {
  try {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", lat.toString());
    url.searchParams.set("longitude", lng.toString());
    url.searchParams.set("hourly", "wind_speed_10m,precipitation_probability,temperature_2m");
    url.searchParams.set("wind_speed_unit", "mph");
    url.searchParams.set("temperature_unit", "fahrenheit");
    url.searchParams.set("forecast_days", "3");
    url.searchParams.set("timezone", "auto");

    const res = await fetch(url.toString(), {
      cache: "no-store",
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) return null;
    const data = await res.json();

    // Find the hourly slot closest to game time
    const gameMs = new Date(gameTimeIso).getTime();
    const times: string[] = data.hourly?.time ?? [];
    let closest = 0;
    let minDiff = Infinity;
    for (let i = 0; i < times.length; i++) {
      const diff = Math.abs(new Date(times[i]).getTime() - gameMs);
      if (diff < minDiff) { minDiff = diff; closest = i; }
    }

    const wind_mph: number = data.hourly.wind_speed_10m[closest] ?? 0;
    const precip_prob: number = data.hourly.precipitation_probability[closest] ?? 0;
    const temp_f: number = data.hourly.temperature_2m[closest] ?? 65;

    // Compute impact level
    let impact: WeatherData["impact"] = "none";
    let total_modifier = 0;
    let ml_modifier = 0;

    if (wind_mph >= 30) {
      impact = "high";
      total_modifier = -8;
      ml_modifier = -3;
    } else if (wind_mph >= 20) {
      impact = "moderate";
      total_modifier = -5;
      ml_modifier = -2;
    } else if (wind_mph >= 15) {
      impact = "low";
      total_modifier = -2;
    }

    if (precip_prob >= 70) {
      total_modifier -= 3;
      if (impact === "none") impact = "low";
    } else if (precip_prob >= 50) {
      total_modifier -= 1;
    }

    if (temp_f <= 32) {
      total_modifier -= 2;
      if (impact === "none") impact = "low";
    }

    // Build detail string
    const parts: string[] = [];
    if (wind_mph >= 15) parts.push(`${wind_mph.toFixed(0)} mph wind`);
    if (precip_prob >= 50) parts.push(`${precip_prob}% precip`);
    parts.push(`${temp_f.toFixed(0)}°F`);
    const detail = parts.join(" · ");

    return { wind_mph, precip_prob, temp_f, impact, detail, total_modifier, ml_modifier };
  } catch {
    return null;
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

function findStadium(teamName: string, sport: string): StadiumInfo | null {
  const map = sport.includes("football") ? NFL_STADIUMS : MLB_STADIUMS;
  for (const [key, info] of Object.entries(map)) {
    if (teamName.includes(key)) return info;
  }
  return null;
}

export async function fetchWeatherForGame(game: Game): Promise<WeatherData | null> {
  // Only NFL and MLB — basketball and hockey are always indoors
  if (!game.sport.includes("football") && !game.sport.includes("baseball")) return null;

  // Use home team to find the stadium
  const stadium = findStadium(game.home_team, game.sport);
  if (!stadium || !stadium.outdoor) return null;

  return fetchOpenMeteo(stadium.lat, stadium.lng, game.commence_time);
}

export async function fetchWeatherForGames(games: Game[]): Promise<Map<string, WeatherData>> {
  const result = new Map<string, WeatherData>();
  const outdoor = games.filter(
    (g) => (g.sport.includes("football") || g.sport.includes("baseball")) && g.status !== "final"
  );

  await Promise.all(
    outdoor.map(async (g) => {
      const w = await fetchWeatherForGame(g);
      if (w) result.set(g.id, w);
    })
  );

  return result;
}
