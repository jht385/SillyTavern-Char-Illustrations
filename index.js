import { getContext } from '../../../extensions.js';
import { eventSource, event_types } from '../../../../script.js';

// ==================== 0. 全屏图片灯箱 ====================
let viewerState = {
    scale: 1,
    translateX: 0,
    translateY: 0,
    isDragging: false,
    startX: 0,
    startY: 0
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
        <div class="ci-lightbox-hint">滚轮缩放 · 拖拽移动 · 双击复位 · 单击背景关闭</div>
    `;
    document.body.appendChild(modal);

    const img = document.getElementById('ci-lightbox-img');
    const content = modal.querySelector('.ci-lightbox-content');
    const backdrop = modal.querySelector('.ci-lightbox-backdrop');
    const closeBtn = modal.querySelector('.ci-lightbox-close');

    function updateTransform() {
        img.style.transform = `translate(${viewerState.translateX}px, ${viewerState.translateY}px) scale(${viewerState.scale})`;
    }

    function resetTransform() {
        viewerState.scale = 1;
        viewerState.translateX = 0;
        viewerState.translateY = 0;
        updateTransform();
    }

    window.openCIModal = function(src) {
        img.src = src;
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
        updateTransform();
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
        updateTransform();
    });

    window.addEventListener('mouseup', () => {
        if (viewerState.isDragging) {
            viewerState.isDragging = false;
            content.style.cursor = 'grab';
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

// ==================== 1. IndexedDB 存储引擎 ====================
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

async function dbAddIllustration(charId, rules, imageData) {
    const db = await initDB();
    const existing = await dbGetIllustrations(charId);
    const nextOrder = existing.length > 0 ? Math.max(...existing.map(i => i.order || 0)) + 1 : 1;

    return new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_NAME], 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const item = {
            charId,
            rules: rules,
            data: imageData,
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

async function dbUpdateIllustration(id, rules, order = null) {
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

// ==================== 2. 状态获取 & API 核心请求 ====================
let tempBase64 = null;
let allowUserTrigger = localStorage.getItem('ci_allow_user_msg') === '1';
let showAllMatched = localStorage.getItem('ci_show_all_matched') !== '0';

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
        console.error('[插图插件] API 仲裁请求异常:', e);
        toastr?.error?.(`插图AI判定请求失败: ${e.message}`, '插图插件');
    }
    return null;
}

function getCurrentCharId() {
    const context = getContext();
    if (context.characterId !== undefined && context.characters && context.characters[context.characterId]) {
        const char = context.characters[context.characterId];
        return char.avatar || char.name || context.characterId.toString();
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
    const containers = document.querySelectorAll('.char-illustration-container');
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
        if (context && context.chat && context.chat.length > 0) {
            const allMes = Array.from(document.querySelectorAll('#chat .mes'));
            const idx = allMes.indexOf(messageEl);
            if (idx !== -1 && context.chat[idx]) {
                return context.chat[idx].mes || '';
            }
            return context.chat[context.chat.length - 1].mes || '';
        }
    } catch (err) {
        console.warn('[插图插件] 读取底层原始文本异常，降级使用 innerHTML/textContent', err);
    }
    return messageEl.innerHTML ? messageEl.innerHTML.replace(/<[^>]+>/g, ' ') : (messageEl.textContent || '');
}

// ==================== 3. 渲染配置面板 ====================
async function renderSettings() {
    const container = document.getElementById('ci-settings-content');
    if (!container) return;

    const charId = getCurrentCharId();
    const charName = getCurrentCharDisplayName();

    if (!charId) {
        container.innerHTML = `<div style="opacity:0.7; font-size:0.9em; padding:10px;">请先打开一个角色卡对话。</div>`;
        return;
    }

    const items = await dbGetIllustrations(charId);

    // 仅在确认点击搜索后，才根据 searchFilterKeyword 过滤列表
    const filteredItems = items.filter(item => {
        if (!searchFilterKeyword.trim()) return true;
        const text = formatRuleDisplay(item).toLowerCase();
        return text.includes(searchFilterKeyword.trim().toLowerCase());
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
                <b>为角色 [${charName}] 添加插图</b>
                <input id="ci-kw-input" class="text_pole" type="text" placeholder="如: 微笑 + 校园, 礼服" />
                
                <div class="ci-rule-hint">
                    💡 <b>语法说明：</b>使用 <code>,</code> (逗号) 分隔多个备选条件；使用 <code>+</code> (加号) 表示必须同时出现才会触发。例如：<code>微笑 + 校园, 战斗</code>。
                </div>
                
                <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                    <button id="ci-choose-file-btn" class="menu_button">选择本地插图</button>
                    <button id="ci-save-btn" class="menu_button" style="background:#2a9d8f;">保存插图</button>
                    <input id="ci-file-input" type="file" accept="image/*" style="display: none;" />
                </div>
                
                <div id="ci-preview" class="ci-preview-container" style="display: none;">
                    <img id="ci-preview-img" src="" alt="预览" />
                </div>

                <div style="display:flex; flex-direction:column; gap:6px; font-size:0.85em; margin-top:4px;">
                    <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
                        <input type="checkbox" id="ci-show-all-chk" ${showAllMatched ? 'checked' : ''} />
                        <span>多个插图同时触发时全部显示 (未开启 AI 时生效；取消则随机选1张)</span>
                    </label>
                    <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
                        <input type="checkbox" id="ci-allow-user-chk" ${allowUserTrigger ? 'checked' : ''} />
                        <span>包含检测用户发出的消息</span>
                    </label>
                </div>
            </div>

            <div class="ci-list-header">
                <b>已配置插图 (${items.length})</b>
                <div class="ci-header-actions">
                    <button id="ci-save-all-btn" class="menu_button ci-mini-btn ci-btn-accent" title="一键保存全部修改">一键保存</button>
                    <button id="ci-delete-all-btn" class="menu_button ci-mini-btn ci-btn-danger" title="一键清空全部插图">一键删除</button>
                    <button id="ci-export-btn" class="menu_button ci-mini-btn" title="导出配置">导出</button>
                    <button id="ci-import-btn" class="menu_button ci-mini-btn" title="导入配置">导入</button>
                    <input id="ci-import-input" type="file" accept=".json" style="display:none;" />
                </div>
            </div>

            <!-- 手动点击触发搜索栏 -->
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
                ${filteredItems.map((item, index) => `
                    <div class="ci-card" data-id="${item.id}">
                        <div class="ci-thumb-box">
                            <img class="ci-thumb" src="${item.data}" title="点击放大预览" onclick="window.openCIModal('${item.data}')" />
                            <div class="ci-order-controls">
                                <button class="ci-order-btn ci-order-up" data-id="${item.id}" title="上移" ${index === 0 ? 'disabled style="opacity:0.3;cursor:not-allowed;"' : ''}>▲</button>
                                <button class="ci-order-btn ci-order-down" data-id="${item.id}" title="下移" ${index === filteredItems.length - 1 ? 'disabled style="opacity:0.3;cursor:not-allowed;"' : ''}>▼</button>
                            </div>
                        </div>
                        <div class="ci-card-info">
                            <span style="font-size:0.8em; opacity:0.8;">[插图ID: ${item.id}] 触发规则:</span>
                            <input class="text_pole ci-edit-input" data-id="${item.id}" type="text" value="${formatRuleDisplay(item)}" placeholder="如: 少女A + 女仆装" />
                            <div class="ci-card-actions">
                                <button class="ci-save-edit-btn" data-id="${item.id}">保存修改</button>
                                <button class="ci-del-btn" data-id="${item.id}">删除</button>
                            </div>
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>

        <!-- 一键删除二次确认模态弹窗 -->
        <div id="ci-confirm-modal" class="ci-confirm-modal" style="display:none;">
            <div class="ci-confirm-content">
                <h3>⚠️ 危险操作确认</h3>
                <p>您确定要<b>一键清空并删除</b>角色【${charName}】的所有插图数据吗？此操作无法撤销！</p>
                <div class="ci-confirm-actions">
                    <button id="ci-confirm-cancel-btn" class="menu_button">取消</button>
                    <button id="ci-confirm-delete-btn" class="menu_button ci-btn-danger">确认清空全部</button>
                </div>
            </div>
        </div>
    `;

    // 绑定基础设置事件
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
            showStatus(`🟢 <b>连接成功！</b>共成功读取 <b>${models.length}</b> 个模型。`);
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
    const previewContainer = document.getElementById('ci-preview');
    const previewImg = document.getElementById('ci-preview-img');
    const saveBtn = document.getElementById('ci-save-btn');
    const kwInput = document.getElementById('ci-kw-input');
    const allowUserChk = document.getElementById('ci-allow-user-chk');
    const showAllChk = document.getElementById('ci-show-all-chk');

    showAllChk.onchange = (e) => {
        showAllMatched = e.target.checked;
        localStorage.setItem('ci_show_all_matched', showAllMatched ? '1' : '0');
        scanLatestMessageOnly();
    };

    allowUserChk.onchange = (e) => {
        allowUserTrigger = e.target.checked;
        localStorage.setItem('ci_allow_user_msg', allowUserTrigger ? '1' : '0');
        scanLatestMessageOnly();
    };

    chooseBtn.onclick = () => fileInput.click();

    fileInput.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            tempBase64 = ev.target.result;
            previewImg.src = tempBase64;
            previewContainer.style.display = 'flex';
        };
        reader.readAsDataURL(file);
    };

    saveBtn.onclick = async () => {
        const kwRaw = kwInput.value.trim();
        if (!kwRaw) return alert('请至少输入一个关键词规则！');
        if (!tempBase64) return alert('请先选择一张图片！');

        const rules = parseRuleInput(kwRaw);
        if (!rules.length) return alert('规则解析为空，请重新输入！');

        await dbAddIllustration(charId, rules, tempBase64);
        tempBase64 = null;
        fileInput.value = '';
        renderSettings();
        scanLatestMessageOnly();
    };

    // 关键词搜索栏事件：手动点击搜索或按回车
    const searchInput = document.getElementById('ci-search-kw-input');
    const searchExecBtn = document.getElementById('ci-search-exec-btn');
    const searchClearBtn = document.getElementById('ci-search-clear-btn');
    const searchResetBtn = document.getElementById('ci-search-reset-btn');

    if (searchInput) {
        searchInput.oninput = (e) => {
            searchInputValue = e.target.value;
        };
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
            if (searchFilterKeyword) {
                searchFilterKeyword = '';
                renderSettings();
            } else {
                renderSettings();
            }
        };
    }

    if (searchResetBtn) {
        searchResetBtn.onclick = () => {
            searchInputValue = '';
            searchFilterKeyword = '';
            renderSettings();
        };
    }

    // 单个保存
    container.querySelectorAll('.ci-save-edit-btn').forEach(btn => {
        btn.onclick = async () => {
            const id = parseInt(btn.dataset.id, 10);
            const inputEl = container.querySelector(`.ci-edit-input[data-id="${id}"]`);
            if (!inputEl) return;
            const newVal = inputEl.value.trim();
            if (!newVal) return alert('规则不能为空！');
            await dbUpdateIllustration(id, parseRuleInput(newVal));
            btn.innerText = '已保存 ✓';
            setTimeout(() => { btn.innerText = '保存修改'; }, 1200);
            scanLatestMessageOnly();
        };
    });

    // 一键保存全部修改
    const saveAllBtn = document.getElementById('ci-save-all-btn');
    if (saveAllBtn) {
        saveAllBtn.onclick = async () => {
            const inputs = container.querySelectorAll('.ci-edit-input');
            if (!inputs.length) return alert('当前无插图需要保存！');
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
                scanLatestMessageOnly();
            }
        };
    }

    // 上移 / 下移 排序
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

    // 单个删除
    container.querySelectorAll('.ci-del-btn').forEach(btn => {
        btn.onclick = async () => {
            const id = parseInt(btn.dataset.id, 10);
            if (confirm('确认删除这张插图吗？')) {
                await dbDeleteIllustration(id);
                renderSettings();
                scanLatestMessageOnly();
            }
        };
    });

    // 一键删除与二次确认弹窗
    const deleteAllBtn = document.getElementById('ci-delete-all-btn');
    const confirmModal = document.getElementById('ci-confirm-modal');
    const confirmCancelBtn = document.getElementById('ci-confirm-cancel-btn');
    const confirmDeleteBtn = document.getElementById('ci-confirm-delete-btn');

    if (deleteAllBtn && confirmModal) {
        deleteAllBtn.onclick = () => {
            if (items.length === 0) return alert('当前没有可删除的插图！');
            confirmModal.style.display = 'flex';
        };

        confirmCancelBtn.onclick = () => {
            confirmModal.style.display = 'none';
        };

        confirmDeleteBtn.onclick = async () => {
            confirmModal.style.display = 'none';
            await dbDeleteAllByChar(charId);
            clearOldIllustrations();
            renderSettings();
        };
    }

    // 导出配置
    document.getElementById('ci-export-btn').onclick = async () => {
        if (items.length === 0) return alert('当前角色暂无可导出的配置！');
        const exportData = {
            version: '2.6',
            charName,
            charId,
            illustrations: items.map(item => ({ rules: item.rules, data: item.data, order: item.order }))
        };
        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${charName}_插图配置.json`;
        a.click();
        URL.revokeObjectURL(url);
    };

    // 导入配置
    const importInput = document.getElementById('ci-import-input');
    document.getElementById('ci-import-btn').onclick = () => importInput.click();
    importInput.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
            const text = await file.text();
            const json = JSON.parse(text);
            if (!json.illustrations || !Array.isArray(json.illustrations)) throw new Error('格式不正确');
            for (const item of json.illustrations) {
                if (item.data && item.rules) await dbAddIllustration(charId, item.rules, item.data);
            }
            renderSettings();
            scanLatestMessageOnly();
        } catch (err) {
            alert('导入失败: ' + err.message);
        } finally {
            importInput.value = '';
        }
    };
}

// ==================== 4. 消息检测与情景过滤 ====================
async function checkAndRenderMessage(messageEl) {
    if (!messageEl) return;

    const charId = getCurrentCharId();
    if (!charId) return;

    const isUser = messageEl.getAttribute('is_user') === 'true';
    if (isUser && !allowUserTrigger) return;

    const textEl = messageEl.querySelector('.mes_text');
    if (!textEl) return;
    if (textEl.querySelector('.char-illustration-container')) return;

    const items = await dbGetIllustrations(charId);
    if (!items.length) return;

    const rawMessageContent = getRawMessageContent(messageEl);

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
            if (item.rules && Array.isArray(item.rules)) {
                return item.rules.some(group => group.every(kw => lowerContent.includes(kw.toLowerCase())));
            }
            if (item.keywords && Array.isArray(item.keywords)) {
                return item.keywords.some(kw => lowerContent.includes(kw.toLowerCase()));
            }
            return false;
        });
        if (matched.length === 0) return;
        listToDisplay = showAllMatched ? matched : [matched[Math.floor(Math.random() * matched.length)]];
    }

    if (listToDisplay.length === 0) return;

    clearOldIllustrations();

    const container = document.createElement('div');
    container.className = 'char-illustration-container';

    listToDisplay.forEach(item => {
        const card = document.createElement('div');
        card.className = 'char-illustration-card';

        const img = document.createElement('img');
        img.className = 'char-illustration-img';
        img.src = item.data;
        img.title = `点击放大查看\n触发规则: ${formatRuleDisplay(item)}`;
        
        img.onclick = () => window.openCIModal(item.data);

        const removeBtn = document.createElement('div');
        removeBtn.className = 'char-illustration-remove-btn';
        removeBtn.innerHTML = '×';
        removeBtn.title = '从当前回复中删除此插图';
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
    });

    textEl.appendChild(container);
}

function scanLatestMessageOnly() {
    const messages = document.querySelectorAll('#chat .mes');
    if (!messages.length) return;
    const latestMes = messages[messages.length - 1];
    checkAndRenderMessage(latestMes);
}

// ==================== 5. 生命周期绑定 ====================
jQuery(async () => {
    initImageViewer();

    allowUserTrigger = localStorage.getItem('ci_allow_user_msg') === '1';
    showAllMatched = localStorage.getItem('ci_show_all_matched') !== '0';

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
        setTimeout(scanLatestMessageOnly, 300);
    });
    
    eventSource.on(event_types.CHAT_CHANGED, () => {
        invalidateCache();
        clearOldIllustrations();
        renderSettings();
        setTimeout(scanLatestMessageOnly, 300);
    });

    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        setTimeout(scanLatestMessageOnly, 100);
    });
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => {
        setTimeout(scanLatestMessageOnly, 100);
    });

    renderSettings();
    setTimeout(scanLatestMessageOnly, 500);
});