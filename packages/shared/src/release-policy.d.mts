export type UpdateChannel = "stable" | "beta";
export type OfficialRelease = { tag: string; notes: string; prerelease: boolean };
export function parseReleaseVersion(value: unknown): { parts: bigint[]; beta?: bigint } | undefined;
export function compareReleaseVersions(left: string, right: string): -1 | 0 | 1 | undefined;
export function releaseAllowed(tag: unknown, channel?: UpdateChannel, prerelease?: unknown): boolean;
export function completeOfficialRelease(value: unknown, channel?: UpdateChannel): OfficialRelease | undefined;
export function newestOfficialRelease(values: unknown, channel?: UpdateChannel): OfficialRelease | undefined;
export function officialAssetDigest(value: unknown, name: string): string | undefined;
export type KioskRelease = OfficialRelease & { digests: { installer: string; arm64: string; armv7: string } };
export function completeKioskRelease(value: unknown, channel?: UpdateChannel): KioskRelease | undefined;

export function kioskReleaseTransition(candidate: unknown, installed: unknown): "upgrade" | "current" | "replace-development" | "unavailable";

export type PluginReleaseTrack = "stable" | "beta" | "nightly";
export const pluginReleaseTracks: readonly PluginReleaseTrack[];
export function pluginReleaseKind(tag: unknown): PluginReleaseTrack | undefined;
export function pluginTrackOffers(track: unknown, tag: unknown, prerelease: unknown): boolean;
export function newestPluginRelease<T extends { tag_name?: unknown }>(values: readonly T[] | unknown, track?: PluginReleaseTrack): T | undefined;
export type PluginSelectionTrack = "stable" | "nightly";
export const pluginSelectionTracks: readonly PluginSelectionTrack[];
