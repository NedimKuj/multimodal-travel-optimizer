/*
 * Great-circle distance.
 *
 * Used to decide which airports are near a place and how far a ground transfer
 * travels. It is a straight-line distance on a sphere, not a road or rail
 * distance: anything derived from it (transfer time, transfer cost) is an
 * estimate and is labelled as one.
 */

/** Mean Earth radius in kilometres (IUGG). */
const EARTH_RADIUS_KM = 6371.0088;

export interface Coordinates {
  readonly latitude: number;
  readonly longitude: number;
}

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/** Great-circle distance between two points, in kilometres. */
export function distanceKm(from: Coordinates, to: Coordinates): number {
  const latitudeDelta = toRadians(to.latitude - from.latitude);
  const longitudeDelta = toRadians(to.longitude - from.longitude);
  const fromLatitude = toRadians(from.latitude);
  const toLatitude = toRadians(to.latitude);

  // Haversine: numerically stable for the short distances we care about.
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(fromLatitude) * Math.cos(toLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}
