// ===== IndexedDB 封装 =====

const DB_NAME = 'aiImageGen';
const DB_VERSION = 2;

class ImageDB {
  constructor() { this.db = null; }

  async open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('history')) {
          const store = db.createObjectStore('history', { keyPath: 'id' });
          store.createIndex('created_at', 'created_at', { unique: false });
          store.createIndex('provider', 'provider', { unique: false });
          store.createIndex('favorite', 'favorite', { unique: false });
          store.createIndex('project_id', 'project_id', { unique: false });
        }
        if (!db.objectStoreNames.contains('projects')) {
          const pStore = db.createObjectStore('projects', { keyPath: 'id' });
          pStore.createIndex('created_at', 'created_at', { unique: false });
        }
        if (!db.objectStoreNames.contains('templates')) {
          db.createObjectStore('templates', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      };
      request.onsuccess = (e) => { this.db = e.target.result; resolve(this.db); };
      request.onerror = (e) => reject(e.target.error);
    });
  }

  // ===== 项目 =====
  async getProjects() {
    const all = await this._getAll('projects');
    return all.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  }

  async createProject(name) {
    const project = { id: crypto.randomUUID(), name, created_at: new Date().toISOString() };
    await this._put('projects', project);
    return project;
  }

  async deleteProject(id) {
    const items = await this._getAll('history');
    for (const item of items) {
      if (item.project_id === id) { item.project_id = null; await this._put('history', item); }
    }
    await this._delete('projects', id);
  }

  async renameProject(id, name) {
    const p = await this._get('projects', id);
    if (!p) return;
    p.name = name;
    await this._put('projects', p);
  }

  // ===== 历史记录 =====
  async addHistory(record) {
    record.created_at = new Date().toISOString();
    record.favorite = false;
    record.project_id = record.project_id || null;
    await this._put('history', record);
    return record;
  }

  async getHistory(page = 1, limit = 20, favoriteOnly = false, projectId = null) {
    const all = await this._getAll('history');
    let items = all.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    if (favoriteOnly) items = items.filter(i => i.favorite);
    if (projectId) items = items.filter(i => i.project_id === projectId);
    const total = items.length;
    const start = (page - 1) * limit;
    items = items.slice(start, start + limit);
    return { items, total, page, limit, hasMore: start + limit < total };
  }

  async deleteHistory(id) { await this._delete('history', id); return true; }

  async toggleFavorite(id) {
    const item = await this._get('history', id);
    if (!item) return false;
    item.favorite = !item.favorite;
    await this._put('history', item);
    return item.favorite;
  }

  async getHistoryItem(id) { return this._get('history', id); }
  async clearHistory() { await this._clear('history'); }

  async moveToProject(historyId, projectId) {
    const item = await this._get('history', historyId);
    if (!item) return;
    item.project_id = projectId;
    await this._put('history', item);
  }


  async updateProjectTimestamp(id) {
    const p = await this._get('projects', id);
    if (!p) return;
    p.created_at = new Date().toISOString();
    await this._put('projects', p);
  }

  async getProjectThumbnail(projectId) {
    const all = await this._getAll('history');
    const aiItems = all.filter(i => i.role === 'ai' && i.imageBase64 && i.project_id === projectId);
    if (aiItems.length === 0) return null;
    aiItems.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return aiItems[0].imageBase64;
  }

  async getAllProjectThumbnails() {
    const all = await this._getAll('history');
    const thumbs = {};
    for (const item of all) {
      if (item.role === 'ai' && item.imageBase64 && item.project_id) {
        if (!thumbs[item.project_id] || new Date(item.created_at) > new Date(thumbs[item.project_id].created_at)) {
          thumbs[item.project_id] = { base64: item.imageBase64, created_at: item.created_at };
        }
      }
    }
    const result = {};
    for (const [pid, data] of Object.entries(thumbs)) {
      result[pid] = data.base64;
    }
    return result;
  }

  // ===== 模板 =====
  async getTemplates() { const all = await this._getAll('templates'); return all.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)); }
  async addTemplate(template) { template.id = template.id || crypto.randomUUID(); template.created_at = new Date().toISOString(); await this._put('templates', template); return template; }
  async deleteTemplate(id) { await this._delete('templates', id); }

  // ===== 设置 =====
  async getSetting(key) { const item = await this._get('settings', key); return item ? item.value : null; }
  async setSetting(key, value) { await this._put('settings', { key, value }); }
  async getAllSettings() { const all = await this._getAll('settings'); const obj = {}; all.forEach(s => obj[s.key] = s.value); return obj; }

  // ===== 底层 =====
  _store(name, mode = 'readwrite') { return this.db.transaction(name, mode).objectStore(name); }
  _get(storeName, id) { return new Promise((resolve, reject) => { const req = this._store(storeName, 'readonly').get(id); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }); }
  _getAll(storeName) { return new Promise((resolve, reject) => { const req = this._store(storeName, 'readonly').getAll(); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }); }
  _put(storeName, item) { return new Promise((resolve, reject) => { const req = this._store(storeName).put(item); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }); }
  _delete(storeName, id) { return new Promise((resolve, reject) => { const req = this._store(storeName).delete(id); req.onsuccess = () => resolve(); req.onerror = () => reject(req.error); }); }
  _clear(storeName) { return new Promise((resolve, reject) => { const req = this._store(storeName).clear(); req.onsuccess = () => resolve(); req.onerror = () => reject(req.error); }); }
}

window.ImageDB = ImageDB;