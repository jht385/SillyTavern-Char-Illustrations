import { getContext } from '../../../extensions.js';
import { eventSource, event_types } from '../../../../script.js';

// ==================== 0. 通用安全与转义工具 ====================
function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function debounce(fn, delay = 300) {
    let timer = null;
    return function (...args) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), delay);
    };
}

function forceKeepDrawerExpanded() {
    localStorage.setItem('ci_drawer_is_open', '1');
    const content = $('#ci-settings-content');
    const icon = $('#ci-drawer-toggle .ci-drawer-icon');
    if (content.length) {
        content.css('display', 'block').show();
    }
    if (icon.length) {
        icon.removeClass('fa-circle-chevron-down down').addClass('fa-circle-chevron-up up');
    }
}

function base64ToBlob(base64) {
    if (base64 instanceof Blob) return base64;
    if (typeof base64 !== 'string') return null;

    try {
        let contentType = 'image/png';
        let rawBase64 = base64;

        if (base64.includes(';base64,')) {
            const parts = base64.split(';base64,');
            if (parts[0].includes(':')) {
                contentType = parts[0].split(':')[1];
            }
            rawBase64 = parts[1];
        } else if (base64.startsWith('data:')) {
            const match = base64.match(/^data:([^;]+);/);
            if (match) contentType = match[1];
            rawBase64 = base64.replace(/^data:[^;]+;base64,/, '');
        }

        const cleanStr = rawBase64.replace(/[\r\n\s]/g, '');
        const byteCharacters = window.atob(cleanStr);
        const len = byteCharacters.length;
        const byteArray = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            byteArray[i] = byteCharacters.charCodeAt(i);
        }
        return new Blob([byteArray], { type: contentType });
    } catch (e) {
        return base64;
    }
}

function blobToBase64(blob) {
    if (typeof blob === 'string') return Promise.resolve(blob);
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

// ==================== 1. 图像展示与生命周期管理 (0 泄漏单例缓存) ====================
class ImageUrlManager {
    constructor() {
        this.blobUrlMap = new WeakMap();
        this.strCache = new Map();
        this.thumbUrlCache = new Map();
    }

    getUrl(source) {
        if (!source) return '';

        if (typeof source === 'string') {
            if (source.startsWith('http://') || source.startsWith('https://') || source.startsWith('/') || source.startsWith('blob:')) {
                return source;
            }

            let base64 = source.trim();
            if (!base64.startsWith('data:image')) {
                base64 = 'data:image/png;base64,' + base64;
            }

            if (this.strCache.has(base64)) {
                return this.strCache.get(base64);
            }

            try {
                const blob = base64ToBlob(base64);
                const url = URL.createObjectURL(blob);
                this.strCache.set(base64, url);
                return url;
            } catch (e) {
                return base64;
            }
        }

        if (source instanceof Blob) {
            if (this.blobUrlMap.has(source)) {
                return this.blobUrlMap.get(source);
            }
            try {
                const url = URL.createObjectURL(source);
                this.blobUrlMap.set(source, url);
                return url;
            } catch (e) {
                return '';
            }
        }

        return '';
    }

    clearCache() {
        for (const url of this.strCache.values()) {
            try { if (typeof url === 'string' && url.startsWith('blob:')) URL.revokeObjectURL(url); } catch (_) {}
        }
        this.strCache.clear();
        this.thumbUrlCache.clear();
    }
}

const urlManager = new ImageUrlManager();

function toDisplayUrl(source) {
    return urlManager.getUrl(source);
}

// ==================== 2. 全屏图片灯箱 ====================
let viewerState = {
    scale: 1,
    translateX: 0,
    translateY: 0,
    isDragging: false,
    startX: 0,
    startY: 0,
    initialDistance: 0,
    initialScale: 1,
    ticking: false
};

function initImageViewer() {
    if (document.getElementById('ci-lightbox-modal')) return;

    const modal = document.createElement('div');
    modal.id = 'ci-lightbox-modal';
    modal.className = 'ci-lightbox';
    modal.innerHTML = `
        <div class="ci-lightbox-backdrop"></div>
        <div class="ci-lightbox-content">
            <img id="ci-lightbox-img" src="" alt="放大插图" draggable="false" />
        </div>
        <div class="ci-lightbox-close" title="关闭 (Esc)">×</div>
        <div class="ci-lightbox-hint">滚轮/双指缩放 · 拖拽移动 · 双击复位 · 单击背景关闭</div>
    `;
    document.body.appendChild(modal);

    const img = document.getElementById('ci-lightbox-img');
    const content = modal.querySelector('.ci-lightbox-content');
    const backdrop = modal.querySelector('.ci-lightbox-backdrop');
    const closeBtn = modal.querySelector('.ci-lightbox-close');

    function scheduleRender() {
        if (viewerState.ticking) return;
        viewerState.ticking = true;
        requestAnimationFrame(() => {
            img.style.transform = `translate3d(${viewerState.translateX}px, ${viewerState.translateY}px, 0) scale(${viewerState.scale})`;
            viewerState.ticking = false;
        });
    }

    function resetTransform() {
        viewerState.scale = 1;
        viewerState.translateX = 0;
        viewerState.translateY = 0;
        scheduleRender();
    }

    window.openCIModal = function(src) {
        img.src = toDisplayUrl(src);
        resetTransform();
        modal.classList.add('active');
    };

    function closeModal() {
        modal.classList.remove('active');
        img.src = '';
        forceKeepDrawerExpanded();
    }

    closeBtn.onclick = (e) => { e.stopPropagation(); closeModal(); };
    backdrop.onclick = (e) => { e.stopPropagation(); closeModal(); };

    modal.addEventListener('wheel', (e) => {
        if (!modal.classList.contains('active')) return;
        e.preventDefault();
        const zoomFactor = 1.15;
        if (e.deltaY < 0) {
            viewerState.scale = Math.min(viewerState.scale * zoomFactor, 8);
        } else {
            viewerState.scale = Math.max(viewerState.scale / zoomFactor, 0.4);
        }
        scheduleRender();
    }, { passive: false });

    content.addEventListener('mousedown', (e) => {
        if (e.target !== img && e.target !== content) return;
        e.preventDefault();
        viewerState.isDragging = true;
        viewerState.startX = e.clientX - viewerState.translateX;
        viewerState.startY = e.clientY - viewerState.translateY;
        content.style.cursor = 'grabbing';
    });

    window.addEventListener('mousemove', (e) => {
        if (!viewerState.isDragging) return;
        viewerState.translateX = e.clientX - viewerState.startX;
        viewerState.translateY = e.clientY - viewerState.startY;
        scheduleRender();
    }, { passive: true });

    window.addEventListener('mouseup', () => {
        if (viewerState.isDragging) {
            viewerState.isDragging = false;
            content.style.cursor = 'grab';
        }
    }, { passive: true });

    function getDistanceSquared(touch1, touch2) {
        const dx = touch1.clientX - touch2.clientX;
        const dy = touch1.clientY - touch2.clientY;
        return dx * dx + dy * dy;
    }

    content.addEventListener('touchstart', (e) => {
        if (!modal.classList.contains('active')) return;
        if (e.touches.length === 1) {
            viewerState.isDragging = true;
            viewerState.startX = e.touches[0].clientX - viewerState.translateX;
            viewerState.startY = e.touches[0].clientY - viewerState.translateY;
        } else if (e.touches.length === 2) {
            viewerState.isDragging = false;
            viewerState.initialDistance = Math.sqrt(getDistanceSquared(e.touches[0], e.touches[1]));
            viewerState.initialScale = viewerState.scale;
        }
    }, { passive: true });

    content.addEventListener('touchmove', (e) => {
        if (!modal.classList.contains('active')) return;
        if (e.touches.length === 1 && viewerState.isDragging) {
            e.preventDefault();
            viewerState.translateX = e.touches[0].clientX - viewerState.startX;
            viewerState.translateY = e.touches[0].clientY - viewerState.startY;
            scheduleRender();
        } else if (e.touches.length === 2 && viewerState.initialDistance > 0) {
            e.preventDefault();
            const currentDist = Math.sqrt(getDistanceSquared(e.touches[0], e.touches[1]));
            const pinchRatio = currentDist / viewerState.initialDistance;
            viewerState.scale = Math.min(Math.max(viewerState.initialScale * pinchRatio, 0.4), 8);
            scheduleRender();
        }
    }, { passive: false });

    content.addEventListener('touchend', (e) => {
        if (e.touches.length === 0) {
            viewerState.isDragging = false;
            viewerState.initialDistance = 0;
        } else if (e.touches.length === 1) {
            viewerState.isDragging = true;
            viewerState.startX = e.touches[0].clientX - viewerState.translateX;
            viewerState.startY = e.touches[0].clientY - viewerState.translateY;
            viewerState.initialDistance = 0;
        }
    });

    img.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        resetTransform();
    });

    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal.classList.contains('active')) {
            closeModal();
        }
    });
}

// ==================== 3. 规则与数据标准化 ====================
function parseRuleInput(inputStr) {
    if (!inputStr) return [];
    return inputStr
        .split(/[,，]/)
        .map(group => group.split('+').map(k => k.trim()).filter(k => k.length > 0))
        .filter(group => group.length > 0);
}

function cleanAndNormalizeRules(rulesInput) {
    if (!rulesInput) return [];
    let list = [];
    if (Array.isArray(rulesInput)) {
        list = rulesInput;
    } else if (typeof rulesInput === 'string') {
        list = parseRuleInput(rulesInput);
    }

    const seenGroup = new Set();
    const result = [];

    for (const group of list) {
        let tokens = [];
        if (Array.isArray(group)) {
            tokens = group.map(k => String(k).trim()).filter(Boolean);
        } else if (typeof group === 'string') {
            tokens = group.split('+').map(k => k.trim()).filter(Boolean);
        }

        if (tokens.length > 0) {
            const uniqueTokens = Array.from(new Set(tokens));
            const groupKey = uniqueTokens.slice().sort().join('+');
            if (!seenGroup.has(groupKey)) {
                seenGroup.add(groupKey);
                result.push(uniqueTokens);
            }
        }
    }
    return result;
}

function formatRuleDisplay(item) {
    if (item.rules && Array.isArray(item.rules)) {
        return item.rules.map(group => (Array.isArray(group) ? group.join(' + ') : group)).join(', ');
    }
    if (item.keywords && Array.isArray(item.keywords)) {
        return item.keywords.join(', ');
    }
    return '';
}

function optimizeIllustrationRecord(rawItem, fallbackOrder = 1) {
    const rawImgs = rawItem.images || (rawItem.data ? [rawItem.data] : []);
    if (!rawImgs.length) return null;

    const blobImgs = rawImgs.map(img => {
        if (typeof img === 'string' && img.startsWith('data:image')) {
            return base64ToBlob(img);
        }
        return img;
    });

    const cleanRules = cleanAndNormalizeRules(rawItem.rules || rawItem.keywords);
    if (!cleanRules.length) return null;

    const cleanNames = Array.isArray(rawItem.imageNames) ? [...rawItem.imageNames] : [];
    while (cleanNames.length < blobImgs.length) cleanNames.push('');
    if (cleanNames.length > blobImgs.length) cleanNames.length = blobImgs.length;

    let selectedIdx = typeof rawItem.selectedIndex === 'number' ? rawItem.selectedIndex : 0;
    if (selectedIdx < 0 || selectedIdx >= blobImgs.length) selectedIdx = 0;

    return {
        rules: cleanRules,
        images: blobImgs,
        imageNames: cleanNames,
        selectedIndex: selectedIdx,
        groupName: typeof rawItem.groupName === 'string' ? rawItem.groupName.trim() : '',
        order: typeof rawItem.order === 'number' ? rawItem.order : fallbackOrder,
        createdAt: rawItem.createdAt || Date.now()
    };
}

// ==================== 4. 极速 IndexedDB 存储引擎 (带常驻内存 Map，零顿卡) ====================
const DB_NAME = 'ST_Char_Illustrations_DB';
const STORE_NAME = 'illustrations';
let dbInstance = null;
let dbInitPromise = null;

// 全局内存级插图缓存 Map: charKey -> Array of items，命中即秒回，彻底避免 IO 阻塞
const memoryIllustrationCache = new Map();

let searchFilterKeyword = '';
let searchInputValue = '';
let activeGroupFilter = '';
let cachedStorageStats = null;
let lastStatsCharId = null;

const activeSlideMemoryByChar = new Map();

function initDB() {
    if (dbInstance) return Promise.resolve(dbInstance);
    if (dbInitPromise) return dbInitPromise;

    dbInitPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 3);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            let store;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
                store.createIndex('charId', 'charId', { unique: false });
            } else {
                store = e.target.transaction.objectStore(STORE_NAME);
            }
            if (store && !store.indexNames.contains('order')) {
                store.createIndex('order', 'order', { unique: false });
            }
        };

        req.onsuccess = (e) => {
            dbInstance = e.target.result;
            dbInitPromise = null;
            dbInstance.onversionchange = () => { try { dbInstance.close(); } catch (_) {} dbInstance = null; };
            dbInstance.onclose = () => { dbInstance = null; };
            resolve(dbInstance);
        };

        req.onerror = (e) => {
            dbInstance = null;
            dbInitPromise = null;
            reject(e);
        };
    });

    return dbInitPromise;
}

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function dbGetStorageStats(charId) {
    const db = await initDB();
    return new Promise((resolve) => {
        try {
            const tx = db.transaction([STORE_NAME], 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const req = store.openCursor();
            let totalBytes = 0;
            let charBytes = 0;
            let totalCount = 0;

            req.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) {
                    const item = cursor.value;
                    totalCount++;
                    let size = 0;
                    const imgs = item.images || [];
                    for (const img of imgs) {
                        if (img instanceof Blob) size += img.size;
                        else if (typeof img === 'string') size += img.length * 2;
                    }
                    totalBytes += size;
                    if (item.charId === charId) charBytes += size;
                    cursor.continue();
                } else {
                    resolve({
                        charSize: formatBytes(charBytes),
                        totalSize: formatBytes(totalBytes),
                        totalCount
                    });
                }
            };
            req.onerror = () => resolve({ charSize: '0 B', totalSize: '0 B', totalCount: 0 });
        } catch (_) {
            resolve({ charSize: '0 B', totalSize: '0 B', totalCount: 0 });
        }
    });
}

async function dbClearEntireDatabase() {
    const db = await initDB();
    urlManager.clearCache();
    memoryIllustrationCache.clear();
    return new Promise((resolve, reject) => {
        try {
            const tx = db.transaction([STORE_NAME], 'readwrite');
            tx.objectStore(STORE_NAME).clear();
            tx.oncomplete = () => { cachedStorageStats = null; resolve(); };
            tx.onerror = (e) => reject(e);
        } catch (err) { reject(err); }
    });
}

async function dbAddIllustration(charId, rules, imagesData, imageNames = [], selectedIndex = 0, groupName = '') {
    const db = await initDB();
    const existing = await dbGetIllustrations(charId);
    const nextOrder = existing.length > 0 ? Math.max(...existing.map(i => i.order || 0)) + 1 : 1;
    const imagesList = Array.isArray(imagesData) ? imagesData : [imagesData];

    const blobList = imagesList.map(img => (typeof img === 'string' && img.startsWith('data:image') ? base64ToBlob(img) : img));
    const namesList = Array.isArray(imageNames) ? [...imageNames] : [];
    while (namesList.length < blobList.length) namesList.push('');

    return new Promise((resolve, reject) => {
        try {
            const tx = db.transaction([STORE_NAME], 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const item = {
                charId,
                rules: cleanAndNormalizeRules(rules),
                images: blobList,
                imageNames: namesList,
                selectedIndex: selectedIndex || 0,
                groupName: (groupName || '').trim(),
                order: nextOrder,
                createdAt: Date.now()
            };
            const req = store.add(item);
            req.onsuccess = () => {
                memoryIllustrationCache.delete(charId);
                cachedStorageStats = null;
                resolve(req.result);
            };
            req.onerror = (e) => reject(e);
        } catch (err) { reject(err); }
    });
}

async function dbBatchInsertItems(charId, batchRecords) {
    if (!batchRecords || !batchRecords.length) return 0;
    const db = await initDB();
    return new Promise((resolve, reject) => {
        try {
            const tx = db.transaction([STORE_NAME], 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            let count = 0;
            for (const rec of batchRecords) {
                store.add({ charId, ...rec });
                count++;
            }
            tx.oncomplete = () => {
                memoryIllustrationCache.delete(charId);
                cachedStorageStats = null;
                resolve(count);
            };
            tx.onerror = (e) => reject(e);
        } catch (err) { reject(err); }
    });
}

// 高性能直查：优先从内存 Map 瞬间提取，彻底消灭聊天卡顿
async function dbGetIllustrations(charId) {
    if (!charId) return [];
    if (memoryIllustrationCache.has(charId)) {
        return memoryIllustrationCache.get(charId);
    }

    const db = await initDB();
    return new Promise((resolve) => {
        try {
            const tx = db.transaction([STORE_NAME], 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const index = store.index('charId');
            const req = index.getAll(IDBKeyRange.only(charId));
            
            req.onsuccess = () => {
                let res = req.result || [];
                res.forEach(item => {
                    if (!item.images) item.images = item.data ? [item.data] : [];
                    if (!Array.isArray(item.imageNames)) item.imageNames = new Array(item.images.length).fill('');
                    if (typeof item.selectedIndex !== 'number') item.selectedIndex = 0;
                    if (typeof item.groupName !== 'string') item.groupName = '';
                });
                res.sort((a, b) => (a.order ?? a.id) - (b.order ?? b.id));
                memoryIllustrationCache.set(charId, res);
                resolve(res);
            };
            req.onerror = () => resolve([]);
        } catch (_) {
            resolve([]);
        }
    });
}

async function dbUpdateIllustration(id, rules = null, order = null, newImages = null, imageNames = null, selectedIndex = null, groupName = null) {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        try {
            const tx = db.transaction([STORE_NAME], 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const getReq = store.get(id);
            getReq.onsuccess = () => {
                const data = getReq.result;
                if (!data) return reject(new Error('数据未找到'));
                if (rules !== null) {
                    data.rules = cleanAndNormalizeRules(rules);
                    delete data.keywords;
                }
                if (order !== null) data.order = order;
                if (newImages !== null) {
                    data.images = newImages.map(img => (typeof img === 'string' && img.startsWith('data:image') ? base64ToBlob(img) : img));
                    delete data.data;
                    cachedStorageStats = null;
                }
                if (imageNames !== null) data.imageNames = imageNames;
                if (selectedIndex !== null) data.selectedIndex = selectedIndex;
                if (groupName !== null) data.groupName = groupName.trim();
                
                const putReq = store.put(data);
                putReq.onsuccess = () => {
                    memoryIllustrationCache.delete(data.charId);
                    resolve();
                };
                putReq.onerror = (e) => reject(e);
            };
            getReq.onerror = (e) => reject(e);
        } catch (err) { reject(err); }
    });
}

async function dbSetIllustrationSelectedIndex(id, index) {
    const db = await initDB();
    return new Promise((resolve) => {
        try {
            const tx = db.transaction([STORE_NAME], 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const getReq = store.get(id);
            getReq.onsuccess = () => {
                const data = getReq.result;
                if (!data) return resolve();
                data.selectedIndex = index;
                const putReq = store.put(data);
                putReq.onsuccess = () => {
                    memoryIllustrationCache.delete(data.charId);
                    resolve();
                };
                putReq.onerror = () => resolve();
            };
            getReq.onerror = () => resolve();
        } catch (_) { resolve(); }
    });
}

async function dbBatchSaveAll(updates) {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        try {
            const tx = db.transaction([STORE_NAME], 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            for (const item of updates) {
                const getReq = store.get(item.id);
                getReq.onsuccess = () => {
                    const data = getReq.result;
                    if (data) {
                        if (item.rules) data.rules = cleanAndNormalizeRules(item.rules);
                        if (item.order !== undefined) data.order = item.order;
                        if (item.images) {
                            data.images = item.images.map(img => (typeof img === 'string' && img.startsWith('data:image') ? base64ToBlob(img) : img));
                            delete data.data;
                        }
                        if (item.imageNames) data.imageNames = item.imageNames;
                        if (item.selectedIndex !== undefined) data.selectedIndex = item.selectedIndex;
                        if (item.groupName !== undefined) data.groupName = item.groupName.trim();
                        store.put(data);
                        memoryIllustrationCache.delete(data.charId);
                    }
                };
            }
            tx.oncomplete = () => resolve();
            tx.onerror = (e) => reject(e);
        } catch (err) { reject(err); }
    });
}

async function dbDeleteIllustration(id) {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        try {
            const tx = db.transaction([STORE_NAME], 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const getReq = store.get(id);
            getReq.onsuccess = () => {
                const data = getReq.result;
                if (data) memoryIllustrationCache.delete(data.charId);
                store.delete(id);
                cachedStorageStats = null;
                resolve();
            };
            getReq.onerror = () => resolve();
        } catch (err) { reject(err); }
    });
}

async function dbDeleteAllByChar(charId) {
    if (!charId) return;
    const db = await initDB();
    const items = await dbGetIllustrations(charId);
    return new Promise((resolve, reject) => {
        try {
            const tx = db.transaction([STORE_NAME], 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            for (const it of items) store.delete(it.id);
            tx.oncomplete = () => {
                memoryIllustrationCache.delete(charId);
                cachedStorageStats = null;
                resolve();
            };
            tx.onerror = (e) => reject(e);
        } catch (err) { reject(err); }
    });
}

async function dbOptimizeCurrentChar(charId) {
    const items = await dbGetIllustrations(charId);
    if (!items.length) return 0;
    const db = await initDB();

    return new Promise((resolve, reject) => {
        try {
            const tx = db.transaction([STORE_NAME], 'readwrite');
            const store = tx.objectStore(STORE_NAME);

            items.forEach((item, index) => {
                const optimized = optimizeIllustrationRecord(item, index + 1);
                if (optimized) {
                    store.put({ id: item.id, charId: item.charId, ...optimized, order: index + 1 });
                }
            });

            tx.oncomplete = () => {
                memoryIllustrationCache.delete(charId);
                resolve(items.length);
            };
            tx.onerror = (e) => reject(e);
        } catch (err) { reject(err); }
    });
}

// ==================== 5. 状态与配置持久化 ====================
let tempBlobList = [];
let allowUserTrigger = localStorage.getItem('ci_allow_user_msg') === '1';
let showAllMatched = localStorage.getItem('ci_show_all_matched') !== '0';
let singleImageMode = localStorage.getItem('ci_single_image_mode') !== '0';
let displayPosition = localStorage.getItem('ci_display_position') || 'top';
let topFixedSize = localStorage.getItem('ci_top_fixed_size') || 'large';
let currentArbitrateController = null;

function getCustomGroups(charId) {
    if (!charId) return [];
    try {
        const raw = localStorage.getItem(`ci_groups_${charId}`);
        return raw ? JSON.parse(raw) : [];
    } catch (_) { return []; }
}

function saveCustomGroups(charId, groups) {
    if (!charId) return;
    const clean = Array.from(new Set(groups.map(g => String(g).trim()).filter(Boolean)));
    localStorage.setItem(`ci_groups_${charId}`, JSON.stringify(clean));
}

function getFolderCollapsedState(charId, groupKey) {
    return localStorage.getItem(`ci_folder_collapsed_${charId}_${groupKey}`) === '1';
}

function setFolderCollapsedState(charId, groupKey, isCollapsed) {
    localStorage.setItem(`ci_folder_collapsed_${charId}_${groupKey}`, isCollapsed ? '1' : '0');
}

let apiSettings = {
    enabled: localStorage.getItem('ci_api_enabled') === '1',
    url: localStorage.getItem('ci_api_url') || '',
    key: localStorage.getItem('ci_api_key') || '',
    model: localStorage.getItem('ci_api_model') || ''
};

function saveApiSettings() {
    localStorage.setItem('ci_api_enabled', apiSettings.enabled ? '1' : '0');
    localStorage.setItem('ci_api_url', apiSettings.url);
    localStorage.setItem('ci_api_key', apiSettings.key);
    localStorage.setItem('ci_api_model', apiSettings.model);
}

function cleanApiUrl(url) {
    return (url || '').trim().replace(/\/+$/, '');
}

async function fetchModelsList() {
    if (!apiSettings.url) throw new Error('请先输入 API URL');
    let baseUrl = cleanApiUrl(apiSettings.url);
    let targetUrl = baseUrl.endsWith('/models') ? baseUrl : `${baseUrl}/models`;

    const headers = { 'Content-Type': 'application/json' };
    if (apiSettings.key) headers['Authorization'] = `Bearer ${apiSettings.key}`;

    const resp = await fetch(targetUrl, { credentials: 'omit', headers });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    const list = data.data || data;
    if (Array.isArray(list)) return list.map(m => m.id || m.name).filter(Boolean);
    return [];
}

async function testChatApi() {
    if (!apiSettings.url) throw new Error('请先填写 API URL');
    if (!apiSettings.model) throw new Error('请先选择或输入模型名');

    let baseUrl = cleanApiUrl(apiSettings.url);
    let chatEndpoint = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;

    const resp = await fetch(chatEndpoint, {
        method: 'POST',
        credentials: 'omit',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiSettings.key}`
        },
        body: JSON.stringify({
            model: apiSettings.model,
            messages: [{ role: 'user', content: 'Say "OK"' }],
            max_tokens: 10,
            temperature: 0.1
        })
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    const res = await resp.json();
    return res.choices?.[0]?.message?.content?.trim() || 'OK';
}

async function arbitrateScenario(fullRawText, candidateItems) {
    if (!apiSettings.enabled || !apiSettings.url || !apiSettings.model) return null;

    if (currentArbitrateController) currentArbitrateController.abort();
    const controller = new AbortController();
    currentArbitrateController = controller;

    const optionsList = candidateItems.map(item => `- 插图ID [${item.id}]: 【${formatRuleDisplay(item)}】`).join('\n');
    const systemPrompt = `你是一个高度精准的二次元剧情插图判定中枢。你接收的内容包含角色的【思维链推演/设定审查】以及【实际对话与叙述正文】。
必须且仅输出纯 JSON 数组，包含所有符合当前场面的插图数字 ID（例如 [1, 3]；若完全不符合则返回 []）。严禁包含任何分析说明或 Markdown 代码块！`;
    const userPrompt = `【候选插图库】：\n${optionsList}\n\n【文本】：\n"""${fullRawText}"""\n\n请输出当前场景下真正应当展示的插图ID数组：`;

    let baseUrl = cleanApiUrl(apiSettings.url);
    let chatEndpoint = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;

    try {
        const resp = await fetch(chatEndpoint, {
            method: 'POST',
            credentials: 'omit',
            signal: controller.signal,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiSettings.key}`
            },
            body: JSON.stringify({
                model: apiSettings.model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                temperature: 0.05
            })
        });

        if (!resp.ok) return null;
        const result = await resp.json();
        const rawContent = result.choices?.[0]?.message?.content?.trim() || '';
        const cleanContent = rawContent.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        const jsonMatch = cleanContent.match(/\[[\d\s,]*?\]/);
        if (jsonMatch) {
            const sanitized = jsonMatch[0].replace(/,\s*\]/, ']');
            return JSON.parse(sanitized);
        }
    } catch (_) {
        return null;
    } finally {
        if (currentArbitrateController === controller) currentArbitrateController = null;
    }
    return null;
}

// 稳定获取当前唯一角色 ID，优先以头像文件名为准，绝对不飘移
function getCurrentCharId(messageEl = null) {
    const context = getContext();
    if (!context) return null;

    if (messageEl) {
        const chid = messageEl.getAttribute('chid');
        if (chid !== null && context.characters && context.characters[chid]) {
            const char = context.characters[chid];
            return char.avatar || char.name || String(chid);
        }
    }

    if (context.characterId !== undefined && context.characters && context.characters[context.characterId]) {
        const char = context.characters[context.characterId];
        return char.avatar || char.name || String(context.characterId);
    }
    return null;
}

function getCurrentCharDisplayName() {
    const context = getContext();
    if (context?.characterId !== undefined && context?.characters && context?.characters[context.characterId]) {
        return context.characters[context.characterId].name || '当前角色';
    }
    return '当前角色';
}

function clearOldIllustrations() {
    const containers = document.querySelectorAll('.char-illustration-container, #ci-top-fixed-container');
    containers.forEach(el => el.remove());
}

function getRawMessageContent(messageEl) {
    try {
        const context = getContext();
        const mesIdAttr = messageEl.getAttribute('mesid');
        if (mesIdAttr !== null && context?.chat) {
            const id = parseInt(mesIdAttr, 10);
            if (!isNaN(id) && context.chat[id] && typeof context.chat[id].mes === 'string') {
                return context.chat[id].mes;
            }
        }
    } catch (_) {}

    const textEl = messageEl.querySelector('.mes_text');
    return textEl ? (textEl.innerText || textEl.textContent || '') : (messageEl.innerText || '');
}

function showGlobalDialog(title, htmlContent, onConfirm) {
    const existing = document.getElementById('ci-custom-dialog');
    if (existing) existing.remove();

    const dialog = document.createElement('div');
    dialog.id = 'ci-custom-dialog';
    dialog.className = 'ci-confirm-modal active';
    dialog.innerHTML = `
        <div class="ci-confirm-content">
            <h3>${escapeHtml(title)}</h3>
            <div>${htmlContent}</div>
            <div class="ci-confirm-actions">
                <button id="ci-dialog-cancel" class="menu_button">取消</button>
                <button id="ci-dialog-confirm" class="menu_button ci-btn-danger">确认执行</button>
            </div>
        </div>
    `;

    document.body.appendChild(dialog);
    dialog.querySelector('#ci-dialog-cancel').onclick = (e) => { e.stopPropagation(); dialog.remove(); forceKeepDrawerExpanded(); };
    dialog.querySelector('#ci-dialog-confirm').onclick = async (e) => {
        e.stopPropagation();
        dialog.remove();
        forceKeepDrawerExpanded();
        if (onConfirm) await onConfirm();
    };
}

// ==================== 6. 导入/导出与进度管理 ====================
function createProgressModal(title) {
    const existing = document.getElementById('ci-progress-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'ci-progress-modal';
    modal.className = 'ci-progress-modal';
    modal.innerHTML = `
        <div class="ci-progress-dialog">
            <div class="ci-progress-title">${escapeHtml(title)}</div>
            <div class="ci-progress-bar-bg">
                <div class="ci-progress-bar-fill" id="ci-progress-fill"></div>
            </div>
            <div class="ci-progress-info">
                <span id="ci-progress-status">准备就绪...</span>
                <span id="ci-progress-percent">0%</span>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    requestAnimationFrame(() => modal.classList.add('active'));

    const fillEl = modal.querySelector('#ci-progress-fill');
    const statusEl = modal.querySelector('#ci-progress-status');
    const percentEl = modal.querySelector('#ci-progress-percent');

    return {
        update(current, total, statusText = '') {
            const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
            fillEl.style.width = `${pct}%`;
            percentEl.textContent = `${pct}%`;
            statusEl.textContent = statusText || `正在处理 (${current}/${total})...`;
        },
        close(delay = 400) {
            setTimeout(() => {
                modal.classList.remove('active');
                setTimeout(() => { modal.remove(); forceKeepDrawerExpanded(); }, 200);
            }, delay);
        }
    };
}

async function streamParseAndImportLargeJson(file, charId, onProgress) {
    const stream = file.stream();
    const reader = stream.getReader();
    const decoder = new TextDecoder('utf-8');
    const totalBytes = file.size;
    let loadedBytes = 0;

    let buffer = '';
    let insideIllustrations = false;
    let depth = 0;
    let inString = false;
    let isEscaped = false;
    let currentObjectStart = -1;
    let importedCount = 0;
    let scanIdx = 0;
    let hasWipedOldData = false;

    let batch = [];
    const BATCH_SIZE = 15;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        loadedBytes += value.length;
        buffer += decoder.decode(value, { stream: true });

        if (!insideIllustrations) {
            const arrIndex = buffer.indexOf('"illustrations"');
            if (arrIndex !== -1) {
                const openBracket = buffer.indexOf('[', arrIndex);
                if (openBracket !== -1) {
                    insideIllustrations = true;
                    buffer = buffer.slice(openBracket + 1);
                    scanIdx = 0;
                }
            }
        }

        if (insideIllustrations) {
            while (scanIdx < buffer.length) {
                const char = buffer[scanIdx];
                if (inString) {
                    if (isEscaped) isEscaped = false;
                    else if (char === '\\') isEscaped = true;
                    else if (char === '"') inString = false;
                    scanIdx++;
                    continue;
                }

                if (char === '"') { inString = true; scanIdx++; continue; }
                if (char === '{') {
                    if (depth === 0) currentObjectStart = scanIdx;
                    depth++;
                } else if (char === '}') {
                    depth--;
                    if (depth === 0 && currentObjectStart !== -1) {
                        const objText = buffer.slice(currentObjectStart, scanIdx + 1);
                        try {
                            const parsedItem = JSON.parse(objText);
                            const opt = optimizeIllustrationRecord(parsedItem, importedCount + batch.length + 1);
                            if (opt) batch.push(opt);

                            if (batch.length >= BATCH_SIZE) {
                                if (!hasWipedOldData) {
                                    await dbDeleteAllByChar(charId);
                                    hasWipedOldData = true;
                                }
                                const count = await dbBatchInsertItems(charId, batch);
                                importedCount += count;
                                batch = [];
                                if (onProgress) onProgress(loadedBytes, totalBytes, `已写入 ${importedCount} 条`);
                            }
                        } catch (_) {}

                        buffer = buffer.slice(scanIdx + 1);
                        scanIdx = 0;
                        currentObjectStart = -1;
                        await new Promise(r => setTimeout(r, 0));
                        continue;
                    }
                } else if (char === ']' && depth === 0) {
                    insideIllustrations = false;
                    break;
                }
                scanIdx++;
            }
        }
    }

    if (batch.length > 0) {
        if (!hasWipedOldData) await dbDeleteAllByChar(charId);
        const count = await dbBatchInsertItems(charId, batch);
        importedCount += count;
    }

    memoryIllustrationCache.delete(charId);
    cachedStorageStats = null;
    return importedCount;
}

// ==================== 7. 更换插图选择模态窗 ====================
function openImagePickerModal(item, onSelect) {
    const existingModal = document.getElementById('ci-picker-modal');
    if (existingModal) existingModal.remove();

    const pickerModal = document.createElement('div');
    pickerModal.id = 'ci-picker-modal';
    pickerModal.className = 'ci-picker-modal';

    const imgs = item.images || [];
    const names = item.imageNames || [];
    const currentSelected = typeof item.selectedIndex === 'number' ? item.selectedIndex : 0;

    const itemsHtml = imgs.map((rawSource, idx) => {
        const rawName = names[idx] ? names[idx].trim() : '';
        const displayName = rawName || `插图 ${idx + 1}`;
        const isActive = idx === currentSelected;
        const url = toDisplayUrl(rawSource);
        return `
            <div class="ci-picker-card ${isActive ? 'active' : ''}" data-idx="${idx}">
                <div class="ci-picker-img-box">
                    <img src="${url}" loading="lazy" decoding="async" alt="${escapeHtml(displayName)}" />
                    ${isActive ? '<div class="ci-picker-badge">当前已选</div>' : ''}
                </div>
                <div class="ci-picker-name" title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</div>
            </div>
        `;
    }).join('');

    pickerModal.innerHTML = `
        <div class="ci-picker-backdrop"></div>
        <div class="ci-picker-dialog">
            <div class="ci-picker-header">
                <div class="ci-picker-title">✨ 选择并锁定要展示的插图</div>
                <div class="ci-picker-close">×</div>
            </div>
            <div class="ci-picker-hint">点击下方插图即可更换：</div>
            <div class="ci-picker-grid">${itemsHtml}</div>
        </div>
    `;

    document.body.appendChild(pickerModal);

    const closePicker = (e) => {
        if (e) e.stopPropagation();
        pickerModal.classList.remove('active');
        setTimeout(() => { pickerModal.remove(); forceKeepDrawerExpanded(); }, 180);
    };

    pickerModal.querySelector('.ci-picker-backdrop').onclick = closePicker;
    pickerModal.querySelector('.ci-picker-close').onclick = closePicker;

    pickerModal.querySelectorAll('.ci-picker-card').forEach(card => {
        card.onclick = (e) => {
            e.stopPropagation();
            const chosenIdx = parseInt(card.dataset.idx, 10);
            closePicker();
            if (onSelect) onSelect(chosenIdx);
        };
    });

    requestAnimationFrame(() => pickerModal.classList.add('active'));
}

// ==================== 8. 单规则多图管理弹窗 ====================
function openManageImagesModal(item, onUpdated) {
    const existing = document.getElementById('ci-manage-modal');
    if (existing) existing.remove();

    const manageModal = document.createElement('div');
    manageModal.id = 'ci-manage-modal';
    manageModal.className = 'ci-manage-modal';

    let localImgs = [...(item.images || [])];
    let localNames = [...(item.imageNames || [])];
    while (localNames.length < localImgs.length) localNames.push('');
    let localSelectedIndex = typeof item.selectedIndex === 'number' ? item.selectedIndex : 0;
    if (localSelectedIndex >= localImgs.length) localSelectedIndex = 0;

    function renderGridContent() {
        return localImgs.map((rawSource, idx) => {
            const isSelected = idx === localSelectedIndex;
            const nameVal = localNames[idx] || '';
            const url = toDisplayUrl(rawSource);
            return `
                <div class="ci-manage-item ${isSelected ? 'is-selected' : ''}" data-idx="${idx}">
                    <div class="ci-manage-img-wrap">
                        <div class="ci-manage-order-bar">
                            <button type="button" class="ci-order-mini-btn ci-suborder-left" data-idx="${idx}" ${idx === 0 ? 'disabled' : ''}>◀</button>
                            <span class="ci-img-index-badge">#${idx + 1}</span>
                            <button type="button" class="ci-order-mini-btn ci-suborder-right" data-idx="${idx}" ${idx === localImgs.length - 1 ? 'disabled' : ''}>▶</button>
                        </div>
                        <img src="${url}" loading="lazy" decoding="async" />
                    </div>
                    <input class="ci-manage-name-input" data-idx="${idx}" type="text" placeholder="输入插图命名..." value="${escapeHtml(nameVal)}" />
                    <div class="ci-manage-actions">
                        <button type="button" class="ci-set-default-btn" data-idx="${idx}">${isSelected ? '★ 默认展示' : '设为默认'}</button>
                        <span class="ci-manage-del-btn" data-idx="${idx}">🗑️</span>
                    </div>
                </div>
            `;
        }).join('');
    }

    manageModal.innerHTML = `
        <div class="ci-manage-backdrop"></div>
        <div class="ci-manage-dialog">
            <div class="ci-manage-header">
                <div>🖼️ 插图与命名管理 [规则ID: ${item.id}]</div>
                <div class="ci-manage-close">×</div>
            </div>
            <div class="ci-manage-grid" id="ci-manage-grid-container">${renderGridContent()}</div>
            <div class="ci-manage-footer">
                <button type="button" id="ci-modal-append-btn" class="menu_button ci-mini-btn" style="background:#457b9d; color:#fff;">＋ 追加新插图</button>
                <div style="display:flex; gap:8px;">
                    <button type="button" id="ci-modal-cancel-btn" class="menu_button ci-mini-btn">取消</button>
                    <button type="button" id="ci-modal-save-btn" class="menu_button ci-mini-btn ci-btn-accent">保存修改</button>
                </div>
            </div>
            <input id="ci-modal-file-input" type="file" accept="image/*" multiple style="display:none;" />
        </div>
    `;

    document.body.appendChild(manageModal);

    function bindGridEvents() {
        const container = manageModal.querySelector('#ci-manage-grid-container');
        container.innerHTML = renderGridContent();

        container.querySelectorAll('.ci-manage-name-input').forEach(inp => {
            inp.oninput = (e) => {
                const idx = parseInt(e.target.dataset.idx, 10);
                localNames[idx] = e.target.value;
            };
        });

        container.querySelectorAll('.ci-set-default-btn').forEach(btn => {
            btn.onclick = () => {
                localSelectedIndex = parseInt(btn.dataset.idx, 10);
                bindGridEvents();
            };
        });

        container.querySelectorAll('.ci-suborder-left').forEach(btn => {
            btn.onclick = () => {
                const idx = parseInt(btn.dataset.idx, 10);
                if (idx > 0) {
                    [localImgs[idx], localImgs[idx - 1]] = [localImgs[idx - 1], localImgs[idx]];
                    [localNames[idx], localNames[idx - 1]] = [localNames[idx - 1], localNames[idx]];
                    bindGridEvents();
                }
            };
        });

        container.querySelectorAll('.ci-suborder-right').forEach(btn => {
            btn.onclick = () => {
                const idx = parseInt(btn.dataset.idx, 10);
                if (idx < localImgs.length - 1) {
                    [localImgs[idx], localImgs[idx + 1]] = [localImgs[idx + 1], localImgs[idx]];
                    [localNames[idx], localNames[idx + 1]] = [localNames[idx + 1], localNames[idx]];
                    bindGridEvents();
                }
            };
        });

        container.querySelectorAll('.ci-manage-del-btn').forEach(btn => {
            btn.onclick = () => {
                const idx = parseInt(btn.dataset.idx, 10);
                if (localImgs.length <= 1) return alert('规则至少需要保留1张插图');
                localImgs.splice(idx, 1);
                localNames.splice(idx, 1);
                if (localSelectedIndex >= localImgs.length) localSelectedIndex = 0;
                bindGridEvents();
            };
        });
    }

    bindGridEvents();

    const closeModal = () => {
        manageModal.classList.remove('active');
        setTimeout(() => { manageModal.remove(); forceKeepDrawerExpanded(); }, 180);
    };

    manageModal.querySelector('.ci-manage-backdrop').onclick = closeModal;
    manageModal.querySelector('.ci-manage-close').onclick = closeModal;
    manageModal.querySelector('#ci-modal-cancel-btn').onclick = closeModal;

    const modalFileInput = manageModal.querySelector('#ci-modal-file-input');
    manageModal.querySelector('#ci-modal-append-btn').onclick = () => modalFileInput.click();
    modalFileInput.onchange = (e) => {
        const files = Array.from(e.target.files);
        for (const file of files) {
            localImgs.push(file);
            localNames.push('');
        }
        bindGridEvents();
    };

    manageModal.querySelector('#ci-modal-save-btn').onclick = async () => {
        await dbUpdateIllustration(item.id, null, null, localImgs, localNames, localSelectedIndex);
        closeModal();
        if (onUpdated) await onUpdated();
    };

    requestAnimationFrame(() => manageModal.classList.add('active'));
}

// ==================== 9. 分组维护管理 ====================
function openGroupsManageDialog(charId, onUpdated) {
    const existing = document.getElementById('ci-group-manage-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'ci-group-manage-modal';
    modal.className = 'ci-confirm-modal active';
    modal.innerHTML = `
        <div class="ci-confirm-content" style="border-color:#48cae4 !important; max-width:480px;">
            <h3 style="color:#48cae4 !important; display:flex; justify-content:space-between; align-items:center;">
                <span>🏷️ 分组管理</span>
                <span id="ci-group-close-x" style="cursor:pointer; font-size:1.2em; color:#bbb;">&times;</span>
            </h3>
            <div style="display:flex; gap:6px;">
                <input id="ci-new-group-name-input" class="text_pole" type="text" placeholder="输入新分组名称..." style="flex:1;" />
                <button type="button" id="ci-add-group-btn" class="menu_button ci-mini-btn ci-btn-accent">＋ 新建</button>
            </div>
            <div class="ci-group-manage-list" id="ci-group-manage-items"></div>
            <div class="ci-confirm-actions">
                <button type="button" id="ci-group-done-btn" class="menu_button ci-mini-btn" style="background:#2a9d8f; color:#fff;">完成</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
    const listContainer = modal.querySelector('#ci-group-manage-items');

    function renderGroupList() {
        const curGroups = getCustomGroups(charId);
        listContainer.innerHTML = curGroups.map((g, idx) => `
            <div class="ci-group-manage-row">
                <input class="ci-group-manage-input text_pole" data-idx="${idx}" type="text" value="${escapeHtml(g)}" />
                <button type="button" class="menu_button ci-mini-btn ci-btn-danger ci-del-group-btn" data-name="${escapeHtml(g)}">删除</button>
            </div>
        `).join('') || `<div style="text-align:center; padding:10px; color:#888;">暂无自定义分组</div>`;

        listContainer.querySelectorAll('.ci-del-group-btn').forEach(btn => {
            btn.onclick = () => {
                const gName = btn.dataset.name;
                saveCustomGroups(charId, getCustomGroups(charId).filter(g => g !== gName));
                renderGroupList();
                if (onUpdated) onUpdated();
            };
        });
    }

    renderGroupList();

    modal.querySelector('#ci-add-group-btn').onclick = () => {
        const inp = modal.querySelector('#ci-new-group-name-input');
        const val = inp.value.trim();
        if (!val) return;
        const cur = getCustomGroups(charId);
        if (!cur.includes(val)) {
            cur.push(val);
            saveCustomGroups(charId, cur);
            inp.value = '';
            renderGroupList();
            if (onUpdated) onUpdated();
        }
    };

    const closeModal = () => { modal.remove(); forceKeepDrawerExpanded(); };
    modal.querySelector('#ci-group-close-x').onclick = closeModal;
    modal.querySelector('#ci-group-done-btn').onclick = closeModal;
}

// ==================== 10. 设置主面板渲染 ====================
function renderSingleCardHtml(item, index, totalInGroup) {
    const imgs = item.images || [];
    const selectedIdx = typeof item.selectedIndex === 'number' && item.selectedIndex < imgs.length ? item.selectedIndex : 0;
    const names = item.imageNames || [];
    const currentName = names[selectedIdx] || '';
    const groupBadge = item.groupName ? `<span class="ci-group-badge-tag">${escapeHtml(item.groupName)}</span>` : '';
    const mainThumbUrl = toDisplayUrl(imgs[selectedIdx] || imgs[0]);

    return `
    <div class="ci-card" data-id="${item.id}">
        <div class="ci-thumb-box">
            <div class="ci-thumb-preview-wrap" data-id="${item.id}">
                <img class="ci-thumb-main" src="${mainThumbUrl}" alt="缩略图" loading="lazy" decoding="async" />
                <div class="ci-thumb-count-tag">${imgs.length} 图</div>
            </div>
            <div class="ci-order-controls">
                <button type="button" class="ci-order-btn ci-order-up" data-id="${item.id}" ${index === 0 ? 'disabled style="opacity:0.3;"' : ''}>▲</button>
                <button type="button" class="ci-order-btn ci-order-down" data-id="${item.id}" ${index === totalInGroup - 1 ? 'disabled style="opacity:0.3;"' : ''}>▼</button>
            </div>
        </div>
        <div class="ci-card-info">
            <div class="ci-card-header-row">
                <div style="display:flex; align-items:center; gap:6px; overflow:hidden;">
                    <span style="font-size:0.8em; opacity:0.85;">[ID: ${item.id}]</span>
                    ${groupBadge}
                    <span style="font-size:0.8em; opacity:0.85; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                        锁定: <b style="color:#ffd166;">${escapeHtml(currentName || `插图 ${selectedIdx + 1}`)}</b>
                    </span>
                </div>
                <button type="button" class="ci-manage-btn" data-id="${item.id}">🖼️ 管理 (${imgs.length})</button>
            </div>
            <input class="text_pole ci-edit-input" data-id="${item.id}" type="text" value="${escapeHtml(formatRuleDisplay(item))}" />
            <div class="ci-card-actions">
                <button type="button" class="ci-save-edit-btn" data-id="${item.id}">保存规则</button>
                <button type="button" class="ci-del-btn" data-id="${item.id}">删除</button>
            </div>
        </div>
    </div>
    `;
}

async function renderSettings(forceRefreshStats = false) {
    const container = document.getElementById('ci-settings-content');
    if (!container) return;

    const charId = getCurrentCharId();
    const charName = getCurrentCharDisplayName();

    if (!charId) {
        container.innerHTML = `<div style="opacity:0.7; font-size:0.9em; padding:10px;">请先打开一个角色对话。</div>`;
        forceKeepDrawerExpanded();
        return;
    }

    const items = await dbGetIllustrations(charId);

    if (forceRefreshStats || !cachedStorageStats || lastStatsCharId !== charId) {
        cachedStorageStats = await dbGetStorageStats(charId);
        lastStatsCharId = charId;
    }
    const stats = cachedStorageStats || { charSize: '统计中...', totalSize: '统计中...' };
    const customGroups = getCustomGroups(charId);

    const filteredItems = items.filter(item => {
        if (activeGroupFilter === '__UNGROUPED__') { if (item.groupName) return false; }
        else if (activeGroupFilter) { if (item.groupName !== activeGroupFilter) return false; }

        if (!searchFilterKeyword.trim()) return true;
        const kw = searchFilterKeyword.trim().toLowerCase();
        return formatRuleDisplay(item).toLowerCase().includes(kw) || (item.groupName || '').toLowerCase().includes(kw);
    });

    const allExistingGroups = Array.from(new Set([...customGroups, ...items.map(i => i.groupName).filter(Boolean)]));
    let groupsToDisplay = activeGroupFilter ? [activeGroupFilter] : [...allExistingGroups];
    if (!activeGroupFilter && (items.some(i => !i.groupName) || groupsToDisplay.length === 0)) {
        groupsToDisplay.push('__UNGROUPED__');
    }

    const folderBlocksHtml = groupsToDisplay.map(groupKey => {
        const isUngrouped = groupKey === '__UNGROUPED__';
        const groupDisplayName = isUngrouped ? '未分组' : groupKey;
        const groupItems = filteredItems.filter(i => isUngrouped ? !i.groupName : i.groupName === groupKey);
        if (groupItems.length === 0 && (activeGroupFilter || searchFilterKeyword.trim())) return '';

        const isCollapsed = getFolderCollapsedState(charId, groupKey);
        const cardsHtml = groupItems.map((item, idx) => renderSingleCardHtml(item, idx, groupItems.length)).join('');

        return `
            <div class="ci-folder-block ${isCollapsed ? 'collapsed' : ''}" data-group="${escapeHtml(groupKey)}">
                <div class="ci-folder-header" data-group="${escapeHtml(groupKey)}">
                    <div class="ci-folder-title-left">
                        <span class="ci-folder-arrow">▼</span>
                        <span class="ci-folder-name">📁 ${escapeHtml(groupDisplayName)}</span>
                        <span class="ci-folder-count-badge">${groupItems.length} 条</span>
                    </div>
                    <div class="ci-folder-status-tag">${isCollapsed ? '展开' : '折叠'}</div>
                </div>
                <div class="ci-folder-body">${cardsHtml || '<div style="font-size:0.8em; opacity:0.5; padding:6px;">暂无条目</div>'}</div>
            </div>
        `;
    }).filter(Boolean).join('');

    container.innerHTML = `
        <div class="ci-panel">
            <div class="ci-api-config-box">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <b>🤖 智能情景过滤 API</b>
                    <label style="display:flex; align-items:center; gap:4px; font-size:0.85em; cursor:pointer;">
                        <input type="checkbox" id="ci-api-enabled" ${apiSettings.enabled ? 'checked' : ''} />
                        <span>启用 AI 过滤</span>
                    </label>
                </div>
            </div>

            <div class="ci-upload-box">
                <b>为角色 [${escapeHtml(charName)}] 添加新规则</b>
                <input id="ci-kw-input" class="text_pole" type="text" placeholder="如: 微笑 + 校园, 礼服" />
                <div style="display: flex; gap: 8px; flex-wrap: wrap; align-items: center;">
                    <button type="button" id="ci-choose-file-btn" class="menu_button">选择插图</button>
                    <select id="ci-new-item-group-select" class="text_pole" style="max-width:140px;">
                        <option value="">未分组</option>
                        ${customGroups.map(g => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join('')}
                    </select>
                    <button type="button" id="ci-save-btn" class="menu_button" style="background:#2a9d8f;">保存规则与图片</button>
                    <input id="ci-file-input" type="file" accept="image/*" multiple style="display: none;" />
                    <span id="ci-upload-count-hint" style="font-size:0.85em; color:#ffd166;"></span>
                </div>

                <div style="display:flex; flex-direction:column; gap:6px; font-size:0.85em; margin-top:6px;">
                    <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
                        <input type="checkbox" id="ci-single-image-mode-chk" ${singleImageMode ? 'checked' : ''} />
                        <span style="color:#ffd166; font-weight:bold;">单图自选锁定模式</span>
                    </label>
                    <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
                        <input type="checkbox" id="ci-show-all-chk" ${showAllMatched ? 'checked' : ''} />
                        <span>多个规则同时命中时轮播切换</span>
                    </label>
                </div>
            </div>

            <div class="ci-list-header">
                <div class="ci-list-header-info">
                    <b>规则库 (${items.length})</b>
                    <span style="font-size:0.8em; opacity:0.85;">容量: <b style="color:#ffd166;">${stats.charSize}</b></span>
                </div>
                <div class="ci-header-actions">
                    <button type="button" id="ci-groups-btn" class="menu_button ci-mini-btn">🏷️ 分组</button>
                    <button type="button" id="ci-export-btn" class="menu_button ci-mini-btn">导出</button>
                    <button type="button" id="ci-import-btn" class="menu_button ci-mini-btn">导入</button>
                    <button type="button" id="ci-delete-all-btn" class="menu_button ci-mini-btn ci-btn-danger">清空本角色</button>
                    <input id="ci-import-input" type="file" accept=".json" style="display:none;" />
                </div>
            </div>

            <div class="ci-items-list">${folderBlocksHtml || '<div style="text-align:center; padding:10px; opacity:0.6;">未找到插图规则</div>'}</div>
        </div>
    `;

    forceKeepDrawerExpanded();

    container.querySelectorAll('.ci-folder-header').forEach(header => {
        header.onclick = () => {
            const groupKey = header.dataset.group;
            const block = header.closest('.ci-folder-block');
            const isNowCollapsed = !block.classList.contains('collapsed');
            block.classList.toggle('collapsed');
            header.querySelector('.ci-folder-status-tag').innerText = isNowCollapsed ? '展开' : '折叠';
            setFolderCollapsedState(charId, groupKey, isNowCollapsed);
        };
    });

    container.querySelectorAll('.ci-manage-btn').forEach(btn => {
        btn.onclick = () => {
            const id = parseInt(btn.dataset.id, 10);
            const targetItem = items.find(i => i.id === id);
            if (targetItem) openManageImagesModal(targetItem, () => renderSettings());
        };
    });

    container.querySelectorAll('.ci-del-btn').forEach(btn => {
        btn.onclick = async () => {
            const id = parseInt(btn.dataset.id, 10);
            if (confirm('确定删除该规则？')) {
                await dbDeleteIllustration(id);
                renderSettings();
                debouncedScan();
            }
        };
    });

    const fileInput = document.getElementById('ci-file-input');
    document.getElementById('ci-choose-file-btn').onclick = () => fileInput.click();
    fileInput.onchange = (e) => {
        tempBlobList = Array.from(e.target.files);
        document.getElementById('ci-upload-count-hint').innerText = `已选 ${tempBlobList.length} 张`;
    };

    document.getElementById('ci-save-btn').onclick = async () => {
        const kw = document.getElementById('ci-kw-input').value.trim();
        if (!kw || !tempBlobList.length) return alert('请输入规则词并选择图片');
        const gSelect = document.getElementById('ci-new-item-group-select');
        await dbAddIllustration(charId, parseRuleInput(kw), tempBlobList, [], 0, gSelect ? gSelect.value : '');
        tempBlobList = [];
        fileInput.value = '';
        renderSettings();
        debouncedScan();
    };

    document.getElementById('ci-groups-btn').onclick = () => openGroupsManageDialog(charId, () => renderSettings());

    const importInput = document.getElementById('ci-import-input');
    document.getElementById('ci-import-btn').onclick = () => importInput.click();
    importInput.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const progress = createProgressModal('正在导入插图配置');
        await streamParseAndImportLargeJson(file, charId, (loaded, total, status) => progress.update(loaded, total, status));
        progress.close(300);
        renderSettings();
        debouncedScan();
    };

    document.getElementById('ci-export-btn').onclick = async () => {
        if (!items.length) return alert('暂无配置可导出');
        const blob = new Blob([JSON.stringify({ illustrations: items })], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${charName}_插图.json`;
        a.click();
        URL.revokeObjectURL(url);
    };

    document.getElementById('ci-delete-all-btn').onclick = () => {
        showGlobalDialog('危险确认', '确定清空当前角色的全部插图？', async () => {
            await dbDeleteAllByChar(charId);
            clearOldIllustrations();
            renderSettings(true);
            debouncedScan();
        });
    };
}

// ==================== 11. 极速轮播组件 (纯静态事件，零死循环) ====================
function setupIllustrationCarousel(containerEl, charId) {
    const track = containerEl.querySelector('.ci-carousel-track');
    const prevBtn = containerEl.querySelector('.ci-arrow-prev');
    const nextBtn = containerEl.querySelector('.ci-arrow-next');
    const badgeEl = containerEl.querySelector('.ci-carousel-badge');
    const dotsContainer = containerEl.querySelector('.ci-carousel-dots');

    if (!track) return;
    const slides = Array.from(track.querySelectorAll('.ci-carousel-slide'));
    const total = slides.length;
    if (total <= 1) {
        if (prevBtn) prevBtn.style.display = 'none';
        if (nextBtn) nextBtn.style.display = 'none';
        if (dotsContainer) dotsContainer.style.display = 'none';
        if (slides[0]) slides[0].classList.add('active');
        return;
    }

    let activeIndex = 0;
    const rememberedId = activeSlideMemoryByChar.get(charId);
    if (rememberedId) {
        const found = slides.findIndex(s => s.dataset.slideId === rememberedId);
        if (found !== -1) activeIndex = found;
    }

    function showSlide(idx) {
        if (idx < 0) idx = 0;
        if (idx >= total) idx = total - 1;
        activeIndex = idx;

        slides.forEach((s, i) => s.classList.toggle('active', i === activeIndex));
        if (prevBtn) prevBtn.disabled = activeIndex <= 0;
        if (nextBtn) nextBtn.disabled = activeIndex >= total - 1;
        if (badgeEl) badgeEl.innerText = `${activeIndex + 1} / ${total}`;

        if (dotsContainer) {
            dotsContainer.querySelectorAll('.ci-carousel-dot').forEach((d, i) => d.classList.toggle('active', i === activeIndex));
        }

        if (slides[activeIndex]?.dataset?.slideId && charId) {
            activeSlideMemoryByChar.set(charId, slides[activeIndex].dataset.slideId);
        }
    }

    if (dotsContainer) {
        dotsContainer.innerHTML = slides.map((_, idx) => `<span class="ci-carousel-dot" data-idx="${idx}"></span>`).join('');
        dotsContainer.onclick = (e) => {
            const dot = e.target.closest('.ci-carousel-dot');
            if (dot) showSlide(parseInt(dot.dataset.idx, 10));
        };
    }

    if (prevBtn) prevBtn.onclick = (e) => { e.stopPropagation(); showSlide(activeIndex - 1); };
    if (nextBtn) nextBtn.onclick = (e) => { e.stopPropagation(); showSlide(activeIndex + 1); };

    showSlide(activeIndex);
}

// ==================== 12. 消息检测与插图挂载 (防抖节流保护) ====================
async function checkAndRenderMessage(messageEl) {
    if (!messageEl) return;
    const charId = getCurrentCharId(messageEl);
    if (!charId) return;

    const isUser = messageEl.getAttribute('is_user') === 'true';
    if (isUser && !allowUserTrigger) return;

    const textEl = messageEl.querySelector('.mes_text');
    if (!textEl) return;

    const items = await dbGetIllustrations(charId);
    if (!items.length) {
        clearOldIllustrations();
        return;
    }

    const rawMessageContent = getRawMessageContent(messageEl);
    if (!rawMessageContent || !rawMessageContent.trim()) return;

    let listToDisplay = [];
    const lowerContent = rawMessageContent.toLowerCase();

    const matched = items.filter(item => {
        if (item.rules && Array.isArray(item.rules) && item.rules.length > 0) {
            return item.rules.some(group => {
                if (Array.isArray(group)) return group.length > 0 && group.every(kw => lowerContent.includes(kw.toLowerCase()));
                if (typeof group === 'string') return lowerContent.includes(group.toLowerCase());
                return false;
            });
        }
        return false;
    });

    if (matched.length === 0) {
        clearOldIllustrations();
        return;
    }

    listToDisplay = showAllMatched ? matched : [matched[0]];
    const targetRenderKey = `${charId}_` + listToDisplay.map(item => `${item.id}:${item.selectedIndex || 0}`).join(';');

    const existingContainer = document.querySelector('.char-illustration-container');
    if (existingContainer && existingContainer.dataset.renderKey === targetRenderKey) {
        return; // 已经渲染，不再触碰 DOM
    }

    clearOldIllustrations();

    const container = document.createElement('div');
    container.className = 'char-illustration-container';
    container.dataset.renderKey = targetRenderKey;

    const carouselRoot = document.createElement('div');
    carouselRoot.className = 'ci-carousel-root';

    const carouselWrapper = document.createElement('div');
    carouselWrapper.className = 'ci-carousel-wrapper';

    const prevBtn = document.createElement('button');
    prevBtn.className = 'ci-carousel-arrow ci-arrow-prev';
    prevBtn.innerHTML = '❮';

    const nextBtn = document.createElement('button');
    nextBtn.className = 'ci-carousel-arrow ci-arrow-next';
    nextBtn.innerHTML = '❯';

    const viewport = document.createElement('div');
    viewport.className = 'ci-carousel-viewport';

    const track = document.createElement('div');
    track.className = 'ci-carousel-track';

    viewport.appendChild(track);
    carouselWrapper.appendChild(prevBtn);
    carouselWrapper.appendChild(viewport);
    carouselWrapper.appendChild(nextBtn);

    const footer = document.createElement('div');
    footer.className = 'ci-carousel-footer';
    footer.innerHTML = `<span class="ci-carousel-badge">1 / 1</span><div class="ci-carousel-dots"></div>`;

    carouselRoot.appendChild(carouselWrapper);
    carouselRoot.appendChild(footer);
    container.appendChild(carouselRoot);

    for (const item of listToDisplay) {
        const imgs = item.images || [];
        if (!imgs.length) continue;

        let selectedIdx = item.selectedIndex || 0;
        if (selectedIdx < 0 || selectedIdx >= imgs.length) selectedIdx = 0;

        const displayUrl = toDisplayUrl(imgs[selectedIdx]);
        const card = document.createElement('div');
        card.className = 'ci-carousel-slide char-illustration-card';
        card.dataset.slideId = `rule_${item.id}`;

        const img = document.createElement('img');
        img.className = 'char-illustration-img';
        img.src = displayUrl;
        img.onclick = () => window.openCIModal(displayUrl);

        const removeBtn = document.createElement('div');
        removeBtn.className = 'char-illustration-remove-btn';
        removeBtn.innerHTML = '×';
        removeBtn.onclick = (e) => {
            e.stopPropagation();
            container.remove();
        };

        card.appendChild(img);
        card.appendChild(removeBtn);

        if (imgs.length > 1) {
            const switchWrap = document.createElement('div');
            switchWrap.className = 'ci-switch-btn-container';
            const currentName = (item.imageNames?.[selectedIdx] || `插图 ${selectedIdx + 1}`).trim();

            switchWrap.innerHTML = `
                <div class="ci-name-tag-wrapper">
                    ${item.groupName ? `<span class="ci-switch-group-prefix">${escapeHtml(item.groupName)}</span>` : ''}
                    <span class="ci-switch-name-label">${escapeHtml(currentName)}</span>
                </div>
                <button class="ci-switch-btn">⇄ 更换插图</button>
            `;

            switchWrap.querySelector('.ci-switch-btn').onclick = (e) => {
                e.stopPropagation();
                openImagePickerModal(item, (chosenIdx) => {
                    item.selectedIndex = chosenIdx;
                    dbSetIllustrationSelectedIndex(item.id, chosenIdx);
                    img.src = toDisplayUrl(imgs[chosenIdx]);
                });
            };

            card.appendChild(switchWrap);
        }

        track.appendChild(card);
    }

    if (textEl && textEl.parentNode) {
        textEl.parentNode.insertBefore(container, textEl);
    } else {
        messageEl.prepend(container);
    }

    setupIllustrationCarousel(container, charId);
}

function scanLatestMessageOnly() {
    const messages = document.querySelectorAll('#chat .mes');
    if (!messages.length) return;
    checkAndRenderMessage(messages[messages.length - 1]);
}

const debouncedScan = debounce(scanLatestMessageOnly, 350);

// ==================== 13. 生命周期与启动挂载 ====================
jQuery(async () => {
    initImageViewer();

    const drawerHtml = `
        <div id="char-illustrations-drawer" class="extension_settings">
            <div class="ci-custom-drawer">
                <div class="ci-custom-drawer-toggle" id="ci-drawer-toggle">
                    <b>角色插图管理 (Character Illustrations)</b>
                    <div class="ci-drawer-icon fa-solid fa-circle-chevron-up up"></div>
                </div>
                <div class="ci-custom-drawer-content" id="ci-settings-content" style="display: block;"></div>
            </div>
        </div>
    `;
    $('#extensions_settings').append(drawerHtml);

    $('#ci-drawer-toggle').on('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        forceKeepDrawerExpanded();
    });

    await initDB();

    const handleCharChange = () => {
        memoryIllustrationCache.clear();
        clearOldIllustrations();
        renderSettings();
        debouncedScan();
    };

    eventSource.on(event_types.CHARACTER_PAGE_LOADED, handleCharChange);
    eventSource.on(event_types.CHAT_CHANGED, handleCharChange);
    eventSource.on(event_types.MESSAGE_RECEIVED, debouncedScan);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, debouncedScan);

    renderSettings();
    debouncedScan();
});