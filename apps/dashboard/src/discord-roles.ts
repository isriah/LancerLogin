/** Every Discord role picker lists roles by name, ignoring case and accents. The API sorts too; this keeps pickers sorted for any source. */
export function sortDiscordRoles<T extends { name: string }>(roles: readonly T[]): T[] {
  return [...roles].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.name.localeCompare(b.name));
}
