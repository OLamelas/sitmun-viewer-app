const MIDDLEWARE_URL_KEY = 'MIDDLEWARE_URL';
const DB_NAME = 'sitmun-sw-db';
const TOKENS_STORE_NAME = 'tokens';
const CONFIG_STORE_NAME = 'config';
const READONLY = 'readonly';
const ID = 'id';

let middlewareUrl;

self.addEventListener('install', (event) => {
  event.waitUntil(
    loadMiddlewareUrlFromDB().then(() => {
      console.debug('[SW] Middleware URL loaded from IndexedDB');
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', () => {
  self.clients.claim();
});

self.addEventListener('message', (event) => {
  const eventData = event.data;
  if (eventData.type === MIDDLEWARE_URL_KEY) {
    middlewareUrl = eventData.url;
    console.debug('[SW] Middleware URL updated:', middlewareUrl);
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Filter requests to only include middleware requests
  if (!middlewareUrl || !url.toString().startsWith(middlewareUrl)) {
    return;
  }

  event.respondWith(
    getToken('proxy_token')
      .then((token) => {
        const headers = new Headers(request.headers);
        if (token) {
          headers.set('Authorization', `Bearer ${token}`);
          console.debug(`[SW] Requested ${url} with Authorization header`);
        } else {
          console.warn(`[SW] Token not found!`);
        }

        const modifiedRequest = new Request(request, {
          headers
        });

        return fetch(modifiedRequest);
      })
      .catch((error) => {
        console.error('[SW] Error handling middleware request', error);
        return fetch(request);
      })
  );
});

async function loadMiddlewareUrlFromDB() {
  try {
    const db = await openDB();
    middlewareUrl = await getConfigFromDB(db, 'middleware_url');
    if (middlewareUrl) {
      console.debug('[SW] Middleware URL loaded from DB', middlewareUrl);
    }
  } catch (error) {
    console.warn('[SW] Error loading middleware URL from DB', error);
  }
}

async function getToken(tokenName) {
  try {
    const db = await openDB();

    return await getTokenFromDB(db, tokenName);
  } catch (error) {
    console.warn('Error retrieving proxy token', error);
    return null;
  }
}

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);

    request.onerror = () => reject(request.error);

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(TOKENS_STORE_NAME)) {
        db.createObjectStore(TOKENS_STORE_NAME, { keyPath: ID });
      }
      if (!db.objectStoreNames.contains(CONFIG_STORE_NAME)) {
        db.createObjectStore(CONFIG_STORE_NAME, { keyPath: ID });
      }
    };
  });
}

function getTokenFromDB(db, id) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([TOKENS_STORE_NAME], READONLY);
    const store = transaction.objectStore(TOKENS_STORE_NAME);
    const request = store.get(id);

    request.onerror = () => reject(request.error);

    request.onsuccess = () => {
      const result = request.result;
      resolve(result ? result.token : null);
    };
  });
}

function getConfigFromDB(db, id) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([CONFIG_STORE_NAME], READONLY);
    const store = transaction.objectStore(CONFIG_STORE_NAME);
    const request = store.get(id);

    request.onerror = () => reject(request.error);

    request.onsuccess = () => {
      const result = request.result;
      resolve(result ? result.value : null);
    };
  });
}

