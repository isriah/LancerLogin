export const capabilities = Object.freeze({
  "view-dashboard": ["admin", "operator"],
  "manage-meetings": ["admin", "operator"],
  "manage-attendance": ["admin", "operator"],
  "manage-corrections": ["admin", "operator"],
  "manage-excuses": ["admin", "operator"],
  "view-reports": ["admin", "operator"],
  "view-roster": ["admin", "operator"],
  "manage-roster": ["admin"],
  "view-kiosk-status": ["admin", "operator"],
  "manage-users": ["admin"],
  "manage-security": ["admin"],
  "manage-integrations": ["admin"],
  "manage-branding": ["admin"],
  "destructive-configuration": ["admin"],
});

export function can(role, capability) {
  return capabilities[capability]?.includes(role) ?? false;
}

export function requireCapability(principal, capability) {
  if (!principal || !can(principal.role, capability)) {
    const error = new Error("Forbidden");
    error.status = 403;
    throw error;
  }
}
