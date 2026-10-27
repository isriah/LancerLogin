/**
 * Major version of the module contract this Core implements: ModuleDefinition, the API and dashboard
 * contributions, and the plugin package format. A plugin declares the major it was built for in the
 * `lancerlogin.contract` field of its package.json, and its manifest's `contractVersion` must match.
 */
export const moduleContractVersion = 1;

/**
 * Contract majors this Core accepts. A breaking contract change adds a new major and keeps the previous
 * one supported for at least one Core minor release.
 */
export const supportedModuleContractVersions: readonly number[] = Object.freeze([moduleContractVersion]);

/** The only LancerLogin package a plugin may import. Everything else in Core is internal. */
export const moduleSdkPackageName = "@lancerlogin/module-sdk";
