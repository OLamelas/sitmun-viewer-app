import { Injectable } from '@angular/core';

const DB_NAME = 'sitmun-sw-db';
const DB_VERSION = 1;
const TOKENS_STORE_NAME = 'tokens';
const CONFIG_STORE_NAME = 'config';

export interface TokenData {
  id: string;
  token: string;
  timestamp: number;
}

export interface ConfigData {
  id: string;
  value: string;
}

@Injectable({
  providedIn: 'root'
})
export class IndexedDbService {
  private db: IDBDatabase | null = null;

  async init(): Promise<void> {
    if (this.db) return;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => reject(new Error(request.error?.message));

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(TOKENS_STORE_NAME)) {
          db.createObjectStore(TOKENS_STORE_NAME, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(CONFIG_STORE_NAME)) {
          db.createObjectStore(CONFIG_STORE_NAME, { keyPath: 'id' });
        }
      };
    });
  }

  async set(id: string, token: string): Promise<void> {
    await this.ensureDb();
    const db = this.db;
    if (!db) throw new Error('Database not initialized');

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([TOKENS_STORE_NAME], 'readwrite');
      const store = transaction.objectStore(TOKENS_STORE_NAME);
      const request = store.put({
        id,
        token,
        timestamp: Date.now()
      } as TokenData);

      request.onerror = () => reject(new Error(request.error?.message));
      request.onsuccess = () => resolve();
    });
  }

  async remove(id: string): Promise<void> {
    await this.ensureDb();
    const db = this.db;
    if (!db) throw new Error('Database not initialized');

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([TOKENS_STORE_NAME], 'readwrite');
      const store = transaction.objectStore(TOKENS_STORE_NAME);
      const request = store.delete(id);

      request.onerror = () => reject(new Error(request.error?.message));
      request.onsuccess = () => resolve();
    });
  }

  private async ensureDb(): Promise<void> {
    if (!this.db) {
      await this.init();
    }
  }

  // Config methods -------------------------------------------------------

  async setConfig(id: string, value: string): Promise<void> {
    await this.ensureDb();
    const db = this.db;
    if (!db) throw new Error('Database not initialized');

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([CONFIG_STORE_NAME], 'readwrite');
      const store = transaction.objectStore(CONFIG_STORE_NAME);
      const request = store.put({ id, value } as ConfigData);

      request.onerror = () => reject(new Error(request.error?.message));
      request.onsuccess = () => resolve();
    });
  }
}
