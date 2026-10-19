// Only fixed codes and bounded aggregates cross the local diagnostic boundary.
export const fingerprintDiagnosticMessages = Object.freeze({
  starting: "Waiting for the first fingerprint sync check.",
  ready: "The last fingerprint sync check completed successfully.",
  installation_disabled: "An Admin must enable fingerprint sharing in the dashboard.",
  local_disabled: "Peer sharing is off on this kiosk.",
  unpaired: "Pair this kiosk before using fingerprint sync.",
  reader_unavailable: "The fingerprint reader is unavailable. Test its connection in maintenance.",
  authentication_failed: "Cloud authorization was rejected. Ask an Admin to review this kiosk's pairing.",
  network_unavailable: "The cloud could not be reached. Check the network; saved transfers will retry.",
  request_timeout: "The cloud request timed out. Check the network; saved transfers will retry.",
  invalid_response: "The cloud returned an invalid response. Refresh and contact an Admin if this continues.",
  roster_unavailable: "The current roster could not be verified. Restore cloud access before enrolling again.",
  reset_recovery: "Fingerprint reset recovery must finish before sharing can continue.",
  local_state_review: "Protected fingerprint state needs local review. Do not delete state files or lock directories.",
  identity_mismatch: "The installation identity changed. Ask an Admin to review local sharing before continuing.",
  no_approved_peer: "No peer is approved locally. Compare device fingerprints before approving another kiosk.",
  enrollment_identity_missing: "Some enrollments lack verified roster identities and need fresh enrollment to be shared.",
  mapping_review: "Some mappings need review or belong to inactive members. They are not being shared.",
  transfer_pending: "Fingerprint transfers are still queued. Leave the kiosk online to finish syncing.",
  retirement_review: "An enrollment was retired, but its local slot has changed. Review that mapping before removing it.",
  transfer_retry: "Some fingerprint transfers need another attempt. Check reader, network and peer approval.",
  stale: "The last successful check is old. Current fingerprint sync health has not been verified.",
  unavailable: "Fingerprint sync could not be verified. Refresh or ask an Admin to review the kiosk.",
});

const codes = new Set(Object.keys(fingerprintDiagnosticMessages));
const states = new Set(["starting", "ready", "disabled", "waiting", "blocked", "unavailable", "stale"]);
const statuses = new Set(["starting", "ready", "disabled", "installation_disabled", "waiting", "needs_attention", "reset", "idle", "unavailable", "stale"]);
const counts = ["received", "errors", "captured", "completed", "uploaded", "legacyMappings", "missingIdentityMappings", "unshareableMappings", "pendingUploads", "pendingDownloads", "reviewRequired", "retiredEnrollments", "locallyRemoved"];
const timestamp = value => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

export function fingerprintDiagnostic(component, values = {}, now = Date.now()) {
  const status = statuses.has(values.status) ? values.status : "starting";
  const reasonCode = codes.has(values.reasonCode) ? values.reasonCode : status === "starting" ? "starting" : status === "ready" || status === "idle" ? "ready" : "unavailable";
  const lastAttemptAt = timestamp(values.lastAttemptAt), lastSuccessAt = timestamp(values.lastSuccessAt);
  let state = values.blocked || ["local_state_review", "identity_mismatch", "reset_recovery"].includes(reasonCode) ? "blocked" : states.has(values.state) ? values.state : status === "idle" || status === "reset" && reasonCode === "ready" ? "ready" : status === "installation_disabled" ? "disabled" : status === "needs_attention" || status === "reset" ? "waiting" : states.has(status) ? status : "unavailable";
  if (state === "ready" && lastSuccessAt && now - Date.parse(lastSuccessAt) > 120_000) state = "stale";
  return { component: ["reset", "peer", "vault"].includes(component) ? component : "peer", status, state,
    reasonCode: state === "stale" ? "stale" : reasonCode, lastAttemptAt, lastSuccessAt,
    ...Object.fromEntries(counts.filter(key => Number.isSafeInteger(values[key]) && values[key] >= 0).map(key => [key, Math.min(values[key], 1_000_000)])) };
}

export function fingerprintFailureReason(error, fallback = "unavailable") {
  if (codes.has(error?.reasonCode)) return error.reasonCode;
  if (error?.status === 401 || error?.status === 403) return "authentication_failed";
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return "request_timeout";
  if (["EACCES", "EPERM", "EEXIST", "ENOSPC", "EROFS", "ELOOP"].includes(error?.code)) return "local_state_review";
  return codes.has(fallback) ? fallback : "unavailable";
}

export function fingerprintDiagnosticError(reasonCode) {
  const safe = codes.has(reasonCode) ? reasonCode : "unavailable";
  return Object.assign(new Error(fingerprintDiagnosticMessages[safe]), { reasonCode: safe });
}

export async function fingerprintDiagnosticOperation(reasonCode, operation) {
  try { return await operation(); }
  catch (error) { throw fingerprintDiagnosticError(fingerprintFailureReason(error, reasonCode)); }
}
