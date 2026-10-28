export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json({ buildId: process.env.FTOWN_UI_BUILD_ID }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}
