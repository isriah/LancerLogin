export function createIdentityInput() {
  const pending = [];
  return {
    submit(observation) {
      if (!observation || !["identified", "unknown"].includes(observation.status)) throw new Error("Invalid identity observation");
      if (pending.length >= 4) return false;
      pending.push(Object.freeze({ ...observation }));
      return true;
    },
    async next() {
      return pending.shift() ?? { status: "idle" };
    },
    clear() { pending.splice(0); },
    size() { return pending.length; },
  };
}
