import { createFingerprintRequester } from "./fingerprint-vault-client.mjs";

export function createFingerprintResetClient(config, options = {}) {
  const request = createFingerprintRequester(config, "/kiosk/fingerprint-reset", { ...options, maximumResponseBytes: 4096 });
  return {
    commands: () => request("/commands"),
    complete: id => {
      if (typeof id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(id)) throw new Error("Invalid fingerprint reset command");
      return request(`/commands/${id}/acknowledge`, "POST", { completed: true });
    },
  };
}
