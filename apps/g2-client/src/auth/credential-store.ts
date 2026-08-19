import {
  isBase64UrlSecret,
  isUtcTimestamp,
} from "@palancar/contracts";

export const CREDENTIAL_DATABASE_NAME = "palancar-auth" as const;
export const CREDENTIAL_DATABASE_VERSION = 1 as const;
export const CREDENTIAL_OBJECT_STORE_NAME = "installation" as const;
export const ACTIVE_INSTALLATION_KEY = "active" as const;

export interface StoredInstallationCredential {
  readonly key: "active";
  readonly schemaVersion: 1;
  readonly installationId: string;
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
  readonly currentCredential: string;
  readonly currentCredentialVersion: number;
  readonly currentRotationDueAt: string;
  readonly pendingCredential?: string;
  readonly pendingCredentialVersion?: number;
  readonly pendingCredentialExpiresAt?: string;
  readonly pendingRotationDueAt?: string;
}

export interface CredentialStore {
  load(): Promise<StoredInstallationCredential | undefined>;
  save(record: StoredInstallationCredential): Promise<void>;
  clear(): Promise<void>;
  close(): void;
}

export interface CredentialStoreOptions {
  readonly indexedDB?: IDBFactory;
}

export class CredentialStoreError extends Error {
  constructor() {
    super("Credential storage unavailable");
    this.name = "CredentialStoreError";
  }
}

const BASE_KEYS = [
  "key",
  "schemaVersion",
  "installationId",
  "idleExpiresAt",
  "absoluteExpiresAt",
  "currentCredential",
  "currentCredentialVersion",
  "currentRotationDueAt",
] as const;
const PENDING_KEYS = [
  "pendingCredential",
  "pendingCredentialVersion",
  "pendingCredentialExpiresAt",
  "pendingRotationDueAt",
] as const;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type RecordValue = Record<string, unknown>;

function unavailable(): never {
  throw new CredentialStoreError();
}

function hasOwn(value: RecordValue, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function exactPlainRecord(value: unknown): value is RecordValue {
  if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype) {
    return false;
  }
  const record = value as RecordValue;
  const hasPending = PENDING_KEYS.every((key) => hasOwn(record, key));
  const expectedKeys = hasPending ? [...BASE_KEYS, ...PENDING_KEYS] : [...BASE_KEYS];
  const ownKeys = Reflect.ownKeys(record);
  if (ownKeys.length !== expectedKeys.length) return false;
  return ownKeys.every((key) => {
    if (typeof key !== "string" || !expectedKeys.includes(key as never)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
  });
}

function validPositiveVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && isUtcTimestamp(value);
}

function timestampAtOrBefore(first: string, second: string): boolean {
  return Date.parse(first) <= Date.parse(second);
}

function validateRecord(value: unknown): StoredInstallationCredential {
  if (!exactPlainRecord(value)) unavailable();
  const record = value as RecordValue;
  const hasPending = PENDING_KEYS.every((key) => hasOwn(record, key));
  if (
    record.key !== ACTIVE_INSTALLATION_KEY ||
    record.schemaVersion !== CREDENTIAL_DATABASE_VERSION ||
    typeof record.installationId !== "string" ||
    !UUID_V4_PATTERN.test(record.installationId) ||
    !validTimestamp(record.idleExpiresAt) ||
    !validTimestamp(record.absoluteExpiresAt) ||
    !timestampAtOrBefore(record.idleExpiresAt, record.absoluteExpiresAt) ||
    !isBase64UrlSecret(record.currentCredential) ||
    !validPositiveVersion(record.currentCredentialVersion) ||
    !validTimestamp(record.currentRotationDueAt) ||
    !timestampAtOrBefore(record.currentRotationDueAt, record.absoluteExpiresAt)
  ) {
    unavailable();
  }
  if (!hasPending) return value as unknown as StoredInstallationCredential;
  if (
    !isBase64UrlSecret(record.pendingCredential) ||
    !validPositiveVersion(record.pendingCredentialVersion) ||
    record.pendingCredentialVersion !== record.currentCredentialVersion + 1 ||
    !validTimestamp(record.pendingCredentialExpiresAt) ||
    !validTimestamp(record.pendingRotationDueAt) ||
    !timestampAtOrBefore(record.pendingCredentialExpiresAt, record.absoluteExpiresAt) ||
    !timestampAtOrBefore(record.pendingCredentialExpiresAt, record.pendingRotationDueAt) ||
    !timestampAtOrBefore(record.pendingRotationDueAt, record.absoluteExpiresAt)
  ) {
    unavailable();
  }
  return value as unknown as StoredInstallationCredential;
}

function cloneRecord(record: StoredInstallationCredential): StoredInstallationCredential {
  const base = {
    key: record.key,
    schemaVersion: record.schemaVersion,
    installationId: record.installationId,
    idleExpiresAt: record.idleExpiresAt,
    absoluteExpiresAt: record.absoluteExpiresAt,
    currentCredential: record.currentCredential,
    currentCredentialVersion: record.currentCredentialVersion,
    currentRotationDueAt: record.currentRotationDueAt,
  };
  return record.pendingCredential === undefined
    ? base
    : {
      ...base,
      pendingCredential: record.pendingCredential,
      pendingCredentialVersion: record.pendingCredentialVersion!,
      pendingCredentialExpiresAt: record.pendingCredentialExpiresAt!,
      pendingRotationDueAt: record.pendingRotationDueAt!,
    };
}

function freezeClone(record: StoredInstallationCredential): StoredInstallationCredential {
  return Object.freeze(cloneRecord(record));
}

function closeDatabase(database: IDBDatabase): void {
  try {
    database.close();
  } catch {
    // Closing is best effort and must not expose a platform error.
  }
}

function validateDatabaseSchema(database: IDBDatabase, upgradeTransaction?: IDBTransaction): void {
  if (
    database.objectStoreNames.length !== 1 ||
    !database.objectStoreNames.contains(CREDENTIAL_OBJECT_STORE_NAME)
  ) {
    unavailable();
  }
  const objectStore = upgradeTransaction === undefined
    ? database.transaction(CREDENTIAL_OBJECT_STORE_NAME, "readonly").objectStore(CREDENTIAL_OBJECT_STORE_NAME)
    : upgradeTransaction.objectStore(CREDENTIAL_OBJECT_STORE_NAME);
  if (objectStore.keyPath !== "key" || objectStore.autoIncrement) unavailable();
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    let settled = false;
    const failOpen = (): void => {
      if (settled) return;
      settled = true;
      reject(new CredentialStoreError());
    };
    try {
      request = factory.open(CREDENTIAL_DATABASE_NAME, CREDENTIAL_DATABASE_VERSION);
    } catch {
      failOpen();
      return;
    }
    request.onblocked = (): void => { failOpen(); };
    request.onerror = (): void => { failOpen(); };
    request.onupgradeneeded = (): void => {
      const database = request.result;
      const transaction = request.transaction;
      try {
        if (database.objectStoreNames.length === 0) {
          database.createObjectStore(CREDENTIAL_OBJECT_STORE_NAME, { keyPath: "key" });
        } else {
          validateDatabaseSchema(database, transaction ?? undefined);
        }
      } catch {
        try {
          transaction?.abort();
        } catch {
          failOpen();
        }
      }
    };
    request.onsuccess = (): void => {
      const database = request.result;
      if (settled) {
        closeDatabase(database);
        return;
      }
      try {
        validateDatabaseSchema(database);
      } catch {
        closeDatabase(database);
        failOpen();
        return;
      }
      settled = true;
      database.onerror = (): void => undefined;
      resolve(database);
    };
  });
}

function runTransaction<T>(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let result: T;
    const failTransaction = (): void => {
      if (settled) return;
      settled = true;
      reject(new CredentialStoreError());
    };
    try {
      const transaction = database.transaction(CREDENTIAL_OBJECT_STORE_NAME, mode);
      transaction.onerror = failTransaction;
      transaction.onabort = failTransaction;
      transaction.oncomplete = (): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const request = operation(transaction.objectStore(CREDENTIAL_OBJECT_STORE_NAME));
      request.onerror = failTransaction;
      request.onsuccess = (): void => { result = request.result; };
    } catch {
      failTransaction();
    }
  });
}

export function createCredentialStore(options: CredentialStoreOptions = {}): CredentialStore {
  let database: IDBDatabase | undefined;
  let opening: Promise<IDBDatabase> | undefined;
  let generation = 0;

  const getDatabase = (): Promise<IDBDatabase> => {
    if (database !== undefined) return Promise.resolve(database);
    if (opening !== undefined) return opening;
    const factory = options.indexedDB ?? globalThis.indexedDB;
    if (factory === undefined) return Promise.reject(new CredentialStoreError());
    const openGeneration = generation;
    const openPromise = openDatabase(factory).then((opened) => {
      if (openGeneration !== generation) {
        closeDatabase(opened);
        throw new CredentialStoreError();
      }
      opened.onversionchange = (): void => {
        if (database === opened) database = undefined;
        closeDatabase(opened);
      };
      database = opened;
      return opened;
    });
    opening = openPromise;
    void openPromise.then(
      () => { if (opening === openPromise) opening = undefined; },
      () => { if (opening === openPromise) opening = undefined; },
    );
    return openPromise;
  };

  const load = async (): Promise<StoredInstallationCredential | undefined> => {
    try {
      const result = await runTransaction<unknown>(
        await getDatabase(),
        "readonly",
        (store) => store.get(ACTIVE_INSTALLATION_KEY),
      );
      if (result === undefined) return undefined;
      return freezeClone(validateRecord(result));
    } catch {
      throw new CredentialStoreError();
    }
  };

  const save = async (record: StoredInstallationCredential): Promise<void> => {
    try {
      const validated = validateRecord(record);
      await runTransaction(
        await getDatabase(),
        "readwrite",
        (store) => store.put(cloneRecord(validated)),
      );
    } catch {
      throw new CredentialStoreError();
    }
  };

  const clear = async (): Promise<void> => {
    try {
      await runTransaction(
        await getDatabase(),
        "readwrite",
        (store) => store.delete(ACTIVE_INSTALLATION_KEY),
      );
    } catch {
      throw new CredentialStoreError();
    }
  };

  const close = (): void => {
    generation += 1;
    const current = database;
    database = undefined;
    opening = undefined;
    if (current !== undefined) closeDatabase(current);
  };

  return Object.freeze({ load, save, clear, close });
}
