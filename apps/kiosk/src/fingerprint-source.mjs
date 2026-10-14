// Only a new local two-scan enrollment may be exported. Legacy association
// markers remain readable for compatibility, but never become fresh authority.
// Received copies have no local enrollment and must not be re-exported.
export function freshFingerprintSource(mapping, now = Date.now()) {
  return Boolean(mapping && mapping.review === undefined
    && typeof mapping.rosterId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(mapping.rosterId)
    && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(mapping.enrollment?.id ?? "")
    && Number.isSafeInteger(mapping.enrollment?.occurredAt) && mapping.enrollment.occurredAt >= 0 && mapping.enrollment.occurredAt <= now);
}
