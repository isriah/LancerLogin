import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { adminApi, status } from "./virtual-kiosk";

// Member PINs at a web kiosk with Require PIN, against the real local Worker and dashboard: a member with no PIN asks
// for approval and chooses one after an Operator approves on the dashboard; a wrong PIN; a PIN set from the kiosk's
// maintenance; the lockout after 3 wrong tries and the unlock; offline, a wrong try counted on the device and a right PIN
// checked against the cached hash, both synced once the network is back; a reset from maintenance; and the cached
// hashes removed when Require PIN is turned off. Test Students G (1007) and H (1008) are scanned only here, once each.
test.describe.configure({ mode: "serial" });
const settingsPin = "246810";
const kioskName = "Test web kiosk D";
const pinG = "4821";
const pinH = "5930";

async function pressAll(page: Page, keys: string) {
  for (const key of keys) await page.getByRole("button", { name: key, exact: true }).click();
}

/** Types a member ID on the keypad, then Confirm on "Is this you?". */
async function identify(page: Page, memberId: string, name: string) {
  await expect(page.getByRole("heading", { name: /Enter your\s*member ID/ })).toBeVisible({ timeout: 20_000 });
  await pressAll(page, memberId);
  await page.getByRole("button", { name: "Enter", exact: true }).click();
  await expect(page.getByText("Is this you?")).toBeVisible();
  await expect(page.getByText(name)).toBeVisible();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
}

async function enterPin(page: Page, pin: string) {
  await expect(page.getByRole("heading", { name: "Enter your PIN" })).toBeVisible({ timeout: 20_000 });
  await pressAll(page, pin);
  await page.getByRole("button", { name: "Enter", exact: true }).click();
}

/** Holds the organization name for 3 seconds and enters the settings PIN. */
async function openMaintenance(page: Page) {
  const box = (await page.getByTestId("wk-brand-hold").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(3_500);
  await page.mouse.up();
  await expect(page.getByRole("heading", { name: "Settings PIN" })).toBeVisible();
  await pressAll(page, settingsPin);
  await page.getByRole("button", { name: "Enter", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Maintenance" })).toBeVisible();
}

/** A member as the kiosk keeps them in its cached roster (IndexedDB), with their PIN hash and lock. */
async function cachedMember(page: Page, memberId: string) {
  return page.evaluate(async (id) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("lancerlogin-web-kiosk"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const roster = await new Promise<{ members?: { memberId: string; pin?: unknown; pinLockedUntil?: string | null }[] } | undefined>((resolve, reject) => {
      const request = database.transaction("state").objectStore("state").get("roster"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    database.close();
    return roster?.members?.find((member) => member.memberId === id);
  }, memberId);
}

async function putAsAdmin(request: APIRequestContext, path: string, data: object) {
  const { apiUrl } = await status(request);
  const response = await request.put(`${apiUrl}${path}`, { headers: { origin: "http://localhost:" + (Number(new URL(apiUrl).port) + 1) }, data });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

test("a web kiosk with Require PIN sets up a PIN with an Operator's approval, refuses wrong PINs, locks and unlocks, and checks a PIN offline", async ({ page, context, request }) => {
  const api = await adminApi(request);
  const { dashboardUrl } = await status(request);
  expect(dashboardUrl).toBeTruthy();
  await page.setViewportSize({ width: 1024, height: 600 });

  // Pair, then turn on Require PIN from the dashboard API.
  const created = await api.post("/admin/pairing-codes", { kioskName, kind: "web" });
  await page.goto(`${dashboardUrl}/kiosk#code=${created.code}`);
  await expect(page.getByRole("heading", { name: "Pair this kiosk" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await expect(page.getByText("Choose a settings PIN")).toBeVisible({ timeout: 20_000 });
  await pressAll(page, settingsPin);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await pressAll(page, settingsPin);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Enter your\s*member ID/ })).toBeVisible({ timeout: 20_000 });
  const kioskId = (await api.get("/admin/kiosks")).kiosks.find((item: { name: string; active: number }) => item.name === kioskName && item.active).id;
  await api.patch(`/admin/kiosks/${kioskId}/authentication-method`, { authenticationMethod: "member_id", memberLookup: "entry", requirePin: true });
  expect((await api.get("/admin/kiosks")).kiosks.find((item: { id: string }) => item.id === kioskId)).toMatchObject({ requirePin: true });
  await page.reload();
  await expect(page.getByText("Online", { exact: true })).toBeVisible({ timeout: 30_000 });
  // The roster now carries PIN data: none for G yet.
  await expect.poll(async () => (await cachedMember(page, "1007"))?.pin, { timeout: 30_000 }).toBeNull();

  const meeting = (await api.get("/meetings")).meetings.find((item: { title: string }) => item.title === "Test meeting A");
  // The meeting's attendance lists every member; a recorded scan has an arrival.
  const attendanceFor = async (memberId: string) => (await api.get(`/attendance?meetingId=${encodeURIComponent(meeting.id)}`)).attendance.filter((row: { externalId: string; checkedInAt?: string | null }) => row.externalId === memberId && row.checkedInAt);
  const rosterIdFor = async (memberId: string) => (await api.get("/admin/members")).members.find((item: { memberId: string }) => item.memberId === memberId).id as string;

  // G has no PIN: ask for approval, approve on the dashboard, choose a PIN twice, and the scan is recorded.
  await identify(page, "1007", "Test Student G");
  await expect(page.getByRole("heading", { name: "You don't have a PIN yet" })).toBeVisible();
  await page.getByRole("button", { name: "Ask for approval", exact: true }).click();
  await expect(page.getByText("Waiting for an Operator or Admin to approve in the dashboard")).toBeVisible({ timeout: 20_000 });
  let requestId = "";
  await expect.poll(async () => {
    const { requests } = await api.get(`/admin/kiosks/${kioskId}/pin-requests`);
    requestId = requests.find((item: { member: { memberId: string } }) => item.member.memberId === "1007")?.id ?? "";
    return requestId;
  }, { timeout: 20_000 }).not.toBe("");
  await api.post(`/admin/pin-requests/${requestId}/approve`, {});
  await expect(page.getByRole("heading", { name: "Choose a PIN" })).toBeVisible({ timeout: 20_000 });
  await pressAll(page, pinG);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Type the PIN again" })).toBeVisible();
  await pressAll(page, pinG);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Welcome" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Test Student G")).toBeVisible();
  const rosterG = await rosterIdFor("1007");
  expect((await api.get(`/admin/members/${rosterG}/pin`)).pin).toMatchObject({ set: true, setKioskName: kioskName });
  await expect.poll(async () => (await attendanceFor("1007")).length, { timeout: 20_000 }).toBe(1);

  // A wrong PIN: "Wrong PIN", and nothing recorded. Lockout is off, so no lockout line.
  await expect.poll(async () => Boolean((await cachedMember(page, "1007"))?.pin), { timeout: 30_000 }).toBe(true);
  await identify(page, "1007", "Test Student G");
  await enterPin(page, "1111");
  await expect(page.getByRole("heading", { name: "Wrong PIN" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Try again, or ask an Operator to reset it.")).toBeVisible();
  await expect(page.getByText(/PIN locked|tries left/)).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await attendanceFor("1007")).toHaveLength(1);

  // An Operator sets H's PIN from the kiosk's maintenance with its settings PIN.
  await openMaintenance(page);
  await page.getByRole("button", { name: "Set member PIN", exact: true }).click();
  await pressAll(page, "1008");
  await page.getByRole("button", { name: "Enter", exact: true }).click();
  await expect(page.getByText("Test Student H")).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await pressAll(page, pinH);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await pressAll(page, pinH);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("heading", { name: "PIN set" })).toBeVisible({ timeout: 20_000 });
  // The member holds the kiosk by now, so Done goes to the start screen and never shows them the maintenance menu.
  await expect(page.getByRole("button", { name: "Back to maintenance", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Enter your\s*member ID/ })).toBeVisible();
  const rosterH = await rosterIdFor("1008");
  expect((await api.get(`/admin/members/${rosterH}/pin`)).pin).toMatchObject({ set: true });
  await expect.poll(async () => Boolean((await cachedMember(page, "1008"))?.pin), { timeout: 30_000 }).toBe(true);

  // Lockout on: 3 wrong tries lock H for 15 minutes.
  await putAsAdmin(request, "/admin/settings/pin-lockout", { enabled: true, attempts: 3, minutes: 15 });
  await identify(page, "1008", "Test Student H");
  await enterPin(page, "1111");
  await expect(page.getByRole("heading", { name: "Wrong PIN" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("2 tries left before the PIN locks")).toBeVisible();
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await enterPin(page, "2222");
  await expect(page.getByText("1 try left before the PIN locks")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await enterPin(page, "3333");
  await expect(page.getByRole("heading", { name: "Wrong PIN" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/PIN locked until \d{1,2}:\d{2}/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again", exact: true })).toHaveCount(0);
  expect((await api.get(`/admin/members/${rosterH}/pin`)).pin.lockedUntil).toBeTruthy();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  // Locked, H is refused before typing a PIN, even with the right one.
  await identify(page, "1008", "Test Student H");
  await expect(page.getByRole("heading", { name: "PIN locked" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Done", exact: true }).click();
  expect(await attendanceFor("1008")).toHaveLength(0);

  // Unlocked on the dashboard; the kiosk's roster picks it up.
  await api.post(`/admin/members/${rosterH}/pin/unlock`, {});
  expect((await api.get(`/admin/members/${rosterH}/pin`)).pin).toMatchObject({ lockedUntil: null, failedAttempts: 0 });
  await page.reload();
  await expect(page.getByText("Online", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => { const cached = await cachedMember(page, "1008"); return Boolean(cached?.pin) && !cached?.pinLockedUntil; }, { timeout: 30_000 }).toBe(true);

  // Offline: the PIN is checked against the cached hash, and the scan is saved for sync.
  // A wrong try first is counted on the device and reported once it syncs.
  await context.setOffline(true);
  await identify(page, "1008", "Test Student H");
  await enterPin(page, "1111");
  await expect(page.getByRole("heading", { name: "Wrong PIN" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await enterPin(page, pinH);
  await expect(page.getByText("Saved for sync")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Welcome" })).toBeVisible();
  await expect(page.getByText("Offline · 1 waiting")).toBeVisible({ timeout: 20_000 });

  // Back online: the queued scan reaches the server once.
  await context.setOffline(false);
  await expect(page.getByText("Online", { exact: true })).toBeVisible({ timeout: 60_000 });
  const kioskRecord = async () => (await api.get("/admin/kiosks")).kiosks.find((item: { id: string }) => item.id === kioskId);
  await expect.poll(async () => (await kioskRecord())?.pendingEvents, { timeout: 90_000 }).toBe(0);
  await expect.poll(async () => (await attendanceFor("1008")).length, { timeout: 30_000 }).toBe(1);
  await expect.poll(async () => (await api.get(`/admin/members/${rosterH}/pin`)).pin.failedAttempts, { timeout: 90_000 }).toBe(1);
  await expect.poll(async () => (await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("lancerlogin-web-kiosk"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const failures = await new Promise<unknown[] | undefined>((resolve, reject) => { const request = database.transaction("state").objectStore("state").get("pinFailures"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    database.close();
    return failures?.length ?? 0;
  })), { timeout: 30_000 }).toBe(0);

  // An Operator resets G's PIN from maintenance.
  await openMaintenance(page);
  await page.getByRole("button", { name: "Reset member PIN", exact: true }).click();
  await pressAll(page, "1007");
  await page.getByRole("button", { name: "Enter", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Reset Test Student G's PIN?" })).toBeVisible();
  await page.getByRole("button", { name: "Reset PIN", exact: true }).click();
  await expect(page.getByRole("heading", { name: "PIN reset" })).toBeVisible({ timeout: 20_000 });
  expect((await api.get(`/admin/members/${rosterG}/pin`)).pin).toMatchObject({ set: false });
  await page.getByRole("button", { name: "Back to maintenance", exact: true }).click();
  await page.getByRole("button", { name: "Back", exact: true }).click();

  // Turning Require PIN off removes the cached hashes from the device.
  await putAsAdmin(request, "/admin/settings/pin-lockout", { enabled: false, attempts: 5, minutes: 15 });
  await api.patch(`/admin/kiosks/${kioskId}/authentication-method`, { authenticationMethod: "member_id", memberLookup: "entry", requirePin: false });
  await page.reload();
  await expect(page.getByText("Online", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => { const cached = await cachedMember(page, "1008"); return cached ? "pin" in cached || "pinLockedUntil" in cached : undefined; }, { timeout: 30_000 }).toBe(false);
});

/** The wrong PIN tries the kiosk keeps (IndexedDB) until the server has answered a report of them. */
async function keptPinFailures(page: Page) {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("lancerlogin-web-kiosk"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const failures = await new Promise<{ memberId: string; count: number; report?: { id: string; count: number } }[] | undefined>((resolve, reject) => { const request = database.transaction("state").objectStore("state").get("pinFailures"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    database.close();
    return (failures ?? []).map((item) => ({ memberId: item.memberId, count: item.count, ...(item.report ? { report: { id: item.report.id, count: item.report.count } } : {}) }));
  });
}

test("a web kiosk resends a wrong-PIN report whose answer was lost under the same id, and the server counts each try once", async ({ page, context, request }) => {
  const api = await adminApi(request);
  const { dashboardUrl } = await status(request);
  expect(dashboardUrl).toBeTruthy();
  await page.setViewportSize({ width: 1024, height: 600 });
  // H keeps the PIN an Operator set in the scenario above. H's count starts at zero, and lockout stays off, so every
  // wrong try is only counted.
  const rosterH = (await api.get("/admin/members")).members.find((item: { memberId: string }) => item.memberId === "1008").id as string;
  expect((await api.get(`/admin/members/${rosterH}/pin`)).pin, "the scenario above leaves Test Student H with a PIN").toMatchObject({ set: true });
  await putAsAdmin(request, "/admin/settings/pin-lockout", { enabled: false, attempts: 5, minutes: 15 });
  await api.post(`/admin/members/${rosterH}/pin/unlock`, {});
  const failedAttempts = async () => (await api.get(`/admin/members/${rosterH}/pin`)).pin.failedAttempts;
  expect(await failedAttempts()).toBe(0);

  // A second web kiosk with Require PIN: each scenario has its own browser storage, so the one above is gone.
  const secondKiosk = "Test web kiosk F";
  const created = await api.post("/admin/pairing-codes", { kioskName: secondKiosk, kind: "web" });
  await page.goto(`${dashboardUrl}/kiosk#code=${created.code}`);
  await expect(page.getByRole("heading", { name: "Pair this kiosk" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await expect(page.getByText("Choose a settings PIN")).toBeVisible({ timeout: 20_000 });
  await pressAll(page, settingsPin);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await pressAll(page, settingsPin);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Enter your\s*member ID/ })).toBeVisible({ timeout: 20_000 });
  const kioskId = (await api.get("/admin/kiosks")).kiosks.find((item: { name: string; active: number }) => item.name === secondKiosk && item.active).id;
  await api.patch(`/admin/kiosks/${kioskId}/authentication-method`, { authenticationMethod: "member_id", memberLookup: "entry", requirePin: true });

  // The kiosk's reports of wrong tries, as the page sends them. While `unreachable` is set, as it is whenever the browser
  // is offline, a report never reaches the server. The first report that does reach it is counted there, but its answer
  // is dropped on the way back, and the network stays down from then until the scenario brings it back.
  type Report = { reportId: string; failures: { memberId: string; count: number }[]; fate: "answer lost" | "never arrived" | "answered"; recorded?: number };
  const sent: Report[] = [];
  let unreachable = false;
  await context.route("**/kiosk/pin-failures", async (route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    const body = route.request().postDataJSON() as { reportId: string; failures: { memberId: string; count: number }[] };
    const entry: Report = { reportId: body.reportId, failures: body.failures.map((item) => ({ memberId: item.memberId, count: item.count })), fate: "answered" };
    if (unreachable) { entry.fate = "never arrived"; sent.push(entry); await route.abort("connectionfailed"); return; }
    const first = !sent.some((item) => item.fate !== "never arrived");
    if (first) unreachable = true;
    const response = await route.fetch();
    if (first) { entry.fate = "answer lost"; sent.push(entry); await route.abort("connectionreset"); return; }
    entry.recorded = (await response.json()).recorded; sent.push(entry);
    await route.fulfill({ response });
  });
  const reachedServer = () => sent.filter((item) => item.fate !== "never arrived");
  const goOffline = async () => { unreachable = true; await context.setOffline(true); };
  const goOnline = async () => { unreachable = false; await context.setOffline(false); };
  const wrongTry = async (pin: string) => {
    await identify(page, "1008", "Test Student H");
    await enterPin(page, pin);
    await expect(page.getByRole("heading", { name: "Wrong PIN" })).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  };

  await page.reload();
  await expect(page.getByText("Online", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => Boolean((await cachedMember(page, "1008"))?.pin), { timeout: 30_000 }).toBe(true);

  // Offline, H types two wrong PINs. The kiosk checks them against its cached hash and counts them itself.
  await goOffline();
  await wrongTry("1111");
  await wrongTry("2222");
  await expect.poll(async () => (await keptPinFailures(page)).map((item) => [item.memberId, item.count]), { timeout: 20_000 }).toEqual([["1008", 2]]);
  expect(reachedServer()).toEqual([]);
  expect(await failedAttempts()).toBe(0);

  // Back online, the kiosk reports its tries. The server counts them, but the kiosk never gets the answer.
  await goOnline();
  await expect.poll(() => reachedServer().length, { timeout: 90_000 }).toBe(1);
  await goOffline();
  const first = reachedServer()[0];
  expect(first.fate).toBe("answer lost");
  expect(first.reportId).toMatch(/^[\w-]{1,128}$/);
  expect(first.failures).toHaveLength(1);
  // The report holds the tries made before the kiosk put it together. That is both of them, unless the kiosk's
  // once-a-minute check-in fell between the two tries: then it holds the first, and the second waits for the next report.
  const firstCount = first.failures[0].count;
  expect(first.failures[0].memberId).toBe("1008");
  expect([1, 2]).toContain(firstCount);
  expect(await failedAttempts()).toBe(firstCount);
  // The kiosk keeps the report, marked with its id, because nothing said the server has it.
  await expect.poll(() => keptPinFailures(page), { timeout: 20_000 }).toEqual([{ memberId: "1008", count: 2, report: { id: first.reportId, count: firstCount } }]);

  // A third wrong try while the report waits is kept for a later report; the waiting one stays as it was sent.
  await wrongTry("3333");
  await expect.poll(() => keptPinFailures(page), { timeout: 20_000 }).toEqual([{ memberId: "1008", count: 3, report: { id: first.reportId, count: firstCount } }]);
  expect(reachedServer()).toHaveLength(1);
  expect(await failedAttempts()).toBe(firstCount);

  // Online for good: the kiosk sends the first report again, with the same id and the same tries, and the server answers
  // with what it counted the first time instead of counting them again.
  await goOnline();
  await expect.poll(() => reachedServer().length, { timeout: 90_000 }).toBeGreaterThanOrEqual(2);
  expect(reachedServer()[1]).toEqual({ reportId: first.reportId, failures: first.failures, fate: "answered", recorded: firstCount });
  // The tries made since go in a new report, at the kiosk's next check-in.
  await expect.poll(async () => (await keptPinFailures(page)).length, { timeout: 90_000 }).toBe(0);
  const later = reachedServer().slice(2);
  expect(later.length).toBeGreaterThanOrEqual(1);
  for (const report of later) expect(report).toMatchObject({ fate: "answered", failures: [{ memberId: "1008" }] });
  expect(new Set([first.reportId, ...later.map((report) => report.reportId)]).size, "every later report has an id of its own").toBe(later.length + 1);
  expect(later.reduce((total, report) => total + report.failures[0].count, 0)).toBe(3 - firstCount);
  expect(later.reduce((total, report) => total + (report.recorded ?? 0), 0)).toBe(3 - firstCount);
  // Three tries were made and the server counted three, though it received the first report twice.
  expect(await failedAttempts()).toBe(3);

  // Leave the installation as the scenarios after this one expect: no wrong tries counted for H, Require PIN off here.
  await api.post(`/admin/members/${rosterH}/pin/unlock`, {});
  await api.patch(`/admin/kiosks/${kioskId}/authentication-method`, { authenticationMethod: "member_id", memberLookup: "entry", requirePin: false });
});
