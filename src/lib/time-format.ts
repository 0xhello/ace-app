const ET_TIME_ZONE = "America/New_York";

export function formatEtTime(iso: string | Date, options: Intl.DateTimeFormatOptions = {}): string {
  const date = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(date.getTime())) return "TBD";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: ET_TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    ...options,
  }).format(date);
}

export function formatEtDate(iso: string | Date, options: Intl.DateTimeFormatOptions = {}): string {
  const date = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(date.getTime())) return "TBD";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: ET_TIME_ZONE,
    month: "short",
    day: "numeric",
    ...options,
  }).format(date);
}

export function formatEtDateTime(iso: string | Date, options: Intl.DateTimeFormatOptions = {}): string {
  const date = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(date.getTime())) return "TBD";
  return `${new Intl.DateTimeFormat("en-US", {
    timeZone: ET_TIME_ZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    ...options,
  }).format(date)} ET`;
}

export function etDateKey(iso: string | Date): string {
  const date = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ET_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function todayEtKey(): string {
  return etDateKey(new Date());
}

export function formatEtTimeLabel(iso: string | Date): string {
  const value = formatEtTime(iso);
  return value === "TBD" ? value : `${value} ET`;
}

export function formatEtDateLabel(iso: string | Date): string {
  const value = formatEtDate(iso);
  return value === "TBD" ? value : `${value} ET`;
}

export function formatDurationUntil(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return "time TBD";
  if (ms <= 0) return "starting soon";
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  const mins = Math.floor((ms % 3_600_000) / 60_000);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}
