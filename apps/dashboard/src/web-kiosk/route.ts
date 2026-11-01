// The web kiosk lives at /kiosk on the dashboard site (not /kiosks, the dashboard's Kiosks page).
export const webKioskPath = "/kiosk";
export const isWebKioskPath = (pathname: string) => (pathname.replace(/\/+$/, "") || "/") === webKioskPath;
