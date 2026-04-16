import { TestBed } from '@angular/core/testing';

import { IndexedDbService } from './indexed-db.service';

describe('IndexedDbService', () => {
  let service: IndexedDbService;
  let originalIndexedDb: IDBFactory | undefined;

  function installFakeIndexedDb(): void {
    const storeNames = new Set<string>();

    const makeObjectStore = () => ({
      put: (_value: unknown) => {
        const r = { onsuccess: null as (() => void) | null, onerror: null as (() => void) | null };
        queueMicrotask(() => r.onsuccess?.());
        return r;
      },
      delete: (_id: string) => {
        const r = { onsuccess: null as (() => void) | null, onerror: null as (() => void) | null };
        queueMicrotask(() => r.onsuccess?.());
        return r;
      }
    });

    const makeDb = () => ({
      objectStoreNames: {
        contains: (name: string) => storeNames.has(name)
      },
      createObjectStore: (name: string) => {
        storeNames.add(name);
        return {};
      },
      transaction: (_names: string[], _mode: IDBTransactionMode) => ({
        objectStore: (_name: string) => makeObjectStore()
      })
    });

    globalThis.indexedDB = {
      open: (_dbName: string, _version: number) => {
        const openReq = {
          error: null as DOMException | null,
          result: null as ReturnType<typeof makeDb> | null,
          onsuccess: null as (() => void) | null,
          onerror: null as (() => void) | null,
          onupgradeneeded: null as ((ev: IDBVersionChangeEvent) => void) | null
        };

        queueMicrotask(() => {
          const db = makeDb();
          openReq.result = db;
          openReq.onupgradeneeded?.({
            target: openReq
          } as unknown as IDBVersionChangeEvent);
          openReq.onsuccess?.();
        });

        return openReq as unknown as IDBOpenDBRequest;
      }
    } as IDBFactory;
  }

  beforeEach(() => {
    originalIndexedDb = globalThis.indexedDB;
    installFakeIndexedDb();
    TestBed.configureTestingModule({
      providers: [IndexedDbService]
    });
    service = TestBed.inject(IndexedDbService);
  });

  afterEach(() => {
    if (originalIndexedDb !== undefined) {
      globalThis.indexedDB = originalIndexedDb;
    } else {
      Reflect.deleteProperty(globalThis, 'indexedDB');
    }
  });

  it('initializes once and resolves init()', async () => {
    await service.init();
    await service.init();
    expect(service).toBeTruthy();
  });

  it('persists a token via set()', async () => {
    await expect(service.set('session', 'token-value')).resolves.toBeUndefined();
  });

  it('removes a token via remove()', async () => {
    await expect(service.remove('session')).resolves.toBeUndefined();
  });

  it('persists config via setConfig()', async () => {
    await expect(service.setConfig('k', 'v')).resolves.toBeUndefined();
  });
});
