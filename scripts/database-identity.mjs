/** Fixed controller setting, never an application or dispatch selector. */
export function resolveDatabaseName(slug, fixedName) {
  const name = fixedName || `${slug}-data`;
  if (!/^[a-z][a-z0-9-]{2,62}-data$/.test(name)) throw new Error("fixed_database_name_invalid");
  return name;
}
