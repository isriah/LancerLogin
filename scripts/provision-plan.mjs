const slugPattern = /^[a-z][a-z0-9-]{2,40}$/;

export function validateProvisionPlan(input) {
  if (!slugPattern.test(input.installationSlug ?? "")) throw new Error("Installation slug must be 3-41 lowercase letters, digits, or hyphens and start with a letter");
  if (input.dryRun !== true) throw new Error("Provisioning is mock-only until an adopter-specific target is supplied");
  if (input.existingInstallationId || input.existingAccountId || input.existingDatabaseId) throw new Error("Existing installation identifiers are not accepted");
  return {
    dryRun: true,
    plannedResources: [`${input.installationSlug}-api`, `${input.installationSlug}-data`, `${input.installationSlug}-dashboard`],
    requiredSecretNames: ["CLOUDFLARE_API_TOKEN"],
  };
}
