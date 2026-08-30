const requiredSteps = ["branding", "roster", "pair-kiosk", "fingerprint-test", "test-meeting", "confirm-attendance"];
const optionalSteps = ["google-oauth", "resend", "discord"];

export function createSetupProgress() {
  const completions = new Map();
  return {
    complete({ step, actorUserId, completedAt }) {
      if (![...requiredSteps, ...optionalSteps].includes(step)) throw new Error("Unknown setup step");
      if (!actorUserId || !completedAt) throw new Error("Completion requires an actor and timestamp");
      completions.set(step, { step, actorUserId, completedAt });
    },
    reopen(step) { if (!requiredSteps.includes(step)) throw new Error("Only required setup steps can be reopened"); completions.delete(step); },
    summary() {
      const completedRequired = requiredSteps.filter((step) => completions.has(step));
      return {
        requiredSteps: requiredSteps.map((step) => ({ step, completion: completions.get(step) })),
        optionalSteps: optionalSteps.map((step) => ({ step, completion: completions.get(step) })),
        complete: completedRequired.length === requiredSteps.length,
        showPrimaryChecklist: completedRequired.length !== requiredSteps.length,
        setupHelpAvailable: true,
      };
    },
  };
}
