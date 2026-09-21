import {
  localDateTime,
  moneyEquals,
  toDecimalString,
  type AccommodationStay,
  type ItineraryGap,
  type Money,
  type PriceProvenance,
  type TransportSegment,
  type TripSummary,
} from "@travel-optimizer/domain";
import type { RankedCandidate, SearchStage } from "@travel-optimizer/optimizer";

/** Local copy of optimizer PATTERN_LABELS — avoids pulling Node crypto into the client bundle. */
const PATTERN_LABELS = {
  round_trip: "round trip",
  open_jaw: "open jaw",
  multi_city: "multi-city",
  multi_city_open_jaw: "multi-city, open jaw",
} as const;

function transportPatternLabel(candidate: RankedCandidate): string {
  const multiCity = candidate.nightsByStay.length > 1;
  const openJaw = candidate.summary.unpricedGaps.length > 0;
  if (multiCity) return openJaw ? PATTERN_LABELS.multi_city_open_jaw : PATTERN_LABELS.multi_city;
  return openJaw ? PATTERN_LABELS.open_jaw : PATTERN_LABELS.round_trip;
}

/** Always includes the currency code. Never silently formats unknown as zero. */
export function formatMoney(money: Money): string {
  return `${toDecimalString(money)} ${money.currency}`;
}

export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${String(rest)}m`;
  if (rest === 0) return `${String(hours)}h`;
  return `${String(hours)}h ${String(rest)}m`;
}

export function formatStops(segment: TransportSegment): string {
  if (segment.transfers === 0) return "direct";
  return segment.transfers === 1 ? "1 stop" : `${String(segment.transfers)} stops`;
}

function placeCode(location: {
  readonly iata?: string | undefined;
  readonly name: string;
}): string {
  return location.iata ?? location.name;
}

/**
 * Human-facing itinerary shape. One-way is detected from `endsAt` / missing
 * return rather than from `transportPattern`, which today has no one-way label.
 */
export function itineraryPatternLabel(candidate: RankedCandidate): string {
  if (candidate.candidate.endsAt !== undefined || candidate.summary.returnDate === undefined) {
    return "one-way";
  }
  return transportPatternLabel(candidate);
}

export function scopeLabel(summary: TripSummary): string {
  const { exclusions, scope } = summary.cost;
  if (scope === "complete") return "complete trip";
  const missing = [
    exclusions.includes("unpriced_segment") ? "an unpriced sector" : "",
    exclusions.includes("accommodation") ? "some accommodation" : "",
    exclusions.includes("unresolved_accommodation") ? "unresolved accommodation" : "",
  ].filter((entry) => entry !== "");
  return `excludes ${missing.join(" and ")}`;
}

export function formatPerPerson(summary: TripSummary): string {
  const shares = summary.cost.perPersonShares;
  const [first] = shares;
  if (first === undefined) return "n/a";
  const even = shares.every((share) => moneyEquals(share, first));
  return `${even ? "" : "≈ "}${formatMoney(first)}`;
}

/**
 * Cost line that keeps estimated / known / incomplete distinctions visible.
 *
 * Example: "Flights €306 · Transfers €18 estimated · Total €324 known cost"
 */
export function formatCostBreakdown(summary: TripSummary): string {
  const parts: string[] = [];
  const { cost, provenance } = summary;

  if (cost.fares.amountMinor > 0) {
    const fareLabel = provenance.fareSourceType ?? "retrieved";
    parts.push(`Fares ${formatMoney(cost.fares)} (${fareLabel})`);
  }

  if (cost.groundTransfer.amountMinor > 0) {
    parts.push(`Transfers ${formatMoney(cost.groundTransfer)} estimated`);
  }

  if (cost.accommodation.amountMinor > 0) {
    parts.push(`Accommodation ${formatMoney(cost.accommodation)}`);
  }

  for (const gap of summary.unpricedGaps) {
    parts.push(`${placeCode(gap.from)} → ${placeCode(gap.to)} unpriced`);
  }

  const totalWord = cost.scope === "complete" ? "Total" : "Known cost";
  parts.push(`${totalWord} ${formatMoney(cost.total)}`);

  return parts.join(" · ");
}

/**
 * Provenance wording for a priced offer.
 *
 * Uses "usable until", never "expires" / "fare guaranteed" — `expiresAt` is the
 * permitted-use boundary, not commercial fare validity (ADR 0006).
 */
export function formatOfferProvenance(provenance: PriceProvenance): string {
  const fetched = provenance.fetchedAt.slice(0, 16).replace("T", " ");
  const usable =
    provenance.expiresAt === undefined
      ? "no provider expiry (freshness unknown)"
      : `usable until ${provenance.expiresAt.slice(0, 16).replace("T", " ")}`;
  return `${provenance.sourceType} price · checked ${fetched}Z · ${provenance.provider} · ${usable}`;
}

export function formatGap(gap: ItineraryGap): string {
  const distance =
    gap.distanceKm === undefined ? "distance unknown" : `${String(Math.round(gap.distanceKm))} km`;
  return `${placeCode(gap.from)} → ${placeCode(gap.to)} — transport price unavailable (${distance})`;
}

export function formatAccommodationState(entry: AccommodationStay): string {
  const nights = (count: number) => `${String(count)} night${count === 1 ? "" : "s"}`;

  if (entry.state === "priced") {
    return `${entry.city.name}: priced · ${formatMoney(entry.stay.price)} · ${entry.stay.provenance.sourceType} · ${nights(entry.nights)}`;
  }
  if (entry.state === "unresolved") {
    const where = entry.cities.map((city) => city.name).join("/");
    return `unresolved — ${nights(entry.nights)} across ${where}, allocation undeterminable`;
  }

  const why =
    entry.reason === "provider_no_results"
      ? "provider had nothing"
      : entry.reason === "provider_unavailable"
        ? "provider unavailable"
        : entry.reason === "no_provider"
          ? "no accommodation provider"
          : entry.reason === "outside_shortlist"
            ? "not among the priced finalists"
            : "not searched";

  const state = entry.state === "unpriced" ? "unpriced" : "not searched";
  return `${entry.city.name}: ${state} — ${nights(entry.nights)} · ${why}`;
}

export function formatSegmentSchedule(segment: TransportSegment): string {
  const departure = localDateTime(segment.departureAt);
  const arrival = localDateTime(segment.arrivalAt);
  return (
    `${departure.date} ${departure.time.slice(0, 5)} ${placeCode(segment.origin)}` +
    ` → ${arrival.date} ${arrival.time.slice(0, 5)} ${placeCode(segment.destination)}` +
    ` (${segment.departureAt.timeZone} → ${segment.arrivalAt.timeZone})`
  );
}

export const SEARCH_STAGE_LABELS: Readonly<Record<SearchStage, string>> = {
  destinations: "Finding destinations",
  flights: "Searching flights",
  ground_transport: "Searching ground transport",
  open_jaw: "Evaluating open-jaw routes",
  accommodation: "Searching accommodation",
  optimization: "Optimizing results",
  complete: "Complete",
};

export function destinationTitle(
  cities: readonly { readonly name: string; readonly countryCode?: string }[],
  pattern: string,
): string {
  if (cities.length === 0) return "Unknown destination";
  if (cities.length === 1) {
    const city = cities[0];
    if (city === undefined) return "Unknown destination";
    return city.countryCode === undefined
      ? city.name
      : `${city.name} (${city.countryCode})`;
  }
  return `${cities.map((city) => city.name).join(" → ")} (${pattern})`;
}

/** True when unknown/unpriced must not render as a money amount of zero. */
export function hasPricedAmount(money: Money | undefined): money is Money {
  return money !== undefined;
}
