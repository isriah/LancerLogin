# Security model

Local sign-in passwords are never recovered. LancerLogin stores a unique-salt, memory-hard scrypt hash (N=32768, r=8, p=1) and verifies it with constant-time comparison. A forgotten local credential is reset only from the authenticated local setup tool; it cannot be emailed or displayed.

Google OAuth is selectable at first setup and will be verified server-side in the production Worker. Either method or both may be enabled. Integration settings use an installation-specific 32-byte Worker secret and AES-256-GCM with a fresh IV per save. Dashboard responses return only configuration state and update time, never saved values. Provider test/rotate/remove controls must use the same Admin-only integration capability.
