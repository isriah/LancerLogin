import type { Page } from "@playwright/test";
import { buildCarpoolShare, carpoolShareRows, type CarpoolShareInput } from "../packages/shared/src/carpool-share.ts";
import { carpoolCsv } from "../apps/api/src/carpool-csv.ts";

export async function mockCarpoolShare(page: Page, saved: () => any) {
  await page.route(/\/admin\/carpool\/plans\/[^/?]+\/share(?:\?.*)?$/, route => {
    const detail = saved(); const query = new URL(route.request().url()).searchParams;
    if (!detail || Number(query.get("planRevision")) !== detail.plan.revision) return route.fulfill({ status: 409, json: { error: "The plan changed. Refresh the saved plan before sharing." } });
    const normalized = { ...detail, plan: { timeZone: "UTC", outboundDepartureAt: null, returnDepartureAt: null, tripScope: "both", groupSettings: [], ...detail.plan } } as CarpoolShareInput;
    let preview: ReturnType<typeof buildCarpoolShare>; try { preview = buildCarpoolShare(normalized, { direction: query.get("direction") as "outbound" | "return", driverId: query.get("driverId") || undefined, unsaved: query.get("unsaved") === "1" }, "2026-10-14T14:30:00.000Z"); } catch (error) { return route.fulfill({ status: 400, json: { error: (error as Error).message } }); }
    return route.fulfill({ json: { preview, filename: "synthetic-" + preview.audience + "-v" + preview.version + ".csv", content: carpoolCsv(carpoolShareRows(preview)) } });
  });
}
