import { GeneratedImageCard } from '../types';

const DB_NAME = 'bcai_image_gallery_v1';
const STORE_NAME = 'images';
const LS_FALLBACK_KEY = 'bcai.imageGalleryMeta.v1';

function openGalleryDb(): Promise<IDBDatabase | null> {
  if (typeof window === 'undefined' || !('indexedDB' in window)) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    try {
      const req = window.indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function sanitizeCardForStorage(card: GeneratedImageCard): GeneratedImageCard {
  const usableUrl = card.dataUrl || (card.url && !card.url.startsWith('blob:') ? card.url : '');
  return {
    ...card,
    loading: false,
    url: usableUrl,
  };
}

export async function loadGalleryImages(): Promise<GeneratedImageCard[]> {
  const db = await openGalleryDb();
  if (!db) {
    try {
      const raw = localStorage.getItem(LS_FALLBACK_KEY);
      const parsed = raw ? (JSON.parse(raw) as GeneratedImageCard[]) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => {
        const rows = (Array.isArray(req.result) ? req.result : []) as GeneratedImageCard[];
        const sorted = rows
          .map((r) => ({
            ...r,
            loading: false,
            url: r.dataUrl || r.url || '',
          }))
          .filter((r) => Boolean(r.url || r.error))
          .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        resolve(sorted);
      };
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

export async function upsertGalleryImage(card: GeneratedImageCard): Promise<void> {
  if (card.loading) return;
  const clean = sanitizeCardForStorage(card);
  const db = await openGalleryDb();
  if (!db) {
    try {
      const current = await loadGalleryImages();
      const next = [clean, ...current.filter((x) => x.id !== clean.id)].slice(0, 30);
      localStorage.setItem(LS_FALLBACK_KEY, JSON.stringify(next));
    } catch {
      // ignore quota
    }
    return;
  }
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(clean);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function removeGalleryImage(id: string): Promise<void> {
  const db = await openGalleryDb();
  if (!db) {
    try {
      const raw = localStorage.getItem(LS_FALLBACK_KEY);
      const parsed = raw ? (JSON.parse(raw) as GeneratedImageCard[]) : [];
      localStorage.setItem(LS_FALLBACK_KEY, JSON.stringify(parsed.filter((x) => x.id !== id)));
    } catch {
      // ignore
    }
    return;
  }
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function clearGalleryImages(): Promise<void> {
  const db = await openGalleryDb();
  if (!db) {
    try {
      localStorage.removeItem(LS_FALLBACK_KEY);
    } catch {
      // ignore
    }
    return;
  }
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}
