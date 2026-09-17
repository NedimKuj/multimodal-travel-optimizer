import { locationSchema, type Location, type LocationInput } from "../location.js";

// Reference geography for unit tests only. Coordinates are approximate and
// these objects are not a production geographic dataset.

function location(input: LocationInput): Location {
  return locationSchema.parse(input);
}

export const SJJ = location({
  id: "airport:SJJ",
  type: "airport",
  name: "Sarajevo International Airport",
  countryCode: "BA",
  latitude: 43.8246,
  longitude: 18.3315,
  timeZone: "Europe/Sarajevo",
  iata: "SJJ",
});

export const VIE = location({
  id: "airport:VIE",
  type: "airport",
  name: "Vienna International Airport",
  countryCode: "AT",
  latitude: 48.1103,
  longitude: 16.5697,
  timeZone: "Europe/Vienna",
  iata: "VIE",
});

export const PRG = location({
  id: "airport:PRG",
  type: "airport",
  name: "Václav Havel Airport Prague",
  countryCode: "CZ",
  latitude: 50.1008,
  longitude: 14.26,
  timeZone: "Europe/Prague",
  iata: "PRG",
});

export const VIENNA = location({
  id: "city:vienna",
  type: "city",
  name: "Vienna",
  countryCode: "AT",
  latitude: 48.2082,
  longitude: 16.3738,
  timeZone: "Europe/Vienna",
});

export const PRAGUE = location({
  id: "city:prague",
  type: "city",
  name: "Prague",
  countryCode: "CZ",
  latitude: 50.0755,
  longitude: 14.4378,
  timeZone: "Europe/Prague",
});

export const WIEN_HBF = location({
  id: "station:wien-hbf",
  type: "station",
  name: "Wien Hauptbahnhof",
  countryCode: "AT",
  latitude: 48.1851,
  longitude: 16.3776,
  timeZone: "Europe/Vienna",
});

export const PRAHA_HLAVNI = location({
  id: "station:praha-hlavni",
  type: "station",
  name: "Praha hlavní nádraží",
  countryCode: "CZ",
  latitude: 50.0833,
  longitude: 14.4353,
  timeZone: "Europe/Prague",
});
