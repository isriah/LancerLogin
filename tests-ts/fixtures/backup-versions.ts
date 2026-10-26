// Remove fields introduced after these synthetic archives' declared version.
export function omitContestResubmissionFields(backup: any) {
  if (backup.schemaVersion >= 41) return;
  for (const row of backup.tables?.organization_settings ?? []) delete row.discord_block_recontests_after_rejection;
  for (const row of backup.tables?.discord_attendance_contests ?? []) delete row.prior_reviews_json;
  for (const module of backup.ownership?.modules ?? []) for (const field of module.sharedFields ?? []) {
    if (field.table === "organization_settings") field.columns = field.columns.filter((column: string) => column !== "discord_block_recontests_after_rejection");
  }
}
