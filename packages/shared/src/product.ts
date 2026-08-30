export const product = {
  name: "LancerLogin",
  supportedKiosks: 1,
  fingerprintTemplateStorage: "sensor-local",
  defaultTheme: { primary: "#7c3aed", secondary: "#0f766e" },
} as const;

export type Role = "admin" | "operator";

export const operatorForbiddenCapabilities = [
  "manage-users", "manage-security", "manage-integrations", "manage-branding", "destructive-configuration",
] as const;
