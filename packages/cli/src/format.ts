import {
  localDateTime,
  moneyEquals,
  toDecimalString,
  type Money,
  type TransportSegment,
} from "@travel-optimizer/domain";
import type { DestinationResult, RankedCandidate, SearchTrace } from "@travel-optimizer/optimizer";

/*
 * Human-readable output for trip-search.
 *
 * Phase 1 shows transport only, and says so: nothing here may read as a
 * complete-trip cost or as a guaranteed bookable price.
 */

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

function formatStops(segment: TransportSegment): string {
  if (segment.transfers === 0) return "direct";
  return segment.transfers === 1 ? "1 stop" : `${String(segment.transfers)} stops`;
}

function formatStopCount(stops: number, pricedLegs: number): string {
  // "Both ways" is only true of a trip with two legs.
  if (stops === 0) return pricedLegs > 2 ? "direct on every leg" : "direct both ways";
  return stops === 1 ? "1 stop" : `${String(stops)} stops`;
}

const LEG_LABELS: Readonly<Record<string, string>> = {
  flight: "fly     ",
  train: "train   ",
  bus: "bus     ",
  ground_transfer: "transfer",
};

function placeName(location: TransportSegment["origin"]): string {
  return location.iata ?? location.name;
}

function formatLeg(segment: TransportSegment): string {
  const departure = localDateTime(segment.departureAt);
  const arrival = localDateTime(segment.arrivalAt);
  const label = LEG_LABELS[segment.mode] ?? segment.mode;
  const detail =
    segment.mode === "ground_transfer"
      ? "estimated"
      : `${formatStops(segment)} · ${segment.carrier ?? "unknown carrier"}${segment.serviceNumber === undefined ? "" : ` ${segment.serviceNumber}`}`;
  return (
    `   ${label} ${departure.date} ${departure.time.slice(0, 5)} ${placeName(segment.origin)}` +
    ` → ${arrival.date} ${arrival.time.slice(0, 5)} ${placeName(segment.destination)}` +
    ` · ${formatDuration(segment.durationMinutes)} · ${detail}`
  );
}

/** "Fare: cached · includes estimated transfer (9.00 EUR)" */
function formatProvenanceLine(candidate: RankedCandidate): string {
  const { provenance, cost } = candidate.summary;
  const fare = provenance.fareSourceType ?? "no retrieved fare";
  if (!provenance.partiallyEstimated) return `   Fare: ${fare}`;
  const parts = provenance.estimatedComponents
    .map((component) => component.replace("_", " "))
    .join(", ");
  return `   Fare: ${fare} · includes estimated ${parts} (${formatMoney(cost.estimated)})`;
}

/** Per-person share, marked approximate when the split is uneven. */
function formatPerPerson(candidate: RankedCandidate): string {
  const shares = candidate.summary.cost.perPersonShares;
  const [first] = shares;
  if (first === undefined) return "n/a";
  const even = shares.every((share) => moneyEquals(share, first));
  return `${even ? "" : "≈ "}${formatMoney(first)}`;
}

function formatProvenance(candidate: RankedCandidate): string {
  // The retrieved fare, not a transfer estimate.
  const offer = candidate.candidate.offers.find(
    (entry) => entry.provenance.sourceType !== "estimated",
  );
  if (offer === undefined) return "";
  const fetched = offer.provenance.fetchedAt.slice(0, 16).replace("T", " ");
  const expiry =
    offer.provenance.expiresAt === undefined
      ? "no provider expiry (freshness unknown)"
      : `expires ${offer.provenance.expiresAt.slice(0, 16).replace("T", " ")}`;
  return `   ${offer.provenance.sourceType} price · checked ${fetched}Z · ${offer.provenance.provider} · ${expiry}`;
}

function formatDestination(destination: DestinationResult, index: number): string[] {
  const [best, ...rest] = destination.candidates;
  if (best === undefined) return [];

  const airports = destination.airports.map((airport) => airport.iata ?? airport.id).join(", ");
  const openJaw = best.summary.unpricedGaps.length > 0;
  // More than one stay means the traveler slept in more than one place, which
  // only a trip of three legs or more does. An open jaw has two cities but one
  // stay, because the sector between them has no times to divide it by.
  const multiCity = best.nightsByStay.length > 1;
  const shape = [multiCity ? "multi-city" : "", openJaw ? "open jaw" : ""].filter(
    (entry) => entry !== "",
  );
  const cityNames = destination.cities.map((city) => city.name);
  const name =
    cityNames.length === 0
      ? `${destination.airports[0]?.name ?? "Unknown"} (airport only)`
      : cityNames.length > 1
        ? `${cityNames.join(" → ")}${shape.length > 0 ? ` (${shape.join(", ")})` : ""}`
        : `${cityNames[0] ?? ""} (${destination.cities[0]?.countryCode ?? ""})`;

  const pricedLegs = best.candidate.segments.filter(
    (leg) => leg.mode !== "ground_transfer",
  ).length;
  const nights = (count: number) => `${String(count)} night${count === 1 ? "" : "s"}`;
  // Names are attached only when there is one per stay. A trip that flies home
  // from a third city has more cities than stays, so its nights are reported
  // without them rather than against the wrong one.
  const nightsSummary =
    multiCity && cityNames.length === best.nightsByStay.length
      ? best.nightsByStay
          .map((count, index) => `${nights(count)} ${cityNames[index] ?? ""}`)
          .join(" · ")
      : nights(best.nights);

  const lines = [
    `${String(index + 1)}. ${name} — ${airports}`,
    openJaw
      ? `   Known cost: ${formatPerPerson(best)} / person · ${formatMoney(best.summary.cost.total)} · transport only`
      : `   ${formatPerPerson(best)} / person · ${formatMoney(best.summary.cost.total)} total · transport only`,
    ...best.summary.unpricedGaps.map(
      (gap) =>
        `   ${gap.from.iata ?? gap.from.name} → ${gap.to.iata ?? gap.to.name}: ${gap.distanceKm === undefined ? "distance unknown" : `${String(Math.round(gap.distanceKm))} km`}, UNPRICED — arrange separately`,
    ),
    ...(openJaw
      ? [
          `   The amount above EXCLUDES ${best.summary.unpricedGaps
            .map((gap) => `${gap.from.iata ?? gap.from.name} → ${gap.to.iata ?? gap.to.name}`)
            .join(", ")}`,
        ]
      : []),
    formatProvenanceLine(best),
    // Only in-segment stops are shown. `connections` counts changes with no
    // stay in between (ADR 0005), and until accommodation exists every trip
    // has one for its destination stay, which is not a transfer.
    `   ${nightsSummary} · ${formatDuration(best.summary.travelTimeMinutes)} travelling · ${formatStopCount(best.summary.stops, pricedLegs)}`,
  ];

  for (const segment of best.candidate.segments) {
    lines.push(formatLeg(segment));
  }

  const provenance = formatProvenance(best);
  if (provenance !== "") lines.push(provenance);

  const bookable = best.candidate.offers.find((entry) => entry.bookingUrl !== undefined);
  if (bookable?.bookingUrl !== undefined) lines.push(`   book: ${bookable.bookingUrl}`);
  if (rest.length > 0) {
    lines.push(`   (${String(rest.length)} more fare(s) to this destination)`);
  }
  return lines;
}

export interface FormatOptions {
  readonly limit: number;
}

/** Renders a finished search for a terminal. */
export function formatSearch(trace: SearchTrace, options: FormatOptions): string {
  const lines: string[] = [];
  const { request, counts } = trace;

  const where = request.destination ?? "anywhere";
  lines.push(
    `Searching ${request.origin} → ${where} for ${String(request.travelers)} traveler(s)`,
  );
  if (trace.window !== undefined) {
    const nights =
      trace.window.minNights === undefined && trace.window.maxNights === undefined
        ? "any length"
        : `${String(trace.window.minNights ?? 0)}–${String(trace.window.maxNights ?? "∞")} nights`;
    lines.push(
      `Window ${trace.window.outerBounds.from} .. ${trace.window.outerBounds.to} · ${nights} · ${trace.window.mode} mode`,
    );
  }
  if (trace.origins !== undefined && trace.origins.origins.length > 1) {
    const extra = trace.origins.origins
      .filter((origin) => !origin.isPrimary)
      .map((origin) => `${origin.airport.iata ?? origin.airport.id} (${String(Math.round(origin.distanceKm))} km)`);
    lines.push(`Also departing from ${extra.join(", ")}`);
  }
  if (trace.origins !== undefined && trace.origins.skipped.length > 0) {
    const skipped = trace.origins.skipped
      .map(
        (entry) =>
          `${entry.airport.iata ?? entry.airport.id} (${String(Math.round(entry.distanceKm))} km, ${entry.reason === "call_budget" ? "call budget" : "cap"})`,
      )
      .join(", ");
    lines.push(`Alternative origins not searched: ${skipped}`);
  }
  if (request.budget !== undefined) {
    const basis = request.budget.kind === "perPerson" ? "per person" : "total";
    lines.push(`Budget ${formatMoney(request.budget.amount)} ${basis}`);
  }
  lines.push("");

  if (trace.status === "failed") {
    lines.push("Search failed.");
    for (const failure of trace.provider.failures) {
      lines.push(`  provider ${failure.kind}: ${failure.message}`);
    }
    for (const issue of trace.issues) {
      lines.push(`  ${issue.code}: ${issue.message}`);
    }
    lines.push("");
    lines.push(`Search ${trace.searchId} · optimizer ${trace.optimizerVersion}`);
    return lines.join("\n");
  }

  const metrics = trace.provider.metrics;
  lines.push(
    `Provider calls: ${String(metrics?.requestCount ?? 0)} (cache ${metrics?.cache ?? "n/a"}) · fares returned: ${String(counts.offersReturned)}`,
  );
  if (trace.discovery !== undefined) {
    const withReturns = trace.discovery.enriched.filter(
      (entry) => entry.returnOffersFound > 0,
    ).length;
    // This line is about ways home, so it counts only the queries that would
    // have found one. Onward queries are reported on their own line below.
    const returnSkips = trace.discovery.skipped.filter((entry) => entry.stage === "return");
    // A destination stopped by our own shortlist cap was not stopped by the
    // budget, and saying so would misdescribe what limited the search.
    const outOfBudget = returnSkips.filter((entry) => entry.reason === "call_budget").length;
    const beyondCap = returnSkips.length - outOfBudget;
    const reasons = [
      ...(outOfBudget > 0 ? [`${String(outOfBudget)} not checked (call budget)`] : []),
      ...(beyondCap > 0 ? [`${String(beyondCap)} beyond the shortlist`] : []),
    ];
    lines.push(
      `Destinations checked for a way home: ${String(trace.discovery.enriched.length)} (${String(withReturns)} had one)` +
        (reasons.length > 0 ? ` · ${reasons.join(" · ")}` : ""),
    );
    if (counts.secondCitiesReached > 0) {
      lines.push(
        `Second cities reachable onward: ${String(counts.secondCitiesReached)}` +
          (counts.secondCitiesWithoutReturn > 0
            ? ` (${String(counts.secondCitiesWithoutReturn)} with no retrieved way home)`
            : ""),
      );
    }
    // Which stage ran out, not just that something did: a search short of ways
    // home and one short of onward legs are thin for different reasons.
    const hungry = (["return", "onward"] as const)
      .map((stage) => ({
        stage,
        count: (trace.discovery?.skipped ?? []).filter(
          (entry) => entry.stage === stage && entry.reason === "call_budget",
        ).length,
      }))
      .filter((entry) => entry.count > 0)
      .map(
        (entry) =>
          `${String(entry.count)} ${entry.stage === "return" ? "way home" : "onward leg"} quer${entry.count === 1 ? "y" : "ies"}`,
      );
    lines.push(
      `Calls planned: ${String(trace.discovery.callsPlanned)} of ${String(trace.discovery.callBudget)} budget` +
        (hungry.length > 0 ? ` · budget-limited: ${hungry.join(", ")} not made` : ""),
    );
  }
  const rejected = [
    counts.rejectedOutsideWindow > 0 ? `${String(counts.rejectedOutsideWindow)} outside window` : "",
    counts.rejectedNights > 0 ? `${String(counts.rejectedNights)} wrong length` : "",
    counts.rejectedBudget > 0 ? `${String(counts.rejectedBudget)} over budget` : "",
    counts.rejectedNotRoundTrip > 0 ? `${String(counts.rejectedNotRoundTrip)} not round trips` : "",
    counts.rejectedInfeasible > 0
      ? `${String(counts.rejectedInfeasible)} impossible connections`
      : "",
    counts.rejectedGapTooFar > 0
      ? `${String(counts.rejectedGapTooFar)} open jaws too far apart`
      : "",
    counts.rejectedReturnBeforeArrival > 0
      ? `${String(counts.rejectedReturnBeforeArrival)} return before arrival`
      : "",
    counts.rejectedStayTooShort > 0
      ? `${String(counts.rejectedStayTooShort)} passed through a city without stopping`
      : "",
    counts.rejectedInvalid > 0 ? `${String(counts.rejectedInvalid)} unusable` : "",
  ].filter((entry) => entry !== "");
  if (rejected.length > 0) lines.push(`Filtered out: ${rejected.join(" · ")}`);
  lines.push(
    `Candidates: ${String(counts.candidatesBuilt)} across ${String(counts.destinations)} destination(s)`,
  );
  lines.push("");

  const shown = trace.destinations.slice(0, options.limit);
  if (shown.length === 0) {
    lines.push("No trips matched. The counts above show what was filtered out.");
  }
  for (const [index, destination] of shown.entries()) {
    lines.push(...formatDestination(destination, index));
    lines.push("");
  }
  if (trace.destinations.length > shown.length) {
    lines.push(
      `(${String(trace.destinations.length - shown.length)} more destination(s); raise --limit to see them)`,
    );
    lines.push("");
  }

  lines.push(
    "Transport only: accommodation and extras are not included. Airport transfers are estimates from a distance model, not quotes, and cached fares are not guaranteed bookable.",
  );
  for (const failure of trace.provider.failures) {
    lines.push(`Provider issue (${failure.kind}): ${failure.message}`);
  }
  if (trace.issues.length > 0) {
    const codes = new Map<string, number>();
    for (const issue of trace.issues) codes.set(issue.code, (codes.get(issue.code) ?? 0) + 1);
    lines.push(
      `Data issues: ${[...codes].map(([code, count]) => `${code}×${String(count)}`).join(", ")}`,
    );
  }
  lines.push(
    `Search ${trace.searchId} · fingerprint ${trace.fingerprint.slice(0, 12)} · optimizer ${trace.optimizerVersion}`,
  );
  return lines.join("\n");
}
