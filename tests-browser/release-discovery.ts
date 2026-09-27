export const discovered = (release: { tag_name: string; html_url?: string; body?: string }, checkedAt = Date.now()) => ({ fresh: true, checkedAt, attemptedAt: checkedAt, release });
