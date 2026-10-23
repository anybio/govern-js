import { getGovern } from "../../../lib/govern";

export const runtime = "nodejs";

/**
 * Stand in for a reviewer. Only the mock server exposes the /__mock/ routes;
 * against the real API a person releases or rejects from the console, and
 * the application learns about it through `waitForRelease` or the webhook.
 */
export async function POST(request: Request) {
  const { decisionId, action } = (await request.json()) as { decisionId: string; action: "release" | "reject" };
  if (!decisionId || (action !== "release" && action !== "reject")) {
    return Response.json({ error: "decisionId and action (release | reject) are required" }, { status: 400 });
  }
  const base = process.env.ANYBIO_GOVERN_BASE_URL;
  if (!base) return Response.json({ error: "reviewer stand-in is available only against the mock server" }, { status: 400 });

  const mock = await fetch(`${base}/__mock/decisions/${encodeURIComponent(decisionId)}/${action}`, { method: "POST" });
  if (!mock.ok) return Response.json({ error: `mock answered ${mock.status}` }, { status: 502 });

  // The same poll path a real integration uses; here it resolves at once.
  const result = await getGovern().waitForRelease(decisionId, { timeoutMs: 5_000, intervalMs: 250 });
  if (!result) return Response.json({ error: "timed out waiting for the review" }, { status: 504 });
  return Response.json({
    reviewState: result.state,
    releasedContent: result.state === "released" ? result.content : null,
  });
}
