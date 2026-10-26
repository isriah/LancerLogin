// Behavior flows run once per supported viewport with alternating themes, so both sizes and both themes stay covered
// without repeating an identical flow. Definitions that assert theme-specific rendered styles keep the full
// viewport x theme matrix from dashboardConformanceReferences.
export const pairedViews = [
  { viewport: { width: 1280, height: 900 }, width: 1280, height: 900, theme: "light" },
  { viewport: { width: 390, height: 844 }, width: 390, height: 844, theme: "dark" },
] as const;
