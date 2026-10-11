// IndexedDB storage for the offline writer. Shared by the page (app.js) and the
// service worker (sw.js, via importScripts), so it only uses worker-safe APIs.
/* global self */
(function (scope) {
  "use strict";

  const DB_NAME = "blog-writer";
  const DB_VERSION = 1;
  let dbPromise = null;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          // { id, title, date, excerpt, body, cover, nextPhoto, status, error,
          //   slug, path, url, dirty, updatedAt }
          db.createObjectStore("drafts", { keyPath: "id" });
          // { key: `${draftId}:${n}`, draftId, n, blob, width, height, blobSha, uploadedPath }
          const photos = db.createObjectStore("photos", { keyPath: "key" });
          photos.createIndex("draftId", "draftId");
          // { key: "config", token, owner, repo, branch, siteUrl }
          db.createObjectStore("settings", { keyPath: "key" });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  function promisify(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function store(name, mode) {
    const db = await open();
    return db.transaction(name, mode).objectStore(name);
  }

  const DEFAULT_SETTINGS = {
    key: "config",
    token: "",
    owner: "mattv52",
    repo: "blog",
    branch: "main",
    siteUrl: "https://mattv52.github.io/blog",
  };

  const BlogDB = {
    async getSettings() {
      const s = await promisify((await store("settings", "readonly")).get("config"));
      return Object.assign({}, DEFAULT_SETTINGS, s || {});
    },
    async saveSettings(settings) {
      return promisify((await store("settings", "readwrite")).put(Object.assign({}, settings, { key: "config" })));
    },

    async listDrafts() {
      const all = await promisify((await store("drafts", "readonly")).getAll());
      return all.sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async getDraft(id) {
      return promisify((await store("drafts", "readonly")).get(id));
    },
    async saveDraft(draft) {
      return promisify((await store("drafts", "readwrite")).put(draft));
    },
    /**
     * Merge fields into the stored draft in one transaction. The editor and the
     * publisher each only write the fields they own, so neither overwrites the other.
     */
    async updateDraft(id, fields) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("drafts", "readwrite");
        const s = tx.objectStore("drafts");
        let merged = null;
        const get = s.get(id);
        get.onsuccess = () => {
          if (!get.result) return; // deleted meanwhile
          merged = Object.assign(get.result, fields);
          s.put(merged);
        };
        tx.oncomplete = () => resolve(merged);
        tx.onerror = () => reject(tx.error);
      });
    },
    async deleteDraft(id) {
      const photos = await BlogDB.listPhotos(id);
      const s = await store("photos", "readwrite");
      await Promise.all(photos.map((p) => promisify(s.delete(p.key))));
      return promisify((await store("drafts", "readwrite")).delete(id));
    },

    async listPhotos(draftId) {
      const s = await store("photos", "readonly");
      const all = await promisify(s.index("draftId").getAll(draftId));
      return all.sort((a, b) => a.n - b.n);
    },
    async getPhoto(draftId, n) {
      return promisify((await store("photos", "readonly")).get(`${draftId}:${n}`));
    },
    async savePhoto(photo) {
      photo.key = `${photo.draftId}:${photo.n}`;
      return promisify((await store("photos", "readwrite")).put(photo));
    },
    async deletePhoto(draftId, n) {
      return promisify((await store("photos", "readwrite")).delete(`${draftId}:${n}`));
    },
  };

  scope.BlogDB = BlogDB;
})(typeof self !== "undefined" ? self : window);
