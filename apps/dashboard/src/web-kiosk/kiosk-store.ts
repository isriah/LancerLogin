// The web kiosk's storage, kept in IndexedDB database `lancerlogin-web-kiosk`:
// - store `state`: the pairing (key `pairing`) and small values the kiosk keeps between starts, such as the last
//   config and roster, the server clock offset and the scans the server refused (see `stateKeys`);
// - store `queue` (version 2): scans waiting to reach the server, in the order they were taken (key `seq`, an
//   auto-incrementing number) with a unique `eventId` index so a scan is never queued twice.
import type { SettingsPinHash } from "./settings-pin.ts";

export type StoredPairing = { kioskId: string; kioskToken: string; pairingId: string; name: string; settingsPin?: SettingsPinHash };

/**
 * A scan saved on the device until the server answers for it. `eventId` stays the same on every retry. At a Require PIN
 * kiosk, a scan is queued only after the member's PIN matched the cached hash, and says `pinCheck: "offline"`; the PIN
 * itself is never saved.
 */
export type QueuedScan = { eventId: string; memberId: string; occurredAt: string; pairingId: string; queuedAt: string; pinCheck?: "offline" };

/** The queue of scans waiting to be sent, oldest first. */
export interface ScanQueue {
  /** Saves a scan at the end of the queue. A scan whose `eventId` is already queued is left as it is. */
  add(scan: QueuedScan): Promise<void>;
  list(): Promise<QueuedScan[]>;
  remove(eventId: string): Promise<void>;
  count(): Promise<number>;
}

export interface KioskStore {
  load(): Promise<StoredPairing | undefined>;
  save(pairing: StoredPairing): Promise<void>;
  /** Forgets everything: the pairing, cached config and roster, the clock offset, refused scans and the queue. */
  clear(): Promise<void>;
  /** A value in the `state` store, or undefined when there is none. */
  read<T>(key: StateKey): Promise<T | undefined>;
  write(key: StateKey, value: unknown): Promise<void>;
  queue: ScanQueue;
}

export const kioskDatabaseName = "lancerlogin-web-kiosk";
export const kioskDatabaseVersion = 2;
const stateStore = "state";
const queueStore = "queue";
const pairingKey = "pairing";
/**
 * Keys in the `state` store besides the pairing. `pinFailures` holds wrong PIN tries made offline until the server has
 * them (member-pin.ts). The roster holds members' PIN hashes only while the kiosk requires a PIN.
 */
export const stateKeys = { config: "config", roster: "roster", clock: "clock", rejected: "rejected", pinFailures: "pinFailures" } as const;
export type StateKey = typeof stateKeys[keyof typeof stateKeys];

/** A stored record is usable only with every credential field; anything else is treated as no pairing. */
export function usablePairing(value: unknown): StoredPairing | undefined {
  const record = value as Partial<StoredPairing> | undefined;
  if (!record || typeof record !== "object") return undefined;
  if (![record.kioskId, record.kioskToken, record.pairingId, record.name].every((field) => typeof field === "string" && field)) return undefined;
  const pin = record.settingsPin;
  const settingsPin = pin && typeof pin.salt === "string" && typeof pin.hash === "string" && Number.isInteger(pin.iterations) ? { salt: pin.salt, hash: pin.hash, iterations: pin.iterations } : undefined;
  return { kioskId: record.kioskId!, kioskToken: record.kioskToken!, pairingId: record.pairingId!, name: record.name!, ...(settingsPin ? { settingsPin } : {}) };
}

/** A stored queue record, or undefined when it is missing a field a scan needs. */
export function usableQueuedScan(value: unknown): QueuedScan | undefined {
  const record = value as Partial<QueuedScan> | undefined;
  if (!record || typeof record !== "object") return undefined;
  if (![record.eventId, record.memberId, record.occurredAt, record.pairingId].every((field) => typeof field === "string" && field)) return undefined;
  return { eventId: record.eventId!, memberId: record.memberId!, occurredAt: record.occurredAt!, pairingId: record.pairingId!, queuedAt: typeof record.queuedAt === "string" ? record.queuedAt : record.occurredAt!, ...(record.pinCheck === "offline" ? { pinCheck: "offline" as const } : {}) };
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}

/** Creates or upgrades the database. Version 1 had only `state`; version 2 adds `queue`. Existing pairings stay. */
export function upgradeKioskDatabase(database: IDBDatabase) {
  if (!database.objectStoreNames.contains(stateStore)) database.createObjectStore(stateStore);
  if (!database.objectStoreNames.contains(queueStore)) database.createObjectStore(queueStore, { keyPath: "seq", autoIncrement: true }).createIndex("eventId", "eventId", { unique: true });
}

/** Sent on the window while another tab's older kiosk page blocks the database upgrade. */
export const kioskStorageBlockedEvent = "lancerlogin-kiosk-storage-blocked";

export function createIndexedDbStore(factory: IDBFactory = globalThis.indexedDB): KioskStore {
  let opening: Promise<IDBDatabase> | undefined;
  const open = () => opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(kioskDatabaseName, kioskDatabaseVersion);
    request.onupgradeneeded = () => upgradeKioskDatabase(request.result);
    // A tab still running an older kiosk page holds the database open; the upgrade waits until that tab closes.
    request.onblocked = () => globalThis.dispatchEvent?.(new Event(kioskStorageBlockedEvent));
    request.onsuccess = () => {
      const database = request.result;
      // Another tab opened a newer version of the database: close this one so the upgrade can go ahead.
      database.onversionchange = () => { database.close(); opening = undefined; };
      resolve(database);
    };
    request.onerror = () => { opening = undefined; reject(request.error); };
  });
  async function run<T>(stores: string | string[], mode: IDBTransactionMode, action: (transaction: IDBTransaction) => IDBRequest<T> | undefined) {
    const database = await open();
    const transaction = database.transaction(stores, mode);
    const request = action(transaction);
    const result = request ? requestResult(request) : Promise.resolve(undefined as T);
    await new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error); });
    return result;
  }
  const queue: ScanQueue = {
    async add(scan) {
      await run(queueStore, "readwrite", (transaction) => {
        const store = transaction.objectStore(queueStore);
        const existing = store.index("eventId").getKey(scan.eventId);
        existing.onsuccess = () => { if (existing.result === undefined) store.add({ ...scan }); };
        return undefined;
      });
    },
    async list() {
      const records = await run(queueStore, "readonly", (transaction) => transaction.objectStore(queueStore).getAll()) as unknown[];
      return records.map(usableQueuedScan).filter((scan): scan is QueuedScan => Boolean(scan));
    },
    async remove(eventId) {
      await run(queueStore, "readwrite", (transaction) => {
        const store = transaction.objectStore(queueStore);
        const key = store.index("eventId").getKey(eventId);
        key.onsuccess = () => { if (key.result !== undefined) store.delete(key.result); };
        return undefined;
      });
    },
    async count() { return run(queueStore, "readonly", (transaction) => transaction.objectStore(queueStore).count()); },
  };
  return {
    async load() { return usablePairing(await run(stateStore, "readonly", (transaction) => transaction.objectStore(stateStore).get(pairingKey))); },
    async save(pairing) { await run(stateStore, "readwrite", (transaction) => transaction.objectStore(stateStore).put(pairing, pairingKey)); },
    async clear() {
      await run([stateStore, queueStore], "readwrite", (transaction) => { transaction.objectStore(stateStore).clear(); transaction.objectStore(queueStore).clear(); return undefined; });
    },
    async read<T>(key: StateKey) { return await run(stateStore, "readonly", (transaction) => transaction.objectStore(stateStore).get(key)) as T | undefined; },
    async write(key, value) { await run(stateStore, "readwrite", (transaction) => transaction.objectStore(stateStore).put(value, key)); },
    queue,
  };
}

/** An in-memory queue, for tests and for a browser that has no IndexedDB. */
export function createMemoryQueue(initial: readonly QueuedScan[] = []): ScanQueue & { clear(): void } {
  let scans = initial.map((scan) => structuredClone(scan));
  return {
    async add(scan) { if (!scans.some((item) => item.eventId === scan.eventId)) scans.push(structuredClone(scan)); },
    async list() { return scans.map((scan) => structuredClone(scan)); },
    async remove(eventId) { scans = scans.filter((scan) => scan.eventId !== eventId); },
    async count() { return scans.length; },
    clear() { scans = []; },
  };
}

/** An in-memory store, for tests and for a browser that has no IndexedDB. */
export function createMemoryStore(initial?: StoredPairing): KioskStore {
  let value = initial;
  const values = new Map<string, unknown>();
  const queue = createMemoryQueue();
  return {
    async load() { return usablePairing(value ? structuredClone(value) : undefined); },
    async save(pairing) { value = structuredClone(pairing); },
    async clear() { value = undefined; values.clear(); queue.clear(); },
    async read<T>(key: StateKey) { return values.has(key) ? structuredClone(values.get(key)) as T : undefined; },
    async write(key, next) { values.set(key, structuredClone(next)); },
    queue,
  };
}
