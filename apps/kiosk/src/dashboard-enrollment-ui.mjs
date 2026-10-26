export const dashboardEnrollmentApp = `
let remotePolling;
export async function startDashboardEnrollment({ id, call, stage, message, confirmAction, cancelConfirmation, isReady }) {
  clearInterval(remotePolling);
  const byId = value => document.getElementById(value);
  byId("unlock").hidden = true;
  byId("maintenance-main").classList.remove("locked");
  byId("maintenance-main").classList.add("dashboard-enrollment");
  byId("maintenance-header").hidden = false;
  for (const action of byId("maintenance-header").querySelectorAll("button,a")) action.hidden = action.getAttribute("href") !== "/";
  if (byId("maintenance-tabs")) byId("maintenance-tabs").hidden = true;
  const workspace = byId("workspace"); workspace.hidden = false; workspace.className = "workspace";
  for (const card of workspace.children) card.hidden = !card.classList.contains("reader-card");
  byId("test-reader").hidden = true;
  if (byId("open-fingerprint-sync")) byId("open-fingerprint-sync").hidden = true;
  let card = byId("dashboard-enrollment-card");
  if (!card) {
    card = document.createElement("section"); card.id = "dashboard-enrollment-card"; card.className = "card dashboard-enrollment-card";
    const title = document.createElement("h2"); title.textContent = "Dashboard enrollment";
    const member = document.createElement("p"); member.id = "dashboard-enrollment-member";
    const detail = document.createElement("p"); detail.id = "dashboard-enrollment-detail";
    const cancel = document.createElement("button"); cancel.id = "dashboard-enrollment-cancel"; cancel.type = "button"; cancel.textContent = "Cancel enrollment";
    card.append(title, member, detail, cancel); workspace.append(card);
  }
  card.hidden = false;
  const cancel = byId("dashboard-enrollment-cancel");
  let stopped = false, confirming = false, confirmationShown = false, polling = false;
  const endpoint = "/maintenance/enrollment/" + encodeURIComponent(id);
  const labels = {
    waiting_member: ["ready", "Waiting for member", "Select the member in the dashboard."],
    awaiting_confirmation: ["ready", "Confirm your name", "Check the name on this kiosk before continuing."],
    enroll_wait_first: ["enroll_wait_first", "Place finger", "Enrollment scan 1 of 2"],
    enroll_remove: ["enroll_scan_accepted", "Lift finger", "Remove your finger before the second scan."],
    enroll_wait_second: ["enroll_wait_second", "Same finger again", "Enrollment scan 2 of 2"],
    enroll_success: ["enroll_success", "Enrollment saved", "Lift your finger, then return to the kiosk."],
    enroll_failure: ["enroll_failure", "Enrollment stopped", "Review the dashboard and kiosk before retrying."],
    cancelled: ["ready", "Enrollment cancelled", "Return to the kiosk when ready."],
    expired: ["ready", "Enrollment expired", "Start a new session from the dashboard."],
  };
  async function cancelSession() {
    cancel.disabled = true;
    try { await call(endpoint + "/cancel", { method: "POST", body: "{}" }); }
    catch (error) { message(error.message, true); }
    finally { cancel.disabled = false; await poll(); }
  }
  cancel.onclick = cancelSession;
  async function confirm(session) {
    if (confirmationShown || confirming || !isReady()) return;
    confirmationShown = true; confirming = true;
    const fullName = session.member.firstName + " " + session.member.lastName;
    const decline = byId("cancel-action"), oldLabel = decline.textContent; decline.textContent = "No, not me";
    try {
      const accepted = await confirmAction("Is this you?", fullName + " · " + session.member.memberId + ". Present the same finger twice, lifting when prompted.", { enrollment: true, label: "Yes, begin enrollment", returnFocus: cancel });
      if (!accepted) { if (!stopped) await cancelSession(); return; }
      if (stopped || !isReady()) return;
      message("Enrollment is listening on the reader.");
      await call(endpoint + "/confirm", { method: "POST", body: "{}" });
    } catch (error) { message(error.message, true); }
    finally { decline.textContent = oldLabel; confirming = false; await poll(); }
  }
  async function poll() {
    if (polling) return; polling = true;
    try {
      const value = await call(endpoint), session = value.session;
      if (!session || session.id !== id || !labels[session.progress]) throw new Error("Dashboard enrollment status is unavailable.");
      const terminal = ["enroll_success", "enroll_failure", "cancelled", "expired"].includes(session.progress);
      stopped = terminal;
      byId("dashboard-enrollment-member").textContent = session.member ? session.member.firstName + " " + session.member.lastName + " · " + session.member.memberId : "Waiting for a dashboard selection";
      byId("dashboard-enrollment-detail").textContent = session.message || (session.busy ? "Follow the reader prompts. Other maintenance controls remain locked." : "This session permits fingerprint enrollment only. Other maintenance controls remain locked.");
      const definition = labels[session.member && session.state === "ready" && session.progress === "waiting_member" ? "awaiting_confirmation" : session.progress];
      stage(...definition); byId("reader-status").textContent = "Dashboard enrollment session";
      cancel.hidden = terminal;
      if (terminal) { cancelConfirmation(); clearInterval(remotePolling); }
      else if (session.state === "ready" && session.member && !session.busy) void confirm(session);
    } catch (error) { stopped = true; cancelConfirmation(); message(error.message, true); clearInterval(remotePolling); }
    finally { polling = false; }
  }
  message("Attendance is paused for dashboard enrollment.");
  remotePolling = setInterval(() => void poll(), 1000);
  await poll();
}
`;
