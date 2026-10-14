import type { CarpoolTripDirection } from "./carpool-state.ts";

export const carpoolGroupColors = [
  { id: "blue", label: "Blue", value: "#20639b" }, { id: "amber", label: "Amber", value: "#b45309" },
  { id: "teal", label: "Teal", value: "#16866f" }, { id: "violet", label: "Violet", value: "#8b5cf6" },
  { id: "rose", label: "Rose", value: "#c2415d" }, { id: "olive", label: "Olive", value: "#50723c" },
  { id: "cyan", label: "Cyan", value: "#0e7490" }, { id: "gold", label: "Gold", value: "#a16207" },
] as const;
export type CarpoolGroupColor = typeof carpoolGroupColors[number]["id"];
export type CarpoolGroupSetting = { direction: CarpoolTripDirection; vehiclePersonId: string; label: string; color: CarpoolGroupColor };
export function carpoolGroupStyle(vehicle: { id: string; displayName: string }, direction: CarpoolTripDirection, settings: readonly CarpoolGroupSetting[] = []) {
  const saved = settings.find(item => item.direction === direction && item.vehiclePersonId === vehicle.id);
  const hash = [...vehicle.id].reduce((value, character) => (value * 31 + character.charCodeAt(0)) >>> 0, 0);
  const color = carpoolGroupColors.find(color => color.id === saved?.color) ?? carpoolGroupColors[hash % carpoolGroupColors.length]!;
  const channels = color.value.slice(1).match(/../g)!.map(channel => { const value = Number.parseInt(channel, 16) / 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4; });
  const luminance = .2126 * channels[0]! + .7152 * channels[1]! + .0722 * channels[2]!;
  return { label: saved?.label || vehicle.displayName, color: color.value, colorText: luminance > .179 ? "#000000" : "#ffffff", colorId: color.id, colorLabel: color.label };
}
