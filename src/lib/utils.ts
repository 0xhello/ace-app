import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function americanToDecimal(american: number): number {
  if (american > 0) return parseFloat((american / 100 + 1).toFixed(2));
  return parseFloat((100 / Math.abs(american) + 1).toFixed(2));
}

export function formatAmericanOdds(american: number): string {
  return american > 0 ? `+${american}` : `${american}`;
}

export function oddsColor(american: number): string {
  if (american > 0) return "text-ace-green";
  return "text-ace-muted";
}

export function timeUntilGame(commenceTime: string): string {
  const now = new Date();
  const game = new Date(commenceTime);
  const diff = game.getTime() - now.getTime();
  if (diff < 0) return "Live";
  const hours = Math.floor(diff / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  if (hours > 24) return game.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export function teamAbbr(name: string): string {
  return name.split(" ").map((w) => w[0]).join("").slice(0, 3).toUpperCase();
}
