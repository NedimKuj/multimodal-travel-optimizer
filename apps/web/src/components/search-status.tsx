"use client";

import type { SearchStageRecord } from "@travel-optimizer/optimizer";

import { SEARCH_STAGE_LABELS } from "../lib/format";
import { Panel } from "./ui/form";

export type SearchUiPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "preparing" }
  | { readonly kind: "searching" }
  | { readonly kind: "complete"; readonly stages: readonly SearchStageRecord[] }
  | { readonly kind: "error"; readonly message: string };

/**
 * Truthful search state only. No fake percentages.
 * Stages listed after completion are those the backend actually recorded.
 */
export function SearchStatus({ phase }: { readonly phase: SearchUiPhase }) {
  if (phase.kind === "idle") return null;

  return (
    <Panel className="border-[var(--accent)]/25 bg-[#f2f8f5]">
      {phase.kind === "preparing" ? (
        <p className="font-medium text-[var(--accent)]">Preparing search</p>
      ) : null}
      {phase.kind === "searching" ? (
        <div>
          <p className="font-medium text-[var(--accent)]">Running optimizer search</p>
          <p className="mt-1 text-sm text-[var(--ink-muted)]">
            Waiting for the server. Progress stages appear when the search finishes —
            percentages are not invented while waiting.
          </p>
        </div>
      ) : null}
      {phase.kind === "complete" ? (
        <div>
          <p className="font-medium text-[var(--accent)]">Search complete</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-[var(--ink-muted)]">
            {phase.stages.map((stage) => (
              <li key={`${stage.stage}-${stage.startedAt}`}>
                {SEARCH_STAGE_LABELS[stage.stage]}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      {phase.kind === "error" ? (
        <p className="font-medium text-[var(--danger)]">{phase.message}</p>
      ) : null}
    </Panel>
  );
}
