"use client";

import { SELECTABLE_TRANSPORT_MODES, type SelectableTransportMode } from "@travel-optimizer/domain";

import {
  DEFAULT_SEARCH_FORM,
  type SearchFormState,
  type TripShape,
} from "../lib/map-search-request";
import { Button, CheckboxRow, Field, Panel, TextInput, TextSelect } from "./ui/form";

export function SearchForm({
  value,
  onChange,
  onSubmit,
  busy,
  error,
}: {
  readonly value: SearchFormState;
  readonly onChange: (next: SearchFormState) => void;
  readonly onSubmit: () => void;
  readonly busy: boolean;
  readonly error: string | undefined;
}) {
  const composeForced =
    value.tripShape === "one_way" || value.allowOpenJaw || value.allowMultiCity;

  function patch(partial: Partial<SearchFormState>): void {
    onChange({ ...value, ...partial });
  }

  function toggleMode(mode: SelectableTransportMode): void {
    const has = value.transportModes.includes(mode);
    const next = has
      ? value.transportModes.filter((entry) => entry !== mode)
      : SELECTABLE_TRANSPORT_MODES.filter(
          (entry) => entry === mode || value.transportModes.includes(entry),
        );
    patch({ transportModes: next });
  }

  return (
    <Panel>
      <form
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Origin" hint="IATA airport code. Default SJJ (Sarajevo).">
            <TextInput
              value={value.origin}
              onChange={(event) => {
                patch({ origin: event.target.value.toUpperCase() });
              }}
              maxLength={3}
              autoComplete="off"
              required
            />
          </Field>

          <div className="flex flex-col gap-2">
            <CheckboxRow
              checked={value.destinationAnywhere}
              onChange={(destinationAnywhere) => {
                patch({ destinationAnywhere });
              }}
              label="Anywhere"
              hint="Not a destination code — searches all reachable destinations."
            />
            {!value.destinationAnywhere ? (
              <Field label="Destination">
                <TextInput
                  value={value.destination}
                  onChange={(event) => {
                    patch({ destination: event.target.value.toUpperCase() });
                  }}
                  maxLength={3}
                  placeholder="e.g. VIE"
                  autoComplete="off"
                  required
                />
              </Field>
            ) : null}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Trip shape">
            <TextSelect
              value={value.tripShape}
              onChange={(event) => {
                const tripShape =
                  event.target.value === "one_way" ? "one_way" : "round_trip";
                const next: TripShape = tripShape;
                patch({ tripShape: next });
              }}
            >
              <option value="round_trip">Round trip</option>
              <option value="one_way">One-way</option>
            </TextSelect>
          </Field>
          <Field label="Departure">
            <TextInput
              type="date"
              value={value.departureDate}
              onChange={(event) => {
                patch({ departureDate: event.target.value });
              }}
              required
            />
          </Field>
          {value.tripShape === "round_trip" ? (
            <Field label="Return" hint="End of travel window when nights are set.">
              <TextInput
                type="date"
                value={value.returnDate}
                onChange={(event) => {
                  patch({ returnDate: event.target.value });
                }}
                required
              />
            </Field>
          ) : (
            <Field
              label="End date"
              hint="Checkout boundary for a one-way. Never widened by flexibility."
            >
              <TextInput
                type="date"
                value={value.endDate}
                onChange={(event) => {
                  patch({ endDate: event.target.value });
                }}
                required
              />
            </Field>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Flexibility (± days)" hint="Example: 26 Dec → 3 Jan ±2 days.">
            <TextInput
              type="number"
              min={0}
              value={value.flexibilityDays}
              onChange={(event) => {
                patch({ flexibilityDays: Number(event.target.value) });
              }}
            />
          </Field>
          <Field label="Min nights" hint="Leave blank for exact dates.">
            <TextInput
              type="number"
              min={1}
              value={value.minNights}
              onChange={(event) => {
                patch({ minNights: event.target.value });
              }}
              placeholder="5"
            />
          </Field>
          <Field label="Max nights" hint="Example: 5–7 nights.">
            <TextInput
              type="number"
              min={1}
              value={value.maxNights}
              onChange={(event) => {
                patch({ maxNights: event.target.value });
              }}
              placeholder="7"
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Travelers">
            <TextInput
              type="number"
              min={1}
              value={value.travelers}
              onChange={(event) => {
                patch({ travelers: Number(event.target.value) });
              }}
            />
          </Field>
          <Field
            label="Budget"
            hint={
              value.budgetKind === "perPerson"
                ? "Per-person budget (optimizer default)."
                : "Total-trip budget for all travelers."
            }
          >
            <TextInput
              value={value.budgetAmount}
              onChange={(event) => {
                patch({ budgetAmount: event.target.value });
              }}
              placeholder="700"
              inputMode="decimal"
            />
          </Field>
          <Field label="Budget basis">
            <TextSelect
              value={value.budgetKind}
              onChange={(event) => {
                patch({
                  budgetKind: event.target.value === "total" ? "total" : "perPerson",
                });
              }}
            >
              <option value="perPerson">Per person</option>
              <option value="total">Total trip</option>
            </TextSelect>
          </Field>
          <Field label="Currency">
            <TextInput
              value={value.currency}
              onChange={(event) => {
                patch({ currency: event.target.value.toUpperCase() });
              }}
              maxLength={3}
            />
          </Field>
        </div>

        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">Transport modes</legend>
          <p className="mb-1 text-xs text-[var(--ink-muted)]">
            Mapped into the optimizer request. Only flights have a licensed provider today;
            train/bus yields no offers until a provider exists.
          </p>
          {SELECTABLE_TRANSPORT_MODES.map((mode) => (
            <CheckboxRow
              key={mode}
              checked={value.transportModes.includes(mode)}
              onChange={() => {
                toggleMode(mode);
              }}
              label={mode.charAt(0).toUpperCase() + mode.slice(1)}
            />
          ))}
        </fieldset>

        <fieldset className="grid gap-2 sm:grid-cols-2">
          <legend className="mb-1 text-sm font-medium sm:col-span-2">Routing</legend>
          <CheckboxRow
            checked={value.allowOpenJaw}
            onChange={(allowOpenJaw) => {
              patch({ allowOpenJaw });
            }}
            label="Open-jaw"
            hint="Fly home from a different city. Inter-city sector may be unpriced."
          />
          <CheckboxRow
            checked={value.allowMultiCity}
            onChange={(allowMultiCity) => {
              patch({ allowMultiCity });
            }}
            label="Multi-city"
            hint="Allow a second city stay on the way."
          />
          <CheckboxRow
            checked={value.alternativeAirports}
            onChange={(alternativeAirports) => {
              patch({ alternativeAirports });
            }}
            label="Alternative airports"
            hint="Also search nearby origin airports (costs provider calls)."
          />
          <CheckboxRow
            checked={composeForced || value.compose}
            onChange={(compose) => {
              if (!composeForced) patch({ compose });
            }}
            disabled={composeForced}
            label="Compose from one-way fares"
            hint={
              composeForced
                ? "Required for one-way, open-jaw, and multi-city."
                : "Broader destination discovery than provider round-trip fares."
            }
          />
        </fieldset>

        {error !== undefined ? (
          <p className="rounded-md border border-[var(--danger)]/30 bg-red-50 px-3 py-2 text-sm text-[var(--danger)]">
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={busy}>
            {busy ? "Searching…" : "Explore trips"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() => {
              onChange(DEFAULT_SEARCH_FORM);
            }}
          >
            Reset defaults
          </Button>
        </div>
      </form>
    </Panel>
  );
}
