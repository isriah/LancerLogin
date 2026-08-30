# Security model

Local sign-in passwords are never recovered. LancerLogin stores a unique-salt, memory-hard scrypt hash (N=32768, r=8, p=1) and verifies it with constant-time comparison. A forgotten local credential is reset only from the interactive local recovery tool using the adopter's scoped D1 authorization; it cannot be emailed or displayed.

Google OAuth is selectable at first setup and is verified server-side in the Worker with signed, expiring state plus issuer, audience, verified-email, and active-user checks. Either method or both may be enabled. Integration settings use an installation-specific 32-byte Worker secret and AES-256-GCM with a fresh IV per save. Dashboard responses return only configuration state and update time, never saved values. Provider test, rotation, and removal controls use the same Admin-only integration capability.

For local sign-in, the Worker issues a signed, expiry-bound session containing only user ID and role. Signatures are HMAC-SHA-256 with an installation secret; tampered and expired sessions are rejected before authorization. The generated Pages `_worker.js` forwards `/api/*` to the Worker, so the browser keeps Secure, HTTP-only, SameSite=Strict cookies on one first-party Pages origin instead of depending on third-party Worker cookies. Google uses the same Pages `/api/auth/google/callback` origin.
