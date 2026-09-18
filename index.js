import { getContext } from '../../../extensions.js';
import { eventSource, event_types } from '../../../../script.js';

// ==================== 0. Blob / ObjectURL 核心生命周期管理器 ====================
const blobToObjectUrlMap = new WeakMap();
const stringUrlCache = new Map();

/**
 * 将任意图片数据（Blob、File、Base64、HTTP URL）转换为标准 ObjectURL 或直接可访问地址
 */
function toDisplayUrl(source) {
    if (!source) return '';
    if (source instanceof Blob) {
        if (blobToObjectUrlMap.has(source)) {
            return blobToObjectUrlMap.get(source);
        }
        const url = URL.createObjectURL(source);
        blobToObjectUrlMap.set(source, url);
        return url;
    }
    if (typeof source === 'string') {
        if (source.startsWith('blob:') || source.startsWith('http') || source.startsWith('/')) {
            return source;
        }
        if (source.startsWith('data:image')) {
            if (stringUrlCache.has(source)) return stringUrlCache.get(source);
            try {
                const blob = base64ToBlob(source);
                const url = URL.createObjectURL(blob);
                if (stringUrlCache.size > 200) {
                    const first = stringUrlCache.keys().next().value;
                    URL.revokeObjectURL(stringUrlCache.get(first));
                    stringUrlCache.delete(first);
                }
                stringUrlCache.set(source, url);
                return url;
            } catch (e) {
                return source;
            }
        }
    }
    return source;
}

/**
 * Base64 转二进制 Blob 工具函数
 */
function base64ToBlob(base64) {
    const parts = base64.split(';base64,');
    const contentType = parts[0].split(':')[1] || 'image/png';
    const raw = window.atob(parts[1]);
    const rawLength = raw.length;
    const uInt8Array = new Uint8Array(rawLength);
    for (let i = 0; i < rawLength; ++i) {
        uInt8Array[i] = raw.charCodeAt(i);
    }
    return new Blob([uInt8Array], { type: contentType });
}

/**
 * Blob 转 Base64（仅在生成 JSON 导出文件时按需调用）
 */
function blobToBase64(blob) {
    if (typeof blob === 'string') return Promise.resolve(blob);
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

// 统一的视口交互观察器
let lazyObserver = null;
function getLazyObserver() {
    if (!lazyObserver) {
        lazyObserver = new IntersectionObserver((entries, observer) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const img = entry.target;
                    const url = img.dataset.src;
                    if (url) {
                        img.src = url;
                        img.classList.add('loaded');
                    }
                    observer.unobserve(img);
                }
            });
        }, {
            rootMargin: '200px 0px 200px 0px'
        });
    }
    return lazyObserver;
}

// ==================== 1. 全屏图片灯箱 (高性能硬件加速版) ====================
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
    }

    closeBtn.onclick = closeModal;
    backdrop.onclick = closeModal;

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
    });

    window.addEventListener('mouseup', () => {
        if (viewerState.isDragging) {
            viewerState.isDragging = false;
            content.style.cursor = 'grab';
        }
    });

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

// ==================== 2. 防抖实用工具 ====================
function debounce(fn, delay = 250) {
    let timer = null;
    return function (...args) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), delay);
    };
}

// ==================== 3. IndexedDB 存储引擎 & 容量统计 ====================
const DB_NAME = 'ST_Char_Illustrations_DB';
const STORE_NAME = 'illustrations';
let dbInstance = null;
let cachedIllustrations = [];
let currentCachedCharId = null;
let searchFilterKeyword = '';
let searchInputValue = '';

function initDB() {
    return new Promise((resolve, reject) => {
        if (dbInstance) return resolve(dbInstance);
        const req = indexedDB.open(DB_NAME, 2);
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
            resolve(dbInstance);
        };
        req.onerror = (e) => reject(e);
    });
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
    return new Promise((resolve, reject) => {
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
                const imgs = item.images || (item.data ? [item.data] : []);
                for (const img of imgs) {
                    if (img instanceof Blob) {
                        size += img.size;
                    } else if (typeof img === 'string') {
                        size += img.length * 2;
                    }
                }
                totalBytes += size;
                if (item.charId === charId) {
                    charBytes += size;
                }
                cursor.continue();
            } else {
                resolve({
                    charSize: formatBytes(charBytes),
                    totalSize: formatBytes(totalBytes),
                    totalCount
                });
            }
        };
        req.onerror = (e) => reject(e);
    });
}

async function dbClearEntireDatabase() {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_NAME], 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.clear();
        req.onsuccess = () => {
            invalidateCache();
            resolve();
        };
        req.onerror = (e) => reject(e);
    });
}

async function dbAddIllustration(charId, rules, imagesData, imageNames = [], selectedIndex = 0) {
    const db = await initDB();
    const existing = await dbGetIllustrations(charId);
    const nextOrder = existing.length > 0 ? Math.max(...existing.map(i => i.order || 0)) + 1 : 1;
    const imagesList = Array.isArray(imagesData) ? imagesData : [imagesData];
    const namesList = Array.isArray(imageNames) ? [...imageNames] : [];
    while (namesList.length < imagesList.length) {
        namesList.push('');
    }

    return new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_NAME], 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const item = {
            charId,
            rules: rules,
            images: imagesList,
            imageNames: namesList,
            selectedIndex: selectedIndex || 0,
            data: imagesList[0] || null,
            order: nextOrder,
            createdAt: Date.now()
        };
        const req = store.add(item);
        req.onsuccess = () => {
            invalidateCache();
            resolve(req.result);
        };
        req.onerror = (e) => reject(e);
    });
}

/**
 * 极速批量写入单个规则项（将 Base64 即时转成 Blob 释放字符串内存）
 */
async function dbSaveSingleImportRecord(charId, rawItem, fallbackOrder = 1) {
    const db = await initDB();
    const rawImgs = rawItem.images || (rawItem.data ? [rawItem.data] : []);
    if (!rawImgs.length || !rawItem.rules) return;

    const blobImgs = rawImgs.map(img => {
        if (typeof img === 'string' && img.startsWith('data:image')) {
            return base64ToBlob(img);
        }
        return img;
    });

    const namesList = Array.isArray(rawItem.imageNames) ? [...rawItem.imageNames] : [];
    while (namesList.length < blobImgs.length) namesList.push('');

    return new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_NAME], 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const record = {
            charId,
            rules: rawItem.rules,
            images: blobImgs,
            imageNames: namesList,
            selectedIndex: typeof rawItem.selectedIndex === 'number' ? rawItem.selectedIndex : 0,
            data: blobImgs[0] || null,
            order: rawItem.order !== undefined ? rawItem.order : fallbackOrder,
            createdAt: Date.now()
        };
        const req = store.add(record);
        req.onsuccess = () => resolve();
        req.onerror = (e) => reject(e);
    });
}

async function dbGetIllustrations(charId) {
    if (currentCachedCharId === charId && cachedIllustrations.length > 0) {
        return cachedIllustrations;
    }
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_NAME], 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const index = store.index('charId');
        const req = index.getAll(IDBKeyRange.only(charId));
        req.onsuccess = () => {
            let res = req.result || [];
            res.forEach(item => {
                if (!item.images) {
                    item.images = item.data ? [item.data] : [];
                }
                if (!Array.isArray(item.imageNames)) {
                    item.imageNames = new Array(item.images.length).fill('');
                } else if (item.imageNames.length < item.images.length) {
                    while (item.imageNames.length < item.images.length) {
                        item.imageNames.push('');
                    }
                }
                if (typeof item.selectedIndex !== 'number') {
                    item.selectedIndex = 0;
                }
            });
            res.sort((a, b) => (a.order ?? a.id) - (b.order ?? b.id));
            cachedIllustrations = res;
            currentCachedCharId = charId;
            resolve(cachedIllustrations);
        };
        req.onerror = (e) => reject(e);
    });
}

function invalidateCache() {
    cachedIllustrations = [];
    currentCachedCharId = null;
}

async function dbUpdateIllustration(id, rules = null, order = null, newImages = null, imageNames = null, selectedIndex = null) {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_NAME], 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const getReq = store.get(id);
        getReq.onsuccess = () => {
            const data = getReq.result;
            if (!data) return reject(new Error('数据未找到'));
            if (rules !== null) {
                data.rules = rules;
                delete data.keywords;
            }
            if (order !== null) {
                data.order = order;
            }
            if (newImages !== null) {
                data.images = newImages;
                data.data = newImages[0] || null;
            }
            if (imageNames !== null) {
                data.imageNames = imageNames;
            }
            if (selectedIndex !== null) {
                data.selectedIndex = selectedIndex;
            }
            const putReq = store.put(data);
            putReq.onsuccess = () => {
                invalidateCache();
                resolve();
            };
            putReq.onerror = (e) => reject(e);
        };
        getReq.onerror = (e) => reject(e);
    });
}

async function dbSetIllustrationSelectedIndex(id, index) {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_NAME], 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const getReq = store.get(id);
        getReq.onsuccess = () => {
            const data = getReq.result;
            if (!data) return resolve();
            data.selectedIndex = index;
            const putReq = store.put(data);
            putReq.onsuccess = () => {
                invalidateCache();
                resolve();
            };
            putReq.onerror = (e) => reject(e);
        };
        getReq.onerror = (e) => reject(e);
    });
}

async function dbBatchSaveAll(updates) {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_NAME], 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        for (const item of updates) {
            const getReq = store.get(item.id);
            getReq.onsuccess = () => {
                const data = getReq.result;
                if (data) {
                    if (item.rules) data.rules = item.rules;
                    if (item.order !== undefined) data.order = item.order;
                    if (item.images) {
                        data.images = item.images;
                        data.data = item.images[0] || null;
                    }
                    if (item.imageNames) data.imageNames = item.imageNames;
                    if (item.selectedIndex !== undefined) data.selectedIndex = item.selectedIndex;
                    store.put(data);
                }
            };
        }
        tx.oncomplete = () => {
            invalidateCache();
            resolve();
        };
        tx.onerror = (e) => reject(e);
    });
}

async function dbDeleteIllustration(id) {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_NAME], 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.delete(id);
        req.onsuccess = () => {
            invalidateCache();
            resolve();
        };
        req.onerror = (e) => reject(e);
    });
}

async function dbDeleteAllByChar(charId) {
    const db = await initDB();
    const items = await dbGetIllustrations(charId);
    return new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_NAME], 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        for (const it of items) {
            store.delete(it.id);
        }
        tx.oncomplete = () => {
            invalidateCache();
            resolve();
        };
        tx.onerror = (e) => reject(e);
    });
}

// ==================== 4. 状态变量 & API 过滤配置 ====================
let tempBlobList = [];
let allowUserTrigger = localStorage.getItem('ci_allow_user_msg') === '1';
let showAllMatched = localStorage.getItem('ci_show_all_matched') !== '0';
let singleImageMode = localStorage.getItem('ci_single_image_mode') !== '0';
let displayPosition = localStorage.getItem('ci_display_position') || 'bottom';
let currentArbitrateController = null;

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
    return url.trim().replace(/\/+$/, '');
}

async function fetchModelsList() {
    if (!apiSettings.url) throw new Error('请先输入 API URL');
    let baseUrl = cleanApiUrl(apiSettings.url);
    let targetUrl = baseUrl.endsWith('/models') ? baseUrl : `${baseUrl}/models`;

    const headers = { 'Content-Type': 'application/json' };
    if (apiSettings.key) {
        headers['Authorization'] = `Bearer ${apiSettings.key}`;
    }

    const resp = await fetch(targetUrl, { credentials: 'omit', headers });
    if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    }
    const data = await resp.json();
    const list = data.data || data;
    if (Array.isArray(list)) {
        return list.map(m => m.id || m.name).filter(Boolean);
    }
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
    if (!apiSettings.enabled || !apiSettings.url || !apiSettings.model) {
        return null;
    }

    if (currentArbitrateController) {
        currentArbitrateController.abort();
    }
    currentArbitrateController = new AbortController();

    const optionsList = candidateItems.map(item => {
        return `- 插图ID [${item.id}]: 【${formatRuleDisplay(item)}】`;
    }).join('\n');

    const systemPrompt = `你是一个高度精准的二次元剧情插图判定中枢。你接收的内容包含角色的【思维链推演/设定审查(Subtext/Think等隐藏内容)】以及【实际对话与叙述正文】。

你的核心任务：
1. 全文综合感知：结合文本中角色的真实状态推演、设定审查和行动，确定当前场景下“每个角色当下最终生效的形态或服装”。
2. 实体与形态强绑定：绝对不能张冠李戴！
3. 状态时序替换：若角色中途换装或变身，只保留最终定格的形态，屏蔽旧形态。
4. 严格输出格式：必须且仅输出纯 JSON 数组，包含所有符合当前场面的插图数字 ID（例如 [1, 3]；若完全不符合则返回 []）。严禁包含任何分析说明或 Markdown 代码块！`;

    const userPrompt = `【候选插图库】：
${optionsList}

【包含隐藏推演与正文的完整消息】：
"""${fullRawText}"""

请输出当前场景下真正应当展示的插图ID数组：`;

    let baseUrl = cleanApiUrl(apiSettings.url);
    let chatEndpoint = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;

    try {
        const resp = await fetch(chatEndpoint, {
            method: 'POST',
            credentials: 'omit',
            signal: currentArbitrateController.signal,
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

        if (!resp.ok) {
            const errText = await resp.text();
            throw new Error(`HTTP ${resp.status} - ${errText}`);
        }

        const result = await resp.json();
        const rawContent = result.choices[0].message.content.trim();
        const jsonMatch = rawContent.match(/\[[\d\s,]*?\]/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }
    } catch (e) {
        if (e.name === 'AbortError') return null;
        console.error('[插图插件] API 仲裁请求异常:', e);
        toastr?.error?.(`插图AI判定请求失败: ${e.message}`, '插图插件');
    } finally {
        currentArbitrateController = null;
    }
    return null;
}

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
    if (context.characterId !== undefined && context.characters && context.characters[context.characterId]) {
        return context.characters[context.characterId].name || '当前角色';
    }
    return '当前角色';
}

function parseRuleInput(inputStr) {
    return inputStr
        .split(/[,，]/)
        .map(group => group.split('+').map(k => k.trim()).filter(k => k.length > 0))
        .filter(group => group.length > 0);
}

function formatRuleDisplay(item) {
    if (item.rules && Array.isArray(item.rules)) {
        return item.rules.map(group => group.join(' + ')).join(', ');
    }
    if (item.keywords && Array.isArray(item.keywords)) {
        return item.keywords.join(', ');
    }
    return '';
}

function clearOldIllustrations() {
    const containers = document.querySelectorAll('.char-illustration-container, #ci-top-fixed-container');
    containers.forEach(el => {
        el.querySelectorAll('img').forEach(img => {
            img.src = '';
        });
        el.remove();
    });
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

        if (context?.chat && context.chat.length > 0) {
            const allMes = Array.from(document.querySelectorAll('#chat .mes'));
            const idx = allMes.indexOf(messageEl);
            if (idx !== -1 && context.chat[idx] && typeof context.chat[idx].mes === 'string') {
                return context.chat[idx].mes;
            }
        }
    } catch (err) {
        console.warn('[插图插件] 读取底层 context 文本异常，降级使用 DOM 文本提取', err);
    }

    const textEl = messageEl.querySelector('.mes_text');
    if (textEl) {
        return textEl.innerText || textEl.textContent || '';
    }
    return messageEl.innerText || messageEl.textContent || '';
}

function showGlobalDialog(title, htmlContent, onConfirm) {
    const existing = document.getElementById('ci-custom-dialog');
    if (existing) existing.remove();

    const dialog = document.createElement('div');
    dialog.id = 'ci-custom-dialog';
    dialog.className = 'ci-confirm-modal active';
    dialog.innerHTML = `
        <div class="ci-confirm-content">
            <h3>${title}</h3>
            <div>${htmlContent}</div>
            <div class="ci-confirm-actions">
                <button id="ci-dialog-cancel" class="menu_button">取消</button>
                <button id="ci-dialog-confirm" class="menu_button ci-btn-danger">确认执行</button>
            </div>
        </div>
    `;

    document.body.appendChild(dialog);

    dialog.querySelector('#ci-dialog-cancel').onclick = () => dialog.remove();
    dialog.querySelector('#ci-dialog-confirm').onclick = async () => {
        dialog.remove();
        if (onConfirm) await onConfirm();
    };
}

// ==================== 4.5 增强型进度条与错误诊断弹窗 ====================
function createProgressModal(title) {
    const existing = document.getElementById('ci-progress-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'ci-progress-modal';
    modal.className = 'ci-progress-modal';
    modal.innerHTML = `
        <div class="ci-progress-dialog">
            <div class="ci-progress-title">${title}</div>
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
                setTimeout(() => modal.remove(), 200);
            }, delay);
        }
    };
}

function showDetailedErrorReportModal(reportData) {
    const existing = document.getElementById('ci-error-report-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'ci-error-report-modal';
    modal.className = 'ci-confirm-modal active';

    const fullReportText = `================ 角色插图配置导入错误报告 ================
时间: ${new Date().toLocaleString()}
错误信息: ${reportData.message || '未知错误'}
文件名称: ${reportData.fileName || '未知'}
文件总大小: ${reportData.fileSize || '0 B'}
已成功导入规则项数: ${reportData.importedCount || 0}
错误堆栈:
${reportData.stack || '无堆栈信息'}
========================================================`;

    modal.innerHTML = `
        <div class="ci-confirm-content" style="max-width: 600px; width: 92%; max-height: 85vh; display: flex; flex-direction: column;">
            <h3 style="color: #ff4d4f; display: flex; align-items: center; justify-content: space-between;">
                <span>❌ 导入失败诊断报告</span>
                <span id="ci-error-close-x" style="cursor: pointer; font-size: 1.2em; color: #bbb;">&times;</span>
            </h3>
            
            <div style="font-size: 0.88em; color: #eee; line-height: 1.5;">
                <p style="margin: 0 0 6px 0;">解析或写入流时发生异常。</p>
            </div>

            <textarea readonly style="flex: 1; min-height: 220px; font-family: monospace; font-size: 0.78em; background: rgba(0,0,0,0.6); color: #ffd166; border: 1px solid rgba(255,255,255,0.2); border-radius: 6px; padding: 8px; resize: none; white-space: pre-wrap; word-break: break-all;">${fullReportText}</textarea>

            <div class="ci-confirm-actions" style="margin-top: 10px; display: flex; justify-content: flex-end; gap: 8px;">
                <button id="ci-copy-report-btn" class="menu_button ci-btn-accent" style="background: #2a9d8f !important;">📋 复制完整错误报告</button>
                <button id="ci-error-close-btn" class="menu_button">关闭</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    const closeModal = () => modal.remove();
    modal.querySelector('#ci-error-close-x').onclick = closeModal;
    modal.querySelector('#ci-error-close-btn').onclick = closeModal;

    const copyBtn = modal.querySelector('#ci-copy-report-btn');
    copyBtn.onclick = async () => {
        try {
            await navigator.clipboard.writeText(fullReportText);
            copyBtn.innerText = '已复制到剪贴板 ✓';
            setTimeout(() => { copyBtn.innerText = '📋 复制完整错误报告'; }, 1500);
        } catch (err) {
            alert('复制失败，请直接在文本框中手动全选复制。');
        }
    };
}

/**
 * 修复版：流式切块解析器（消除扫描回溯与死锁状态）
 */
async function streamParseAndImportJson(file, charId, onProgress) {
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
                    if (isEscaped) {
                        isEscaped = false;
                    } else if (char === '\\') {
                        isEscaped = true;
                    } else if (char === '"') {
                        inString = false;
                    }
                    scanIdx++;
                    continue;
                }

                if (char === '"') {
                    inString = true;
                    scanIdx++;
                    continue;
                }

                if (char === '{') {
                    if (depth === 0) {
                        currentObjectStart = scanIdx;
                    }
                    depth++;
                } else if (char === '}') {
                    depth--;
                    if (depth === 0 && currentObjectStart !== -1) {
                        const objText = buffer.slice(currentObjectStart, scanIdx + 1);
                        try {
                            const parsedItem = JSON.parse(objText);
                            importedCount++;
                            await dbSaveSingleImportRecord(charId, parsedItem, importedCount);

                            const mbLoaded = (loadedBytes / 1024 / 1024).toFixed(1);
                            const mbTotal = (totalBytes / 1024 / 1024).toFixed(1);
                            if (onProgress) {
                                onProgress(loadedBytes, totalBytes, `流式解析入库 (${mbLoaded}MB / ${mbTotal}MB) · 已导入 ${importedCount} 项`);
                            }
                        } catch (err) {
                            console.warn('[插图插件] 跳过一个损坏项:', err);
                        }

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

    invalidateCache();
    return importedCount;
}

// ==================== 5. “更换插图”交互弹窗 (纯 ObjectURL 极速版) ====================
function openImagePickerModal(item, onSelect) {
    const existingModal = document.getElementById('ci-picker-modal');
    if (existingModal) existingModal.remove();

    const pickerModal = document.createElement('div');
    pickerModal.id = 'ci-picker-modal';
    pickerModal.className = 'ci-picker-modal';

    const imgs = item.images || (item.data ? [item.data] : []);
    const names = item.imageNames || [];
    const currentSelected = typeof item.selectedIndex === 'number' ? item.selectedIndex : 0;

    const itemsHtml = imgs.map((rawSource, idx) => {
        const url = toDisplayUrl(rawSource);
        const rawName = names[idx] ? names[idx].trim() : '';
        const displayName = rawName || `插图 ${idx + 1}`;
        const isActive = idx === currentSelected;
        return `
            <div class="ci-picker-card ${isActive ? 'active' : ''}" data-idx="${idx}">
                <div class="ci-picker-img-box">
                    <img class="ci-lazy-img" data-src="${url}" />
                    ${isActive ? '<div class="ci-picker-badge">当前已选</div>' : ''}
                </div>
                <div class="ci-picker-name" title="${displayName}">${displayName}</div>
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
            <div class="ci-picker-hint">点击下方插图即可更换。选择后今后触发该规则将<b>固定展示</b>此图：</div>
            <div class="ci-picker-grid">
                ${itemsHtml}
            </div>
        </div>
    `;

    document.body.appendChild(pickerModal);

    const observer = getLazyObserver();
    pickerModal.querySelectorAll('.ci-lazy-img').forEach(el => observer.observe(el));

    const closePicker = () => {
        pickerModal.classList.remove('active');
        setTimeout(() => pickerModal.remove(), 180);
    };

    pickerModal.querySelector('.ci-picker-backdrop').onclick = closePicker;
    pickerModal.querySelector('.ci-picker-close').onclick = closePicker;

    pickerModal.querySelectorAll('.ci-picker-card').forEach(card => {
        card.onclick = () => {
            const chosenIdx = parseInt(card.dataset.idx, 10);
            closePicker();
            if (onSelect) {
                onSelect(chosenIdx);
            }
        };
    });

    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            pickerModal.classList.add('active');
        });
    });
}

// ==================== 6. 单规则多图管理弹窗 (直接操作 Blob) ====================
function openManageImagesModal(item, onUpdated) {
    const existing = document.getElementById('ci-manage-modal');
    if (existing) existing.remove();

    const manageModal = document.createElement('div');
    manageModal.id = 'ci-manage-modal';
    manageModal.className = 'ci-manage-modal';

    let localImgs = [...(item.images || (item.data ? [item.data] : []))];
    let localNames = [...(item.imageNames || [])];
    while (localNames.length < localImgs.length) {
        localNames.push('');
    }
    let localSelectedIndex = typeof item.selectedIndex === 'number' ? item.selectedIndex : 0;
    if (localSelectedIndex >= localImgs.length) localSelectedIndex = 0;

    function syncInputsToLocalNames() {
        const container = manageModal.querySelector('#ci-manage-grid-container');
        if (!container) return;
        container.querySelectorAll('.ci-manage-name-input').forEach(inp => {
            const idx = parseInt(inp.dataset.idx, 10);
            if (!isNaN(idx) && idx < localNames.length) {
                localNames[idx] = inp.value.trim();
            }
        });
    }

    function renderGridContent() {
        return localImgs.map((rawSource, idx) => {
            const isSelected = idx === localSelectedIndex;
            const nameVal = localNames[idx] || '';
            const url = toDisplayUrl(rawSource);
            return `
                <div class="ci-manage-item ${isSelected ? 'is-selected' : ''}" data-idx="${idx}">
                    <div class="ci-manage-img-wrap">
                        <div class="ci-manage-order-bar">
                            <button class="ci-order-mini-btn ci-suborder-left" data-idx="${idx}" title="向前调整顺序" ${idx === 0 ? 'disabled' : ''}>◀</button>
                            <span class="ci-img-index-badge">#${idx + 1}</span>
                            <button class="ci-order-mini-btn ci-suborder-right" data-idx="${idx}" title="向后调整顺序" ${idx === localImgs.length - 1 ? 'disabled' : ''}>▶</button>
                        </div>
                        <img src="${url}" loading="lazy" title="点击放大预览" onclick="window.openCIModal('${url}')" />
                    </div>
                    <input class="ci-manage-name-input" data-idx="${idx}" type="text" placeholder="输入插图命名..." value="${nameVal.replace(/"/g, '&quot;')}" title="输入给这张插图的文字名称" />
                    <div class="ci-manage-actions">
                        <button class="ci-set-default-btn" data-idx="${idx}">${isSelected ? '★ 默认展示' : '设为默认'}</button>
                        <span class="ci-manage-del-btn" data-idx="${idx}" title="从该规则中移除此图">🗑️</span>
                    </div>
                </div>
            `;
        }).join('');
    }

    manageModal.innerHTML = `
        <div class="ci-manage-backdrop"></div>
        <div class="ci-manage-dialog">
            <div class="ci-manage-header">
                <div>🖼️ 插图与命名管理 <span style="font-size:0.8em; opacity:0.75; font-weight:normal;">[规则ID: ${item.id}]</span></div>
                <div class="ci-manage-close" style="cursor:pointer; font-size:1.4em; line-height:1;">×</div>
            </div>
            <div style="font-size:0.82em; color:#bbb;">
                可点击 <b>◀ / ▶</b> 调整排版顺序，输入命名并在聊天中随时自选切换：
            </div>
            <div class="ci-manage-grid" id="ci-manage-grid-container">
                ${renderGridContent()}
            </div>
            <div class="ci-manage-footer">
                <button id="ci-modal-append-btn" class="menu_button ci-mini-btn" style="background:#457b9d; color:#fff;">＋ 追加新插图</button>
                <div style="display:flex; gap:8px;">
                    <button id="ci-modal-cancel-btn" class="menu_button ci-mini-btn">取消</button>
                    <button id="ci-modal-save-btn" class="menu_button ci-mini-btn ci-btn-accent">保存修改</button>
                </div>
            </div>
            <input id="ci-modal-file-input" type="file" accept="image/*" multiple style="display:none;" />
        </div>
    `;

    document.body.appendChild(manageModal);

    const closeManageModal = () => {
        manageModal.classList.remove('active');
        setTimeout(() => manageModal.remove(), 180);
    };

    function bindGridEvents() {
        const container = manageModal.querySelector('#ci-manage-grid-container');
        container.innerHTML = renderGridContent();

        container.querySelectorAll('.ci-manage-name-input').forEach(inp => {
            inp.oninput = (e) => {
                const idx = parseInt(e.target.dataset.idx, 10);
                localNames[idx] = e.target.value.trim();
            };
        });

        container.querySelectorAll('.ci-set-default-btn').forEach(btn => {
            btn.onclick = () => {
                syncInputsToLocalNames();
                localSelectedIndex = parseInt(btn.dataset.idx, 10);
                bindGridEvents();
            };
        });

        container.querySelectorAll('.ci-suborder-left').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                syncInputsToLocalNames();
                const idx = parseInt(btn.dataset.idx, 10);
                if (idx > 0) {
                    const tempImg = localImgs[idx];
                    localImgs[idx] = localImgs[idx - 1];
                    localImgs[idx - 1] = tempImg;

                    const tempName = localNames[idx];
                    localNames[idx] = localNames[idx - 1];
                    localNames[idx - 1] = tempName;

                    if (localSelectedIndex === idx) {
                        localSelectedIndex = idx - 1;
                    } else if (localSelectedIndex === idx - 1) {
                        localSelectedIndex = idx;
                    }
                    bindGridEvents();
                }
            };
        });

        container.querySelectorAll('.ci-suborder-right').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                syncInputsToLocalNames();
                const idx = parseInt(btn.dataset.idx, 10);
                if (idx < localImgs.length - 1) {
                    const tempImg = localImgs[idx];
                    localImgs[idx] = localImgs[idx + 1];
                    localImgs[idx + 1] = tempImg;

                    const tempName = localNames[idx];
                    localNames[idx] = localNames[idx + 1];
                    localNames[idx + 1] = tempName;

                    if (localSelectedIndex === idx) {
                        localSelectedIndex = idx + 1;
                    } else if (localSelectedIndex === idx + 1) {
                        localSelectedIndex = idx;
                    }
                    bindGridEvents();
                }
            };
        });

        container.querySelectorAll('.ci-manage-del-btn').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                syncInputsToLocalNames();
                const idx = parseInt(btn.dataset.idx, 10);
                if (localImgs.length <= 1) {
                    alert('每条规则至少需要保留 1 张插图！如不再需要此规则，请在主面板中点击“删除”。');
                    return;
                }
                if (confirm(`确认移除第 ${idx + 1} 张图片吗？`)) {
                    localImgs.splice(idx, 1);
                    localNames.splice(idx, 1);
                    if (localSelectedIndex >= localImgs.length) {
                        localSelectedIndex = 0;
                    }
                    bindGridEvents();
                }
            };
        });
    }

    bindGridEvents();

    manageModal.querySelector('.ci-manage-backdrop').onclick = closeManageModal;
    manageModal.querySelector('.ci-manage-close').onclick = closeManageModal;
    manageModal.querySelector('#ci-modal-cancel-btn').onclick = closeManageModal;

    const modalFileInput = manageModal.querySelector('#ci-modal-file-input');
    manageModal.querySelector('#ci-modal-append-btn').onclick = () => {
        syncInputsToLocalNames();
        modalFileInput.value = '';
        modalFileInput.click();
    };

    modalFileInput.onchange = (e) => {
        const files = Array.from(e.target.files);
        if (!files.length) return;
        for (const file of files) {
            localImgs.push(file);
            localNames.push('');
        }
        bindGridEvents();
    };

    manageModal.querySelector('#ci-modal-save-btn').onclick = async () => {
        syncInputsToLocalNames();
        await dbUpdateIllustration(
            item.id,
            null,
            null,
            localImgs,
            localNames,
            localSelectedIndex
        );
        closeManageModal();
        if (onUpdated) await onUpdated();
    };

    requestAnimationFrame(() => {
        manageModal.classList.add('active');
    });
}

// ==================== 7. 渲染扩展设置面板 ====================
async function renderSettings() {
    const container = document.getElementById('ci-settings-content');
    if (!container) return;

    const charId = getCurrentCharId();
    const charName = getCurrentCharDisplayName();

    if (!charId) {
        container.innerHTML = `<div style="opacity:0.7; font-size:0.9em; padding:10px;">请先打开一个角色卡对话。</div>`;
        return;
    }

    const [items, stats] = await Promise.all([
        dbGetIllustrations(charId),
        dbGetStorageStats(charId)
    ]);

    const filteredItems = items.filter(item => {
        if (!searchFilterKeyword.trim()) return true;
        const text = formatRuleDisplay(item).toLowerCase();
        return text.includes(searchFilterKeyword.trim().toLowerCase());
    });

    const itemCardsHtml = filteredItems.map((item, index) => {
        const imgs = item.images || (item.data ? [item.data] : []);
        const selectedIdx = typeof item.selectedIndex === 'number' && item.selectedIndex < imgs.length ? item.selectedIndex : 0;
        const rawSource = imgs[selectedIdx] || imgs[0] || null;
        const displayUrl = toDisplayUrl(rawSource);
        const names = item.imageNames || [];
        const currentName = names[selectedIdx] || '';

        return `
        <div class="ci-card" data-id="${item.id}">
            <div class="ci-thumb-box">
                <div class="ci-thumb-preview-wrap" data-id="${item.id}" title="点击放大主图 (共 ${imgs.length} 张图片)">
                    <img class="ci-thumb-main ci-lazy-img" data-src="${displayUrl}" onclick="window.openCIModal('${displayUrl}')" />
                    <div class="ci-thumb-count-tag">${imgs.length} 图</div>
                </div>
                <div class="ci-order-controls">
                    <button class="ci-order-btn ci-order-up" data-id="${item.id}" title="上移" ${index === 0 ? 'disabled style="opacity:0.3;cursor:not-allowed;"' : ''}>▲</button>
                    <button class="ci-order-btn ci-order-down" data-id="${item.id}" title="下移" ${index === filteredItems.length - 1 ? 'disabled style="opacity:0.3;cursor:not-allowed;"' : ''}>▼</button>
                </div>
            </div>
            <div class="ci-card-info">
                <div class="ci-card-header-row">
                    <span style="font-size:0.8em; opacity:0.85;">
                        [ID: ${item.id}] 当前锁定: <b style="color:#ffd166;">${currentName || `插图 ${selectedIdx + 1}`}</b>
                    </span>
                    <button class="ci-manage-btn" data-id="${item.id}">🖼️ 管理与命名 (${imgs.length})</button>
                </div>
                <input class="text_pole ci-edit-input" data-id="${item.id}" type="text" value="${formatRuleDisplay(item)}" placeholder="如: 少女A + 女仆装" />
                <div class="ci-card-actions">
                    <button class="ci-save-edit-btn" data-id="${item.id}">保存规则</button>
                    <button class="ci-del-btn" data-id="${item.id}">删除</button>
                </div>
            </div>
        </div>
        `;
    });

    container.innerHTML = `
        <div class="ci-panel">
            <div class="ci-api-config-box">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <b>🤖 智能情景过滤 API (AI 仲裁)</b>
                    <label style="display:flex; align-items:center; gap:4px; font-size:0.85em; cursor:pointer;">
                        <input type="checkbox" id="ci-api-enabled" ${apiSettings.enabled ? 'checked' : ''} />
                        <span>启用 AI 过滤</span>
                    </label>
                </div>
                
                <div class="ci-api-row">
                    <label>API URL:</label>
                    <input id="ci-api-url" class="text_pole" type="text" placeholder="https://api.openai.com/v1" value="${apiSettings.url}" />
                </div>
                
                <div class="ci-api-row">
                    <label>API KEY:</label>
                    <input id="ci-api-key" class="text_pole" type="password" placeholder="sk-..." value="${apiSettings.key}" />
                </div>
                
                <div class="ci-api-row">
                    <label>选择或指定模型名:</label>
                    <div style="display:flex; gap:6px; width:100%;">
                        <input id="ci-api-model" class="text_pole" type="text" placeholder="手动输入或通过右侧选择" value="${apiSettings.model}" style="flex:1;" />
                        <select id="ci-api-model-select" class="text_pole" style="display:none; flex:1; max-width: 50%;"></select>
                    </div>
                </div>
                
                <div class="ci-api-btn-group">
                    <button id="ci-api-fetch-models" class="menu_button ci-btn-standard">1. 连接 / 拉取模型列表</button>
                    <button id="ci-api-test-chat" class="menu_button ci-btn-standard" style="background:#2a9d8f;">2. 测试 API 对话连通性</button>
                </div>
                
                <div id="ci-api-status-box" class="ci-status-box"></div>
            </div>

            <div class="ci-upload-box">
                <b>为角色 [${charName}] 添加新规则 (原生 Blob 存储)</b>
                <input id="ci-kw-input" class="text_pole" type="text" placeholder="如: 微笑 + 校园, 礼服" />
                
                <div class="ci-rule-hint">
                    💡 <b>语法说明：</b>使用 <code>,</code> 分隔备选条件；使用 <code>+</code> 表示必须同时出现。单条规则可绑定多张图。
                </div>
                
                <div style="display: flex; gap: 8px; flex-wrap: wrap; align-items: center;">
                    <button id="ci-choose-file-btn" class="menu_button">选择本地插图 (可多选)</button>
                    <button id="ci-save-btn" class="menu_button" style="background:#2a9d8f;">保存规则与图片</button>
                    <input id="ci-file-input" type="file" accept="image/*" multiple style="display: none;" />
                    <span id="ci-upload-count-hint" style="font-size:0.85em; opacity:0.8; color:#ffd166;"></span>
                </div>
                
                <div id="ci-preview" class="ci-preview-container" style="display: none;"></div>

                <div style="display:flex; flex-direction:column; gap:6px; font-size:0.85em; margin-top:4px;">
                    <div style="display:flex; align-items:center; gap:8px;">
                        <span><b>插图显示位置：</b></span>
                        <select id="ci-display-pos-select" class="text_pole" style="flex:1; padding:2px 6px; font-size:0.9em;">
                            <option value="bottom" ${displayPosition === 'bottom' ? 'selected' : ''}>当前最新楼层最下方</option>
                            <option value="top_fixed" ${displayPosition === 'top_fixed' ? 'selected' : ''}>聊天界面上方固定 (不受滑动影响)</option>
                        </select>
                    </div>

                    <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
                        <input type="checkbox" id="ci-single-image-mode-chk" ${singleImageMode ? 'checked' : ''} />
                        <span style="color:#ffd166; font-weight:bold;">启用单图展示与自选模式 (单规则仅显示1张插图，可通过“更换”按钮自选并锁定)</span>
                    </label>

                    <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
                        <input type="checkbox" id="ci-show-all-chk" ${showAllMatched ? 'checked' : ''} />
                        <span>多个不同规则同时命中时全部显示 (未开启 AI 时生效；取消则随机选1个规则)</span>
                    </label>
                    <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
                        <input type="checkbox" id="ci-allow-user-chk" ${allowUserTrigger ? 'checked' : ''} />
                        <span>包含检测用户发出的消息</span>
                    </label>
                </div>
            </div>

            <div class="ci-list-header">
                <div class="ci-list-header-info">
                    <b>已配置规则项 (${items.length})</b>
                    <span style="font-size:0.8em; opacity:0.85;">
                        💾 本角色: <b style="color:#ffd166;">${stats.charSize}</b> | 总库: <b style="color:#2a9d8f;">${stats.totalSize}</b>
                    </span>
                </div>
                <div class="ci-header-actions">
                    <button id="ci-refresh-storage-btn" class="menu_button ci-mini-btn" title="刷新存储容量">🔄 刷新</button>
                    <button id="ci-save-all-btn" class="menu_button ci-mini-btn ci-btn-accent" title="一键保存所有规则文字">一键保存</button>
                    <button id="ci-export-btn" class="menu_button ci-mini-btn" title="导出配置">导出</button>
                    <button id="ci-import-btn" class="menu_button ci-mini-btn" title="导入配置">导入</button>
                    <button id="ci-delete-all-btn" class="menu_button ci-mini-btn ci-btn-danger" title="清空当前角色插图">清空本角色</button>
                    <button id="ci-clear-db-btn" class="menu_button ci-mini-btn ci-btn-danger" style="background:#b7094c !important;" title="清空所有角色的插图并释放浏览器空间">🔥 清空整库</button>
                    <input id="ci-import-input" type="file" accept=".json" style="display:none;" />
                </div>
            </div>

            <div class="ci-search-row">
                <div class="ci-search-input-wrapper">
                    <input id="ci-search-kw-input" class="text_pole" type="text" placeholder="输入关键词或规则..." value="${searchInputValue}" />
                    ${searchInputValue ? `<button id="ci-search-clear-btn" class="ci-search-clear" title="清空搜索">×</button>` : ''}
                </div>
                <button id="ci-search-exec-btn" class="menu_button ci-mini-btn" style="background:#457b9d; color:#fff;">搜索</button>
                ${searchFilterKeyword ? `<button id="ci-search-reset-btn" class="menu_button ci-mini-btn" title="显示全部">重置</button>` : ''}
            </div>

            <div class="ci-items-list">
                ${items.length === 0 ? `<div style="font-size:0.85em; opacity:0.6; text-align:center; padding:10px 0;">当前角色暂未配置任何插图</div>` : ''}
                ${items.length > 0 && filteredItems.length === 0 ? `<div style="font-size:0.85em; opacity:0.6; text-align:center; padding:10px 0;">未找到包含关键词 "<b>${searchFilterKeyword}</b>" 的插图</div>` : ''}
                ${itemCardsHtml.join('')}
            </div>
        </div>
    `;

    const observer = getLazyObserver();
    container.querySelectorAll('.ci-lazy-img').forEach(el => observer.observe(el));

    const apiEnabledChk = document.getElementById('ci-api-enabled');
    const apiUrlInput = document.getElementById('ci-api-url');
    const apiKeyInput = document.getElementById('ci-api-key');
    const apiModelInput = document.getElementById('ci-api-model');
    const apiModelSelect = document.getElementById('ci-api-model-select');
    const fetchModelsBtn = document.getElementById('ci-api-fetch-models');
    const testChatBtn = document.getElementById('ci-api-test-chat');
    const statusBox = document.getElementById('ci-api-status-box');

    function showStatus(text, isError = false) {
        statusBox.style.display = 'block';
        statusBox.style.color = isError ? '#ff6b6b' : '#51cf66';
        statusBox.innerHTML = text;
    }

    apiEnabledChk.onchange = (e) => {
        apiSettings.enabled = e.target.checked;
        saveApiSettings();
    };
    apiUrlInput.oninput = (e) => {
        apiSettings.url = e.target.value.trim();
        saveApiSettings();
    };
    apiKeyInput.oninput = (e) => {
        apiSettings.key = e.target.value.trim();
        saveApiSettings();
    };
    apiModelInput.oninput = (e) => {
        apiSettings.model = e.target.value.trim();
        saveApiSettings();
    };

    fetchModelsBtn.onclick = async () => {
        showStatus('⏳ 正在连接端点并获取模型列表...');
        try {
            const models = await fetchModelsList();
            if (!models.length) throw new Error('返回列表为空');
            apiModelSelect.innerHTML = `<option value="">-- 点击选择模型 --</option>` + models.map(m => `<option value="${m}">${m}</option>`).join('');
            apiModelSelect.style.display = 'block';
            apiModelSelect.value = apiSettings.model;
            apiModelSelect.onchange = () => {
                apiModelInput.value = apiModelSelect.value;
                apiSettings.model = apiModelSelect.value;
                saveApiSettings();
            };
            showStatus(`🟢 <b>连接成功！</b>共读取 <b>${models.length}</b> 个模型。`);
        } catch (err) {
            showStatus(`🔴 <b>拉取失败：</b> ${err.message}`, true);
        }
    };

    testChatBtn.onclick = async () => {
        showStatus('⏳ 正在发起对话连通性测试...');
        try {
            const reply = await testChatApi();
            showStatus(`🟢 <b>对话测试成功！</b> 模型响应正常 (回复: "${reply}")，AI 智能情境过滤已就绪。`);
        } catch (err) {
            showStatus(`🔴 <b>测试失败：</b> 无法与模型对话。<br>错误: ${err.message}`, true);
        }
    };

    const fileInput = document.getElementById('ci-file-input');
    const chooseBtn = document.getElementById('ci-choose-file-btn');
    const countHint = document.getElementById('ci-upload-count-hint');
    const previewContainer = document.getElementById('ci-preview');
    const saveBtn = document.getElementById('ci-save-btn');
    const kwInput = document.getElementById('ci-kw-input');
    const allowUserChk = document.getElementById('ci-allow-user-chk');
    const showAllChk = document.getElementById('ci-show-all-chk');
    const singleModeChk = document.getElementById('ci-single-image-mode-chk');
    const displayPosSelect = document.getElementById('ci-display-pos-select');

    if (displayPosSelect) {
        displayPosSelect.onchange = (e) => {
            displayPosition = e.target.value;
            localStorage.setItem('ci_display_position', displayPosition);
            clearOldIllustrations();
            debouncedScan();
        };
    }

    if (singleModeChk) {
        singleModeChk.onchange = (e) => {
            singleImageMode = e.target.checked;
            localStorage.setItem('ci_single_image_mode', singleImageMode ? '1' : '0');
            debouncedScan();
        };
    }

    showAllChk.onchange = (e) => {
        showAllMatched = e.target.checked;
        localStorage.setItem('ci_show_all_matched', showAllMatched ? '1' : '0');
        debouncedScan();
    };

    allowUserChk.onchange = (e) => {
        allowUserTrigger = e.target.checked;
        localStorage.setItem('ci_allow_user_msg', allowUserTrigger ? '1' : '0');
        debouncedScan();
    };

    chooseBtn.onclick = () => fileInput.click();

    fileInput.onchange = (e) => {
        const files = Array.from(e.target.files);
        if (!files.length) return;

        tempBlobList = [...files];
        previewContainer.innerHTML = '';

        for (const file of files) {
            const url = toDisplayUrl(file);
            const thumb = document.createElement('img');
            thumb.src = url;
            thumb.className = 'ci-preview-thumb';
            thumb.onclick = () => window.openCIModal(url);
            previewContainer.appendChild(thumb);
        }

        previewContainer.style.display = 'flex';
        countHint.innerText = `已选 ${files.length} 张图片 (Blob 原生加速)`;
    };

    saveBtn.onclick = async () => {
        const kwRaw = kwInput.value.trim();
        if (!kwRaw) return alert('请至少输入一个关键词规则！');
        if (!tempBlobList.length) return alert('请先选择至少一张图片！');

        const rules = parseRuleInput(kwRaw);
        if (!rules.length) return alert('规则解析为空，请重新输入！');

        await dbAddIllustration(charId, rules, tempBlobList, new Array(tempBlobList.length).fill(''));
        tempBlobList = [];
        fileInput.value = '';
        countHint.innerText = '';
        renderSettings();
        debouncedScan();
    };

    container.querySelectorAll('.ci-manage-btn').forEach(btn => {
        btn.onclick = () => {
            const id = parseInt(btn.dataset.id, 10);
            const targetItem = items.find(i => i.id === id);
            if (!targetItem) return;
            openManageImagesModal(targetItem, async () => {
                await renderSettings();
                debouncedScan();
            });
        };
    });

    const searchInput = document.getElementById('ci-search-kw-input');
    const searchExecBtn = document.getElementById('ci-search-exec-btn');
    const searchClearBtn = document.getElementById('ci-search-clear-btn');
    const searchResetBtn = document.getElementById('ci-search-reset-btn');

    if (searchInput) {
        searchInput.oninput = (e) => { searchInputValue = e.target.value; };
        searchInput.onkeydown = (e) => {
            if (e.key === 'Enter') {
                searchFilterKeyword = searchInput.value.trim();
                renderSettings();
            }
        };
    }

    if (searchExecBtn) {
        searchExecBtn.onclick = () => {
            if (searchInput) {
                searchFilterKeyword = searchInput.value.trim();
                renderSettings();
            }
        };
    }

    if (searchClearBtn) {
        searchClearBtn.onclick = () => {
            searchInputValue = '';
            if (searchInput) searchInput.value = '';
            searchFilterKeyword = '';
            renderSettings();
        };
    }

    if (searchResetBtn) {
        searchResetBtn.onclick = () => {
            searchInputValue = '';
            searchFilterKeyword = '';
            renderSettings();
        };
    }

    container.querySelectorAll('.ci-save-edit-btn').forEach(btn => {
        btn.onclick = async () => {
            const id = parseInt(btn.dataset.id, 10);
            const inputEl = container.querySelector(`.ci-edit-input[data-id="${id}"]`);
            if (!inputEl) return;
            const newVal = inputEl.value.trim();
            if (!newVal) return alert('规则不能为空！');

            await dbUpdateIllustration(id, parseRuleInput(newVal));
            btn.innerText = '已保存 ✓';
            setTimeout(() => { btn.innerText = '保存规则'; }, 1200);
            debouncedScan();
        };
    });

    const saveAllBtn = document.getElementById('ci-save-all-btn');
    if (saveAllBtn) {
        saveAllBtn.onclick = async () => {
            const inputs = container.querySelectorAll('.ci-edit-input');
            if (!inputs.length) return alert('当前无规则需要保存！');
            const updates = [];
            for (const input of inputs) {
                const id = parseInt(input.dataset.id, 10);
                const val = input.value.trim();
                if (val) {
                    updates.push({ id, rules: parseRuleInput(val) });
                }
            }
            if (updates.length > 0) {
                await dbBatchSaveAll(updates);
                saveAllBtn.innerText = '全部保存成功 ✓';
                setTimeout(() => { saveAllBtn.innerText = '一键保存'; }, 1500);
                debouncedScan();
            }
        };
    }

    const refreshStorageBtn = document.getElementById('ci-refresh-storage-btn');
    if (refreshStorageBtn) {
        refreshStorageBtn.onclick = async () => {
            refreshStorageBtn.innerText = '⏳ 统计中';
            await renderSettings();
        };
    }

    const clearDbBtn = document.getElementById('ci-clear-db-btn');
    if (clearDbBtn) {
        clearDbBtn.onclick = () => {
            showGlobalDialog(
                '🚨 极度危险：清空整库容量',
                `
                <p style="margin: 0; line-height: 1.6; font-size: 0.95em;">
                    此操作将<b>彻底抹除浏览器 IndexedDB 中存储的所有插图与数据</b>（涵盖所有角色的全部插图配置）！<br>
                    <span style="color: #ff3333; font-weight: bold; background: rgba(255, 0, 0, 0.2); padding: 4px 8px; border-radius: 4px; display: inline-block; margin-top: 8px; border: 1px solid rgba(255,0,0,0.4);">
                        ⚠️ 警告：数据一旦清空将永久丢失，绝对无法复原！
                    </span>
                </p>
                `,
                async () => {
                    await dbClearEntireDatabase();
                    clearOldIllustrations();
                    await renderSettings();
                    debouncedScan();
                    toastr?.success?.('IndexedDB 数据库已被彻底清空，空间已释放！', '插图插件');
                }
            );
        };
    }

    container.querySelectorAll('.ci-order-up').forEach(btn => {
        btn.onclick = async () => {
            const id = parseInt(btn.dataset.id, 10);
            const idx = items.findIndex(i => i.id === id);
            if (idx > 0) {
                const currentItem = items[idx];
                const prevItem = items[idx - 1];
                const tempOrder = currentItem.order ?? idx + 1;
                currentItem.order = prevItem.order ?? idx;
                prevItem.order = tempOrder;
                await dbBatchSaveAll([
                    { id: currentItem.id, order: currentItem.order },
                    { id: prevItem.id, order: prevItem.order }
                ]);
                renderSettings();
            }
        };
    });

    container.querySelectorAll('.ci-order-down').forEach(btn => {
        btn.onclick = async () => {
            const id = parseInt(btn.dataset.id, 10);
            const idx = items.findIndex(i => i.id === id);
            if (idx < items.length - 1 && idx !== -1) {
                const currentItem = items[idx];
                const nextItem = items[idx + 1];
                const tempOrder = currentItem.order ?? idx + 1;
                currentItem.order = nextItem.order ?? idx + 2;
                nextItem.order = tempOrder;
                await dbBatchSaveAll([
                    { id: currentItem.id, order: currentItem.order },
                    { id: nextItem.id, order: nextItem.order }
                ]);
                renderSettings();
            }
        };
    });

    container.querySelectorAll('.ci-del-btn').forEach(btn => {
        btn.onclick = async () => {
            const id = parseInt(btn.dataset.id, 10);
            if (confirm('确认删除该条规则及其绑定的全部插图吗？')) {
                await dbDeleteIllustration(id);
                renderSettings();
                debouncedScan();
            }
        };
    });

    const deleteAllBtn = document.getElementById('ci-delete-all-btn');
    if (deleteAllBtn) {
        deleteAllBtn.onclick = () => {
            if (items.length === 0) return alert('当前没有可删除的插图！');
            showGlobalDialog(
                '⚠️ 危险操作确认',
                `
                <p style="margin: 0; line-height: 1.5; font-size: 0.95em;">
                    您确定要<b>一键清空并删除</b>角色【${charName}】的所有插图数据吗？<br>
                    <span style="color: #ff3333; font-weight: bold; margin-top: 6px; display: inline-block;">
                        ⚠️ 警告：删除后无法撤销或复原！
                    </span>
                </p>
                `,
                async () => {
                    await dbDeleteAllByChar(charId);
                    clearOldIllustrations();
                    await renderSettings();
                    debouncedScan();
                }
            );
        };
    }

    // ==================== 导出：流式分块序列化与进度监控 ====================
    document.getElementById('ci-export-btn').onclick = async () => {
        if (items.length === 0) return alert('当前角色暂无可导出的配置！');
        
        const progress = createProgressModal('📦 正在导出插图配置');
        const total = items.length;
        const exportedList = [];

        for (let i = 0; i < total; i++) {
            const item = items[i];
            const imgs = item.images || (item.data ? [item.data] : []);
            
            const serializedImgs = [];
            for (const img of imgs) {
                if (img instanceof Blob) {
                    serializedImgs.push(await blobToBase64(img));
                } else {
                    serializedImgs.push(img);
                }
            }

            exportedList.push({
                rules: item.rules,
                images: serializedImgs,
                imageNames: item.imageNames || [],
                selectedIndex: typeof item.selectedIndex === 'number' ? item.selectedIndex : 0,
                order: item.order
            });

            progress.update(i + 1, total, `[1/2] 正在打包图像数据 (${i + 1}/${total})`);
            await new Promise(r => setTimeout(r, 0));
        }

        progress.update(0, total, `[2/2] ⚡ 正在压缩序列化 JSON (0/${total})`);
        await new Promise(r => setTimeout(r, 30));

        const jsonChunks = [
            '{\n  "version": "3.0",\n  "charName": ' + JSON.stringify(charName) + ',\n  "charId": ' + JSON.stringify(charId) + ',\n  "illustrations": [\n'
        ];

        for (let i = 0; i < total; i++) {
            const itemString = JSON.stringify(exportedList[i]);
            jsonChunks.push(i < total - 1 ? itemString + ',\n' : itemString + '\n');

            progress.update(i + 1, total, `[2/2] ⚡ 正在压缩序列化 JSON (${i + 1}/${total})`);

            if (i % 2 === 0 || i === total - 1) {
                await new Promise(r => setTimeout(r, 0));
            }
        }
        jsonChunks.push('  ]\n}');

        progress.update(total, total, '💾 正在调起下载保存...');
        await new Promise(r => setTimeout(r, 50));

        const blob = new Blob(jsonChunks, { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${charName}_插图配置.json`;
        a.click();
        URL.revokeObjectURL(url);

        progress.update(total, total, '🎉 导出文件下载已触发！');
        progress.close(500);
    };

    // ==================== 导入：流式块解析（无视文件大小，绝不崩溃） ====================
    const importInput = document.getElementById('ci-import-input');
    document.getElementById('ci-import-btn').onclick = () => importInput.click();
    importInput.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const progress = createProgressModal('📥 正在导入插图配置');
        let importedCount = 0;

        try {
            progress.update(0, 100, '正在清理当前角色旧插图配置...');
            await dbDeleteAllByChar(charId);
            clearOldIllustrations();

            importedCount = await streamParseAndImportJson(file, charId, (loaded, total, statusText) => {
                progress.update(loaded, total, statusText);
            });

            if (importedCount === 0) {
                throw new Error('未在文件中检测到有效的插图条目，请检查 JSON 结构。');
            }

            progress.update(100, 100, '正在重构界面显示...');
            await renderSettings();
            debouncedScan();

            progress.update(100, 100, '🎉 导入已全部完成！');
            progress.close(500);
            toastr?.success?.(`成功导入 ${importedCount} 项插图规则！`, '插图插件');
        } catch (err) {
            progress.close(0);
            console.error('[插图插件] 导入严重错误:', err);
            showDetailedErrorReportModal({
                message: err.message,
                fileName: file.name,
                fileSize: formatBytes(file.size),
                importedCount: importedCount,
                stack: err.stack
            });
        } finally {
            importInput.value = '';
        }
    };
}

// ==================== 8. 消息检测与情景渲染 ====================
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
    if (!rawMessageContent || !rawMessageContent.trim()) {
        return;
    }

    let listToDisplay = [];

    if (apiSettings.enabled && apiSettings.url && apiSettings.model) {
        const arbitratedIds = await arbitrateScenario(rawMessageContent, items);
        if (Array.isArray(arbitratedIds)) {
            listToDisplay = items.filter(item => arbitratedIds.includes(item.id));
        } else {
            return;
        }
    } else {
        const lowerContent = rawMessageContent.toLowerCase();
        const matched = items.filter(item => {
            if (item.rules && Array.isArray(item.rules) && item.rules.length > 0) {
                return item.rules.some(group => 
                    group.length > 0 && group.every(kw => lowerContent.includes(kw.toLowerCase()))
                );
            }
            if (item.keywords && Array.isArray(item.keywords)) {
                return item.keywords.some(kw => lowerContent.includes(kw.toLowerCase()));
            }
            return false;
        });

        if (matched.length === 0) {
            clearOldIllustrations();
            return;
        }
        listToDisplay = showAllMatched ? matched : [matched[Math.floor(Math.random() * matched.length)]];
    }

    if (listToDisplay.length === 0) {
        clearOldIllustrations();
        return;
    }

    clearOldIllustrations();

    const container = document.createElement('div');

    if (displayPosition === 'top_fixed') {
        container.id = 'ci-top-fixed-container';
        container.className = 'ci-top-fixed-container';
    } else {
        container.className = 'char-illustration-container';
    }

    for (const item of listToDisplay) {
        const imgs = item.images || (item.data ? [item.data] : []);
        if (imgs.length === 0) continue;

        if (singleImageMode) {
            let selectedIdx = typeof item.selectedIndex === 'number' ? item.selectedIndex : 0;
            if (selectedIdx < 0 || selectedIdx >= imgs.length) selectedIdx = 0;

            const originalSource = imgs[selectedIdx];
            const displayUrl = toDisplayUrl(originalSource);

            const card = document.createElement('div');
            card.className = displayPosition === 'top_fixed' ? 'ci-top-fixed-card' : 'char-illustration-card';

            const img = document.createElement('img');
            img.className = displayPosition === 'top_fixed' ? 'ci-top-fixed-img' : 'char-illustration-img';
            img.src = displayUrl;
            img.loading = 'lazy';
            img.decoding = 'async';
            img.title = `点击放大查看\n触发规则: ${formatRuleDisplay(item)}`;
            img.onclick = () => window.openCIModal(displayUrl);

            const removeBtn = document.createElement('div');
            removeBtn.className = 'char-illustration-remove-btn';
            removeBtn.innerHTML = '×';
            removeBtn.title = '关闭展示此插图';
            removeBtn.onclick = (e) => {
                e.stopPropagation();
                img.src = '';
                card.remove();
                if (container.children.length === 0) {
                    container.remove();
                }
            };

            card.appendChild(img);
            card.appendChild(removeBtn);

            if (imgs.length > 1) {
                const switchWrap = document.createElement('div');
                switchWrap.className = 'ci-switch-btn-container';

                const switchBtn = document.createElement('button');
                switchBtn.className = 'ci-switch-btn';
                switchBtn.innerHTML = `<span>⇄ 更换插图</span>`;
                switchBtn.title = '点击自选并锁定此规则展示的其他插图';

                switchBtn.onclick = (e) => {
                    e.stopPropagation();
                    requestAnimationFrame(() => {
                        openImagePickerModal(item, (chosenIdx) => {
                            item.selectedIndex = chosenIdx;
                            const newSource = imgs[chosenIdx];
                            const newUrl = toDisplayUrl(newSource);

                            img.src = newUrl;
                            img.onclick = () => window.openCIModal(newUrl);
                            
                            setTimeout(() => {
                                dbSetIllustrationSelectedIndex(item.id, chosenIdx);
                            }, 10);
                        });
                    });
                };

                switchWrap.appendChild(switchBtn);
                card.appendChild(switchWrap);
            }

            container.appendChild(card);

        } else {
            for (const originalSource of imgs) {
                const displayUrl = toDisplayUrl(originalSource);

                const card = document.createElement('div');
                card.className = displayPosition === 'top_fixed' ? 'ci-top-fixed-card' : 'char-illustration-card';

                const img = document.createElement('img');
                img.className = displayPosition === 'top_fixed' ? 'ci-top-fixed-img' : 'char-illustration-img';
                img.src = displayUrl;
                img.loading = 'lazy';
                img.decoding = 'async';
                img.title = `点击放大查看\n触发规则: ${formatRuleDisplay(item)}`;
                img.onclick = () => window.openCIModal(displayUrl);

                const removeBtn = document.createElement('div');
                removeBtn.className = 'char-illustration-remove-btn';
                removeBtn.innerHTML = '×';
                removeBtn.title = '关闭展示此插图';
                removeBtn.onclick = (e) => {
                    e.stopPropagation();
                    img.src = '';
                    card.remove();
                    if (container.children.length === 0) {
                        container.remove();
                    }
                };

                card.appendChild(img);
                card.appendChild(removeBtn);
                container.appendChild(card);
            }
        }
    }

    if (displayPosition === 'top_fixed') {
        const host = document.getElementById('sheld') || document.getElementById('chat') || document.body;
        host.appendChild(container);
    } else {
        textEl.appendChild(container);
    }
}

function scanLatestMessageOnly() {
    const messages = document.querySelectorAll('#chat .mes');
    if (!messages.length) return;
    const latestMes = messages[messages.length - 1];
    checkAndRenderMessage(latestMes);
}

const debouncedScan = debounce(scanLatestMessageOnly, 200);

// ==================== 9. 生命周期绑定 ====================
jQuery(async () => {
    initImageViewer();

    allowUserTrigger = localStorage.getItem('ci_allow_user_msg') === '1';
    showAllMatched = localStorage.getItem('ci_show_all_matched') !== '0';
    singleImageMode = localStorage.getItem('ci_single_image_mode') !== '0';
    displayPosition = localStorage.getItem('ci_display_position') || 'bottom';

    const drawerHtml = `
        <div id="char-illustrations-drawer" class="extension_settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>角色插图管理 (Character Illustrations)</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content" id="ci-settings-content"></div>
            </div>
        </div>
    `;
    $('#extensions_settings').append(drawerHtml);

    await initDB();

    eventSource.on(event_types.CHARACTER_PAGE_LOADED, () => {
        invalidateCache();
        clearOldIllustrations();
        renderSettings();
        debouncedScan();
    });
    
    eventSource.on(event_types.CHAT_CHANGED, () => {
        invalidateCache();
        clearOldIllustrations();
        renderSettings();
        debouncedScan();
    });

    eventSource.on(event_types.MESSAGE_RECEIVED, debouncedScan);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, debouncedScan);

    if (event_types.GENERATION_ENDED) {
        eventSource.on(event_types.GENERATION_ENDED, debouncedScan);
    }

    renderSettings();
    debouncedScan();
});