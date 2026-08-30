const slugPattern = /^[a-z][a-z0-9-]{2,40}$/;

export function validateProvisionPlan(input) {
  if (!slugPattern.test(input.installationSlug ?? "")) throw new Error("Installation slug must be 3-41 lowercase letters, digits, or hyphens and start with a letter");
  if (!["create", "resume"].includes(input.operation)) throw new Error("Operation must be create or resume");
  const expected = `${input.operation.toUpperCase()} ${input.installationSlug}`;
  if (input.confirmation !== expected) throw new Error(`Confirmation must exactly match ${expected}`);
  if (input.existingInstallationId || input.existingAccountId || input.existingDatabaseId) throw new Error("Existing installation identifiers are not accepted");
  return {
    operation: input.operation,
    plannedResources: [`${input.installationSlug}-api`, `${input.installationSlug}-data`, `${input.installationSlug}-dashboard`],
    requiredSecretNames: ["CLOUDFLARE_API_TOKEN"],
  };
}
