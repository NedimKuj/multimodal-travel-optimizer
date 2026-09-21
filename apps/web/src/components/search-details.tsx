"use client";

import type { SearchTrace } from "@travel-optimizer/optimizer";

import { Panel } from "./ui/form";

export function SearchDetails({ trace }: { readonly trace: SearchTrace }) {
  const { counts, discovery, pruning, accommodation, origins, provider } = trace;

  return (
    <details className="group">
      <summary className="cursor-pointer list-none font-medium text-[var(--accent)] marker:content-none">
        <span className="underline-offset-2 group-open:underline">Search details</span>
        <span className="ml-2 text-sm font-normal text-[var(--ink-muted)]">
          how this result was found
        </span>
      </summary>
      <Panel className="mt-3 text-sm">
        <dl className="grid gap-2 sm:grid-cols-2">
          <div>
            <dt className="font-medium">Candidates built</dt>
            <dd className="text-[var(--ink-muted)]">{counts.candidatesBuilt}</dd>
          </div>
          <div>
            <dt className="font-medium">Destinations</dt>
            <dd className="text-[var(--ink-muted)]">{counts.destinations}</dd>
          </div>
          <div>
            <dt className="font-medium">Offers returned</dt>
            <dd className="text-[var(--ink-muted)]">{counts.offersReturned}</dd>
          </div>
          <div>
            <dt className="font-medium">Provider</dt>
            <dd className="text-[var(--ink-muted)]">
              {provider.descriptor.id} · {provider.status}
              {provider.metrics !== undefined
                ? ` · ${String(provider.metrics.requestCount)} requests (${provider.metrics.cache})`
                : ""}
            </dd>
          </div>
        </dl>

        <h3 className="mt-4 font-medium">Filtered out</h3>
        <ul className="mt-1 columns-1 gap-x-6 text-[var(--ink-muted)] sm:columns-2">
          <li>Wrong length / nights: {counts.rejectedNights}</li>
          <li>Outside window: {counts.rejectedOutsideWindow}</li>
          <li>Budget: {counts.rejectedBudget}</li>
          <li>Infeasible connections: {counts.rejectedInfeasible}</li>
          <li>Invalid: {counts.rejectedInvalid}</li>
          <li>Gap too far: {counts.rejectedGapTooFar}</li>
          <li>Return before arrival: {counts.rejectedReturnBeforeArrival}</li>
          <li>Stay too short: {counts.rejectedStayTooShort}</li>
          <li>Not round trip: {counts.rejectedNotRoundTrip}</li>
        </ul>

        {pruning !== undefined ? (
          <p className="mt-3 text-[var(--ink-muted)]">
            Dominance pruning: {pruning.pruned} removed of {pruning.entered} entered (
            {pruning.remaining} remaining).
          </p>
        ) : null}

        {discovery !== undefined ? (
          <p className="mt-3 text-[var(--ink-muted)]">
            Composed search · {discovery.callsPlanned} of {discovery.callBudget} call budget ·
            destinations discovered {discovery.funnel.destinationsDiscovered}, admitted{" "}
            {discovery.funnel.destinationsAdmitted}
          </p>
        ) : null}

        {origins !== undefined ? (
          <p className="mt-3 text-[var(--ink-muted)]">
            Origins queried:{" "}
            {origins.origins.map((entry) => entry.airport.iata ?? entry.airport.id).join(", ") ||
              "none"}
            {origins.skipped.length > 0
              ? ` · skipped ${String(origins.skipped.length)} alternative(s)`
              : ""}
          </p>
        ) : null}

        {accommodation !== undefined ? (
          <p className="mt-3 text-[var(--ink-muted)]">
            Accommodation:{" "}
            {accommodation.providerId ?? "no provider configured"}
            {" · "}
            shortlist {accommodation.shortlisted} · queries {accommodation.queriesMade}/
            {accommodation.queriesPlanned}
          </p>
        ) : null}

        {trace.issues.length > 0 ? (
          <div className="mt-3">
            <h3 className="font-medium">Issues</h3>
            <ul className="mt-1 list-disc pl-5 text-[var(--warn)]">
              {trace.issues.map((issue) => (
                <li key={`${issue.code}-${issue.message}`}>{issue.message}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </Panel>
    </details>
  );
}
