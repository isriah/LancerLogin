export type PairingCode = { expiresAt: string; status: "unused" | "redeemed" | "expired" };

export const isPairable = (code: PairingCode, now: Date) => code.status === "unused" && Date.parse(code.expiresAt) > now.getTime();
