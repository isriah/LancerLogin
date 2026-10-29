import type { LogoBackdrop } from "./adaptive-brand-logo";

/** Organization identity and appearance, as /setup/status and /admin/branding return it. */
export type Branding = { organizationName: string; subtitle?: string; logoData?: string; primaryColor: string; secondaryColor: string; appearance: "system" | "light" | "dark"; logoBackdrop: LogoBackdrop; lateScanMinutes: number; discordContestWindowHours: number; attendanceReportingStartsOn?: string | null; anomalyLateThresholdMinutes?: number; anomalyEarlyThresholdMinutes?: number };
