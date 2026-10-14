import { carpoolGroupStyle, type CarpoolGroupSetting } from "../../../packages/shared/src/carpool-groups";
import { useEffect, useRef, type ReactNode } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { type Person, type Assignment, type Direction, leg, statusLabel } from "./carpool-model";

function carpoolMarkerIcon(symbol: string, shape: "car" | "rider" | "arranged" | "review", color: string, colorText: string, selected: boolean, size: number) {
  return L.divIcon({ className: "", html: `<div class="carpool-map-hitbox"><div class="carpool-map-pin carpool-map-pin--${shape}${selected ? " carpool-map-pin--selected" : ""}" style="--carpool-pin:${color};--carpool-pin-text:${colorText}"><span>${symbol}</span></div></div>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
}
export function GeographicMap({ people, assignments, direction, selectedOfferId, showSelectedOnly, showPeopleNotNeedingRide, fitKey, onSelect, controls, groupSettings = [] }: { people: Person[]; assignments: Assignment[]; direction: Direction; selectedOfferId: string; showSelectedOnly: boolean; showPeopleNotNeedingRide: boolean; fitKey: number; onSelect: (id: string) => void; controls: ReactNode; groupSettings?: CarpoolGroupSetting[] }) {
  const mapElement = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<L.Map | null>(null); const markerLayer = useRef<L.LayerGroup | null>(null);
  const assignmentByRider = new Map(assignments.map((item) => [item.riderId, item])); const offers = people.filter((person) => leg(person, direction).status === "offer"); const offerIds = new Set(offers.map((person) => person.id));
  const groupFor = (person: Person) => offerIds.has(person.id) ? person.id : assignmentByRider.get(person.id)?.vehiclePersonId;
  const visible = people.filter((person) => { const current = leg(person, direction); if (current.latitude === null || current.longitude === null) return false; const groupId = groupFor(person); if (showSelectedOnly && selectedOfferId && groupId !== selectedOfferId) return false; if (!showPeopleNotNeedingRide && !["offer", "needs-ride"].includes(current.status)) return false; return true; });
  const points = visible.map((person) => [leg(person, direction).latitude!, leg(person, direction).longitude!] as [number, number]); const center = points[0] ?? [39.9526, -75.1652];
  const pointsKey = points.map(([latitude, longitude]) => `${latitude},${longitude}`).join("|");
  const colorFor = (person: Person) => { const groupId = groupFor(person); const driver = offers.find(offer => offer.id === groupId); return driver ? carpoolGroupStyle(driver, direction, groupSettings) : { color: "#6b7280", colorText: "#ffffff" }; };
  useEffect(() => {
    const element = mapElement.current; if (!element || !visible.length) return;
    const map = L.map(element, { scrollWheelZoom: true, preferCanvas: true, fadeAnimation: false }).setView(center, 11);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(map);
    mapInstance.current = map; markerLayer.current = L.layerGroup().addTo(map);
    const frame = window.requestAnimationFrame(() => map.invalidateSize());
    return () => { window.cancelAnimationFrame(frame); markerLayer.current = null; mapInstance.current = null; map.remove(); };
  }, [Boolean(visible.length)]);
  useEffect(() => {
    const layer = markerLayer.current; if (!layer) return; const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.carpoolMarkerId : undefined; const openPopupId = layer.getLayers().flatMap(item => item instanceof L.Marker && item.isPopupOpen() && item.getElement()?.dataset.carpoolMarkerDirection === direction ? [item.getElement()?.dataset.carpoolMarkerId] : [])[0]; layer.clearLayers(); const probe = document.createElement("span"); probe.style.cssText = "position:absolute;visibility:hidden;width:var(--control-min-block-size);height:var(--control-min-block-size)"; mapElement.current?.append(probe); const markerSize = Math.max(44, Math.ceil(probe.getBoundingClientRect().height)); probe.remove();
    for (const person of visible) {
      const current = leg(person, direction); const groupId = groupFor(person); const isOffer = offerIds.has(person.id); const shape = isOffer ? "car" : current.status === "needs-ride" ? "rider" : current.status === "unknown" ? "review" : "arranged";
      const vehicle = offers.find(offer => offer.id === groupId); const groupLabel = vehicle ? carpoolGroupStyle(vehicle, direction, groupSettings).label : groupId ? "Unavailable car" : current.status === "needs-ride" ? "Unassigned" : ""; const markerLabel = [person.displayName, statusLabel(current.status), groupLabel].filter(Boolean).join(" · ");
      const popup = document.createElement("div"); const name = document.createElement("strong"); name.textContent = person.displayName; popup.append(name, document.createElement("br"), statusLabel(current.status), document.createElement("br"), current.address); if (groupId) popup.append(document.createElement("br"), "Group: " + groupLabel);
      const marker = L.marker([current.latitude!, current.longitude!], { icon: carpoolMarkerIcon(isOffer ? "C" : current.status === "needs-ride" ? "R" : current.status === "unknown" ? "?" : current.status === "arranged" ? "A" : "I", shape, colorFor(person).color, colorFor(person).colorText, Boolean(selectedOfferId && groupId === selectedOfferId), markerSize), title: markerLabel }).bindPopup(popup, { maxWidth: Math.max(markerSize, (mapElement.current?.clientWidth ?? markerSize * 4) - markerSize * 2) }).addTo(layer);
      if (groupId) marker.on("click", () => onSelect(groupId)); const markerElement = marker.getElement(); if (markerElement) { markerElement.setAttribute("aria-label", markerLabel); markerElement.dataset.carpoolMarkerId = person.id; markerElement.dataset.carpoolMarkerDirection = direction; markerElement.addEventListener("keydown", event => { if (event.key === " ") { event.preventDefault(); marker.fire("click"); marker.openPopup(); } }); if (focused === person.id) markerElement.focus({ preventScroll: true }); } if (openPopupId === person.id) marker.openPopup();
    }
  }, [people, assignments, direction, selectedOfferId, showSelectedOnly, showPeopleNotNeedingRide, onSelect, groupSettings]);
  useEffect(() => {
    const map = mapInstance.current; if (!map || !points.length) return; map.invalidateSize();
    if (points.length === 1) map.setView(points[0]!, 13); else map.fitBounds(L.latLngBounds(points), { padding: [36, 36], maxZoom: 15 });
  }, [pointsKey, fitKey]);
  return <section className="ui-card carpool-geography"><div className="carpool-geography-header"><h3>Geographic review</h3>{controls}</div>{visible.length ? <div className="carpool-map-shell"><div className="carpool-leaflet-map"><div ref={mapElement} role="region" aria-label={`${visible.length} resolved Carpool locations`} /></div><div className="carpool-map-legend" aria-label="Map legend"><span><b>■</b> Car offer</span><span><b>●</b> Ride request</span>{showPeopleNotNeedingRide && <><span><b>◆</b> Arranged or independent</span><span><b>?</b> Needs review</span></>}</div><ol>{visible.map((person) => { const current = leg(person, direction); const vehicle = offers.find(offer => offer.id === groupFor(person)); const groupLabel = vehicle ? carpoolGroupStyle(vehicle, direction, groupSettings).label : groupFor(person) ? "Unavailable car" : current.status === "needs-ride" ? "Unassigned" : ""; return <li key={person.id}><span className={`carpool-map-key carpool-map-key--${current.status}`} style={{ backgroundColor: colorFor(person).color, color: colorFor(person).colorText }}>{current.status === "offer" ? "C" : current.status === "needs-ride" ? "R" : current.status === "unknown" ? "?" : current.status === "arranged" ? "A" : "I"}</span><span><strong>{person.displayName}</strong><small>{statusLabel(current.status)}{groupLabel ? " · " + groupLabel : ""}</small></span></li>; })}</ol></div> : <p>No resolved locations match the current map filters.</p>}</section>;
}
