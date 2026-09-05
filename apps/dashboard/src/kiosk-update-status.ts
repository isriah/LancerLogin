export type KioskUpdateCommand = {
  id: string;
  type: string;
  createdAt: string;
  completedAt?: string;
  success?: number;
  resultMessage?: string;
  requestedReleaseVersion?: string;
  releaseVersionBefore?: string;
  resolutionStatus?: "succeeded" | "unchanged" | "mismatch";
  resolvedReleaseVersion?: string;
  resolvedAt?: string;
};

export type KioskUpdateState = { message: string; tone: "neutral" | "warning" | "success" | "error" };

const RECEIPT_BOUND_MS = 15 * 60_000;
const RESTART_BOUND_MS = 5 * 60_000;
const displayVersion = (value: string) => value.replace(/^v/, "");

export function kioskUpdateState(
  command: KioskUpdateCommand | undefined,
  kiosk: { lastSeenAt?: string; releaseVersion?: string } | undefined,
  now = Date.now(),
): KioskUpdateState {
  if (!command) return { message: "No kiosk update has been requested.", tone: "neutral" };
  const createdAt = Date.parse(command.createdAt);
  if (!command.completedAt) {
    if (Number.isFinite(createdAt) && now - createdAt >= RECEIPT_BOUND_MS) return { message: "The kiosk did not receive this update request before it expired. Bring it online, confirm its status, and try again.", tone: "error" };
    return { message: `Queued ${new Date(command.createdAt).toLocaleTimeString()}. Waiting for the kiosk to receive the request.`, tone: "warning" };
  }
  if (command.success === 0) return { message: command.resultMessage ? `Kiosk update failed: ${command.resultMessage}` : "Kiosk update failed before the installer started. Check the kiosk service and try again.", tone: "error" };

  const requested = command.requestedReleaseVersion;
  const reported = command.resolvedReleaseVersion ?? kiosk?.releaseVersion;
  if (command.resolutionStatus === "succeeded") return { message: `Installed successfully. This kiosk now reports ${displayVersion(reported ?? requested ?? "unknown")}.`, tone: "success" };
  if (command.resolutionStatus === "unchanged") return { message: `The restarted kiosk still reports ${displayVersion(reported ?? command.releaseVersionBefore ?? "unknown")} instead of requested ${displayVersion(requested ?? "unknown")}. Review the kiosk update service, then try again.`, tone: "error" };
  if (command.resolutionStatus === "mismatch") return { message: `The kiosk restarted into ${displayVersion(reported ?? "unknown")}, not requested ${displayVersion(requested ?? "unknown")}. Review release availability and the kiosk update service before retrying.`, tone: "error" };

  const completedAt = Date.parse(command.completedAt);
  const lastSeenAt = kiosk?.lastSeenAt ? Date.parse(kiosk.lastSeenAt) : Number.NaN;
  const restartOverdue = Number.isFinite(completedAt) && now - completedAt >= RESTART_BOUND_MS;
  const heartbeatAfterHandoff = Number.isFinite(lastSeenAt) && lastSeenAt > completedAt;
  if (!heartbeatAfterHandoff && restartOverdue) return { message: "The installer handoff completed, but the kiosk has not returned online with a new heartbeat. Check its power, network, and kiosk update service.", tone: "error" };
  if (heartbeatAfterHandoff && !reported && restartOverdue) return { message: "The kiosk returned online, but its installed release is unknown. Check the kiosk service environment and update logs.", tone: "error" };
  return { message: `Kiosk received the request for ${displayVersion(requested ?? "the latest compatible release")} and started its verified installer. Waiting up to five minutes for the restarted service to report its installed version.`, tone: "warning" };
}
