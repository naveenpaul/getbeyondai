/**
 * Shared geo normalization for sourcing providers. Pure, vendor-neutral.
 *
 * The ICP's `locations` are free-form (the model emits cities, states, or
 * countries). Each provider needs them disambiguated differently — ZoomInfo can
 * only filter by `country`; PDL filters by `location.country` / `location.locality`
 * globally but on CANONICAL city names. This module is the one place that knows
 * "is this a country?" and "what does this city normalize to?", so the country
 * list and city aliases don't drift between providers.
 */

/**
 * Canonical country names (title-cased, as ZoomInfo's `/lookup` returns them and
 * as PDL stores them once lowercased). Used to recognize which ICP `locations`
 * are countries vs. cities/regions. Not exhaustive by design — an unlisted
 * country degrades to "not a country" (a weaker filter), never an error.
 */
export const CANONICAL_COUNTRIES: readonly string[] = [
  'Afghanistan', 'Albania', 'Algeria', 'Argentina', 'Armenia', 'Australia',
  'Austria', 'Azerbaijan', 'Bahrain', 'Bangladesh', 'Belarus', 'Belgium',
  'Bolivia', 'Bosnia and Herzegovina', 'Brazil', 'Bulgaria', 'Cambodia',
  'Cameroon', 'Canada', 'Chile', 'China', 'Colombia', 'Costa Rica', 'Croatia',
  'Cyprus', 'Czech Republic', 'Denmark', 'Dominican Republic', 'Ecuador',
  'Egypt', 'El Salvador', 'Estonia', 'Ethiopia', 'Finland', 'France', 'Georgia',
  'Germany', 'Ghana', 'Greece', 'Guatemala', 'Honduras', 'Hong Kong', 'Hungary',
  'Iceland', 'India', 'Indonesia', 'Iran', 'Iraq', 'Ireland', 'Israel', 'Italy',
  'Ivory Coast', 'Jamaica', 'Japan', 'Jordan', 'Kazakhstan', 'Kenya', 'Kuwait',
  'Latvia', 'Lebanon', 'Lithuania', 'Luxembourg', 'Malaysia', 'Malta', 'Mexico',
  'Moldova', 'Mongolia', 'Montenegro', 'Morocco', 'Myanmar', 'Nepal',
  'Netherlands', 'New Zealand', 'Nicaragua', 'Nigeria', 'North Macedonia',
  'Norway', 'Oman', 'Pakistan', 'Panama', 'Paraguay', 'Peru', 'Philippines',
  'Poland', 'Portugal', 'Puerto Rico', 'Qatar', 'Romania', 'Russia', 'Rwanda',
  'Saudi Arabia', 'Senegal', 'Serbia', 'Singapore', 'Slovakia', 'Slovenia',
  'South Africa', 'South Korea', 'Spain', 'Sri Lanka', 'Sweden', 'Switzerland',
  'Taiwan', 'Tanzania', 'Thailand', 'Tunisia', 'Turkey', 'Uganda', 'Ukraine',
  'United Arab Emirates', 'United Kingdom', 'United States', 'Uruguay',
  'Uzbekistan', 'Venezuela', 'Vietnam', 'Zambia', 'Zimbabwe',
];

/** Common shorthands → the canonical country name. */
const COUNTRY_ALIASES: Readonly<Record<string, string>> = {
  us: 'United States',
  usa: 'United States',
  'u.s.': 'United States',
  'u.s.a.': 'United States',
  america: 'United States',
  'united states of america': 'United States',
  uk: 'United Kingdom',
  'u.k.': 'United Kingdom',
  britain: 'United Kingdom',
  'great britain': 'United Kingdom',
  england: 'United Kingdom',
  scotland: 'United Kingdom',
  wales: 'United Kingdom',
  uae: 'United Arab Emirates',
  korea: 'South Korea',
  'republic of korea': 'South Korea',
  'russian federation': 'Russia',
  czechia: 'Czech Republic',
  holland: 'Netherlands',
};

/** lowercased name/alias → canonical country name; one lookup for both tables. */
const COUNTRY_BY_KEY: ReadonlyMap<string, string> = new Map<string, string>([
  ...CANONICAL_COUNTRIES.map((c) => [c.toLowerCase(), c] as const),
  ...Object.entries(COUNTRY_ALIASES),
]);

/**
 * Resolve a free-form ICP location to a canonical country, or null when it isn't
 * a country (a city/state/region). Pure.
 */
export function canonicalCountry(location: string): string | null {
  return COUNTRY_BY_KEY.get(location.trim().toLowerCase()) ?? null;
}

/**
 * City aliases — the renamed / colloquial forms a model emits → the name data
 * vendors actually index on. Verified against PDL (2026-06-05): `bengaluru`
 * returns 0, `bangalore` returns 57k — so the alias is load-bearing, not
 * cosmetic. Keys + values are lowercased. Extend as new mismatches surface.
 */
const CITY_ALIASES: Readonly<Record<string, string>> = {
  bengaluru: 'bangalore',
  bombay: 'mumbai',
  calcutta: 'kolkata',
  madras: 'chennai',
  gurgaon: 'gurugram',
  'new york city': 'new york',
  nyc: 'new york',
  sf: 'san francisco',
  'san fran': 'san francisco',
};

/**
 * Normalize a free-form city to the form data vendors index on (lowercased +
 * de-aliased). Pure. Returns null for blank input. Does NOT decide whether the
 * value is a city — callers pass locations they've already determined aren't
 * countries (see {@link canonicalCountry}).
 */
export function canonicalCity(location: string): string | null {
  const key = location.trim().toLowerCase();
  if (!key) return null;
  return CITY_ALIASES[key] ?? key;
}
