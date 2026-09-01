import { useEffect, useState } from "react";

export type LogoBackdrop = "auto" | "light" | "dark" | "none";

export function AdaptiveBrandLogo({ src, alt, backdrop = "auto", className = "" }: { src: string; alt: string; backdrop?: LogoBackdrop; className?: string }) {
  const [rendered, setRendered] = useState(src);
  const [automaticBackdrop, setAutomaticBackdrop] = useState<"light" | "dark">("light");

  useEffect(() => {
    let active = true;
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 512 / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return;
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      let left = canvas.width; let right = 0; let top = canvas.height; let bottom = 0; let light = 0; let samples = 0;
      for (let y = 0; y < canvas.height; y += 1) for (let x = 0; x < canvas.width; x += 1) {
        const offset = (y * canvas.width + x) * 4; const alpha = pixels.data[offset + 3];
        if (alpha < 18) continue;
        left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
        light += (pixels.data[offset] * 0.2126 + pixels.data[offset + 1] * 0.7152 + pixels.data[offset + 2] * 0.0722) / 255; samples += 1;
      }
      let next = src;
      if (samples && right >= left && bottom >= top) {
        const cropped = document.createElement("canvas"); cropped.width = right - left + 1; cropped.height = bottom - top + 1;
        cropped.getContext("2d")?.drawImage(canvas, left, top, cropped.width, cropped.height, 0, 0, cropped.width, cropped.height);
        next = cropped.toDataURL("image/png");
      }
      if (active) { setRendered(next); setAutomaticBackdrop(samples && light / samples > 0.58 ? "dark" : "light"); }
    };
    image.src = src;
    return () => { active = false; };
  }, [src]);

  const resolved = backdrop === "auto" ? automaticBackdrop : backdrop;
  return <span className={`adaptive-logo ${resolved !== "none" ? `backdrop-${resolved}` : "backdrop-none"} ${className}`.trim()}><img src={rendered} alt={alt} /></span>;
}
