"use client";

import type { DestinationResult, RankedCandidate, SearchTrace } from "@travel-optimizer/optimizer";

import {
  destinationTitle,
  formatAccommodationState,
  formatCostBreakdown,
  formatDuration,
  formatGap,
  formatMoney,
  formatPerPerson,
  itineraryPatternLabel,
  scopeLabel,
} from "../lib/format";
import { Button, Panel } from "./ui/form";

function modesOf(candidate: RankedCandidate): string {
  const modes = [
    ...new Set(
      candidate.candidate.segments
        .filter((segment) => segment.mode !== "ground_transfer")
        .map((segment) => segment.mode),
    ),
  ];
  return modes.length === 0 ? "none" : modes.join(", ");
}

function nightsLabel(candidate: RankedCandidate, cities: readonly { readonly name: string }[]): string {
  if (cities.length > 1 && cities.length === candidate.nightsByStay.length) {
    return candidate.nightsByStay
      .map((count, index) => `${String(count)}n ${cities[index]?.name ?? ""}`)
      .join(" · ");
  }
  return `${String(candidate.nights)} night${candidate.nights === 1 ? "" : "s"}`;
}

export function ResultCard({
  destination,
  candidate,
  selected,
  onSelect,
}: {
  readonly destination: DestinationResult;
  readonly candidate: RankedCandidate;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const pattern = itineraryPatternLabel(candidate);
  const title = destinationTitle(destination.cities, pattern);
  const airports = destination.airports
    .map((airport) => airport.iata ?? airport.id)
    .join(", ");
  const summary = candidate.summary;
  const incomplete = summary.cost.scope !== "complete" || summary.unpricedGaps.length > 0;
  const dates =
    summary.returnDate === undefined
      ? `${summary.departureDate} → ends ${summary.tripEndDate}`
      : `${summary.departureDate} → ${summary.returnDate}`;

  return (
    <article
      className={`rounded-lg border p-4 transition ${
        selected
          ? "border-[var(--accent)] bg-[#f2f8f5]"
          : "border-[var(--line)] bg-[var(--bg-elevated)]"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3
            className="text-lg font-semibold text-[var(--ink)]"
            style={{ fontFamily: "var(--font-display), var(--display)" }}
          >
            {title}
          </h3>
          <p className="mt-0.5 text-sm text-[var(--ink-muted)]">
            {pattern} · {airports} · {dates}
          </p>
        </div>
        <div className="text-right">
          <p className="text-lg font-semibold tabular-nums">
            {formatPerPerson(summary)}
            <span className="text-sm font-normal text-[var(--ink-muted)]"> / person</span>
          </p>
          <p className="text-sm text-[var(--ink-muted)]">
            {formatMoney(summary.cost.total)}{" "}
            {summary.cost.scope === "complete" ? "total" : "known cost"} · {scopeLabel(summary)}
          </p>
        </div>
      </div>

      <p className="mt-3 text-sm leading-relaxed text-[var(--ink)]">
        {formatCostBreakdown(summary)}
      </p>

      <dl className="mt-3 grid gap-1 text-sm text-[var(--ink-muted)] sm:grid-cols-2">
        <div>
          <dt className="inline font-medium text-[var(--ink)]">Stay: </dt>
          <dd className="inline">{nightsLabel(candidate, destination.cities)}</dd>
        </div>
        <div>
          <dt className="inline font-medium text-[var(--ink)]">Travel: </dt>
          <dd className="inline">
            {formatDuration(summary.travelTimeMinutes)} · {modesOf(candidate)} ·{" "}
            {summary.stops === 0 ? "direct legs" : `${String(summary.stops)} stops`}
          </dd>
        </div>
      </dl>

      {summary.unpricedGaps.length > 0 ? (
        <ul className="mt-2 space-y-1 text-sm text-[var(--warn)]">
          {summary.unpricedGaps.map((gap) => (
            <li key={gap.id}>{formatGap(gap)}</li>
          ))}
        </ul>
      ) : null}

      {summary.accommodation.length > 0 ? (
        <ul className="mt-2 space-y-1 text-sm text-[var(--ink-muted)]">
          {summary.accommodation.map((entry, index) => (
            <li key={`${entry.state}-${String(index)}`}>
              Accommodation {formatAccommodationState(entry)}
            </li>
          ))}
        </ul>
      ) : null}

      {incomplete ? (
        <p className="mt-2 text-xs font-medium tracking-wide text-[var(--warn)] uppercase">
          Incomplete / not fully priced
        </p>
      ) : null}

      <div className="mt-3">
        <Button type="button" variant={selected ? "primary" : "secondary"} onClick={onSelect}>
          {selected ? "Viewing itinerary" : "View itinerary"}
        </Button>
      </div>
    </article>
  );
}

export function ResultsList({
  trace,
  selectedKey,
  onSelect,
}: {
  readonly trace: SearchTrace;
  readonly selectedKey: string | undefined;
  readonly onSelect: (key: string, destination: DestinationResult, candidate: RankedCandidate) => void;
}) {
  const rows = trace.destinations.flatMap((destination) =>
    destination.candidates.map((candidate) => ({
      key: `${destination.airports.map((a) => a.id).join("-")}:${candidate.candidate.id}`,
      destination,
      candidate,
    })),
  );

  if (rows.length === 0) {
    return (
      <Panel>
        <h2 className="text-lg font-semibold">No trips found</h2>
        <p className="mt-1 text-sm text-[var(--ink-muted)]">
          The optimizer returned no candidates for this request
          {trace.status === "partial" ? " (partial provider results)" : ""}.
          Check search details for funnel counts and filters.
        </p>
      </Panel>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2
          className="text-xl font-semibold"
          style={{ fontFamily: "var(--font-display), var(--display)" }}
        >
          {String(rows.length)} candidate{rows.length === 1 ? "" : "s"}
        </h2>
        <p className="text-sm text-[var(--ink-muted)]">
          searchId {trace.searchId} · status {trace.status} · strategy {trace.strategy}
        </p>
      </div>
      {rows.map((row) => (
        <ResultCard
          key={row.key}
          destination={row.destination}
          candidate={row.candidate}
          selected={selectedKey === row.key}
          onSelect={() => {
            onSelect(row.key, row.destination, row.candidate);
          }}
        />
      ))}
    </div>
  );
}
