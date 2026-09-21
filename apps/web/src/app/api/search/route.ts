import { NextResponse } from "next/server";

import {
  apiBodyToSearchInput,
  searchApiBodySchema,
} from "../../../lib/map-search-request";
import { runTripSearch } from "../../../server/run-search";

export const runtime = "nodejs";
/** Searches can run for several minutes against the provider call budget. */
export const maxDuration = 300;

/**
 * POST /api/search — execute a real optimizer search.
 *
 * Synchronous: returns the full SearchTrace when complete. Progress during the
 * request is not streamed; the response includes the stages that actually ran.
 */
export async function POST(request: Request): Promise<Response> {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json(
      { message: "Request body must be JSON", issues: [] },
      { status: 400 },
    );
  }

  const parsed = searchApiBodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      {
        message: "Invalid search body",
        issues: parsed.error.issues.map((issue) => ({
          code: "INVALID_SEARCH_BODY",
          message: `${issue.path.map(String).join(".") || "body"}: ${issue.message}`,
        })),
      },
      { status: 400 },
    );
  }

  const mapped = apiBodyToSearchInput(parsed.data);
  if (!mapped.ok) {
    return NextResponse.json(
      { message: "Invalid search body", issues: mapped.issues },
      { status: 400 },
    );
  }

  const result = await runTripSearch(mapped.mapped);
  if (!result.ok) {
    return NextResponse.json(
      { message: result.message, issues: result.issues },
      { status: result.status },
    );
  }

  return NextResponse.json({
    searchId: result.trace.searchId,
    status: result.trace.status,
    stages: result.trace.stages,
    trace: result.trace,
  });
}
