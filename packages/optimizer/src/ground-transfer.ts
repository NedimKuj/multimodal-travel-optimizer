import {
  money,
  transportOfferSchema,
  transportSegmentSchema,
  type CurrencyCode,
  type Location,
  type Money,
  type TransportOffer,
  type TransportSegment,
  type UtcInstant,
  type ZonedTimestamp,
} from "@travel-optimizer/domain";

/*
 * Estimated ground transfers (ADR 0011).
 *
 * No provider prices airport access, so these numbers come from a documented
 * model rather than a quote. Everything produced here is labelled `estimated`
 * and attributed to the model, never to a provider, and a trip containing one
 * aggregates to `estimated`.
 *
 * The distance is great-circle, so both time and cost are approximations of a
 * road journey. They exist so that a cheap fare into a far airport is compared
 * honestly against a dearer one into a near airport, not to quote a taxi.
 */

/** Source name recorded on estimates; deliberately not a provider id. */
export const ESTIMATE_SOURCE = "internal-estimate";

export interface GroundTransferOverride {
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly durationMinutes?: number;
  readonly costMinor?: number;
}

export interface GroundTransferConfig {
  readonly currency: CurrencyCode;
  /** Fixed overhead: waiting, boarding, walking at both ends. */
  readonly baseMinutes: number;
  /** Travel time per kilometre; 1.2 implies about 50 km/h door to door. */
  readonly minutesPerKm: number;
  readonly baseCostMinor: number;
  readonly costPerKmMinor: number;
  /** Ground transport is normally sold per person. */
  readonly perTraveler: boolean;
  /** Minutes to leave between a transfer and the transport it connects to. */
  readonly connectionBufferMinutes: number;
  /** Airports beyond this distance from their city get an explicit transfer. */
  readonly accessThresholdKm: number;
  readonly overrides: readonly GroundTransferOverride[];
}

/**
 * Deliberately rough, region-agnostic defaults. They are a starting point, not
 * researched local fares: override them where we know better.
 *
 * Sanity check at the defaults: 30 km costs about EUR 9 and takes 56 minutes;
 * 110 km costs about EUR 25 and takes 152 minutes.
 */
export const DEFAULT_GROUND_TRANSFER_CONFIG: GroundTransferConfig = {
  currency: "EUR",
  baseMinutes: 20,
  minutesPerKm: 1.2,
  baseCostMinor: 300,
  costPerKmMinor: 20,
  perTraveler: true,
  connectionBufferMinutes: 30,
  accessThresholdKm: 25,
  overrides: [],
};

export interface GroundTransferEstimate {
  readonly distanceKm: number;
  readonly durationMinutes: number;
  readonly price: Money;
  readonly overridden: boolean;
}

function findOverride(
  from: Location,
  to: Location,
  config: GroundTransferConfig,
): GroundTransferOverride | undefined {
  return config.overrides.find(
    (override) =>
      (override.fromLocationId === from.id && override.toLocationId === to.id) ||
      (override.fromLocationId === to.id && override.toLocationId === from.id),
  );
}

/** Estimates the time and cost of travelling between two places on the ground. */
export function estimateGroundTransfer(
  from: Location,
  to: Location,
  distanceKm: number,
  config: GroundTransferConfig = DEFAULT_GROUND_TRANSFER_CONFIG,
): GroundTransferEstimate {
  const override = findOverride(from, to, config);
  const durationMinutes =
    override?.durationMinutes ??
    Math.max(1, Math.round(config.baseMinutes + distanceKm * config.minutesPerKm));
  const costMinor =
    override?.costMinor ??
    Math.max(0, Math.round(config.baseCostMinor + distanceKm * config.costPerKmMinor));

  return {
    distanceKm,
    durationMinutes,
    price: money(costMinor, config.currency),
    overridden: override !== undefined,
  };
}

/** Whether an airport is far enough from its city to need an explicit transfer. */
export function needsAccessTransfer(distanceKm: number, config: GroundTransferConfig): boolean {
  return distanceKm > config.accessThresholdKm;
}

export interface GroundTransferLeg {
  readonly segment: TransportSegment;
  readonly offer: TransportOffer;
  readonly estimate: GroundTransferEstimate;
}

function shiftInstant(instant: UtcInstant, minutes: number): string {
  return new Date(Date.parse(instant) + minutes * 60_000).toISOString();
}

export interface BuildTransferInput {
  readonly id: string;
  readonly from: Location;
  readonly to: Location;
  readonly distanceKm: number;
  readonly travelers: number;
  /** Anchor: the transfer ends this long before it, or starts this long after. */
  readonly anchor: ZonedTimestamp;
  readonly anchorRole: "arrive_before" | "depart_after";
  /** Minutes to leave against the anchor; defaults to the config value. */
  readonly bufferMinutes?: number;
  readonly fetchedAt: UtcInstant;
  readonly config?: GroundTransferConfig;
}

/**
 * Builds a transfer leg around the transport it serves.
 *
 * The times are a **plan**, not a timetable: the transfer is scheduled to meet
 * the connection buffer, which is what a traveler would do. It is labelled
 * `estimated` so it is never mistaken for a departure someone published.
 */
export function buildGroundTransferLeg(input: BuildTransferInput): GroundTransferLeg {
  const config = input.config ?? DEFAULT_GROUND_TRANSFER_CONFIG;
  const estimate = estimateGroundTransfer(input.from, input.to, input.distanceKm, config);
  const buffer = input.bufferMinutes ?? config.connectionBufferMinutes;

  const [departureIso, arrivalIso] =
    input.anchorRole === "arrive_before"
      ? [
          shiftInstant(input.anchor.instant, -(estimate.durationMinutes + buffer)),
          shiftInstant(input.anchor.instant, -buffer),
        ]
      : [
          shiftInstant(input.anchor.instant, buffer),
          shiftInstant(input.anchor.instant, buffer + estimate.durationMinutes),
        ];

  const segment = transportSegmentSchema.parse({
    id: input.id,
    mode: "ground_transfer",
    origin: input.from,
    destination: input.to,
    departureAt: { instant: departureIso, timeZone: input.from.timeZone },
    arrivalAt: { instant: arrivalIso, timeZone: input.to.timeZone },
    durationMinutes: estimate.durationMinutes,
    transfers: 0,
    provider: ESTIMATE_SOURCE,
  });

  const offer = transportOfferSchema.parse({
    id: `${input.id}:estimate`,
    segmentIds: [segment.id],
    price: estimate.price,
    priceBasis: config.perTraveler
      ? { kind: "perTraveler" }
      : { kind: "total", travelers: input.travelers },
    provenance: {
      provider: ESTIMATE_SOURCE,
      providerReference: `${String(Math.round(estimate.distanceKm))}km`,
      sourceType: "estimated",
      fetchedAt: input.fetchedAt,
    },
  });

  return { segment, offer, estimate };
}
