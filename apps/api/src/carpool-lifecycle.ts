export const carpoolCleanupSteps = Object.freeze([
  { kind: "delete" as const, table: "carpool_assignments" },
  { kind: "delete" as const, table: "carpool_unresolved" },
  { kind: "delete" as const, table: "carpool_people" },
  { kind: "delete" as const, table: "carpool_plans" },
  { kind: "delete" as const, table: "carpool_import_profiles" },
  { kind: "delete" as const, table: "carpool_location_cache" },
  { kind: "delete" as const, table: "platform_module_setup_progress", where: "module_id=?", bindings: ["carpool"] as const },
  { kind: "assignments" as const },
  { kind: "delete" as const, table: "carpool_geocoding_credentials" },
  { kind: "delete" as const, table: "carpool_settings" },
  // Appended to preserve the cursor positions of interrupted cleanup runs.
  { kind: "delete" as const, table: "carpool_location_resolution" },
]);
