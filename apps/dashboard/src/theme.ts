import type { CSSProperties } from "react";

function rgb(hex: string) {
  const value = hex.replace("#", "");
  return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
}

function luminance(hex: string) {
  const channels = rgb(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

export const readableText = (background: string) => luminance(background) > 0.42 ? "#111714" : "#ffffff";

export function brandTheme(primary: string, secondary: string): CSSProperties {
  return {
    "--primary": primary,
    "--secondary": secondary,
    "--gold": secondary,
    "--on-primary": readableText(primary),
    "--on-secondary": readableText(secondary),
    "--primary-soft": `color-mix(in srgb, ${primary} 12%, var(--surface))`,
    "--secondary-soft": `color-mix(in srgb, ${secondary} 14%, var(--surface))`,
  } as CSSProperties;
}
