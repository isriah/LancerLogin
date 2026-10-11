import { requireCapability } from "../../../packages/shared/src/policy.mjs";

export function createApiHarness() {
  const calls = [];
  return {
    calls,
    request(principal, action) {
      const capability = {
        listMeetings: "view-reports",
        createMeeting: "manage-meetings",
        correctAttendance: "manage-corrections",
        configureBranding: "manage-branding",
        configureIntegration: "manage-integrations",
        deleteInstallation: "destructive-configuration",
      }[action];
      if (!capability) throw new Error("Unknown action");
      requireCapability(principal, capability);
      calls.push({ userId: principal.userId, action });
      return { ok: true };
    },
  };
}
