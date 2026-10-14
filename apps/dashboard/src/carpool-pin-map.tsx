import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

export function CarpoolPinMap({ label, latitude, longitude, onChange }: { label: string; latitude: number | null; longitude: number | null; onChange: (latitude: number, longitude: number) => void }) {
  const element = useRef<HTMLDivElement>(null); const map = useRef<L.Map | null>(null); const marker = useRef<L.CircleMarker | null>(null); const change = useRef(onChange); change.current = onChange;
  useEffect(() => {
    if (!element.current) return;
    const instance = L.map(element.current, { scrollWheelZoom: false }).setView([latitude ?? 39.9526, longitude ?? -75.1652], latitude === null ? 10 : 15);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(instance);
    const color = getComputedStyle(element.current).getPropertyValue("--primary").trim();
    const pin = L.circleMarker([latitude ?? 39.9526, longitude ?? -75.1652], { color, fillColor: color, fillOpacity: latitude === null ? 0 : .5, opacity: latitude === null ? 0 : 1, radius: 10 }).addTo(instance);
    instance.on("click", event => change.current(event.latlng.lat, event.latlng.lng)); map.current = instance; marker.current = pin;
    const frame = requestAnimationFrame(() => instance.invalidateSize());
    return () => { cancelAnimationFrame(frame); instance.remove(); map.current = null; marker.current = null; };
  }, []);
  useEffect(() => { if (latitude !== null && longitude !== null) { marker.current?.setStyle({ opacity: 1, fillOpacity: .5 }); marker.current?.setLatLng([latitude, longitude]); map.current?.panTo([latitude, longitude]); } else marker.current?.setStyle({ opacity: 0, fillOpacity: 0 }); }, [latitude, longitude]);
  return <div className="carpool-pin-review"><div className="carpool-leaflet-map carpool-pin-map"><div ref={element} role="region" aria-label={`${label} location map`} tabIndex={0} /></div><p>{latitude === null || longitude === null ? "No pin is saved for this address. " : ""}Click to place a pin. With the map focused, use arrow keys to move the view, then choose its center.</p><button className="ui-button" type="button" onClick={() => { const center = map.current?.getCenter(); if (center) change.current(center.lat, center.lng); }}>Use {label.toLowerCase()} map center as pin</button></div>;
}
