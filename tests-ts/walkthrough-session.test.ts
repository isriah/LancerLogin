import test from "node:test";
import assert from "node:assert/strict";
import { quietWalkthroughsAfterSetup, WalkthroughSession, walkthroughsQuietAfterSetup } from "../apps/dashboard/src/walkthrough-session.ts";

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}

test("temporary walkthrough deferral survives remounts and reloads for only the same account, page and version", () => {
  const tab = storage();
  new WalkthroughSession("admin-1", tab).defer("roster", 1);
  const reloaded = new WalkthroughSession("admin-1", tab);
  assert.equal(reloaded.isDeferred("roster", 1), true);
  assert.equal(reloaded.isDeferred("reports", 1), false);
  assert.equal(reloaded.isDeferred("roster", 2), false);
  assert.equal(new WalkthroughSession("operator-1", tab).isDeferred("roster", 1), false);
  assert.equal(new WalkthroughSession("admin-1", storage()).isDeferred("roster", 1), false);
});

test("Debug reset clears only the selected page and sign-out clears only that account", () => {
  const tab = storage();
  const admin = new WalkthroughSession("admin-1", tab);
  admin.defer("roster", 1); admin.defer("reports", 1);
  const operator = new WalkthroughSession("operator-1", tab);
  operator.defer("roster", 1);
  admin.reset("roster", 1);
  assert.equal(new WalkthroughSession("admin-1", tab).isDeferred("roster", 1), false);
  assert.equal(admin.isDeferred("reports", 1), true);
  admin.clear();
  assert.equal(new WalkthroughSession("admin-1", tab).isDeferred("reports", 1), false);
  assert.equal(operator.isDeferred("roster", 1), true);
  assert.equal(new WalkthroughSession("operator-1", tab).isDeferred("roster", 1), true);
});

test("unavailable browser storage still defers repeated route visits and permits Debug reset", () => {
  const blocked = () => { throw new Error("Storage unavailable"); };
  for (const tab of [undefined, { getItem: blocked, setItem: blocked, removeItem: blocked }]) {
    const session = new WalkthroughSession("admin-1", tab);
    assert.equal(session.isDeferred("dashboard", 1), false);
    session.defer("dashboard", 1);
    assert.equal(session.isDeferred("dashboard", 1), true);
    session.reset("dashboard", 1);
    assert.equal(session.isDeferred("dashboard", 1), false);
  }
});

test("module setup quiets automatic page tours for the rest of the browser session without changing deferrals", () => {
  const tab = storage();
  assert.equal(walkthroughsQuietAfterSetup(tab), false);
  quietWalkthroughsAfterSetup(tab);
  assert.equal(walkthroughsQuietAfterSetup(tab), true);
  assert.equal(walkthroughsQuietAfterSetup(storage()), false);
  assert.equal(new WalkthroughSession("admin-1", tab).isDeferred("roster", 1), false);
});
