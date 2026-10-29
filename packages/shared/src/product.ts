export type ThemeColors = { readonly primary: string; readonly secondary: string };

export const product = {
  name: "LancerLogin",
  supportedKiosks: 1,
  fingerprintTemplateStorage: "sensor-local",
  /** Colors a released installation starts with. */
  defaultTheme: { primary: "#b80100", secondary: "#eeb822" },
  /** Colors development environments start with (Worker var DEFAULT_THEME=development), so their dashboards look different. */
  developmentTheme: { primary: "#7c3aed", secondary: "#0f766e" },
} as const;

/** The starting organization colors for a Worker's DEFAULT_THEME var. Anything other than "development" is a release. */
export function resolveDefaultTheme(defaultThemeVar?: string): ThemeColors {
  return defaultThemeVar === "development" ? product.developmentTheme : product.defaultTheme;
}

export type Role = "admin" | "operator";

export const operatorForbiddenCapabilities = [
  "manage-users", "manage-security", "manage-integrations", "manage-branding", "destructive-configuration",
] as const;
