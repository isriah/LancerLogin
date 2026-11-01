import qrcode from "qrcode-generator";
import { useMemo } from "react";

/** A QR code drawn as one SVG path, dark modules on a light quiet zone so phone cameras read it in either theme. */
export function QrCode({ value, label, className }: { value: string; label: string; className?: string }) {
  const { size, path } = useMemo(() => {
    const code = qrcode(0, "M");
    code.addData(value, "Byte");
    code.make();
    const count = code.getModuleCount(), margin = 4;
    let d = "";
    for (let row = 0; row < count; row += 1) for (let column = 0; column < count; column += 1) if (code.isDark(row, column)) d += `M${column + margin} ${row + margin}h1v1h-1z`;
    return { size: count + margin * 2, path: d };
  }, [value]);
  return <svg className={className} role="img" aria-label={label} viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges" xmlns="http://www.w3.org/2000/svg">
    <rect width={size} height={size} fill="#ffffff" />
    <path d={path} fill="#000000" />
  </svg>;
}
