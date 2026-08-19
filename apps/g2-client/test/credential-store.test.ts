import { IDBFactory as FakeIDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import {
  ACTIVE_INSTALLATION_KEY,
  CREDENTIAL_DATABASE_NAME,
  CREDENTIAL_DATABASE_VERSION,
  CREDENTIAL_OBJECT_STORE_NAME,
  CredentialStoreError,
  type StoredInstallationCredential,
  createCredentialStore,
} from "../src/auth/credential-store";

const CURRENT_CREDENTIAL = `${"A".repeat(42)}E`;
const PENDING_CREDENTIAL = `${"B".repeat(42)}I`;
const CANARY_CREDENTIAL = `${"C".repeat(42)}M`;
const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";

const RECORD: StoredInstallationCredential = {
  key: ACTIVE_INSTALLATION_KEY,
  schemaVersion: 1,
  installationId: INSTALLATION_ID,
  idleExpiresAt: "2026-01-01T00:00:00.000Z",
  absoluteExpiresAt: "2026-02-01T00:00:00.000Z",
  currentCredential: CURRENT_CREDENTIAL,
  currentCredentialVersion: 1,
  currentRotationDueAt: "2026-01-15T00:00:00.000Z",
};

const PENDING_RECORD: StoredInstallationCredential = {
  ...RECORD,
  pendingCredential: PENDING_CREDENTIAL,
  pendingCredentialVersion: 2,
  pendingCredentialExpiresAt: "2026-01-20T00:00:00.000Z",
  pendingRotationDueAt: "2026-01-20T00:00:00.000Z",
};

function factory(): IDBFactory {
  return new FakeIDBFactory();
}

function openRaw(databaseFactory: IDBFactory, version = CREDENTIAL_DATABASE_VERSION): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = databaseFactory.open(CREDENTIAL_DATABASE_NAME, version);
    request.onerror = () => reject(new Error("raw open failed"));
    request.onsuccess = () => resolve(request.result);
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(new Error("raw transaction failed"));
    transaction.onabort = () => reject(new Error("raw transaction aborted"));
  });
}

function withRecord(overrides: Record<string, unknown>): StoredInstallationCredential {
  return { ...RECORD, ...overrides } as StoredInstallationCredential;
}

async function expectStoreFailure(operation: Promise<unknown>): Promise<CredentialStoreError> {
  const error = await operation.catch((value: unknown) => value);
  expect(error).toBeInstanceOf(CredentialStoreError);
  expect((error as CredentialStoreError).message).toBe("Credential storage unavailable");
  return error as CredentialStoreError;
}

function expectNoCanaryLeak(error: CredentialStoreError): void {
  const serialized = `${JSON.stringify(error)}${error.stack ?? ""}${Object.keys(error).join("\u0000")}`;
  expect(serialized).not.toContain(CANARY_CREDENTIAL);
  expect(serialized).not.toContain(PLATFORM_CANARY);
}

const PLATFORM_CANARY = "platform-idb-error-canary";

type ControlledOpenRequest = {
  result: IDBDatabase;
  transaction: IDBTransaction | null;
  error: unknown;
  onblocked: (() => void) | null;
  onerror: (() => void) | null;
  onupgradeneeded: (() => void) | null;
  onsuccess: (() => void) | null;
};

type ControlledConnection = {
  request: ControlledOpenRequest;
  database: IDBDatabase;
  closeCount: number;
  transactionCount: number;
  abortCount: number;
  fireUpgrade(): void;
  fireSuccess(): void;
  fireBlocked(): void;
  fireError(): Promise<void>;
  fireVersionChange(): void;
};

function controlledFactory(options: { failFirstUpgrade?: boolean; loadResults?: unknown[] } = {}): {
  factory: IDBFactory;
  connections: ControlledConnection[];
} {
  const connections: ControlledConnection[] = [];
  const factory = {
    open: () => {
      const shouldFailUpgrade = options.failFirstUpgrade === true && connections.length === 0;
      const connection = {} as ControlledConnection;
      const stores = new Set<string>();
      const loadResult = options.loadResults?.[connections.length];
      let activeTransaction: (IDBTransaction & { oncomplete: (() => void) | null }) | undefined;
      const objectStore = {
        keyPath: "key",
        autoIncrement: false,
        get: () => {
          const request = {
            result: loadResult,
            error: null,
            onerror: null,
            onsuccess: null,
          } as unknown as IDBRequest<unknown> & { onsuccess: (() => void) | null };
          queueMicrotask(() => {
            request.onsuccess?.();
            activeTransaction?.oncomplete?.();
          });
          return request;
        },
      } as unknown as IDBObjectStore;
      const objectStoreNames = {
        contains: (name: string) => stores.has(name),
        get length() {
          return stores.size;
        },
      } as unknown as DOMStringList;
      const database = {
        objectStoreNames,
        createObjectStore: (name: string) => {
          if (shouldFailUpgrade) {
            throw new Error(PLATFORM_CANARY);
          }
          stores.add(name);
          return objectStore;
        },
        transaction: () => {
          connection.transactionCount += 1;
          const transaction = {
            objectStore: () => objectStore,
            onabort: null,
            oncomplete: null,
            onerror: null,
          } as unknown as IDBTransaction & { oncomplete: (() => void) | null };
          activeTransaction = transaction;
          return transaction;
        },
        close: () => { connection.closeCount += 1; },
        onversionchange: null,
      } as unknown as IDBDatabase;
      const upgradeTransaction = {
        abort: () => {
          connection.abortCount += 1;
          queueMicrotask(() => {
            request.error = new Error(PLATFORM_CANARY);
            request.onerror?.();
          });
        },
        objectStore: () => objectStore,
        onabort: null,
        oncomplete: null,
        onerror: null,
      } as unknown as IDBTransaction;
      const request: ControlledOpenRequest = {
        result: database,
        transaction: upgradeTransaction,
        error: null,
        onblocked: null,
        onerror: null,
        onupgradeneeded: null,
        onsuccess: null,
      };
      connection.request = request;
      connection.database = database;
      connection.closeCount = 0;
      connection.transactionCount = 0;
      connection.abortCount = 0;
      connection.fireUpgrade = () => { request.onupgradeneeded?.(); };
      connection.fireSuccess = () => { request.onsuccess?.(); };
      connection.fireBlocked = () => { request.onblocked?.(); };
      connection.fireError = () => new Promise<void>((resolve) => {
        queueMicrotask(() => {
          request.error = new Error(PLATFORM_CANARY);
          request.onerror?.();
          resolve();
        });
      });
      connection.fireVersionChange = () => {
        database.onversionchange?.({} as IDBVersionChangeEvent);
      };
      connections.push(connection);
      return request;
    },
  } as unknown as IDBFactory;
  return { factory, connections };
}

describe("credential store", () => {
  it("creates the exact database and object store and round trips one record", async () => {
    const databaseFactory = factory();
    const store = createCredentialStore({ indexedDB: databaseFactory });

    await store.save(PENDING_RECORD);
    expect(await store.load()).toEqual(PENDING_RECORD);

    const database = await openRaw(databaseFactory);
    expect(database.objectStoreNames.length).toBe(1);
    expect(database.objectStoreNames.contains(CREDENTIAL_OBJECT_STORE_NAME)).toBe(true);
    const transaction = database.transaction(CREDENTIAL_OBJECT_STORE_NAME, "readonly");
    const objectStore = transaction.objectStore(CREDENTIAL_OBJECT_STORE_NAME);
    expect(objectStore.keyPath).toBe("key");
    expect(objectStore.autoIncrement).toBe(false);
    database.close();
    store.close();
  });

  it("clones on save and freezes a separate object on load", async () => {
    const store = createCredentialStore({ indexedDB: factory() });
    const callerRecord = { ...PENDING_RECORD };

    await store.save(callerRecord);
    callerRecord.currentCredential = CANARY_CREDENTIAL;
    const loaded = await store.load();

    expect(loaded).toEqual(PENDING_RECORD);
    expect(loaded).not.toBe(callerRecord);
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(() => {
      (loaded as { installationId: string }).installationId = CANARY_CREDENTIAL;
    }).toThrow(TypeError);
    store.close();
  });

  it("replaces the active record, clears it, and reopens after close", async () => {
    const databaseFactory = factory();
    const store = createCredentialStore({ indexedDB: databaseFactory });

    await store.save(PENDING_RECORD);
    await store.save(withRecord({ currentCredentialVersion: 3 }));
    expect(await store.load()).toEqual(withRecord({ currentCredentialVersion: 3 }));
    await store.clear();
    expect(await store.load()).toBeUndefined();

    await store.save(RECORD);
    store.close();
    store.close();
    expect(await store.load()).toEqual(RECORD);
    store.close();
  });

  it("fails a load closed during open and permits a later open", async () => {
    let openCount = 0;
    let closeCount = 0;
    type ControlledOpenRequest = {
      result: IDBDatabase;
      transaction: IDBTransaction | null;
      onblocked: (() => void) | null;
      onerror: (() => void) | null;
      onupgradeneeded: (() => void) | null;
      onsuccess: (() => void) | null;
    };
    const requests: ControlledOpenRequest[] = [];
    const databases: IDBDatabase[] = [];
    const databaseFactory = {
      open: () => {
        const stores = new Set<string>();
        const objectStore = {
          keyPath: "key",
          autoIncrement: false,
          get: () => {
            const request = {
              result: undefined,
              error: null,
              onerror: null,
              onsuccess: null,
            } as unknown as IDBRequest<undefined> & { onsuccess: (() => void) | null };
            queueMicrotask(() => {
              request.onsuccess?.();
              transaction.oncomplete?.();
            });
            return request;
          },
        } as unknown as IDBObjectStore;
        const objectStoreNames = {
          contains: (name: string) => stores.has(name),
          get length() {
            return stores.size;
          },
        } as unknown as DOMStringList;
        const transaction = {
          objectStore: () => objectStore,
          onabort: null,
          oncomplete: null,
          onerror: null,
        } as unknown as IDBTransaction & { oncomplete: (() => void) | null };
        const database = {
          objectStoreNames,
          createObjectStore: (name: string) => {
            stores.add(name);
            return objectStore;
          },
          transaction: () => transaction,
          close: () => { closeCount += 1; },
          onversionchange: null,
        } as unknown as IDBDatabase;
        const request: ControlledOpenRequest = {
          result: database,
          transaction: null,
          onblocked: null,
          onerror: null,
          onupgradeneeded: null,
          onsuccess: null,
        };
        openCount += 1;
        requests.push(request);
        databases.push(database);
        return request;
      },
    } as unknown as IDBFactory;

    const store = createCredentialStore({ indexedDB: databaseFactory });
    const firstLoad = store.load();
    expect(openCount).toBe(1);
    store.close();

    requests[0]!.onupgradeneeded?.();
    requests[0]!.onsuccess?.();
    await expectStoreFailure(firstLoad);
    expect(closeCount).toBe(1);

    const secondLoad = store.load();
    expect(openCount).toBe(2);
    requests[1]!.onupgradeneeded?.();
    requests[1]!.onsuccess?.();
    requests[1]!.onerror?.();
    await expect(secondLoad).resolves.toBeUndefined();
    expect(databases).toHaveLength(2);
    store.close();
    expect(closeCount).toBe(2);
  });

  it("normalizes blocked open, closes late success, and retries cleanly", async () => {
    const controlled = controlledFactory();
    const store = createCredentialStore({ indexedDB: controlled.factory });
    const pending = store.load();
    const first = controlled.connections[0]!;

    first.fireUpgrade();
    first.fireBlocked();
    const error = await expectStoreFailure(pending);
    expectNoCanaryLeak(error);
    first.fireSuccess();
    expect(first.closeCount).toBe(1);

    const retry = store.load();
    const second = controlled.connections[1]!;
    second.fireUpgrade();
    second.fireSuccess();
    await expect(retry).resolves.toBeUndefined();
    store.close();
  });

  it("normalizes an asynchronous open error, closes late success, and retries cleanly", async () => {
    const controlled = controlledFactory();
    const store = createCredentialStore({ indexedDB: controlled.factory });
    const pending = store.load();
    const first = controlled.connections[0]!;

    first.fireUpgrade();
    const errorDelivery = first.fireError();
    const error = await expectStoreFailure(pending);
    await errorDelivery;
    expectNoCanaryLeak(error);
    first.fireSuccess();
    expect(first.closeCount).toBe(1);

    const retry = store.load();
    const second = controlled.connections[1]!;
    second.fireUpgrade();
    second.fireSuccess();
    await expect(retry).resolves.toBeUndefined();
    store.close();
  });

  it("aborts a failed upgrade, cleans up late success, and remains retryable", async () => {
    const controlled = controlledFactory({ failFirstUpgrade: true });
    const store = createCredentialStore({ indexedDB: controlled.factory });
    const pending = store.load();
    const first = controlled.connections[0]!;

    first.fireUpgrade();
    expect(first.abortCount).toBe(1);
    const error = await expectStoreFailure(pending);
    expectNoCanaryLeak(error);
    expect(first.abortCount).toBe(1);
    first.fireSuccess();
    expect(first.closeCount).toBe(1);

    const retry = store.load();
    const second = controlled.connections[1]!;
    second.fireUpgrade();
    second.fireSuccess();
    await expect(retry).resolves.toBeUndefined();
    store.close();
  });

  it("discards and closes the cached database on version change", async () => {
    const controlled = controlledFactory({ loadResults: [RECORD] });
    const store = createCredentialStore({ indexedDB: controlled.factory });
    const firstLoad = store.load();
    const first = controlled.connections[0]!;
    first.fireUpgrade();
    first.fireSuccess();
    await expect(firstLoad).resolves.toEqual(RECORD);
    expect(first.transactionCount).toBe(2);

    first.fireVersionChange();
    expect(first.closeCount).toBe(1);

    const secondLoad = store.load();
    const second = controlled.connections[1]!;
    second.fireUpgrade();
    second.fireSuccess();
    await expect(secondLoad).resolves.toBeUndefined();
    expect(first.transactionCount).toBe(2);
    expect(second.transactionCount).toBe(2);
    store.close();
    expect(second.closeCount).toBe(1);
  });

  it.each([
    ["extra key", { ...RECORD, extra: "unexpected" }],
    ["wrong key", withRecord({ key: "other" })],
    ["wrong schema", withRecord({ schemaVersion: 2 })],
    ["non-v4 installation id", withRecord({ installationId: "11111111-1111-5111-8111-111111111111" })],
    ["bad current credential", withRecord({ currentCredential: CANARY_CREDENTIAL.slice(0, -1) })],
    ["zero current version", withRecord({ currentCredentialVersion: 0 })],
    ["invalid timestamp", withRecord({ idleExpiresAt: "2026-02-30T00:00:00Z" })],
    ["idle after absolute", withRecord({ idleExpiresAt: "2026-03-01T00:00:00.000Z" })],
    ["rotation after absolute", withRecord({ currentRotationDueAt: "2026-03-01T00:00:00.000Z" })],
    ["partial pending fields", { ...PENDING_RECORD, pendingRotationDueAt: undefined }],
    ["wrong pending version", { ...PENDING_RECORD, pendingCredentialVersion: 3 }],
    ["pending expiry after absolute", { ...PENDING_RECORD, pendingCredentialExpiresAt: "2026-03-01T00:00:00.000Z" }],
    ["pending rotation before expiry", { ...PENDING_RECORD, pendingRotationDueAt: "2026-01-19T00:00:00.000Z" }],
    ["pending rotation after absolute", { ...PENDING_RECORD, pendingRotationDueAt: "2026-03-01T00:00:00.000Z" }],
  ] as const)("rejects malformed save: %s", async (_name, value) => {
    const store = createCredentialStore({ indexedDB: factory() });
    await expectStoreFailure(store.save(value as StoredInstallationCredential));
    store.close();
  });

  it("rejects non-plain and accessor records without leaking the credential", async () => {
    const store = createCredentialStore({ indexedDB: factory() });
    const inherited = Object.assign(Object.create({ inherited: true }), RECORD);
    const accessor = { ...RECORD } as Record<string, unknown>;
    Object.defineProperty(accessor, "currentCredential", {
      enumerable: true,
      get: () => CANARY_CREDENTIAL,
    });

    for (const value of [inherited, accessor]) {
      const error = await expectStoreFailure(store.save(value as StoredInstallationCredential));
      expect(JSON.stringify(error)).not.toContain(CANARY_CREDENTIAL);
      expect(error.stack ?? "").not.toContain(CANARY_CREDENTIAL);
    }
    store.close();
  });

  it("rejects malformed data loaded from IndexedDB", async () => {
    const databaseFactory = factory();
    const store = createCredentialStore({ indexedDB: databaseFactory });
    await store.save(RECORD);
    const database = await openRaw(databaseFactory);
    const transaction = database.transaction(CREDENTIAL_OBJECT_STORE_NAME, "readwrite");
    transaction.objectStore(CREDENTIAL_OBJECT_STORE_NAME).put({
      ...RECORD,
      currentCredential: CANARY_CREDENTIAL,
      extra: "malformed",
    });
    await transactionComplete(transaction);

    const error = await expectStoreFailure(store.load());
    expect(JSON.stringify(error)).not.toContain(CANARY_CREDENTIAL);
    expect(error.stack ?? "").not.toContain(CANARY_CREDENTIAL);
    database.close();
    store.close();
  });

  it("normalizes absent IndexedDB and open failures", async () => {
    const absentStore = createCredentialStore();
    await expectStoreFailure(absentStore.load());

    const canaryFactory = {
      open: () => { throw new Error(CANARY_CREDENTIAL); },
    } as unknown as IDBFactory;
    const failedStore = createCredentialStore({ indexedDB: canaryFactory });
    const error = await expectStoreFailure(failedStore.load());
    expect(JSON.stringify(error)).not.toContain(CANARY_CREDENTIAL);
    expect(error.stack ?? "").not.toContain(CANARY_CREDENTIAL);
  });

  it("normalizes a transaction abort without exposing platform errors", async () => {
    let transactionCalls = 0;
    const fakeStore = {
      get: () => ({}) as IDBRequest<unknown>,
    } as unknown as IDBObjectStore;
    const fakeDatabase = {
      objectStoreNames: { length: 1, contains: (name: string) => name === CREDENTIAL_OBJECT_STORE_NAME },
      close: () => undefined,
      transaction: () => {
        transactionCalls += 1;
        const transaction = {
          objectStore: () => fakeStore,
          onerror: null,
          onabort: null,
          oncomplete: null,
        } as unknown as IDBTransaction & {
          onabort: (() => void) | null;
          oncomplete: (() => void) | null;
          onerror: (() => void) | null;
        };
        if (transactionCalls > 1) {
          queueMicrotask(() => transaction.onabort?.());
        }
        return transaction;
      },
    } as unknown as IDBDatabase;
    const fakeFactory = {
      open: () => {
        const request = {
          result: fakeDatabase,
          onblocked: null,
          onerror: null,
          onupgradeneeded: null,
          onsuccess: null,
        } as unknown as IDBOpenDBRequest & { onsuccess: (() => void) | null };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      },
    } as unknown as IDBFactory;

    const store = createCredentialStore({ indexedDB: fakeFactory });
    await expectStoreFailure(store.load());
  });
});
