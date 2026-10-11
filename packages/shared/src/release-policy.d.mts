export type UpdateChannel = "stable" | "beta";
export type OfficialRelease = { tag: string; notes: string; prerelease: boolean };
export function parseReleaseVersion(value: unknown): { parts: bigint[]; beta?: bigint } | undefined;
export function compareReleaseVersions(left: string, right: string): -1 | 0 | 1 | undefined;
export function releaseAllowed(tag: unknown, channel?: UpdateChannel, prerelease?: unknown): boolean;
export function completeOfficialRelease(value: unknown, channel?: UpdateChannel): OfficialRelease | undefined;
export function newestOfficialRelease(values: unknown, channel?: UpdateChannel): OfficialRelease | undefined;
