"use client";

import type { DestinationResult, RankedCandidate } from "@travel-optimizer/optimizer";

import {
  formatDuration,
  formatGap,
  formatMoney,
  formatOfferProvenance,
  formatSegmentSchedule,
  formatStops,
  itineraryPatternLabel,
} from "../lib/format";
import { Panel } from "./ui/form";

function modeLabel(mode: string): string {
  switch (mode) {
    case "flight":
      return "Flight";
    case "train":
      return "Train";
    case "bus":
      return "Bus";
    case "ground_transfer":
      return "Transfer";
    default:
      return mode;
  }
}

function offerBasisLabel(offer: RankedCandidate["candidate"]["offers"][number]): string {
  return offer.priceBasis.kind === "perTraveler" ? " / person" : " total";
}

export function ItineraryDetails({
  destination,
  candidate,
}: {
  readonly destination: DestinationResult;
  readonly candidate: RankedCandidate;
}) {
  const { candidate: trip } = candidate;

  const offersBySegment = new Map<string, (typeof trip.offers)[number]>();
  for (const offer of trip.offers) {
    for (const segmentId of offer.segmentIds) {
      offersBySegment.set(segmentId, offer);
    }
  }

  return (
    <Panel className="border-[var(--accent)]/30">
      <h2
        className="text-xl font-semibold"
        style={{ fontFamily: "var(--font-display), var(--display)" }}
      >
        Itinerary · {itineraryPatternLabel(candidate)}
      </h2>
      <p className="mt-1 text-sm text-[var(--ink-muted)]">
        {destination.cities.map((city) => city.name).join(" → ") || "Airport-only destination"}
        {trip.endsAt !== undefined ? ` · ends ${trip.endsAt}` : ""}
      </p>

      <ol className="mt-5 space-y-0 border-l-2 border-[var(--line)] pl-4">
        {trip.segments.map((segment, index) => {
          const offer = offersBySegment.get(segment.id);
          const next = trip.segments[index + 1];
          const gap =
            next !== undefined && segment.destination.id !== next.origin.id
              ? trip.gaps.find(
                  (entry) =>
                    entry.from.id === segment.destination.id &&
                    entry.to.id === next.origin.id,
                )
              : undefined;

          const isTransfer = segment.mode === "ground_transfer";
          const isAltOrigin = index === 0 && isTransfer;

          return (
            <li key={segment.id} className="relative pb-5">
              <span className="absolute -left-[1.4rem] top-1.5 h-2.5 w-2.5 rounded-full bg-[var(--accent)]" />
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-medium">
                  {modeLabel(segment.mode)}{" "}
                  <span className="text-[var(--ink-muted)]">
                    {segment.origin.iata ?? segment.origin.name} →{" "}
                    {segment.destination.iata ?? segment.destination.name}
                  </span>
                </p>
                <p className="text-sm text-[var(--ink-muted)]">
                  {formatDuration(segment.durationMinutes)}
                  {!isTransfer ? ` · ${formatStops(segment)}` : " · estimated"}
                </p>
              </div>
              <p className="mt-1 text-sm" style={{ fontFamily: "var(--font-mono), var(--mono)" }}>
                {formatSegmentSchedule(segment)}
              </p>
              {!isTransfer &&
              (segment.carrier !== undefined || segment.serviceNumber !== undefined) ? (
                <p className="mt-1 text-sm text-[var(--ink-muted)]">
                  {[segment.carrier, segment.serviceNumber].filter(Boolean).join(" ")}
                </p>
              ) : null}
              {isTransfer ? (
                <p className="mt-1 text-sm text-[var(--estimate)]">
                  {isAltOrigin
                    ? `Access transfer toward ${segment.destination.iata ?? segment.destination.name}`
                    : "Airport / city access transfer"}
                  {offer !== undefined
                    ? ` · ${formatMoney(offer.price)} ${offer.provenance.sourceType}`
                    : ""}
                </p>
              ) : null}
              {offer !== undefined && !isTransfer ? (
                <div className="mt-2 rounded-md bg-[var(--bg)] px-3 py-2 text-sm">
                  <p className="font-medium">
                    {formatMoney(offer.price)}
                    {offerBasisLabel(offer)} · offer
                  </p>
                  <p className="mt-0.5 text-[var(--ink-muted)]">
                    {formatOfferProvenance(offer.provenance)}
                  </p>
                  {offer.bookingUrl !== undefined ? (
                    <p className="mt-1">
                      <a href={offer.bookingUrl} target="_blank" rel="noreferrer">
                        Verify / book
                      </a>
                    </p>
                  ) : null}
                </div>
              ) : null}
              {gap !== undefined ? (
                <div className="mt-3 rounded-md border border-dashed border-[var(--warn)] bg-[#fff8f0] px-3 py-2 text-sm text-[var(--warn)]">
                  {formatGap(gap)}
                  <span className="mt-0.5 block text-[var(--ink-muted)]">
                    Not zero — arrange separately; excluded from known cost.
                  </span>
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>

      <section className="mt-4 border-t border-[var(--line)] pt-4">
        <h3 className="font-semibold">Offers</h3>
        <ul className="mt-2 space-y-3">
          {trip.offers.map((offer) => (
            <li key={offer.id} className="text-sm">
              <p className="font-medium">
                {formatMoney(offer.price)}
                {offerBasisLabel(offer)} · {offer.segmentIds.length} segment
                {offer.segmentIds.length === 1 ? "" : "s"}
              </p>
              <p className="text-[var(--ink-muted)]">{formatOfferProvenance(offer.provenance)}</p>
              {offer.bookingUrl !== undefined ? (
                <a href={offer.bookingUrl} target="_blank" rel="noreferrer">
                  Verify / book
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </Panel>
  );
}
