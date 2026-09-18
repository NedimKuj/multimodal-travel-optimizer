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
  /**
   * Great-circle distance understates a road journey. Distances are multiplied
   * by this before estimating time, cost and the access threshold.
   */
  readonly roadDetourFactor: number;
  /** Airports beyond this road distance from their city get a transfer. */
  readonly accessThresholdKm: number;
  readonly overrides: readonly GroundTransferOverride[];
}

/**
 * Deliberately rough, region-agnostic defaults. They are a starting point, not
 * researched local fares: override them where we know better.
 *
 * Sanity check at the defaults, on straight-line distance: 23 km (Fiumicino to
 * Rome) becomes about 30 km of road, EUR 9 and 56 minutes; 110 km (Memmingen to
 * Munich) becomes about 143 km, EUR 32 and 192 minutes.
 */
export const DEFAULT_GROUND_TRANSFER_CONFIG: GroundTransferConfig = {
  currency: "EUR",
  baseMinutes: 20,
  minutesPerKm: 1.2,
  baseCostMinor: 300,
  costPerKmMinor: 20,
  perTraveler: true,
  connectionBufferMinutes: 30,
  // A straight line between two points is not a road. 1.3 is a common
  // detour approximation and keeps the threshold honest: Fiumicino is 23 km
  // from Rome as the crow flies but about 32 km to drive.
  roadDetourFactor: 1.3,
  accessThresholdKm: 20,
  overrides: [],
};

export interface GroundTransferEstimate {
  /** Straight-line distance, as measured. */
  readonly distanceKm: number;
  /** Estimated road distance: `distanceKm` times the detour factor. */
  readonly roadDistanceKm: number;
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
  const roadDistanceKm = distanceKm * config.roadDetourFactor;
  const durationMinutes =
    override?.durationMinutes ??
    Math.max(1, Math.round(config.baseMinutes + roadDistanceKm * config.minutesPerKm));
  const costMinor =
    override?.costMinor ??
    Math.max(0, Math.round(config.baseCostMinor + roadDistanceKm * config.costPerKmMinor));

  return {
    distanceKm,
    roadDistanceKm,
    durationMinutes,
    price: money(costMinor, config.currency),
    overridden: override !== undefined,
  };
}

/**
 * Whether an airport is far enough from its city to need an explicit transfer.
 *
 * Compared on estimated road distance, because that is the journey the
 * traveler actually makes.
 */
export function needsAccessTransfer(distanceKm: number, config: GroundTransferConfig): boolean {
  return distanceKm * config.roadDetourFactor > config.accessThresholdKm;
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
      providerReference: `${String(Math.round(estimate.roadDistanceKm))}km road (est.)`,
      sourceType: "estimated",
      fetchedAt: input.fetchedAt,
    },
  });

  return { segment, offer, estimate };
}
