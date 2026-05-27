console.log('Content Script - Unified Native Click Edition (i18n & Domain Locked)');

const TARGET_HOST_RE = /(^|\.)nhentai\.(?:net|xxx)$/i;

if (!TARGET_HOST_RE.test(window.location.hostname)) {
    throw new Error('Q-Downloader: Unsupported host. The extension is idle.');
}

const POSSIBLE_ITEM_SELECTORS = ['.gallery', '.gallery-item', '.book-item', '.cover', '.item', '.container > div'];
const PREFERRED_ITEM_SELECTORS = ['.gallery', '.gallery-item', '.book-item', 'article', 'li', '.card', '.gallery-container', '.index-container', '.item'];
function findActiveSelector(selectors) { for (let s of selectors) { if (document.querySelector(s)) return s; } return null; }

const I18N = {
    en: {
        title: "Download Center", clear: "Clear", empty: "No tasks currently", cooldown: "Rate limit cooldown...",
        setRule: "1. File Naming Rule", rule1: "Translated Title (Default)", rule2: "Original Title Only",
        setDir: "2. Base Directory (Subfolder)", dirPlaceholder: "Leave blank for default Downloads", dirTip: "e.g., nHentai/Manga",
        save: "Save Settings", saveSuccess: "Saved OK",
        statusPrep: "Ready to execute...", statusDown: "Downloading file...", btnDown: "Download", btnDone: "Done"
    }
};

let currentLang = 'en';
let isWidgetOpen = false; 
let widgetPos = { left: '30px', top: 'auto', bottom: '30px', xRatio: null, yRatio: null }; 
let qCooldownTimer = null; 
let queuedUrls = new Set();
let historyUrls = new Set();
let activeJob = { taskId: "", site: "" };
const triggeredDownloadJobs = new Map();
let activeDownloadHunt = null;
const DOWNLOAD_RECLICK_DELAY_MS = 5000;
const DOWNLOAD_RECLICK_MAX_RETRIES = 3;

function normalizeGalleryUrl(rawUrl) {
    try {
        const url = new URL(rawUrl, location.href);
        if (!TARGET_HOST_RE.test(url.hostname)) return null;
        const galleryId = url.pathname.match(/^\/g\/(\d+)(?:\/|$)/)?.[1];
        if (!galleryId) return null;
        url.pathname = `/g/${galleryId}/`;
        url.hash = "";
        url.search = "";
        return url.href;
    } catch (e) {
        return null;
    }
}

function isXxxHost() {
    return /(^|\.)nhentai\.xxx$/i.test(window.location.hostname);
}

function siteFromUrl(rawUrl) {
    try {
        return /(^|\.)nhentai\.xxx$/i.test(new URL(rawUrl, location.href).hostname) ? "xxx" : "net";
    } catch (e) {
        return "net";
    }
}

function currentPageSite() {
    return siteFromUrl(location.href);
}

function galleryIdFromUrl(rawUrl) {
    try {
        return new URL(rawUrl, location.href).pathname.match(/\/g\/(\d+)\/?/i)?.[1] || "";
    } catch (e) {
        return "";
    }
}

function refreshQueueButtonsFromState() {
    document.querySelectorAll('.q-dl-btn').forEach(button => {
        const buttonUrl = normalizeGalleryUrl(button.dataset.url) || button.dataset.url;
        updateQueueButton(button, buttonUrl);
    });
    try {
        addQueueButtonsToList();
    } catch (error) {
        console.warn('Q-Downloader button refresh failed', error);
    }
}

function siteLabel(site) {
    return site === "xxx" ? "nhentai.xxx" : "nhentai.net";
}

function withActiveJob(payload = {}) {
    return { ...payload, taskId: activeJob.taskId || "", site: activeJob.site || siteFromUrl(location.href) };
}

function cleanupTriggeredDownloadJobs(now = Date.now()) {
    for (const [taskId, timestamp] of triggeredDownloadJobs) {
        if (now - timestamp > 120000) triggeredDownloadJobs.delete(taskId);
    }
}

function markDownloadTriggered(taskId) {
    const id = String(taskId || "");
    if (!id) return false;
    const now = Date.now();
    cleanupTriggeredDownloadJobs(now);
    if (triggeredDownloadJobs.has(id)) return false;
    triggeredDownloadJobs.set(id, now);
    return true;
}

function getQueueTask(taskId) {
    return new Promise((resolve) => {
        const id = String(taskId || "");
        if (!id) {
            resolve(null);
            return;
        }
        chrome.storage.local.get({ queue: [] }, (data) => {
            if (chrome.runtime.lastError) {
                resolve(null);
                return;
            }
            resolve((data.queue || []).find(task => task.id === id) || null);
        });
    });
}

async function hasDownloadStartedForTask(taskId) {
    const task = await getQueueTask(taskId);
    if (!task) return true;
    return Boolean(task.downloadId);
}

function emptySiteCooldowns() {
    return {
        net: { until: 0, total: 0 },
        xxx: { until: 0, total: 0 },
    };
}

function normalizeSiteCooldowns(data = {}) {
    const cooldowns = emptySiteCooldowns();
    const raw = data.siteCooldowns || {};
    ["net", "xxx"].forEach((site) => {
        cooldowns[site] = {
            until: Number(raw[site]?.until) || 0,
            total: Number(raw[site]?.total) || 0,
        };
    });
    if (data.globalCooldownUntil && data.globalCooldownUntil > Date.now()) {
        cooldowns.net = {
            until: Number(data.globalCooldownUntil) || 0,
            total: Number(data.cooldownTotal) || 60000,
        };
    }
    return cooldowns;
}

function cooldownText(site, secondsLeft) {
    return `${siteLabel(site)} cooldown ${secondsLeft.toFixed(1)}s`;
}

function queueCooldownText(site) {
    return `${siteLabel(site)} cooldown`;
}

function uniqueText(items) {
    return [...new Set(items.map(item => String(item || "").trim()).filter(Boolean))];
}

function cleanTagText(text) {
    return String(text || "").replace(/\s+\d+(?:\.\d+)?[KMB]?$/i, "").trim();
}

function firstNumberFromText(text) {
    const match = String(text || "").replace(/,/g, "").match(/\d+/);
    return match ? Number(match[0]) : 0;
}

function collectPageCount(fields, firstValueFromField) {
    const direct = firstNumberFromText(document.querySelector('.tag_name.pages, .name.pages, .pages')?.textContent);
    if (direct) return direct;

    const fromField = firstNumberFromText(firstValueFromField("Pages"));
    if (fromField) return fromField;

    const labelField = fields.find(el => /(?:^|\s)pages\s*:/i.test(el.textContent || ""));
    const fromLabelField = firstNumberFromText(labelField?.textContent);
    if (fromLabelField) return fromLabelField;

    return document.querySelectorAll('#thumbnail-container .gallerythumb, .thumb-container, a[href*="/g/"][href*="/"]').length || null;
}

function namesForPath(path) {
    return uniqueText(Array.from(document.querySelectorAll(`a[href^="/${path}/"], a[href*="/${path}/"]`)).map(link => {
        return cleanTagText(link.querySelector('.tag_name, .name')?.textContent || link.textContent);
    }));
}

function collectGalleryMeta() {
    const fields = Array.from(document.querySelectorAll('#tags .tag-container, .tag-container'));
    const valuesFromField = (label) => {
        const field = fields.find(el => (el.textContent || "").trim().toLowerCase().startsWith(`${label.toLowerCase()}:`));
        if (!field) return [];
        const names = Array.from(field.querySelectorAll('.tag_name, .name')).map(e => cleanTagText(e.textContent));
        if (names.length) return uniqueText(names);
        return uniqueText([cleanTagText((field.textContent || "").replace(new RegExp(`^${label}:`, "i"), ""))]);
    };
    const firstValueFromField = (label) => valuesFromField(label)[0] || "";
    const uploadedField = fields.find(el => (el.textContent || "").trim().toLowerCase().startsWith("uploaded:"));
    const coverUrl = document.querySelector('#cover img')?.getAttribute('data-src') || document.querySelector('#cover img')?.src || document.querySelector('img')?.src || "";
    const mediaId = String(coverUrl || "").match(/\/galleries\/(\d+)\//i)?.[1] || "";
    return {
        titleTrans: document.querySelector('#info h1')?.textContent?.trim() || document.querySelector('h1')?.textContent?.trim() || "",
        titleOrig: document.querySelector('#info h2')?.textContent?.trim() || document.querySelector('h2')?.textContent?.trim() || "",
        groups: namesForPath("group"),
        artists: namesForPath("artist"),
        tags: namesForPath("tag"),
        languages: namesForPath("language"),
        categories: namesForPath("category"),
        parodies: namesForPath("parody"),
        characters: namesForPath("character"),
        pages: collectPageCount(fields, firstValueFromField),
        uploadDate: uploadedField?.querySelector("time")?.getAttribute("datetime") || uploadedField?.querySelector("time")?.textContent?.trim() || firstValueFromField("Uploaded"),
        mediaId,
        coverUrl
    };
}

function sendRuntimeMessageWithTimeout(message, timeoutMs = 1500) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };
        try {
            chrome.runtime.sendMessage(message, (response) => {
                finish(chrome.runtime.lastError ? null : response);
            });
        } catch (error) {
            finish(null);
        }
        setTimeout(() => finish(null), timeoutMs);
    });
}

function clickDownloadTarget(target) {
    if (!target) return false;
    if (!document.contains(target)) target = findDirectDownloadButton();
    if (!target) return false;
    try {
        target.scrollIntoView({ block: "center", inline: "center" });
    } catch (error) {}
    try {
        target.focus({ preventScroll: true });
    } catch (error) {}
    if (target.tagName && target.tagName.toLowerCase() === 'a' && !target.hasAttribute('download')) {
        target.setAttribute('download', '');
    }
    try {
        target.click();
        return true;
    } catch (error) {
        return false;
    }
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function retryClickUntilDownloadStarts(taskId) {
    for (let retry = 1; retry <= DOWNLOAD_RECLICK_MAX_RETRIES; retry++) {
        await delay(DOWNLOAD_RECLICK_DELAY_MS);
        if (await hasDownloadStartedForTask(taskId)) return true;
        const nextTarget = findDirectDownloadButton();
        if (!nextTarget) return false;
        sendRuntimeMessageWithTimeout(withActiveJob({ action: 'STATUS_UPDATE', text: `Triggering download... retry ${retry}` }), 1000);
        clickDownloadTarget(nextTarget);
    }
    return hasDownloadStartedForTask(taskId);
}

// Use the simulated click flow and avoid extra API calls.
function sendMetaThenClickLegacy(target) {
    const taskId = activeJob.taskId;
    if (!markDownloadTriggered(taskId)) return false;
    const meta = collectGalleryMeta();
    chrome.runtime.sendMessage(withActiveJob({ action: 'SET_META', payload: meta }), () => {
        chrome.runtime.sendMessage(withActiveJob({ action: 'PREPARE_DOWNLOAD_CLICK' }), () => {
            chrome.runtime.sendMessage(withActiveJob({ action: 'STATUS_UPDATE', text: 'Triggering download...' }), () => {
                if (target && target.tagName && target.tagName.toLowerCase() === 'a') {
                    if (!target.hasAttribute('download')) {
                        target.setAttribute('download', '');
                    }
                }
                target.click();
            });
        });
    });
    return true;
}

async function sendMetaThenClickEnhanced(target) {
    const taskId = activeJob.taskId;
    if (!markDownloadTriggered(taskId)) return false;
    const meta = collectGalleryMeta();
    await sendRuntimeMessageWithTimeout(withActiveJob({ action: 'SET_META', payload: meta }), 2000);
    await sendRuntimeMessageWithTimeout(withActiveJob({ action: 'PREPARE_DOWNLOAD_CLICK' }), 2000);
    sendRuntimeMessageWithTimeout(withActiveJob({ action: 'STATUS_UPDATE', text: 'Triggering download...' }), 1000);
    const clicked = clickDownloadTarget(target);
    if (clicked) retryClickUntilDownloadStarts(taskId);
    return clicked;
}

function sendMetaThenClick(target) {
    return isXxxHost()
        ? sendMetaThenClickEnhanced(target)
        : sendMetaThenClickLegacy(target);
}

function findDirectDownloadButton() {
    const candidates = Array.from(document.querySelectorAll('a, button')).filter(el => {
        if (el.classList?.contains('q-dl-btn') || el.closest('#q-widget-container')) return false;
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
        const text = (el.textContent || "").trim().toLowerCase();
        const idClass = `${el.id || ""} ${el.className || ""}`.toLowerCase();
        const href = String(el.getAttribute?.('href') || "").toLowerCase();
        const looksLikeDownload = text.includes('download')
            || text.includes('\u4e0b\u8f7d')
            || /(^|[\s_-])dl($|[\s_-])/.test(idClass)
            || idClass.includes('download')
            || href.includes('download');
        if (!looksLikeDownload) return false;
        if (text.includes('favorite') || text.includes('report')) return false;
        if (el.className && String(el.className).includes('download-menu-item')) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    });
    return candidates.find(el => el.matches('#dl_lg, #download, .download, .btn-download'))
        || candidates.find(el => el.matches('a[href]'))
        || candidates[0]
        || null;
}

chrome.storage.local.get(['widgetPosition', 'widgetOpen', 'queue', 'history', 'qSettings'], (data) => {
    if (data.widgetPosition) widgetPos = data.widgetPosition;
    if (typeof data.widgetOpen === 'boolean') isWidgetOpen = data.widgetOpen;
    if (data.queue) data.queue.forEach(item => queuedUrls.add(normalizeGalleryUrl(item.url) || item.url));
    if (data.history) data.history.forEach(url => historyUrls.add(normalizeGalleryUrl(url) || url));
    currentLang = "en";
    syncWidgetVisibility();
});

const WIDGET_HTML = `
  <style>
    #q-widget-container { position: fixed; z-index: 2147483647; font-family: "Inter", "Segoe UI", sans-serif; pointer-events: none;}
    #q-widget-panel { position: absolute; pointer-events: auto; display: none; width: min(340px, calc(100vw - 24px)); max-height: min(480px, calc(100vh - 96px)); color: #f7edf2; background: linear-gradient(145deg, rgba(42, 14, 27, 0.82), rgba(92, 25, 50, 0.68)); border: 1px solid rgba(255,225,238,0.22); border-radius: 18px; box-shadow: 0 18px 42px rgba(19, 3, 12, 0.48), 0 0 20px rgba(171, 39, 91, 0.12), inset 0 1px 0 rgba(255,255,255,0.14); flex-direction: column; overflow: hidden; transition: opacity 0.2s ease-in-out; backdrop-filter: blur(18px) saturate(1.08); -webkit-backdrop-filter: blur(18px) saturate(1.08);}
    #q-widget-panel::before { content: ""; position: absolute; inset: 0; pointer-events: none; background: radial-gradient(circle at 16% 0%, rgba(255,255,255,0.16), transparent 32%), radial-gradient(circle at 86% 12%, rgba(190, 66, 113, 0.14), transparent 40%); }
    #q-widget-header { position: relative; background: linear-gradient(135deg, rgba(171, 37, 92, 0.72), rgba(93, 25, 51, 0.7)); color: white; padding: 13px 15px; display: flex; justify-content: space-between; align-items: center; gap: 12px; font-weight: 800; font-size: 14px; text-shadow: 0 1px 6px rgba(46,0,22,0.42); border-bottom: 1px solid rgba(255,225,238,0.18);}
    #q-widget-title-block { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
    #q-ui-title { display: block; white-space: nowrap; }
    #q-widget-task-count { display: block; color: rgba(255,245,250,0.68); font-size: 10px; font-weight: 750; line-height: 1.15; text-shadow: none; white-space: nowrap; }
    #q-widget-header > div { display: flex; align-items: center; gap: 8px; }
    #q-widget-settings-btn, #q-widget-resume, #q-widget-clear, #q-widget-patreon { width: 34px; height: 34px; display: inline-flex; align-items: center; justify-content: center; background: rgba(255,255,255,0.1) !important; border: 1px solid rgba(255,235,244,0.34) !important; color: #fff5f9 !important; cursor: pointer; padding: 0 !important; border-radius: 999px; font-size: 0; font-weight: 700; box-shadow: inset 0 1px 0 rgba(255,255,255,0.12), 0 5px 14px rgba(35,0,15,0.14); transition: background 0.2s, color 0.2s, transform 0.2s, box-shadow 0.2s; text-decoration: none;}
    #q-widget-settings-btn svg, #q-widget-resume svg, #q-widget-clear svg, #q-widget-patreon svg { width: 17px; height: 17px; stroke: currentColor; stroke-width: 2.2; fill: none; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; }
    #q-widget-patreon { background: rgba(255,66,77,0.9) !important; border-color: rgba(255,126,135,0.85) !important; }
    #q-widget-settings-btn:hover, #q-widget-resume:hover, #q-widget-clear:hover, #q-widget-patreon:hover { background: rgba(255,238,246,0.22) !important; color: white !important; transform: translateY(-1px); box-shadow: 0 7px 18px rgba(90, 14, 46, 0.22);}
    #q-widget-progress-container { display: none; position: relative; padding: 10px 12px; background: rgba(255, 231, 242, 0.08); border-bottom: 1px solid rgba(255,225,238,0.14); }
    #q-widget-progress-text { font-size: 12px; color: #f0c9d9; margin-bottom: 7px; font-weight: 800; text-align: center; white-space: pre-line; text-shadow: 0 1px 6px rgba(43,0,20,0.28); }
    #q-widget-progress-bg { height: 7px; background: rgba(255,235,244,0.14); border-radius: 999px; overflow: hidden; box-shadow: inset 0 1px 4px rgba(43,0,20,0.22); }
    #q-widget-progress-bar { height: 100%; background: linear-gradient(90deg, #d95d91, #ba2e6c, #e58aac); width: 100%; transition: width 0.05s linear; box-shadow: 0 0 10px rgba(205, 64, 121, 0.38); }
    #q-widget-tabs { position: relative; display:flex; gap:6px; padding:8px 10px; background: rgba(255,255,255,0.05); border-bottom: 1px solid rgba(255,225,238,0.12); }
    .q-widget-tab { flex:1; height:28px; border:1px solid rgba(255,235,244,0.18) !important; border-radius:8px !important; color:#f7edf2 !important; background:rgba(255,255,255,0.08) !important; cursor:pointer; font-size:12px; font-weight:800; }
    .q-widget-tab.active { background:rgba(207,107,150,0.42) !important; border-color:rgba(255,235,244,0.34) !important; }
    #q-widget-main-view { position: relative; background: rgba(255,255,255,0.05); }
    #q-widget-list { list-style: none; padding: 11px; margin: 0; overflow-y: auto; flex-grow: 1; max-height: 380px;}
    #q-widget-list li { margin-bottom: 8px; padding: 10px; background: rgba(255,238,246,0.1); border: 1px solid rgba(255,235,244,0.16); border-left: 4px solid rgba(255,235,244,0.22); border-radius: 10px; font-size: 12px; box-shadow: 0 8px 20px rgba(35,0,15,0.12), inset 0 1px 0 rgba(255,255,255,0.1); word-break: break-all; backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);}
    #q-widget-list li.processing { border-left-color: #cf6b96; background: rgba(182, 69, 115, 0.14);}
    #q-widget-list li.downloading { border-left-color: #e4a6bf; background: rgba(255, 238, 246, 0.13);}
    #q-widget-list li.cooldown { border-left-color: #bd4779; background: rgba(78, 12, 39, 0.2);}
    .q-item-title { font-weight: 800; color: #fff7fb; margin-bottom: 4px; text-shadow: 0 1px 6px rgba(43,0,20,0.3); }
    .q-item-status { color: rgba(247,237,242,0.68); font-size: 11px;}
    .q-fav-actions { display:none; }
    .q-fav-current-site { margin-bottom:10px; padding:11px; border:1px solid rgba(255,220,237,0.28); border-radius:10px; color:#fff7fb; background:linear-gradient(135deg, rgba(132,52,89,0.86), rgba(188,90,132,0.62)); box-shadow:inset 0 1px 0 rgba(255,255,255,0.16), 0 9px 22px rgba(57,0,26,0.14); }
    .q-fav-current-site.running { filter:brightness(1.08); }
    .q-fav-current-site.cooldown { filter:saturate(.82) brightness(.92); }
    .q-fav-current-site.problem { background:linear-gradient(135deg, rgba(126,39,55,0.94), rgba(188,70,91,0.72)); }
    .q-fav-current-main { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:10px; align-items:center; }
    .q-fav-current-title { color:#fff7fb; font-size:16px; font-weight:950; line-height:1.2; text-shadow:0 1px 7px rgba(43,0,20,0.3); }
    .q-fav-current-status { margin-top:4px; color:rgba(247,237,242,0.74); font-size:11px; line-height:1.35; }
    .q-fav-current-metrics { display:grid; grid-template-columns:repeat(4, 1fr); gap:6px; margin-top:10px; }
    .q-fav-mini-stat { min-width:0; padding:7px 4px; border-radius:8px; background:rgba(45,8,25,0.2); border:1px solid rgba(255,235,244,0.13); text-align:center; box-shadow:inset 0 1px 0 rgba(255,255,255,0.08); }
    .q-fav-mini-stat strong { display:block; color:#fff7fb; font-size:15px; line-height:1; }
    .q-fav-mini-stat span { display:block; margin-top:4px; color:rgba(247,237,242,0.66); font-size:10px; line-height:1.15; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .q-fav-primary-action { display:inline-flex; align-items:center; justify-content:center; gap:7px; min-width:82px; min-height:34px; padding:0 12px; border:1px solid rgba(255,235,244,0.26) !important; border-radius:999px !important; color:#fff7fb !important; background:rgba(47,8,27,0.28) !important; cursor:pointer; font-weight:900; font-size:13px; box-shadow:inset 0 1px 0 rgba(255,255,255,0.14); }
    .q-fav-primary-action:hover { filter:brightness(1.12); }
    .q-fav-site-card { position:relative; display:grid; grid-template-rows:1fr auto; align-items:center; justify-items:center; min-height:54px; padding:9px 10px 8px; border:1px solid rgba(255,220,237,0.34); border-radius:9px; color:#fff7fb; background:linear-gradient(135deg, rgba(129,54,91,0.92), rgba(184,89,132,0.88)); box-shadow:inset 0 1px 0 rgba(255,255,255,0.16), 0 7px 18px rgba(57,0,26,0.16); font-size:14px; font-weight:900; text-align:center; }
    .q-fav-site-card.active { background:linear-gradient(135deg, rgba(147,63,104,0.98), rgba(204,104,150,0.96)); border-color:rgba(255,235,244,0.48); box-shadow: inset 0 1px 0 rgba(255,255,255,0.2), 0 9px 20px rgba(78,4,38,0.24); }
    .q-fav-site-card.running { filter:brightness(1.12); }
    .q-fav-site-card.cooldown { filter:saturate(.75) brightness(.86); }
    .q-fav-site-card.problem { background:linear-gradient(135deg, rgba(126,39,55,0.96), rgba(188,70,91,0.92)); }
    .q-fav-site-name { pointer-events:none; line-height:1.2; }
    .q-fav-action-btn, .q-fav-site button, #q-fav-queue-all, #q-fav-run-auto { min-height:30px; border:1px solid rgba(255,235,244,0.22) !important; border-radius:8px !important; color:#fff7fb !important; background:rgba(201,85,135,0.36) !important; cursor:pointer; font-weight:800; font-size:12px; }
    .q-fav-action-btn { display:inline-flex; align-items:center; gap:6px; min-height:24px !important; margin-top:6px; padding:3px 9px; border-radius:999px !important; background:rgba(42,8,25,0.26) !important; box-shadow:inset 0 1px 0 rgba(255,255,255,0.14); }
    .q-fav-action-btn:hover { filter:brightness(1.12); }
    .q-fav-indicator { width:12px; height:12px; border-radius:50%; border:1px solid rgba(255,245,250,0.38); background:rgba(45,8,25,0.22); box-shadow:inset 0 1px 0 rgba(255,255,255,0.12); pointer-events:none; }
    .q-fav-site-card.running .q-fav-indicator, .q-fav-site-card.cooldown .q-fav-indicator, .q-fav-current-site.running .q-fav-indicator, .q-fav-current-site.cooldown .q-fav-indicator { border:2px solid rgba(255,245,250,0.3); border-top-color:#fff7fb; background:rgba(255,255,255,0.08); animation:q-fav-spin .8s linear infinite; }
    .q-fav-site-card.problem .q-fav-indicator { background:#f0a0af; border-color:rgba(255,245,250,0.7); }
    .q-fav-current-site.problem .q-fav-indicator { background:#f0a0af; border-color:rgba(255,245,250,0.7); }
    .q-fav-site-card.active:not(.running):not(.cooldown):not(.problem) .q-fav-indicator, .q-fav-current-site:not(.running):not(.cooldown):not(.problem) .q-fav-indicator { background:#ffd3e3; border-color:rgba(255,245,250,0.72); }
    @keyframes q-fav-spin { to { transform:rotate(360deg); } }
    .q-fav-one-line { margin-bottom:10px; padding:8px 10px; border-radius:8px; background:rgba(255,238,246,0.1); border:1px solid rgba(255,235,244,0.14); color:rgba(247,237,242,0.78); font-size:11px; line-height:1.45; }
    .q-plan-card { padding:10px; border-radius:9px; background:rgba(255,238,246,0.1); border:1px solid rgba(255,235,244,0.15); margin-bottom:10px; }
    .q-plan-row { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px; }
    .q-plan-title { color:#fff7fb; font-weight:900; font-size:13px; }
    .q-plan-meta { color:rgba(247,237,242,0.68); font-size:11px; line-height:1.4; }
    .q-plan-switch { position:relative; display:grid; grid-template-columns:1fr 1fr; width:138px; height:30px; padding:2px; border-radius:999px; border:1px solid rgba(255,235,244,0.2); background:rgba(43,8,24,0.36); cursor:pointer; }
    .q-plan-switch span { position:relative; z-index:1; display:flex; align-items:center; justify-content:center; color:rgba(247,237,242,0.72); font-size:11px; font-weight:900; pointer-events:none; }
    .q-plan-switch::before { content:""; position:absolute; top:2px; left:2px; width:calc(50% - 2px); height:calc(100% - 4px); border-radius:999px; background:rgba(207,107,150,0.74); transition:transform .18s ease; }
    .q-plan-switch.auto::before { transform:translateX(100%); }
    .q-plan-switch.auto span:last-child, .q-plan-switch.manual span:first-child { color:#fff; }
    .q-plan-field { display:grid; grid-template-columns:minmax(0,1fr) 84px; gap:8px; align-items:center; margin-top:9px; padding:8px; border-radius:8px; background:rgba(45,8,25,0.18); border:1px solid rgba(255,235,244,0.12); }
    .q-plan-field label { color:#fff7fb; font-size:12px; font-weight:900; line-height:1.25; }
    .q-plan-field span { display:block; margin-top:3px; color:rgba(247,237,242,0.62); font-size:10px; font-weight:700; line-height:1.25; }
    .q-plan-field input { width:100%; min-width:0; height:30px; box-sizing:border-box; border:1px solid rgba(255,235,244,0.22); border-radius:8px; color:#fff7fb; background:rgba(38,6,20,0.28); text-align:center; font-weight:900; outline:none; }
    .q-plan-field input:focus { border-color:rgba(255,235,244,0.45); box-shadow:0 0 0 2px rgba(207,107,150,0.18); }
    .q-plan-buttons { display:grid; grid-template-columns:1fr 1fr; gap:7px; margin-top:9px; }
    .q-plan-buttons button, .q-plan-manual-add button { min-height:34px !important; border:1px solid rgba(255,235,244,0.24) !important; border-radius:8px !important; color:#fff7fb !important; background:rgba(201,85,135,0.36) !important; cursor:pointer; font-weight:900; font-size:12px; box-shadow:inset 0 1px 0 rgba(255,255,255,0.12); }
    .q-plan-buttons button:hover, .q-plan-manual-add button:hover { filter:brightness(1.12); }
    .q-plan-manual-add { display:grid; grid-template-columns:minmax(0,1fr) 72px; gap:8px; align-items:center; margin-top:9px; }
    .q-plan-manual-add input { width:100%; min-width:0; height:34px; box-sizing:border-box; border:1px solid rgba(255,235,244,0.22); border-radius:8px; color:#fff7fb; background:rgba(38,6,20,0.28); text-align:center; font-weight:900; outline:none; }
    .q-fav-summary { display:grid; grid-template-columns:repeat(2, 1fr); gap:7px; margin-bottom:10px; }
    .q-fav-stat, .q-fav-site, .q-fav-item { padding:9px; border-radius:9px; background:rgba(255,238,246,0.1); border:1px solid rgba(255,235,244,0.15); }
    .q-fav-stat strong, .q-fav-site strong { display:block; color:#fff7fb; font-size:16px; }
    .q-fav-stat span, .q-fav-site span, .q-fav-item span { color:rgba(247,237,242,0.68); font-size:11px; }
    .q-fav-sites { display:grid; gap:8px; margin-bottom:10px; }
    .q-fav-site { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:8px; align-items:center; }
    .q-fav-item strong { display:block; color:#fff7fb; font-size:12px; line-height:1.3; margin-bottom:3px; word-break:break-word; }
    #q-widget-btn { position: relative; user-select: none; touch-action: none; pointer-events: auto; width: 64px; height: 64px; border-radius: 50%; background: transparent url("${chrome.runtime.getURL('assets/q-widget-icon.png')}") center / contain no-repeat; color: transparent; border: none; cursor: grab; filter: drop-shadow(0 4px 10px rgba(196, 48, 105, 0.32)); display: flex; align-items: center; justify-content: center; transition: transform 0.1s, filter 0.2s;}
    #q-widget-btn.q-widget-open { filter: drop-shadow(0 5px 13px rgba(196, 48, 105, 0.46)); }
    #q-widget-btn:active { cursor: grabbing; transform: scale(0.95); }
    .empty-tip { text-align: center; color: rgba(247,237,242,0.62); padding: 23px 0; border: none !important; background: none !important; box-shadow: none !important;}
    
    #q-widget-settings-panel { position: relative; display: none; padding: 15px; font-size: 13px; color: #f7edf2; background: rgba(255,255,255,0.05); overflow-y: auto;}
    .q-set-group { margin-bottom: 15px; background: rgba(255,238,246,0.08); padding: 10px; border-radius: 12px; border: 1px solid rgba(255,235,244,0.14); box-shadow: inset 0 1px 0 rgba(255,255,255,0.09); }
    .q-set-title { font-weight: 800; color: #ecc5d5; margin-bottom: 8px; border-bottom: 1px solid rgba(255,235,244,0.12); padding-bottom: 5px;}
    .q-set-label { display: block; margin-bottom: 6px; cursor: pointer; }
    .q-set-input { width: 100%; padding: 7px 9px; box-sizing: border-box; border: 1px solid rgba(255,235,244,0.22); border-radius: 8px; font-size: 12px; margin-top: 4px; color: #fff; background: rgba(38,6,20,0.3); outline: none; }
    .q-set-input::placeholder { color: rgba(247,237,242,0.42); }
    #q-settings-save { width: 100%; padding: 9px; background: linear-gradient(135deg, #c95587, #8e244f) !important; color: white; border: 1px solid rgba(255,235,244,0.2) !important; border-radius: 10px !important; cursor: pointer; font-weight: 800; box-shadow: 0 9px 22px rgba(85, 13, 45, 0.2), inset 0 1px 0 rgba(255,255,255,0.14); transition: transform 0.2s, filter 0.2s; }
    #q-settings-save:hover { transform: translateY(-1px); filter: brightness(1.06); }
  </style>
  <div id="q-widget-panel">
    <div id="q-widget-header">
        <div id="q-widget-title-block">
            <span id="q-ui-title">Download Center</span>
            <span id="q-widget-task-count">0 / 0</span>
        </div>
        <div>
            <button id="q-widget-resume" title="Refresh and recover stuck queue tasks" aria-label="Refresh and recover stuck queue tasks" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 0 1-15.5 6.2"/><path d="M3 12A9 9 0 0 1 18.5 5.8"/><path d="M18.5 2.5v3.3h-3.3"/><path d="M5.5 21.5v-3.3h3.3"/></svg></button>
            <button id="q-widget-clear" title="Clear waiting and failed tasks" aria-label="Clear waiting and failed tasks" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6 18 20H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg></button>
            <button id="q-widget-settings-btn" title="Settings" aria-label="Settings" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6V20a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-.6 1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1H4a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 .6-1 1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6V4a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 .6 1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.2.3.4.6.6 1H20a2 2 0 1 1 0 4h-.09c-.2.4-.4.7-.51 1Z"/></svg></button>
            <a id="q-widget-patreon" href="https://www.patreon.com/MangaFlow" target="_blank" rel="noopener noreferrer" title="Support the developer on Patreon" aria-label="Support the developer on Patreon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.5 12.6 12 20l-7.5-7.4A5 5 0 0 1 12 6a5 5 0 0 1 7.5 6.6Z"/></svg></a>
        </div>
    </div>

    <div id="q-widget-main-view" style="display: flex; flex-direction: column; overflow: hidden; flex-grow: 1;">
        <div id="q-widget-progress-container"><div id="q-widget-progress-text">Rate limit cooldown...</div><div id="q-widget-progress-bg"><div id="q-widget-progress-bar"></div></div></div>
        <ul id="q-widget-list"></ul>
    </div>

    <div id="q-widget-settings-panel">
        <div class="q-set-group">
            <div class="q-set-title" id="q-ui-setRule">1. File Naming Rule</div>
            <label class="q-set-label"><input type="radio" name="q-name-rule" value="1"> <span id="q-ui-rule1">Translated Title (Default)</span></label>
            <label class="q-set-label"><input type="radio" name="q-name-rule" value="2"> <span id="q-ui-rule2">Original Title Only</span></label>
        </div>
        <div class="q-set-group">
            <div class="q-set-title" id="q-ui-setDir">2. Base Directory (Subfolder)</div>
            <input type="text" id="q-base-dir" class="q-set-input" placeholder="Leave blank for default Downloads">
            <div id="q-ui-dirTip" style="font-size:11px; color:rgba(255,245,250,0.6); margin-top:4px;">e.g., nHentai/Manga</div>
        </div>
        <button id="q-settings-save">Save Settings</button>
    </div>
  </div>
  <button id="q-widget-btn" aria-label="Download queue"></button>
`;

function applyTranslations() {
    const t = I18N.en;
    const el = (id) => document.getElementById(id);
    if (!el('q-ui-title')) return;

    el('q-ui-title').innerText = t.title;
    if (el('q-widget-resume')) {
        el('q-widget-resume').title = 'Refresh and recover stuck queue tasks';
        el('q-widget-resume').setAttribute('aria-label', 'Refresh and recover stuck queue tasks');
    }
    if (el('q-widget-clear')) {
        el('q-widget-clear').title = 'Clear waiting and failed tasks';
        el('q-widget-clear').setAttribute('aria-label', 'Clear waiting and failed tasks');
    }
    el('q-ui-setRule').innerText = t.setRule;
    el('q-ui-rule1').innerText = t.rule1;
    el('q-ui-rule2').innerText = t.rule2;
    el('q-ui-setDir').innerText = t.setDir;
    el('q-base-dir').placeholder = t.dirPlaceholder;
    el('q-ui-dirTip').innerText = t.dirTip;
    if (el('q-fav-queue-all')) el('q-fav-queue-all').innerText = 'Add 1';
    if (el('q-fav-run-auto')) el('q-fav-run-auto').innerText = 'Check now';

    const saveBtn = el('q-settings-save');
    if (!saveBtn.innerText.includes('OK')) saveBtn.innerText = t.save;
}

function translateStatus(status, lang) {
    return status
        .replace('Loading environment...', 'Loading environment...')
        .replace('Triggering download...', 'Triggering download...')
        .replace('Waiting for cooldown', 'Waiting for cooldown')
        .replace('System reset', 'System reset')
        .replace('retrying', 'retrying')
        .replace('Task lost', 'Task lost, ')
        .replace('\u4e0b\u8f7d\u4e2d\u65ad', 'Download interrupted, ')
        .replace('Status abnormal', 'Status abnormal, ')
        .replace('Timeout', 'Timeout, ')
        .replace('Script failed', 'Script failed, ')
        .replace('Internal error', 'Internal error, ')
        .replace('Server 500 error', 'Server 500 error, ')
        .replace('\u672a\u627e\u5230\u4e0b\u8f7d\u6309\u94ae', 'Button not found, ')
        .replace('Rate limit', 'Rate limit, ')
        .replace('No response', 'No response, ')
        .replace('Failed:', 'Failed:');
}

function isActiveQueueTaskStatus(status) {
    const value = String(status || "");
    return value === "DOWNLOADING" || value.includes("Triggering download");
}

function updateTaskCount(queue) {
    const count = document.getElementById('q-widget-task-count');
    if (!count) return;
    const active = queue.filter((item) => isActiveQueueTaskStatus(item.status)).length;
    count.textContent = `${active} / ${queue.length}`;
}

const ICON_SETTINGS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6V20a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-.6 1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1H4a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 .6-1 1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6V4a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 .6 1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.2.3.4.6.6 1H20a2 2 0 1 1 0 4h-.09c-.2.4-.4.7-.51 1Z"/></svg>';
const ICON_BACK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>';
const WIDGET_BUTTON_SIZE = 64;

function clampNumber(value, min, max) {
    return Math.max(min, Math.min(value, max));
}

function numberFromCss(value) {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function widgetViewportLimits() {
    return {
        maxLeft: Math.max(0, window.innerWidth - WIDGET_BUTTON_SIZE),
        maxTop: Math.max(0, window.innerHeight - WIDGET_BUTTON_SIZE),
    };
}

function positionFromWidgetPos(pos = widgetPos, options = {}) {
    const limits = widgetViewportLimits();
    let left = numberFromCss(pos.left);
    let top = numberFromCss(pos.top);

    if (options.useRatio && Number.isFinite(pos.xRatio)) {
        left = pos.xRatio * limits.maxLeft;
    }
    if (options.useRatio && Number.isFinite(pos.yRatio)) {
        top = pos.yRatio * limits.maxTop;
    }
    if (top === null && numberFromCss(pos.bottom) !== null) {
        top = window.innerHeight - numberFromCss(pos.bottom) - WIDGET_BUTTON_SIZE;
    }

    return {
        left: clampNumber(left ?? 30, 0, limits.maxLeft),
        top: clampNumber(top ?? 30, 0, limits.maxTop),
    };
}

function widgetPosFromPixels(left, top) {
    const limits = widgetViewportLimits();
    const clampedLeft = clampNumber(left, 0, limits.maxLeft);
    const clampedTop = clampNumber(top, 0, limits.maxTop);
    return {
        left: `${clampedLeft}px`,
        top: `${clampedTop}px`,
        bottom: 'auto',
        xRatio: limits.maxLeft ? clampNumber(clampedLeft / limits.maxLeft, 0, 1) : 0,
        yRatio: limits.maxTop ? clampNumber(clampedTop / limits.maxTop, 0, 1) : 0,
    };
}

function applyWidgetPosition(container, options = {}) {
    if (!container) return;
    const position = positionFromWidgetPos(widgetPos, options);
    widgetPos = widgetPosFromPixels(position.left, position.top);
    container.style.left = widgetPos.left;
    container.style.top = widgetPos.top;
    container.style.bottom = 'auto';
    container.style.right = 'auto';
}

function applySmartPosition(cont, pnl) {
    const rect = cont.getBoundingClientRect();
    pnl.style.right = rect.left > window.innerWidth / 2 ? '0px' : 'auto'; pnl.style.left = rect.left > window.innerWidth / 2 ? 'auto' : '0px';
    pnl.style.bottom = rect.top > window.innerHeight / 2 ? '74px' : 'auto'; pnl.style.top = rect.top > window.innerHeight / 2 ? 'auto' : '74px';
}

function syncWidgetVisibility(options = {}) {
    const container = document.getElementById('q-widget-container');
    const panel = document.getElementById('q-widget-panel');
    const btn = document.getElementById('q-widget-btn');
    if (!container || !panel || !btn) return;
    applyWidgetPosition(container);
    if (isWidgetOpen) applySmartPosition(container, panel);
    panel.style.display = isWidgetOpen ? 'flex' : 'none';
    btn.classList.toggle('q-widget-open', isWidgetOpen);
    if (options.persist) chrome.storage.local.set({ widgetOpen: isWidgetOpen });
}

function syncWidgetPositionForViewport(options = {}) {
    const container = document.getElementById('q-widget-container');
    const panel = document.getElementById('q-widget-panel');
    if (!container) return;
    applyWidgetPosition(container, { useRatio: true });
    if (isWidgetOpen && panel) applySmartPosition(container, panel);
    if (options.persist) chrome.storage.local.set({ widgetPosition: widgetPos });
}

function injectWidget() {
    let container = document.getElementById('q-widget-container');
    if (container) {
        syncWidgetVisibility();
        applyTranslations();
        return;
    }
    container = document.createElement('div'); container.id = 'q-widget-container'; container.innerHTML = WIDGET_HTML;
    applyWidgetPosition(container);
    document.body.appendChild(container);

    applyTranslations();

    const btn = document.getElementById('q-widget-btn'), panel = document.getElementById('q-widget-panel'), resumeBtn = document.getElementById('q-widget-resume'), clearBtn = document.getElementById('q-widget-clear');
    const btnSet = document.getElementById('q-widget-settings-btn'), mainView = document.getElementById('q-widget-main-view'), setView = document.getElementById('q-widget-settings-panel'), saveBtn = document.getElementById('q-settings-save');

    function showQueueView() {
        setView.style.display = 'none';
        btnSet.innerHTML = ICON_SETTINGS;
        btnSet.title = 'Settings';
        btnSet.setAttribute('aria-label', 'Settings');
        mainView.style.display = 'flex';
        updateWidgetUi();
    }

    btnSet.onclick = () => {
        if (setView.style.display === 'none') {
            mainView.style.display = 'none'; setView.style.display = 'block'; btnSet.innerHTML = ICON_BACK; btnSet.title = 'Back'; btnSet.setAttribute('aria-label', 'Back');
            chrome.storage.local.get({qSettings: { nameRule: "1", baseDir: "nHentai", useAuthor: false, lang: "en" }}, (d) => {
                const savedRule = d.qSettings.nameRule === "2" ? "2" : "1";
                let radio = document.querySelector(`input[name="q-name-rule"][value="${savedRule}"]`);
                if (radio) radio.checked = true;
                document.getElementById('q-base-dir').value = d.qSettings.baseDir;
            });
        } else {
            showQueueView();
        }
    };

    saveBtn.onclick = () => {
        const ruleNode = document.querySelector('input[name="q-name-rule"]:checked');
        const rule = ruleNode ? ruleNode.value : "1", uiLang = "en";
        const dir = document.getElementById('q-base-dir').value.trim();
        
        chrome.storage.local.set({ qSettings: { nameRule: rule, baseDir: dir, useAuthor: false, lang: uiLang } }, () => {
            saveBtn.innerText = I18N[uiLang].saveSuccess; saveBtn.style.filter = 'brightness(1.18)';
            setTimeout(() => { saveBtn.innerText = I18N[uiLang].save; saveBtn.style.filter = ''; btnSet.click(); }, 600);
        });
    };

    btn.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        let isDragging = false, startX = e.clientX, startY = e.clientY;
        const rect = container.getBoundingClientRect(), initialLeft = rect.left, initialTop = rect.top;
        try { btn.setPointerCapture(e.pointerId); } catch (error) {}
        const onPointerMove = (me) => {
            const dx = me.clientX - startX, dy = me.clientY - startY;
            if (!isDragging && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) isDragging = true;
            if (isDragging) {
                widgetPos = widgetPosFromPixels(initialLeft + dx, initialTop + dy);
                applyWidgetPosition(container);
                if (isWidgetOpen) applySmartPosition(container, panel);
            }
        };
        const onPointerUp = () => {
            document.removeEventListener('pointermove', onPointerMove); document.removeEventListener('pointerup', onPointerUp); document.removeEventListener('pointercancel', onPointerUp);
            try { btn.releasePointerCapture(e.pointerId); } catch (error) {}
            if (!isDragging) {
                isWidgetOpen = !isWidgetOpen;
                syncWidgetVisibility({ persist: true });
            } else { chrome.storage.local.set({ widgetPosition: widgetPos }); }
        };
        document.addEventListener('pointermove', onPointerMove); document.addEventListener('pointerup', onPointerUp); document.addEventListener('pointercancel', onPointerUp);
    });
    resumeBtn.onclick = () => {
        resumeBtn.disabled = true;
        resumeBtn.title = 'Checking queue and recovering stuck tasks';
        chrome.runtime.sendMessage({ action: 'MANUAL_RECOVER_QUEUE' }, (response) => {
            const recovered = Number(response?.recovered || 0);
            resumeBtn.title = recovered ? `Recovered ${recovered}` : 'No stuck tasks';
            setTimeout(() => {
                resumeBtn.disabled = false;
                resumeBtn.title = 'Refresh and recover stuck queue tasks';
            }, 1200);
        });
    };
    clearBtn.onclick = () => chrome.runtime.sendMessage({ action: 'CLEAR_WAITING_QUEUE', site: currentPageSite() });
    showQueueView(); 
    syncWidgetVisibility();
}

function updateWidgetUi() {
    const listElement = document.getElementById('q-widget-list'), progContainer = document.getElementById('q-widget-progress-container'), progBar = document.getElementById('q-widget-progress-bar'), progText = document.getElementById('q-widget-progress-text');
    if (!listElement) return;

    chrome.storage.local.get({ queue: [], siteCooldowns: emptySiteCooldowns(), globalCooldownUntil: 0, cooldownTotal: 60000 }, (data) => {
        const now = Date.now();
        const pageSite = currentPageSite();
        const siteCooldowns = normalizeSiteCooldowns(data);
        if (progContainer && progBar && progText) {
            const activeSites = [pageSite].filter(site => siteCooldowns[site]?.until > now);
            if (activeSites.length) {
                progContainer.style.display = 'block';
                if (qCooldownTimer) clearInterval(qCooldownTimer); 
                qCooldownTimer = setInterval(() => {
                    const timerNow = Date.now();
                    const active = [pageSite].filter(site => siteCooldowns[site]?.until > timerNow);
                    if (!active.length) { clearInterval(qCooldownTimer); progContainer.style.display = 'none'; }
                    else {
                        const ratios = active.map(site => {
                            const timeLeft = siteCooldowns[site].until - timerNow;
                            return timeLeft / (siteCooldowns[site].total || 60000);
                        });
                        progBar.style.width = Math.max(...ratios) * 100 + '%';
                        progText.innerText = active
                            .map(site => cooldownText(site, (siteCooldowns[site].until - timerNow) / 1000))
                            .join('\n');
                    }
                }, 50); 
            } else { progContainer.style.display = 'none'; if (qCooldownTimer) clearInterval(qCooldownTimer); }
        }
        
        let queue = (data.queue || []).filter((item) => (item.site || siteFromUrl(item.url)) === pageSite);
        updateTaskCount(queue);
        listElement.textContent = '';
        if (queue.length === 0) {
            const empty = document.createElement('li');
            empty.className = 'empty-tip';
            empty.textContent = I18N.en.empty;
            listElement.appendChild(empty);
            return;
        }

        const firstWaitingBySite = new Set();
        queue.forEach((item) => {
            const itemSite = item.site || siteFromUrl(item.url);
            if (!firstWaitingBySite.has(itemSite) && (String(item.status || "").includes("WAITING") || String(item.status || "").includes("\u7b49\u5f85"))) {
                firstWaitingBySite.add(itemSite);
                item.nextWaitingForSite = true;
            } else {
                item.nextWaitingForSite = false;
            }
        });

        queue.forEach((item) => {
            let li = document.createElement('li'), statusClass = '', displayStatus = item.status || 'WAITING';
            const itemSite = item.site || siteFromUrl(item.url);
            const itemCooldown = siteCooldowns[itemSite];
            if (displayStatus === 'DOWNLOADING') { 
                statusClass = 'downloading'; displayStatus = I18N.en.statusDown; 
            } else if (displayStatus.startsWith('FAILED')) {
                statusClass = 'cooldown';
                displayStatus = translateStatus(displayStatus, currentLang);
            } else if (displayStatus.includes('WAITING') || displayStatus.includes('\u7b49\u5f85')) {
                if (item.nextWaitingForSite && itemCooldown?.until > now) {
                    statusClass = 'cooldown';
                    displayStatus = queueCooldownText(itemSite);
                } else if (displayStatus === 'WAITING') displayStatus = I18N.en.statusPrep;
                else displayStatus = translateStatus(displayStatus, currentLang);
                if (displayStatus.includes('retrying') || displayStatus.includes('abnormal') || displayStatus.includes('Rate limit') || displayStatus.includes('error') || displayStatus.includes('retry')) statusClass = 'cooldown';
            } else { 
                statusClass = 'processing'; displayStatus = translateStatus(displayStatus, currentLang);
            }
            if (statusClass) li.className = statusClass;

            const title = document.createElement('div');
            title.className = 'q-item-title';
            title.textContent = item.title || 'Task';

            const status = document.createElement('div');
            status.className = 'q-item-status';
            status.append('Status: ');
            const strong = document.createElement('strong');
            strong.textContent = displayStatus;
            status.appendChild(strong);

            li.append(title, status);
            listElement.appendChild(li);
        });
    });
}

chrome.storage.onChanged.addListener((c, n) => { 
    if (n === 'local') { 
        let shouldUpdateButtons = false;
        if (c.queue) { queuedUrls.clear(); c.queue.newValue.forEach(i => queuedUrls.add(normalizeGalleryUrl(i.url) || i.url)); shouldUpdateButtons = true; } 
        if (c.history) { historyUrls.clear(); c.history.newValue.forEach(u => historyUrls.add(normalizeGalleryUrl(u) || u)); shouldUpdateButtons = true; }
        if (c.qSettings) { currentLang = "en"; applyTranslations(); shouldUpdateButtons = true; }
        if (shouldUpdateButtons) {
            document.querySelectorAll('.q-dl-btn').forEach(b => { 
                const buttonUrl = normalizeGalleryUrl(b.dataset.url) || b.dataset.url;
                updateQueueButton(b, buttonUrl);
            }); 
        }
        if (c.queue || c.siteCooldowns || c.globalCooldownUntil || c.qSettings) updateWidgetUi(); 
    } 
});

function updateQueueButton(button, targetUrl) {
    const isDone = queuedUrls.has(targetUrl) || historyUrls.has(targetUrl);
    button.innerText = isDone ? I18N.en.btnDone : I18N.en.btnDown;
    button.style.backgroundColor = isDone ? '#4CAF50' : '#e53935';
    button.disabled = isDone;
    button.setAttribute('aria-disabled', String(isDone));
    button.title = '';
}

function getGalleryContainer(link) {
    const preferred = PREFERRED_ITEM_SELECTORS.map(selector => link.closest(selector)).find(Boolean);
    return preferred || link.closest('.cover, .thumb, .container > div') || link.parentElement || link;
}

function findDetailButtonContainer() {
    if (isXxxHost()) {
        const favoriteButton = document.querySelector('#fav_act, button#favorite, button[id*="fav"], .info button.mbtn');
        const infoPanel = favoriteButton?.closest('.info') || document.querySelector('.info') || document.querySelector('#info');
        if (infoPanel) {
            let row = document.querySelector('.q-detail-dl-row');
            if (!row) {
                row = document.createElement('div');
                row.className = 'q-detail-dl-row';
                row.style.cssText = 'display:flex; align-items:center; justify-content:flex-start; flex-basis:100%; width:100%; margin:12px 0 0 0;';
                const buttons = Array.from(infoPanel.querySelectorAll('a, button')).filter((el) => {
                    if (el.classList?.contains('q-dl-btn') || el.closest('#q-widget-container')) return false;
                    const text = (el.textContent || "").trim().toLowerCase();
                    return text.includes('favorite') || text.includes('download') || text.includes('report');
                });
                const lastButton = buttons[buttons.length - 1] || favoriteButton;
                if (lastButton?.parentElement === infoPanel) lastButton.insertAdjacentElement('afterend', row);
                else infoPanel.appendChild(row);
            }
            return row;
        }
    }
    const explicit = document.querySelector('#info .buttons, #info .button-container, #info .actions, .buttons, .button-container, .actions');
    if (explicit) {
        return explicit;
    }
    const nativeButton = Array.from(document.querySelectorAll('a, button')).find((el) => {
        if (el.classList?.contains('q-dl-btn') || el.closest('#q-widget-container')) return false;
        const text = (el.textContent || "").trim().toLowerCase();
        return text.includes('favorite') || text.includes('download') || text.includes('report');
    });
    const nativeContainer = nativeButton?.parentElement;
    return nativeContainer || document.querySelector('#info') || document.querySelector('#cover')?.parentElement || document.body;
}

function compactQueueTitle(text) {
    return String(text || "").substring(0, 80).replace(/\s+/g, ' ').trim();
}

function queuePayloadForButton(container, link, targetUrl, options = {}) {
    if (options.detail) {
        const meta = collectGalleryMeta();
        const title = compactQueueTitle(meta.titleTrans || meta.titleOrig || document.title);
        return { url: targetUrl, title: title || 'Task', meta };
    }
    const titleSource = container.innerText || link?.innerText || document.title || "";
    return { url: targetUrl, title: compactQueueTitle(titleSource) || 'Task' };
}

function attachQueueButton(container, link, targetUrl, options = {}) {
    if (!container || !targetUrl) return;
    const buttonSelector = options.detail ? '.q-detail-dl-btn' : '.q-dl-btn:not(.q-detail-dl-btn)';
    const sameUrl = (btn) => (normalizeGalleryUrl(btn.dataset.url) || btn.dataset.url) === targetUrl;
    let qBtn = Array.from((options.detail ? document : container).querySelectorAll(buttonSelector)).find(sameUrl);
    if (!qBtn && !options.detail) qBtn = Array.from(document.querySelectorAll(buttonSelector)).find(sameUrl);
    if (qBtn) {
        updateQueueButton(qBtn, targetUrl);
        if (qBtn.parentElement !== container) container.appendChild(qBtn);
        Array.from(document.querySelectorAll(buttonSelector)).forEach(btn => {
            if (btn !== qBtn && sameUrl(btn)) btn.remove();
        });
        return;
    }

    qBtn = document.createElement('button');
    qBtn.className = options.detail ? 'q-dl-btn q-detail-dl-btn' : 'q-dl-btn';
    qBtn.dataset.url = targetUrl;
    qBtn.style.cssText = options.detail
        ? 'display:inline-flex; align-items:center; justify-content:center; min-width:84px; height:40px; margin:3px 5px 10px 0; padding:0 12px; background-color:#e53935; color:white; border:0; border-radius:6px; cursor:pointer; font-size:14px; line-height:40px; font-family:"Noto Sans", sans-serif; font-weight:900; pointer-events:auto !important; vertical-align:top;'
        : 'position:absolute; bottom:5px; right:5px; z-index:999998; padding:4px 8px; background-color:#e53935; color:white; border:2px solid white; border-radius:4px; cursor:pointer; font-size:12px; font-weight:900; pointer-events:auto !important;';
    updateQueueButton(qBtn, targetUrl);

    qBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    qBtn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        if (qBtn.disabled) return;
        queuedUrls.add(targetUrl);
        updateQueueButton(qBtn, targetUrl);
        try {
            chrome.runtime.sendMessage({ action: 'ADD_TO_QUEUE', payload: queuePayloadForButton(container, link, targetUrl, options) }, () => {
                if (chrome.runtime.lastError) {
                    alert('Extension reloaded. Press F5.');
                    queuedUrls.delete(targetUrl);
                    updateQueueButton(qBtn, targetUrl);
                } else if (!isWidgetOpen) {
                    document.getElementById('q-widget-btn')?.click();
                }
            });
        } catch (err) {
            alert('Press F5 to refresh this page.');
        }
    });

    if (!options.detail && window.getComputedStyle(container).position === 'static') container.style.position = 'relative';
    container.appendChild(qBtn);
    Array.from(document.querySelectorAll(buttonSelector)).forEach(btn => {
        if (btn !== qBtn && sameUrl(btn)) btn.remove();
    });
}

function collectListGalleryTargets(root = document) {
    const targets = new Map();
    const links = [];
    if (root?.nodeType === 1 && root.matches?.('a[href]')) links.push(root);
    root?.querySelectorAll?.('a[href]').forEach(link => links.push(link));
    links.forEach(link => {
        const targetUrl = normalizeGalleryUrl(link.href);
        if (!targetUrl || targets.has(targetUrl)) return;
        const container = getGalleryContainer(link);
        if (!container || container.closest('#q-widget-container')) return;
        targets.set(targetUrl, { link, container });
    });
    return targets;
}

function addQueueButtonsWithin(root) {
    if (!root || normalizeGalleryUrl(location.href)) return false;
    const targets = collectListGalleryTargets(root);
    if (!targets.size) return false;
    targets.forEach(({ link, container }, targetUrl) => {
        attachQueueButton(container, link, targetUrl);
    });
    return true;
}

function addQueueButtonsToList() {
    const currentGalleryUrl = normalizeGalleryUrl(location.href);
    if (currentGalleryUrl) {
        document.querySelectorAll('.q-dl-btn:not(.q-detail-dl-btn)').forEach(button => button.remove());
        attachQueueButton(findDetailButtonContainer(), null, currentGalleryUrl, { detail: true });
        return;
    }

    const targets = collectListGalleryTargets();
    if (!targets.size) return;

    targets.forEach(({ link, container }, targetUrl) => {
        attachQueueButton(container, link, targetUrl);
    });

    document.querySelectorAll('.q-dl-btn:not(.q-detail-dl-btn)').forEach(button => {
        const buttonUrl = normalizeGalleryUrl(button.dataset.url) || button.dataset.url;
        if (!targets.has(buttonUrl)) button.remove();
    });
}

let dbTimer = null;
let dbTimerAt = 0;
function scheduleQueueButtonRefresh(delay = 250) {
    const wait = Math.max(0, Number(delay) || 0);
    const runAt = Date.now() + wait;
    if (dbTimer && dbTimerAt <= runAt) return;
    if (dbTimer) clearTimeout(dbTimer);
    dbTimerAt = runAt;
    dbTimer = setTimeout(() => {
        dbTimer = null;
        dbTimerAt = 0;
        try {
            injectWidget();
            addQueueButtonsToList();
        } catch (error) {
            console.warn('Q-Downloader button refresh failed', error);
        }
    }, wait);
}

const rateLimitObserver = new MutationObserver((mutations) => {
    for (let m of mutations) {
        if (m.addedNodes.length) {
            for (let n of m.addedNodes) {
                if (n.nodeType === 1) {
                    const text = n.textContent || "";
                    if (text.includes('Rate limit exceeded')) {
                        chrome.runtime.sendMessage(withActiveJob({ action: 'RATE_LIMIT_HIT' })); 
                        return;
                    }
                    const waitMatch = text.match(/You need to wait (\d+) seconds/i);
                    if (waitMatch) {
                        const seconds = parseInt(waitMatch[1], 10);
                        console.log(`[Dynamic cooldown] Site requested wait ${seconds}s`);
                        chrome.runtime.sendMessage(withActiveJob({ action: 'DYNAMIC_COOLDOWN', seconds: seconds })); 
                        return;
                    }
                }
            }
        }
    }
});
rateLimitObserver.observe(document.body, { childList: true, subtree: true });

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'DO_YOUR_JOB') {
        activeJob = { taskId: request.taskId || "", site: request.site || siteFromUrl(location.href) };
        sendResponse({ ack: true });
        cleanupTriggeredDownloadJobs();
        if (triggeredDownloadJobs.has(activeJob.taskId)) return true;
        if (activeDownloadHunt) clearInterval(activeDownloadHunt);
        let attempts = 0;
        activeDownloadHunt = setInterval(() => {
            attempts++;
            const pageText = document.body.innerText || "";
            if (pageText.includes('Internal server error') || pageText.includes('502 Bad Gateway') || pageText.includes('503 Service')) {
                clearInterval(activeDownloadHunt); activeDownloadHunt = null; chrome.runtime.sendMessage(withActiveJob({ action: 'SERVER_ERROR' })); return;
            }

            if (isXxxHost()) {
                const direct = findDirectDownloadButton();
                if (direct) {
                    clearInterval(activeDownloadHunt); activeDownloadHunt = null;
                    sendMetaThenClick(direct);
                    return;
                }
            }
            const zip = Array.from(document.querySelectorAll('button.download-menu-item')).find(btn => btn.innerText.includes('ZIP'));
            if (zip) { 
                clearInterval(activeDownloadHunt); activeDownloadHunt = null; sendMetaThenClick(zip); return;
            }
            const cooldown = document.body.innerText.match(/(?:wait|in|remaining|after|\u7b49\u5f85|\u5269\u4f59)[\s\S]{0,30}(\d+)\s*(?:seconds|\u79d2)/i);
            if (cooldown) chrome.runtime.sendMessage(withActiveJob({ action: 'STATUS_UPDATE', text: 'Waiting for cooldown' }));
            if (!isXxxHost()) {
                const main = Array.from(document.querySelectorAll('button')).find(btn => (btn.innerText.includes('Download') || btn.innerText.includes('\u4e0b\u8f7d')) && !btn.className.includes('download-menu-item'));
                if (main && !document.querySelector('button.download-menu-item')) main.click();
            }
            
            if (attempts > 75) { clearInterval(activeDownloadHunt); activeDownloadHunt = null; chrome.runtime.sendMessage(withActiveJob({ action: 'NOT_FOUND_TIMEOUT' })); }
        }, 400); 
        return true;
    }
});

injectWidget();
addQueueButtonsToList();
scheduleQueueButtonRefresh(800);
let qBootstrapRefreshCount = 0;
const qBootstrapRefreshTimer = setInterval(() => {
    scheduleQueueButtonRefresh(0);
    qBootstrapRefreshCount++;
    if (qBootstrapRefreshCount >= 8) clearInterval(qBootstrapRefreshTimer);
}, 1000);
window.addEventListener('load', () => scheduleQueueButtonRefresh(100));
window.addEventListener('resize', () => syncWidgetPositionForViewport({ persist: true }));
if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => syncWidgetPositionForViewport({ persist: true }));
}
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
        syncWidgetPositionForViewport({ persist: true });
        scheduleQueueButtonRefresh(100);
    }
});
function isOwnQueueNode(node) {
    return node?.nodeType === 1 && (
        node.id === 'q-widget-container'
        || node.classList?.contains('q-dl-btn')
        || node.closest?.('#q-widget-container')
        || node.closest?.('.q-dl-btn')
    );
}

function handleQueueDomMutations(mutations) {
    let sawPageNodes = false;
    let addedButtons = false;
    for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
            if (node.nodeType !== 1 || isOwnQueueNode(node)) continue;
            sawPageNodes = true;
            if (addQueueButtonsWithin(node)) addedButtons = true;
        }
    }
    if (addedButtons) scheduleQueueButtonRefresh(900);
    else if (sawPageNodes) scheduleQueueButtonRefresh(180);
}

new MutationObserver(handleQueueDomMutations).observe(document.body, { childList: true, subtree: true });
