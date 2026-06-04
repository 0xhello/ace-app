/**
 * National-team flag helper for soccer (World Cup et al). Maps ACE nation
 * display names → ISO 3166-1 alpha-2 codes (GB subdivisions for the home
 * nations) and returns a flagcdn.com PNG URL. flagcdn is free, reliable, and
 * supports gb-eng / gb-sct. Returns null for anything unmapped so callers can
 * fall back to an initials crest.
 */
const NATION_ISO: Record<string, string> = {
  algeria: "dz", argentina: "ar", australia: "au", austria: "at", belgium: "be",
  "bosnia & herzegovina": "ba", "bosnia and herzegovina": "ba", brazil: "br",
  canada: "ca", "cape verde": "cv", colombia: "co", croatia: "hr", "curacao": "cw",
  "czech republic": "cz", czechia: "cz", "dr congo": "cd", "democratic republic of congo": "cd",
  ecuador: "ec", egypt: "eg", england: "gb-eng", france: "fr", germany: "de", ghana: "gh",
  haiti: "ht", iran: "ir", iraq: "iq", "ivory coast": "ci", "cote d'ivoire": "ci",
  japan: "jp", jordan: "jo", mexico: "mx", morocco: "ma", netherlands: "nl",
  "new zealand": "nz", norway: "no", panama: "pa", paraguay: "py", portugal: "pt",
  qatar: "qa", "saudi arabia": "sa", scotland: "gb-sct", senegal: "sn",
  "south africa": "za", "south korea": "kr", korea: "kr", spain: "es", sweden: "se",
  switzerland: "ch", tunisia: "tn", turkey: "tr", "türkiye": "tr", turkiye: "tr",
  usa: "us", "united states": "us", uruguay: "uy", uzbekistan: "uz",
  // common other qualifiers
  italy: "it", wales: "gb-wls", "northern ireland": "gb-nir", ireland: "ie",
  poland: "pl", denmark: "dk", serbia: "rs", ukraine: "ua", greece: "gr",
  nigeria: "ng", cameroon: "cm", "costa rica": "cr", peru: "pe", chile: "cl",
  honduras: "hn", jamaica: "jm", "trinidad & tobago": "tt", venezuela: "ve",
  bolivia: "bo", "el salvador": "sv", guatemala: "gt", "new caledonia": "nc",
  "saudi-arabia": "sa", mali: "ml", "burkina faso": "bf", angola: "ao",
  gabon: "ga", "south sudan": "ss", kenya: "ke", zambia: "zm",
};

function normNation(name: string): string {
  return name.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** Soccer-only nation flag URL, or null when unmapped. */
export function getNationFlagUrl(teamName: string): string | null {
  const code = NATION_ISO[normNation(teamName)];
  return code ? `https://flagcdn.com/w160/${code}.png` : null;
}
