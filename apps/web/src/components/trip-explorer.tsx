"use client";

import { useState } from "react";

import type { DestinationResult, RankedCandidate, SearchTrace } from "@travel-optimizer/optimizer";

import {
  DEFAULT_SEARCH_FORM,
  mapSearchFormToRequest,
  mappedToApiBody,
  type SearchFormState,
} from "../lib/map-search-request";
import { ItineraryDetails } from "./itinerary-details";
import { ResultsList } from "./results-list";
import { SearchDetails } from "./search-details";
import { SearchForm } from "./search-form";
import { SearchStatus, type SearchUiPhase } from "./search-status";

interface SearchSuccessResponse {
  readonly searchId: string;
  readonly status: SearchTrace["status"];
  readonly stages: SearchTrace["stages"];
  readonly trace: SearchTrace;
}

interface SearchErrorResponse {
  readonly message: string;
  readonly issues?: readonly { readonly code: string; readonly message: string }[];
}

function isSearchSuccess(value: unknown): value is SearchSuccessResponse {
  if (typeof value !== "object" || value === null) return false;
  if (!("trace" in value) || !("stages" in value) || !("searchId" in value)) return false;
  return typeof value.searchId === "string";
}

function parseErrorPayload(
  value: unknown,
): { readonly message: string; readonly issues: readonly string[] } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value;
  if (!("message" in record) || typeof record.message !== "string") return undefined;
  const message = record.message;
  const issues: string[] = [];
  if ("issues" in record && Array.isArray(record.issues)) {
    for (const entry of record.issues) {
      const issue: unknown = entry;
      if (typeof issue !== "object" || issue === null || !("message" in issue)) continue;
      if (typeof issue.message !== "string") continue;
      issues.push(issue.message);
    }
  }
  return { message, issues };
}

export function TripExplorer() {
  const [form, setForm] = useState<SearchFormState>(DEFAULT_SEARCH_FORM);
  const [phase, setPhase] = useState<SearchUiPhase>({ kind: "idle" });
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [trace, setTrace] = useState<SearchTrace | undefined>(undefined);
  const [selectedKey, setSelectedKey] = useState<string | undefined>(undefined);
  const [selected, setSelected] = useState<
    { destination: DestinationResult; candidate: RankedCandidate } | undefined
  >(undefined);

  const busy = phase.kind === "preparing" || phase.kind === "searching";

  async function runSearch(): Promise<void> {
    setFormError(undefined);
    setSelected(undefined);
    setSelectedKey(undefined);

    const mapped = mapSearchFormToRequest(form);
    if (!mapped.ok) {
      setFormError(mapped.issues.map((issue) => issue.message).join("; "));
      setPhase({ kind: "error", message: "Fix the search form and try again." });
      return;
    }

    setPhase({ kind: "preparing" });
    setTrace(undefined);

    const body = mappedToApiBody(mapped.mapped);
    setPhase({ kind: "searching" });

    try {
      const response = await fetch("/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      const payload: unknown = await response.json();

      if (!response.ok) {
        const errorPayload = parseErrorPayload(payload);
        const message = errorPayload?.message ?? `Search failed (${String(response.status)})`;
        const issues = errorPayload?.issues ?? [];
        setPhase({
          kind: "error",
          message: issues.length > 0 ? `${message}: ${issues.join("; ")}` : message,
        });
        return;
      }

      if (!isSearchSuccess(payload)) {
        setPhase({ kind: "error", message: "Unexpected search response shape" });
        return;
      }

      setTrace(payload.trace);
      setPhase({ kind: "complete", stages: payload.stages });
    } catch (error) {
      setPhase({
        kind: "error",
        message: error instanceof Error ? error.message : "Network error during search",
      });
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <SearchForm
        value={form}
        onChange={setForm}
        onSubmit={() => {
          void runSearch();
        }}
        busy={busy}
        error={formError}
      />

      <SearchStatus phase={phase} />

      {trace !== undefined ? (
        <>
          {trace.status === "partial" ? (
            <p className="rounded-md border border-[var(--warn)]/40 bg-[#fff8f0] px-3 py-2 text-sm text-[var(--warn)]">
              Partial results — some provider calls failed. Showing what could be priced.
            </p>
          ) : null}
          {trace.status === "failed" ? (
            <p className="rounded-md border border-[var(--danger)]/30 bg-red-50 px-3 py-2 text-sm text-[var(--danger)]">
              Search failed.{" "}
              {trace.provider.failures.map((failure) => failure.message).join("; ") ||
                "No candidates could be produced."}
            </p>
          ) : null}

          <ResultsList
            trace={trace}
            selectedKey={selectedKey}
            onSelect={(key, destination, candidate) => {
              setSelectedKey(key);
              setSelected({ destination, candidate });
            }}
          />

          {selected !== undefined ? (
            <ItineraryDetails
              destination={selected.destination}
              candidate={selected.candidate}
            />
          ) : null}

          <SearchDetails trace={trace} />
        </>
      ) : null}
    </div>
  );
}

// Keep error response type referenced for documentation of the API contract.
export type { SearchErrorResponse };
