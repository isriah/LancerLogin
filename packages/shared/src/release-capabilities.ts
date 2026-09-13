/** Bundled initial-release policy. No runtime, request or installation override. */
export const documentationAvailable: boolean = false;
export function moduleAvailable(id: string): boolean { return id === 'hour-tracking' || (id === 'activity-documentation' && documentationAvailable); }
