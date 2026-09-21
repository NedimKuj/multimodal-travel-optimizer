import {
  localDateTime,
  moneyEquals,
  toDecimalString,
  type Money,
  type TransportSegment,
} from "@travel-optimizer/domain";
import {
  PATTERN_LABELS,
  transportPattern,
  type DestinationResult,
  type RankedCandidate,
  type SearchTrace,
} from "@travel-optimizer/optimizer";

/*
 * Human-readable output for trip-search.
 *
 * Transport only, and it says so: nothing here may read as a complete-trip
 * cost or as a guaranteed bookable price.
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
  // "Both ways" is only true of a trip with exactly two legs. A one-way has
  // one, a multi-city three or more.
  if (stops === 0) {
    if (pricedLegs <= 1) return "direct";
    return pricedLegs > 2 ? "direct on every leg" : "direct both ways";
  }
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

/**
 * What accommodation is known for each stay.
 *
 * Each component keeps its own label: a missing bed never relabels a retrieved
 * fare, and no state but `priced` contributes an amount (ADR 0016).
 */
function formatAccommodation(candidate: RankedCandidate): string[] {
  const entries = candidate.summary.accommodation;
  if (entries.length === 0) return [];

  const nights = (count: number) => `${String(count)} night${count === 1 ? "" : "s"}`;
  const lines = entries.map((entry) => {
    if (entry.state === "priced") {
      return `   Accommodation ${entry.city.name}: ${formatMoney(entry.stay.price)} — ${entry.stay.provenance.sourceType} · ${nights(entry.nights)}`;
    }
    if (entry.state === "unresolved") {
      const where = entry.cities.map((city) => city.name).join("/");
      return `   Accommodation: unresolved — ${nights(entry.nights)} across ${where}, allocation undeterminable`;
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
    return `   Accommodation ${entry.city.name}: ${state} — ${nights(entry.nights)} · ${why}`;
  });

  const priced = entries.every((entry) => entry.state === "priced");
  if (!priced) {
    lines.push("   The amount above EXCLUDES accommodation that is not priced");
  }
  return lines;
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
  // "usable until", not "expires": for a cached fare this is the boundary past
  // which we may no longer use the price, which is not a claim that the fare
  // itself stays purchasable until then.
  const expiry =
    offer.provenance.expiresAt === undefined
      ? "no provider expiry (freshness unknown)"
      : `usable until ${offer.provenance.expiresAt.slice(0, 16).replace("T", " ")}`;
  return `   ${offer.provenance.sourceType} price · checked ${fetched}Z · ${offer.provenance.provider} · ${expiry}`;
}

/** What the amount covers, in the terms a traveler would use. */
function scopeLabel(candidate: RankedCandidate): string {
  const { exclusions, scope } = candidate.summary.cost;
  if (scope === "complete") return "complete trip";
  const missing = [
    exclusions.includes("unpriced_segment") ? "an unpriced sector" : "",
    exclusions.includes("accommodation") ? "some accommodation" : "",
    exclusions.includes("unresolved_accommodation") ? "unresolved accommodation" : "",
  ].filter((entry) => entry !== "");
  return `excludes ${missing.join(" and ")}`;
}

function formatDestination(destination: DestinationResult, index: number): string[] {
  const [best, ...rest] = destination.candidates;
  if (best === undefined) return [];

  const airports = destination.airports.map((airport) => airport.iata ?? airport.id).join(", ");
  const pattern = transportPattern(best);
  const openJaw = pattern === "open_jaw" || pattern === "multi_city_open_jaw";
  const multiCity = pattern === "multi_city" || pattern === "multi_city_open_jaw";
  const cityNames = destination.cities.map((city) => city.name);
  const name =
    cityNames.length === 0
      ? `${destination.airports[0]?.name ?? "Unknown"} (airport only)`
      : cityNames.length > 1
        ? `${cityNames.join(" → ")} (${PATTERN_LABELS[pattern]})`
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
      ? `   Known cost: ${formatPerPerson(best)} / person · ${formatMoney(best.summary.cost.total)} · ${scopeLabel(best)}`
      : `   ${formatPerPerson(best)} / person · ${formatMoney(best.summary.cost.total)} ${best.summary.cost.scope === "complete" ? "total" : "known cost"} · ${scopeLabel(best)}`,
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
    ...formatAccommodation(best),
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
    const { funnel } = trace.discovery;
    const withReturns = trace.discovery.enriched.filter(
      (entry) => entry.returnOffersFound > 0,
    ).length;
    // The funnel, in the order a search walks it, so a thin result points at
    // the step that thinned it.
    lines.push(
      `Destinations found: ${String(funnel.destinationsDiscovered)}` +
        ` · shortlisted ${String(funnel.destinationsAdmitted)}` +
        (funnel.onwardQueriesExecuted > 0
          ? ` · onward queries ${String(funnel.onwardQueriesExecuted)}` +
            // Airports here, cities on the line below: an onward leg reaches
            // an airport, and several may serve one city.
            ` · second-city airports found ${String(funnel.secondCityAirportsDiscovered)}` +
            ` (${String(funnel.secondCityAirportsAdmitted)} admitted)`
          : ""),
    );
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
      // "Places", not "destinations": second cities are counted here too, and
      // they are not places home flies to directly (ADR 0015 §7).
      `Places checked for a way home: ${String(trace.discovery.enriched.length)} (${String(withReturns)} had one)` +
        (reasons.length > 0 ? ` · ${reasons.join(" · ")}` : ""),
    );
    // Why a way-home query was spent on a city home cannot reach directly.
    const viaSecondCity = trace.discovery.enriched.filter((entry) => entry.source === "onward");
    for (const entry of viaSecondCity) {
      const name = entry.city?.name ?? entry.airport.name;
      const path = [request.origin, ...entry.via.map((stop) => stop.iata ?? stop.name)].join(" → ");
      lines.push(
        `Way home sought from ${name} (${entry.airport.iata ?? entry.airport.id})` +
          ` · reached ${path} · known reach cost ${formatMoney({ amountMinor: entry.reachCostMinor, currency: trace.currency })}` +
          ` · ${entry.returnOffersFound > 0 ? `${String(entry.returnOffersFound)} found` : "none found"}`,
      );
    }
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
    if (funnel.returnQueriesFromSecondCity > 0) {
      lines.push(
        `Ways home queried: ${String(funnel.returnQueriesFromStageOne)} from destinations` +
          ` (${String(funnel.returnFaresFoundFromStageOne)} with fares)` +
          ` · ${String(funnel.returnQueriesFromSecondCity)} from second cities` +
          ` (${String(funnel.returnFaresFoundFromSecondCity)} with fares)`,
      );
    }
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
  if (trace.pruning !== undefined && trace.pruning.pruned > 0) {
    // Reported apart from the filtered-out counts above: those candidates were
    // never viable, these were viable and merely redundant (ADR 0017).
    lines.push(
      `Redundant alternatives removed: ${String(trace.pruning.pruned)} of ${String(trace.pruning.entered)}` +
        ` · ${String(trace.pruning.remaining)} distinct`,
    );
  }
  // What survived, not what was built: pruning runs after the counts above are
  // taken, so `candidatesBuilt` would overstate the list that follows.
  const surviving = trace.pruning?.remaining ?? counts.candidatesBuilt;
  lines.push(
    `Candidates: ${String(surviving)} across ${String(counts.destinations)} destination(s)` +
      (counts.multiCityCandidatesBuilt > 0
        ? ` · ${String(counts.multiCityCandidatesBuilt)} multi-city`
        : ""),
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
    "Each amount covers only what is priced; every stay says what is known about it. Airport transfers are estimates from a distance model, not quotes, and cached fares are not guaranteed bookable.",
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
