import { describe, expect, it } from "vitest";

import { locationSchema, type LocationInput } from "./location.js";

const sarajevoAirport: LocationInput = {
  id: "airport:SJJ",
  type: "airport",
  name: "Sarajevo International Airport",
  countryCode: "BA",
  latitude: 43.8246,
  longitude: 18.3315,
  timeZone: "Europe/Sarajevo",
  iata: "SJJ",
};

describe("locationSchema", () => {
  it("accepts a normalized airport", () => {
    expect(locationSchema.parse(sarajevoAirport)).toEqual(sarajevoAirport);
  });

  it("accepts cities and stations without IATA codes", () => {
    const { iata: _iata, ...withoutIata } = sarajevoAirport;
    expect(locationSchema.safeParse({ ...withoutIata, type: "city" }).success).toBe(true);
    expect(locationSchema.safeParse({ ...withoutIata, type: "station" }).success).toBe(true);
  });

  it("requires a valid IANA time zone", () => {
    const { timeZone: _timeZone, ...withoutZone } = sarajevoAirport;
    expect(locationSchema.safeParse(withoutZone).success).toBe(false);
    expect(locationSchema.safeParse({ ...sarajevoAirport, timeZone: "+01:00" }).success).toBe(
      false,
    );
  });

  it.each([
    ["type", "port"],
    ["countryCode", "BIH"],
    ["countryCode", "ba"],
    ["iata", "sjj"],
    ["iata", "LYSA"],
    ["latitude", 91],
    ["longitude", -181],
    ["name", "  "],
    ["id", ""],
  ])("rejects invalid %s %j", (field, value) => {
    expect(locationSchema.safeParse({ ...sarajevoAirport, [field]: value }).success).toBe(false);
  });
});
