console.log('Background - Ultimate Edition (Path Sanitizer, RAM Intercept, Cover Sync & Ultimate Stability)');

let isProcessing = false; 
let currentTabId = null, downloadGuardTimer = null, taskOverallTimer = null;   
let isWaitingForDownload = false, expectedDownloadUrlToken = ""; 
let processingTaskId = null; 

// In-memory preload queue with type labels for archive and cover downloads.
const pendingMemoryNav = []; 

const DOWNLOAD_TRIGGER_TIMEOUT_MS = 45000;
const DOWNLOAD_TRIGGER_ALARM_PREFIX = "downloadTriggerGuard:";
const QUEUE_WATCHDOG_ALARM = "queueWatchdog";
const QUEUE_WATCHDOG_INTERVAL_MINUTES = 1;
const AUTO_RECOVER_STALE_TASK_MS = 90000;
const TARGET_HOST_RE = /(^|\.)nhentai\.(?:net|xxx)$/i;
// nhentai.xxx fixed click cooldown.
const XXX_CLICK_COOLDOWN_MS = 18000;
const DEFAULT_NET_COOLDOWN_MS = 60000;
const SITE_KEYS = ["net", "xxx"];
const DEFAULT_Q_SETTINGS = { nameRule: "1", baseDir: "nHentai", useAuthor: false, lang: "en" };

function makeSiteState() {
    return {
        isProcessing: false,
        currentTabId: null,
        downloadGuardTimer: null,
        taskOverallTimer: null,
        isWaitingForDownload: false,
        expectedDownloadUrlToken: "",
        processingTaskId: null,
        downloadListenStartedAt: 0,
    };
}

const siteStates = {
    net: makeSiteState(),
    xxx: makeSiteState(),
};

const filenameTasksByDownloadId = new Map();
const cooldownStartedTaskIds = new Set();
const recentCompletedArchiveKeys = new Map();

function getSiteState(site) {
    return siteStates[site === "xxx" ? "xxx" : "net"];
}

function siteStateForTab(tabId) {
    return SITE_KEYS.map(getSiteState).find((state) => state.currentTabId === tabId) || null;
}

function siteStateForTask(taskId) {
    return SITE_KEYS.map(getSiteState).find((state) => state.processingTaskId === taskId) || null;
}

function taskSite(task) {
    return task?.site || siteFromUrl(task?.url || "");
}

function isWaitingStatus(status) {
    return String(status || "").includes("WAITING");
}

function isManualRecoverableStatus(status) {
    const value = String(status || "");
    if (!value) return false;
    if (isWaitingStatus(value) || value === "DOWNLOADING" || value.startsWith("FAILED")) return false;
    return true;
}

function isActiveTaskStatus(status) {
    const value = String(status || "");
    return value === "DOWNLOADING" || value.includes("Triggering download");
}


function isTriggeringDownloadStatus(status) {
    const value = String(status || "");
    return value.includes("Triggering download");
}

function hasActiveDownloadForSite(queue, site) {
    return queue.some((task) => isActiveTaskStatus(task.status) && !task.downloadId && taskSite(task) === site);
}

function queueTaskTimestampFromId(taskId) {
    const value = Number(String(taskId || "").split("-")[0]);
    return Number.isFinite(value) ? value : 0;
}

function queueTaskStatusAgeMs(task, now = Date.now()) {
    const updatedAt = Number(task?.statusUpdatedAt || task?.queuedAt || queueTaskTimestampFromId(task?.id) || 0);
    return updatedAt ? Math.max(0, now - updatedAt) : Number.POSITIVE_INFINITY;
}

async function activeArchiveDownloadCount(queue) {
    const ids = (queue || [])
        .filter((task) => task.status === "DOWNLOADING" && task.downloadId)
        .map((task) => Number(task.downloadId))
        .filter((id) => Number.isFinite(id));
    if (!ids.length) return 0;
    const results = await Promise.all(ids.map((id) => chrome.downloads.search({ id }).catch(() => [])));
    return results
        .flat()
        .filter((item) => item?.state === "in_progress" && !isImageDownloadItem(item))
        .length;
}

function downloadTriggerAlarmName(taskId) {
    return `${DOWNLOAD_TRIGGER_ALARM_PREFIX}${taskId}`;
}

function siteFromUrl(rawUrl) {
    try {
        const host = new URL(rawUrl).hostname;
        if (/(^|\.)nhentai\.xxx$/i.test(host)) return "xxx";
        if (/(^|\.)nhentai\.net$/i.test(host)) return "net";
    } catch (e) {}
    return "net";
}

function galleryIdFromUrl(rawUrl) {
    try {
        return new URL(rawUrl).pathname.match(/\/g\/(\d+)\/?/i)?.[1] || "";
    } catch (e) { return ""; }
}

function galleryKey(site, galleryId) {
    const id = String(galleryId || "");
    if (!id) return "";
    return `${site === "xxx" ? "xxx" : "net"}:${id}`;
}

function galleryKeyFromUrl(rawUrl) {
    const normalized = normalizeGalleryUrl(rawUrl);
    const source = normalized || rawUrl || "";
    return galleryKey(siteFromUrl(source), galleryIdFromUrl(source));
}

function galleryKeyFromTask(task) {
    const id = galleryIdFromUrl(task?.url || "");
    return galleryKey(taskSite(task), id);
}

function historyHasGallery(history, site, galleryId) {
    const key = galleryKey(site, galleryId);
    return Boolean(key && (history || []).some((url) => galleryKeyFromUrl(url) === key));
}

function queueHasGallery(queue, site, galleryId) {
    const key = galleryKey(site, galleryId);
    return Boolean(key && (queue || []).some((task) => galleryKeyFromTask(task) === key));
}

function pushHistoryUrl(history, rawUrl) {
    const cleanUrl = normalizeGalleryUrl(rawUrl) || rawUrl;
    const key = galleryKeyFromUrl(cleanUrl);
    if (key) {
        for (let i = history.length - 1; i >= 0; i--) {
            if (galleryKeyFromUrl(history[i]) === key) history.splice(i, 1);
        }
    } else {
        for (let i = history.length - 1; i >= 0; i--) {
            if (history[i] === cleanUrl) history.splice(i, 1);
        }
    }
    history.push(cleanUrl);
    if (history.length > 2000) history.splice(0, history.length - 2000);
}

function dedupeQueueByGallery(queue) {
    const bestIndexByKey = new Map();
    const scoreTask = (task, index) => {
        let score = 0;
        if (isWaitingStatus(task?.status)) score = 10;
        if (isTriggeringDownloadStatus(task?.status)) score = 20;
        if (task?.status === "DOWNLOADING") score = 30;
        if (task?.downloadId) score = 40;
        if (siteStateForTask(task?.id)) score = 50;
        return score * 1000000 + index;
    };
    queue.forEach((task, index) => {
        const key = galleryKeyFromTask(task);
        if (!key) return;
        const best = bestIndexByKey.get(key);
        if (!best || scoreTask(task, index) >= best.score) bestIndexByKey.set(key, { index, score: scoreTask(task, index) });
    });
    let changed = false;
    for (let i = queue.length - 1; i >= 0; i--) {
        const key = galleryKeyFromTask(queue[i]);
        if (!key) continue;
        if (bestIndexByKey.get(key)?.index !== i) {
            cooldownStartedTaskIds.delete(queue[i].id);
            queue.splice(i, 1);
            changed = true;
        }
    }
    return changed;
}

function downloadHaystack(downloadItem) {
    return [
        downloadItem?.url,
        downloadItem?.finalUrl,
        downloadItem?.referrer,
        downloadItem?.filename,
    ].filter(Boolean).join(" ").toLowerCase();
}

function isImageDownloadItem(downloadItem = {}) {
    const source = [downloadItem.url, downloadItem.finalUrl, downloadItem.filename].filter(Boolean).join(" ");
    return Boolean(downloadItem.mime?.startsWith("image/") || /\.(avif|gif|jpe?g|png|webp)(?:$|[?#])/i.test(source));
}

// Final size guard: reject fake archives below 150KB and HTML responses.
function isKnownArchiveDownloadItem(downloadItem = {}) {
    if (isImageDownloadItem(downloadItem)) return false;
    
    const mime = String(downloadItem.mime || "").toLowerCase();
    if (mime === 'text/html') return false;
    
    const size = downloadItem.fileSize || downloadItem.totalBytes || 0;
    if (size > 0 && size < 153600) return false; 

    const source = [downloadItem.filename, downloadItem.url, downloadItem.finalUrl].filter(Boolean).join(" ");
    return /\.(zip|cbz)(?:$|[?#])/i.test(source) || /(?:zip|cbz)/i.test(mime);
}

function isSuccessfulArchiveDownloadItem(downloadItem = {}) {
    if (!downloadItem || downloadItem.state !== "complete") return false;
    if (downloadItem.error) return false;
    if (!downloadItem.filename) return false;
    if (downloadItem.exists === false) return false;
    return isKnownArchiveDownloadItem(downloadItem);
}

function normalizedArchiveFilename(filename = "") {
    return String(filename || "")
        .split(/[\\/]/)
        .pop()
        .replace(/\s*\(\d+\)(?=\.(?:zip|cbz)$)/i, "")
        .toLowerCase();
}

function completedArchiveKey(downloadItem = {}) {
    const name = normalizedArchiveFilename(downloadItem.filename || "");
    const size = Number(downloadItem.fileSize || downloadItem.totalBytes || 0) || 0;
    return name && size ? `${name}:${size}` : "";
}

function rememberCompletedArchive(downloadItem = {}) {
    const key = completedArchiveKey(downloadItem);
    if (!key) return;
    const now = Date.now();
    for (const [existingKey, timestamp] of recentCompletedArchiveKeys) {
        if (now - timestamp > 120000) recentCompletedArchiveKeys.delete(existingKey);
    }
    recentCompletedArchiveKeys.set(key, now);
}

async function removeIfRecentDuplicateArchive(downloadItem = {}) {
    if (!isSuccessfulArchiveDownloadItem(downloadItem)) return false;
    const key = completedArchiveKey(downloadItem);
    const seenAt = key ? recentCompletedArchiveKeys.get(key) : 0;
    if (!seenAt || Date.now() - seenAt > 120000) return false;
    console.warn("remove untracked duplicate archive", downloadItem.id, downloadItem.filename);
    await chrome.downloads.removeFile(downloadItem.id).catch(() => {});
    return true;
}

async function findSuccessfulArchiveDownload(downloadId) {
    if (!downloadId) return null;
    const items = await chrome.downloads.search({ id: downloadId });
    const downloadItem = items[0] || null;
    return isSuccessfulArchiveDownloadItem(downloadItem) ? downloadItem : null;
}

function compactText(text) {
    return String(text || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function sanitizeFilenamePart(value) {
    let s = String(value || "");
    s = s.replace(/[\\/:*?"<>|~]/g, "_");
    s = s.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
    s = s.trim();
    s = s.replace(/^[.\s]+|[.\s]+$/g, "");
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(s)) s = s + "_";
    return s;
}

function safeTruncate(text, limit) {
    const arr = Array.from(String(text || ""));
    if (arr.length <= limit) return arr.join('');
    return arr.slice(0, limit).join('').trim();
}

function cleanDownloadPathSegments(value) {
    let normalized = String(value || "").replace(/\\/g, "/").replace(/^[a-z]:/i, "");
    normalized = normalized.replace(/^\/+/, "").replace(/\/+$/, "");
    const parts = normalized.split("/").map(sanitizeFilenamePart).filter(p => p.length > 0);
    if (parts[0] && /^downloads?$/i.test(parts[0])) parts.shift();
    return parts;
}

function downloadStartMs(downloadItem) {
    const parsed = Date.parse(downloadItem?.startTime || "");
    return Number.isFinite(parsed) ? parsed : Date.now();
}

function isDownloadForTask(downloadItem, task, state = null, allowLooseRecent = false) {
    if (!task) return false;
    const haystack = downloadHaystack(downloadItem);
    const galleryId = galleryIdFromUrl(task.url);
    if (galleryId && haystack.includes(galleryId)) return true;

    if (task.url && haystack.includes(String(task.url).toLowerCase())) return true;
    if (task.downloadUrl && haystack.includes(String(task.downloadUrl).toLowerCase())) return true;

    const titleKey = compactText(task.title).slice(0, 36);
    if (titleKey.length >= 12 && compactText(haystack).includes(titleKey)) return true;

    if (!allowLooseRecent || !state?.downloadListenStartedAt) return false;
    const taskSite = task.site || siteFromUrl(task.url);
    const startedAfterListen = downloadStartMs(downloadItem) >= state.downloadListenStartedAt - 2000;
    const withinListenWindow = Date.now() - state.downloadListenStartedAt < 45000;
    return taskSite === "xxx" && startedAfterListen && withinListenWindow;
}

function downloadGalleryIds(downloadItem = {}) {
    const haystack = downloadHaystack(downloadItem);
    return [...new Set(Array.from(haystack.matchAll(/\/g\/(\d+)(?:\/|$|\?)/gi)).map((match) => match[1]).filter(Boolean))];
}

function hasForeignGalleryId(downloadItem, task) {
    const taskGalleryId = galleryIdFromUrl(task?.url || "");
    const ids = downloadGalleryIds(downloadItem);
    return Boolean(taskGalleryId && ids.length && !ids.includes(String(taskGalleryId)));
}

function pendingArchiveMatchesDownload(intent, downloadItem) {
    if (!intent || intent.type !== "archive" || isImageDownloadItem(downloadItem)) return false;
    if (hasForeignGalleryId(downloadItem, { url: intent.taskUrl })) return false;
    const haystack = downloadHaystack(downloadItem);
    const taskUrl = String(intent.taskUrl || "").toLowerCase();
    if (taskUrl && haystack.includes(taskUrl)) return true;
    if (intent.galleryId && new RegExp(`/g/${String(intent.galleryId)}(?:/|$|\\?)`, "i").test(haystack)) return true;
    const state = siteStateForTask(intent.taskId);
    const startedAfterListen = !state?.downloadListenStartedAt || downloadStartMs(downloadItem) >= state.downloadListenStartedAt - 3000;
    const withinListenWindow = state?.downloadListenStartedAt && Date.now() - state.downloadListenStartedAt < DOWNLOAD_TRIGGER_TIMEOUT_MS;
    return Boolean(state && state.processingTaskId === intent.taskId && startedAfterListen && withinListenWindow);
}

function hintedSiteFromDownload(downloadItem) {
    const haystack = downloadHaystack(downloadItem);
    if (haystack.includes("nhentai.xxx")) return "xxx";
    if (haystack.includes("nhentai.net")) return "net";
    return null;
}

function findActiveTaskForDownload(downloadItem, queue) {
    const hintedSite = hintedSiteFromDownload(downloadItem);
    const stateOrder = hintedSite ? [hintedSite, ...SITE_KEYS.filter((site) => site !== hintedSite)] : SITE_KEYS;
    for (const site of stateOrder) {
        const state = getSiteState(site);
        const task = queue.find(q => q.id === state.processingTaskId);
        if (!task) continue;
        if (isDownloadForTask(downloadItem, task, state, false) || isDownloadForTask(downloadItem, task, state, true)) return task;
    }
    return queue.find((task) => {
        const taskSiteName = taskSite(task);
        if (hintedSite && taskSiteName !== hintedSite) return false;
        return task.status === "DOWNLOADING" && isDownloadForTask(downloadItem, task, null, false);
    }) || null;
}

function findCurrentTaskForFilename(downloadItem, queue) {
    const hintedSite = hintedSiteFromDownload(downloadItem);
    const stateOrder = hintedSite ? [hintedSite, ...SITE_KEYS.filter((site) => site !== hintedSite)] : ["xxx", "net"];
    for (const site of stateOrder) {
        const state = getSiteState(site);
        if (!state?.processingTaskId) continue;
        const task = queue.find(q => q.id === state.processingTaskId);
        if (!task) continue;
        const startedAfterListen = !state.downloadListenStartedAt || downloadStartMs(downloadItem) >= state.downloadListenStartedAt - 3000;
        const stillExpectingDownload = state.isWaitingForDownload || Date.now() - state.downloadListenStartedAt < 45000;
        if (taskSite(task) === site && startedAfterListen && stillExpectingDownload) return task;
    }
    return null;
}

function siteLabel(site) { return site === "xxx" ? "nhentai.xxx" : "nhentai.net"; }

function emptySiteCooldowns() { return { net: { until: 0, total: 0 }, xxx: { until: 0, total: 0 } }; }

function normalizeSiteCooldowns(data = {}) {
    const cooldowns = emptySiteCooldowns();
    const raw = data.siteCooldowns || {};
    SITE_KEYS.forEach((site) => { cooldowns[site] = { until: Number(raw[site]?.until) || 0, total: Number(raw[site]?.total) || 0 }; });
    if (data.globalCooldownUntil && data.globalCooldownUntil > Date.now()) {
        cooldowns.net = { until: Number(data.globalCooldownUntil) || 0, total: Number(data.cooldownTotal) || DEFAULT_NET_COOLDOWN_MS };
    }
    return cooldowns;
}

function normalizeQueueSites(queue) {
    let changed = false;
    queue.forEach((task) => {
        const site = siteFromUrl(task.url);
        if (task.site !== site) { task.site = site; changed = true; }
    });
    return changed;
}

function resetStaleTransientStatuses(queue) {
    let changed = false;
    queue.forEach((task) => {
        if (task.status === "DOWNLOADING") return;
        if (!isActiveTaskStatus(task.status)) return;
        if (siteStateForTask(task.id)) return;
        task.status = "WAITING (System reset)";
        delete task.triggerStartedAt;
        changed = true;
    });
    return changed;
}

function isSiteCooling(siteCooldowns, site, now = Date.now()) {
    return Boolean(siteCooldowns?.[site]?.until && siteCooldowns[site].until > now);
}

function nextCooldownDelayMs(siteCooldowns, now = Date.now()) {
    const nextUntil = SITE_KEYS.map((site) => Number(siteCooldowns?.[site]?.until) || 0).filter((until) => until > now).sort((a, b) => a - b)[0];
    return nextUntil ? Math.max(100, nextUntil - now) : 0;
}

async function saveSiteCooldown(site, durationMs) {
    const data = await chrome.storage.local.get({ siteCooldowns: emptySiteCooldowns() });
    const siteCooldowns = normalizeSiteCooldowns(data);
    siteCooldowns[site] = { until: Date.now() + durationMs, total: durationMs };
    await chrome.storage.local.set({ siteCooldowns, globalCooldownUntil: 0, cooldownTotal: 0 });
    chrome.alarms.create(`siteCooldown:${site}`, { delayInMinutes: Math.max(durationMs / 60000, 1 / 60) });
}

async function startDownloadCooldown(site, taskId) {
    if (site !== "xxx" || !taskId || cooldownStartedTaskIds.has(taskId)) return;
    cooldownStartedTaskIds.add(taskId);
    await saveSiteCooldown("xxx", XXX_CLICK_COOLDOWN_MS);
    setTimeout(() => processQueue("xxx"), XXX_CLICK_COOLDOWN_MS + 250);
}

function scheduleNextCooldownAlarm(siteCooldowns) {
    const delayMs = nextCooldownDelayMs(siteCooldowns);
    if (delayMs) chrome.alarms.create('siteCooldown:next', { delayInMinutes: Math.max(delayMs / 60000, 1 / 60) });
}

function normalizeGalleryUrl(rawUrl) {
    try {
        const url = new URL(rawUrl);
        if (!TARGET_HOST_RE.test(url.hostname)) return null;
        const galleryId = url.pathname.match(/^\/g\/(\d+)(?:\/|$)/)?.[1];
        if (!galleryId) return null;
        url.pathname = `/g/${galleryId}/`;
        url.hash = ""; url.search = ""; return url.href;
    } catch (e) { return null; }
}

chrome.action.onClicked.addListener(() => {});

function extractGalleryId(value) {
    const match = String(value || "").match(/\/g\/(\d+)/) || String(value || "").match(/(?:^|[^\d])(\d{3,8})(?:$|[^\d])/);
    return match ? match[1] : "";
}

function extFromDownloadSource(downloadItem = {}, fallbackUrl = "") {
    const candidates = [downloadItem.filename, downloadItem.url, downloadItem.finalUrl, fallbackUrl];
    for (const candidate of candidates) {
        const match = String(candidate || "").match(/\.(zip|cbz)(?:$|[?#])/i);
        if (match) return `.${match[1].toLowerCase()}`;
    }
    return ".zip";
}

function buildDownloadFilename(task, settings = DEFAULT_Q_SETTINGS, downloadItem = {}) {
    const setts = { ...DEFAULT_Q_SETTINGS, ...(settings || {}), useAuthor: false };
    const meta = task?.meta || {};
    const sanitize = sanitizeFilenamePart;

    let tTrans = meta.titleTrans ? sanitize(meta.titleTrans) : "";
    let tOrig = meta.titleOrig ? sanitize(meta.titleOrig) : "";
    let baseTitle = task?.title || downloadItem.filename || `Gallery ${extractGalleryId(task?.url) || task?.id || downloadItem.id || Date.now()}`;

    let finalTitle = sanitize(baseTitle) || "Untitled";

    if (setts.nameRule === "1") finalTitle = tTrans || tOrig || finalTitle;
    else if (setts.nameRule === "2") finalTitle = tOrig || tTrans || finalTitle;
    else if (setts.nameRule === "3") {
        if (tTrans && tOrig) finalTitle = `${tTrans} ${tOrig}`;
        else finalTitle = tTrans || tOrig || finalTitle;
    }

    finalTitle = sanitize(finalTitle) || "Untitled";
    finalTitle = safeTruncate(finalTitle, 80);
    finalTitle = sanitize(finalTitle) || "Untitled";

    let finalAuthor = "";
    if (setts.useAuthor) {
        if (meta.groups && meta.groups.length > 0) finalAuthor = sanitize(meta.groups[0]);
        else if (meta.artists && meta.artists.length > 0) finalAuthor = sanitize(meta.artists[0]);
        finalAuthor = safeTruncate(finalAuthor, 40);
        finalAuthor = sanitize(finalAuthor) || "Unknown Artist";
    }

    const pathParts = [];
    if (setts.baseDir) pathParts.push(...cleanDownloadPathSegments(setts.baseDir));
    if (finalAuthor) pathParts.push(finalAuthor);

    const ext = extFromDownloadSource(downloadItem, task?.downloadUrl || "");
    pathParts.push(`${finalTitle}${ext}`);

    return pathParts.filter(Boolean).join("/");
}

async function confirmFinishedTaskDownload(task) {
    const downloadItem = await findSuccessfulArchiveDownload(task.downloadId);
    if (!downloadItem) {
        console.warn("download completion skipped: download is not a completed archive", task?.downloadId, task?.url);
        return false;
    }
    if (hasForeignGalleryId(downloadItem, task)) {
        console.warn("download completion skipped: download gallery mismatch", task?.url, downloadItem?.url, downloadItem?.referrer);
        return false;
    }
    rememberCompletedArchive(downloadItem);
    return true;
}

async function finishQueueTaskFromDownload(queue, history, index, downloadItem) {
    if (index < 0 || !downloadItem?.id) return false;
    const finishedTask = queue.splice(index, 1)[0];
    finishedTask.downloadId = downloadItem.id;
    cooldownStartedTaskIds.delete(finishedTask.id);
    await clearActiveDownloadIntentForTask(finishedTask.id);
    const confirmed = await confirmFinishedTaskDownload(finishedTask).catch(error => {
        console.warn("download confirmation failed", error);
        return false;
    });
    if (!confirmed) {
        finishedTask.status = 'WAITING (Download content mismatch retry)';
        delete finishedTask.downloadId;
        queue.push(finishedTask);
        return false;
    }
    pushHistoryUrl(history, finishedTask.url);
    return true;
}

configureQueueWatchdog();
resetOrphanedTasks();

function configureQueueWatchdog() {
    chrome.alarms.create(QUEUE_WATCHDOG_ALARM, { periodInMinutes: QUEUE_WATCHDOG_INTERVAL_MINUTES });
}

async function autoRecoverStaleQueue() {
    return manualRecoverQueue({
        recoverActiveStale: true,
        staleOnly: true,
        statusText: "WAITING (auto resume)",
    });
}

async function resetOrphanedTasks() {
    await syncDownloadStates(); 
    let d = await chrome.storage.local.get({ queue: [] });
    let changed = false;
    d.queue.forEach(q => {
        if (!q.status) { q.status = 'WAITING'; changed = true; }
        if (isActiveTaskStatus(q.status) && q.status !== 'DOWNLOADING') {
            q.status = 'WAITING (System reset)'; changed = true;
        }
        if (!q.status.includes('WAITING') && !isActiveTaskStatus(q.status) && !q.status.startsWith('FAILED')) {
            q.status = 'WAITING (System reset)'; changed = true;
        }
    });
    if (changed) await chrome.storage.local.set({ queue: d.queue });
    processQueue();
}

async function syncDownloadStates() {
    let d = await chrome.storage.local.get({ queue: [], history: [] });
    let queue = d.queue, history = d.history, changed = false;
    let recentDownloads = null;
    const completedSites = new Set();

    changed = dedupeQueueByGallery(queue) || changed;

    for (let i = queue.length - 1; i >= 0; i--) {
        let q = queue[i];
        if (q.status === 'DOWNLOADING' && q.downloadId) {
            let dls = await chrome.downloads.search({ id: q.downloadId });
            let dl = dls[0];
            if (!dl) { q.status = 'WAITING (Task lost retry)'; delete q.downloadId; changed = true; }
            else if (dl.state === 'complete' && !isSuccessfulArchiveDownloadItem(dl)) {
                if (dl.exists !== false) chrome.downloads.removeFile(dl.id).catch(() => {});
                q.status = 'WAITING (download result invalid retry)';
                delete q.downloadId;
                changed = true;
            }
            else if (isSuccessfulArchiveDownloadItem(dl)) {
                console.log('Recovered missed completed download during cross-check:', dl.id);
                let finishedTask = queue.splice(i, 1)[0];
                cooldownStartedTaskIds.delete(finishedTask.id);
                completedSites.add(taskSite(finishedTask));
                const confirmed = await confirmFinishedTaskDownload(finishedTask).catch(error => { console.warn("download confirmation failed", error); return false; });
                if (!confirmed) {
                    finishedTask.status = 'WAITING (Download content mismatch retry)';
                    delete finishedTask.downloadId;
                    queue.push(finishedTask);
                    changed = true;
                    continue;
                }
                pushHistoryUrl(history, finishedTask.url);
                changed = true;
            } else if (dl.state === 'interrupted') { cooldownStartedTaskIds.delete(q.id); q.status = 'WAITING (Download interrupted retry)'; delete q.downloadId; changed = true; }
        } else if (q.status === 'DOWNLOADING' && !q.downloadId) {
            recentDownloads = recentDownloads || await chrome.downloads.search({ orderBy: ["-startTime"], limit: 50 });
            const state = siteStateForTask(q.id);
            const matched = recentDownloads
                .filter(dl => !isImageDownloadItem(dl))
                .find(dl => isDownloadForTask(dl, q, state, false) || isDownloadForTask(dl, q, state, true));
            if (isSuccessfulArchiveDownloadItem(matched)) {
                console.log('Recovered completed task that was DOWNLOADING without a bound download id:', matched.id);
                completedSites.add(taskSite(q));
                await finishQueueTaskFromDownload(queue, history, i, matched);
                changed = true;
                continue;
            }
            if (matched?.state === "in_progress") {
                q.downloadId = matched.id;
                q.status = "DOWNLOADING";
                q.site = taskSite(q);
                filenameTasksByDownloadId.set(matched.id, { ...q });
                changed = true;
                continue;
            }
            q.status = 'WAITING (Status abnormal retry)';
            changed = true;
        } 
        else if (isTriggeringDownloadStatus(q.status) && !q.downloadId) {
            const triggerStartedAt = Number(q.triggerStartedAt || 0);
            if (!triggerStartedAt) {
                q.triggerStartedAt = Date.now();
                changed = true;
                continue;
            }
            if (Date.now() - triggerStartedAt <= DOWNLOAD_TRIGGER_TIMEOUT_MS) continue;

            recentDownloads = recentDownloads || await chrome.downloads.search({ orderBy: ["-startTime"], limit: 50 });
            const state = siteStateForTask(q.id);
            const matched = recentDownloads
                .filter(dl => !isImageDownloadItem(dl))
                .find(dl => isDownloadForTask(dl, q, state, false) || isDownloadForTask(dl, q, state, true));
            if (isSuccessfulArchiveDownloadItem(matched)) {
                console.log('Recovered completed task before trigger timeout:', matched.id);
                const finishedTask = queue.splice(i, 1)[0]; finishedTask.downloadId = matched.id;
                delete finishedTask.triggerStartedAt;
                cooldownStartedTaskIds.delete(finishedTask.id);
                completedSites.add(taskSite(finishedTask));
                const confirmed = await confirmFinishedTaskDownload(finishedTask).catch(error => { console.warn("download confirmation failed", error); return false; });
                if (!confirmed) {
                    finishedTask.status = 'WAITING (Download content mismatch retry)';
                    delete finishedTask.downloadId;
                    queue.push(finishedTask);
                    changed = true;
                    continue;
                }
                pushHistoryUrl(history, finishedTask.url);
                changed = true;
                continue;
            }
            if (matched?.state === "in_progress") {
                q.downloadId = matched.id; q.status = "DOWNLOADING"; delete q.triggerStartedAt;
                filenameTasksByDownloadId.set(matched.id, { ...q });
                await startDownloadCooldown(taskSite(q), q.id);
                await releaseSiteAfterDownloadStarted(q, { site: taskSite(q), state });
                changed = true;
                continue;
            }

            const failedTask = queue.splice(i, 1)[0];
            const failedState = siteStateForTask(failedTask.id);
            if (failedState) {
                clearAllTimers(failedState);
                failedState.isWaitingForDownload = false; failedState.expectedDownloadUrlToken = ""; failedState.downloadListenStartedAt = 0;
                failedState.processingTaskId = null; failedState.isProcessing = false;
            }
            await closeTaskTab(failedTask.id, failedState);
            cooldownStartedTaskIds.delete(failedTask.id);
            await clearActiveDownloadIntentForTask(failedTask.id);
            failedTask.retries = (failedTask.retries || 0) + 1;
            delete failedTask.downloadId; delete failedTask.triggerStartedAt;
            failedTask.status = `WAITING (Download trigger no response retry ${failedTask.retries})`;
            queue.push(failedTask);
            changed = true;
        }
        else if (q.status?.startsWith('FAILED')) {
            recentDownloads = recentDownloads || await chrome.downloads.search({ state: "complete", orderBy: ["-startTime"], limit: 50 });
            const matched = recentDownloads.find(dl => isSuccessfulArchiveDownloadItem(dl) && isDownloadForTask(dl, q, null, false));
            if (matched) {
                console.log('Cleared completed task stuck in failed state during cross-check:', matched.id);
                const finishedTask = queue.splice(i, 1)[0]; finishedTask.downloadId = matched.id;
                cooldownStartedTaskIds.delete(finishedTask.id);
                completedSites.add(taskSite(finishedTask));
                const confirmed = await confirmFinishedTaskDownload(finishedTask).catch(error => { console.warn("download confirmation failed", error); return false; });
                if (!confirmed) {
                    finishedTask.status = 'WAITING (Download content mismatch retry)';
                    delete finishedTask.downloadId;
                    queue.push(finishedTask);
                    changed = true;
                    continue;
                }
                pushHistoryUrl(history, finishedTask.url);
                changed = true;
            }
        }
    }
    if (changed) { await chrome.storage.local.set({ queue: queue, history: history }); }
}

function clearAllTimers(state) { 
    if (!state) { SITE_KEYS.forEach((site) => clearAllTimers(getSiteState(site))); return; }
    if (state.downloadGuardTimer) clearTimeout(state.downloadGuardTimer); 
    if (state.taskOverallTimer) clearTimeout(state.taskOverallTimer); 
    state.downloadGuardTimer = null; state.taskOverallTimer = null;
}

async function prepareDownloadTracking(state, options = {}) {
    const taskId = options.taskId || state?.processingTaskId || "";
    if (!taskId) return false;

    const data = await chrome.storage.local.get({ queue: [], activeDownloadIntent: null, qSettings: DEFAULT_Q_SETTINGS });
    const taskIndex = data.queue.findIndex(q => q.id === taskId);
    const task = taskIndex !== -1 ? data.queue[taskIndex] : null;
    const site = options.site || task?.site || siteFromUrl(task?.url || "");
    const token = String(task?.url || "").toLowerCase();
    const startedAt = Date.now();
    const existingStartedAt = Number(data.activeDownloadIntent?.startedAt || 0);

    if (state?.isWaitingForDownload && state.processingTaskId === taskId && data.activeDownloadIntent?.taskId === taskId && startedAt - existingStartedAt < 10000) {
        return true;
    }

    if (task) {
        for (let i = pendingMemoryNav.length - 1; i >= 0; i--) {
            if (pendingMemoryNav[i].taskId === task.id) pendingMemoryNav.splice(i, 1);
        }

        let path = buildDownloadFilename(task, data.qSettings, { filename: "archive.zip", url: task.url });
        if (!path.endsWith('.zip') && !path.endsWith('.cbz')) path += '.zip';
        
        pendingMemoryNav.push({
            type: 'archive',
            taskId: task.id,
            site: site,
            taskUrl: task.url,
            galleryId: galleryIdFromUrl(task.url),
            path: path,
            timestamp: Date.now()
        });
        console.log("[archive path prepared] ->", path);

        if (task.meta && task.meta.coverUrl) {
            let coverExt = ".jpg";
            const match = task.meta.coverUrl.match(/\.(jpe?g|png|gif|webp)(\?.*)?$/i);
            if (match) coverExt = `.${match[1].toLowerCase()}`;
            
            let baseName = path.replace(/\.(zip|cbz)$/i, '');
            let coverPath = `${baseName}_cover${coverExt}`;
            
            pendingMemoryNav.push({
                type: 'cover',
                taskId: task.id,
                site: site,
                url: task.meta.coverUrl,
                path: coverPath,
                timestamp: Date.now()
            });

            const referer = site === "xxx" ? "https://nhentai.xxx/" : "https://nhentai.net/";
            
            chrome.downloads.download({
                url: task.meta.coverUrl,
                filename: coverPath,
                conflictAction: "overwrite",
                saveAs: false,
                headers: [{ name: "Referer", value: referer }]
            }, (dlId) => {
                if (chrome.runtime.lastError) {
                    console.warn("Cover download was blocked:", chrome.runtime.lastError);
                } else {
                    console.log("Cover file download started ->", coverPath);
                }
            });
        }
    }

    if (state) {
        state.processingTaskId = taskId; state.isWaitingForDownload = true;
        state.downloadListenStartedAt = startedAt; state.expectedDownloadUrlToken = token;
        clearAllTimers(state);
        
        // Keep a 90 second wait window.
        state.downloadGuardTimer = setTimeout(() => {
            state.isWaitingForDownload = false; state.expectedDownloadUrlToken = "";
            failCurrentTask('No response', state);
        }, DOWNLOAD_TRIGGER_TIMEOUT_MS); 
    }
    chrome.alarms.create(downloadTriggerAlarmName(taskId), { delayInMinutes: Math.max(0.5, DOWNLOAD_TRIGGER_TIMEOUT_MS / 60000) });

    if (site === "xxx" && taskIndex !== -1 && !data.queue[taskIndex].downloadId) {
        data.queue[taskIndex].site = "xxx"; data.queue[taskIndex].status = 'DOWNLOADING';
        await chrome.storage.local.set({ queue: data.queue });
    }

    await chrome.storage.local.set({ activeDownloadIntent: { taskId, site, tabId: options.tabId || 0, token, startedAt } });
    return true;
}

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === QUEUE_WATCHDOG_ALARM) {
        autoRecoverStaleQueue().then(() => processQueue()).catch((error) => console.warn("queue watchdog failed", error));
    } else if (alarm.name === 'rateLimitCooldown' || alarm.name.startsWith('siteCooldown:')) {
        chrome.storage.local.get({ siteCooldowns: emptySiteCooldowns() }).then((data) => {
            const siteCooldowns = normalizeSiteCooldowns(data);
            const now = Date.now(); let changed = false;
            SITE_KEYS.forEach((site) => {
                if (siteCooldowns[site].until && siteCooldowns[site].until <= now) { siteCooldowns[site] = { until: 0, total: 0 }; changed = true; }
            });
            const saved = changed ? chrome.storage.local.set({ siteCooldowns, globalCooldownUntil: 0, cooldownTotal: 0 }) : Promise.resolve();
            saved.then(() => { processQueue(); });
        });
    } else if (alarm.name.startsWith(DOWNLOAD_TRIGGER_ALARM_PREFIX)) {
        syncDownloadStates().then(() => processQueue());
    }
});

chrome.downloads.onCreated.addListener(async (downloadItem) => {
    const url = (downloadItem.url || '').toLowerCase(), ref = (downloadItem.referrer || '').toLowerCase();
    
    if (isImageDownloadItem(downloadItem)) {
        return; 
    }

    const hintedSite = hintedSiteFromDownload(downloadItem);
    const data = await chrome.storage.local.get({ queue: [], activeDownloadIntent: null });
    const taskByState = new Map(SITE_KEYS.map((site) => {
        const state = getSiteState(site); const task = data.queue.find(q => q.id === state.processingTaskId) || null; return [state, task];
    }));
    const stateOrder = hintedSite ? [hintedSite, ...SITE_KEYS.filter((site) => site !== hintedSite)] : SITE_KEYS;
    let matchedState = stateOrder.map(getSiteState).find((state) => {
        if (!state.isWaitingForDownload) return false;
        const task = taskByState.get(state);
        if (isDownloadForTask(downloadItem, task, state, false)) return true;
        const tokenMatch = state.expectedDownloadUrlToken.match(/\/g\/(\d+)/i);
        const token = tokenMatch ? tokenMatch[1] : state.expectedDownloadUrlToken;
        return Boolean(token && (url.includes(token) || ref.includes(token)));
    });
    if (!matchedState) {
        matchedState = stateOrder.map(getSiteState).find((state) => {
            if (!state.isWaitingForDownload) return false;
            const task = taskByState.get(state);
            const taskSite = task?.site || siteFromUrl(task?.url || "");
            if (hintedSite && taskSite !== hintedSite) return false;
            return isDownloadForTask(downloadItem, task, state, true);
        });
    }
    if (!matchedState) {
        const intentTask = recentIntentTaskForDownload(downloadItem, data.queue, data.activeDownloadIntent);
        const intentSite = data.activeDownloadIntent?.site || taskSite(intentTask);
        if (intentTask) {
            matchedState = getSiteState(intentSite); matchedState.processingTaskId = intentTask.id;
            matchedState.currentTabId = data.activeDownloadIntent?.tabId || matchedState.currentTabId;
            taskByState.set(matchedState, intentTask);
        }
    }
    if (!matchedState) return;
    
    {
        console.log('Archive download ID assigned; tracking main flow:', downloadItem.id);
        matchedState.isWaitingForDownload = false; matchedState.expectedDownloadUrlToken = ""; matchedState.downloadListenStartedAt = 0; clearAllTimers(matchedState); 

        let queue = data.queue;
        let index = queue.findIndex(q => q.id === matchedState.processingTaskId);
        let completedSite = SITE_KEYS.find((site) => getSiteState(site) === matchedState) || "net";

        if (index !== -1) {
            const boundTask = await bindDownloadToTask(data, queue[index], downloadItem.id, { status: 'DOWNLOADING' });
            if (!boundTask) return;
            completedSite = queue[index].site || "net";
        }

        if (index !== -1) {
            await releaseSiteAfterDownloadStarted(queue[index], { site: completedSite, state: matchedState });
        }
    }
});

chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
    const now = Date.now();
    
    for (let i = pendingMemoryNav.length - 1; i >= 0; i--) {
        if (now - pendingMemoryNav[i].timestamp > 60000) { pendingMemoryNav.splice(i, 1); }
    }

    const isImage = isImageDownloadItem(downloadItem);

    let matchedIndex = pendingMemoryNav.findIndex(d => {
        if (d.type === 'cover') {
            return isImage && downloadItem.url.split('?')[0] === d.url.split('?')[0];
        } else {
            return pendingArchiveMatchesDownload(d, downloadItem);
        }
    });

    if (matchedIndex !== -1) {
        const upcoming = pendingMemoryNav.splice(matchedIndex, 1)[0];
        console.log(`[memory match - ${upcoming.type}] Injecting same-origin path:`, upcoming.path);
        
        if (upcoming.type === 'archive') {
            for (let i = pendingMemoryNav.length - 1; i >= 0; i--) {
                if (pendingMemoryNav[i].type === 'archive' && pendingMemoryNav[i].taskId === upcoming.taskId) pendingMemoryNav.splice(i, 1);
            }

            chrome.storage.local.get({queue: []}, async (data) => {
                let index = data.queue.findIndex(q => q.id === upcoming.taskId);
                if (index !== -1) {
                    if (await shouldKeepExistingTaskDownload(data.queue[index], downloadItem.id)) {
                        await cancelDuplicateArchiveDownload(downloadItem.id, `filename event for task ${upcoming.taskId}`);
                        return;
                    }
                    if (data.queue[index].downloadId && Number(data.queue[index].downloadId) !== Number(downloadItem.id)) {
                        filenameTasksByDownloadId.delete(Number(data.queue[index].downloadId));
                    }
                    data.queue[index].downloadId = downloadItem.id;
                    data.queue[index].status = 'DOWNLOADING';
                    await chrome.storage.local.set({queue: data.queue});
                    filenameTasksByDownloadId.set(downloadItem.id, data.queue[index]);
                    startDownloadCooldown(data.queue[index].site || siteFromUrl(data.queue[index].url), data.queue[index].id).catch(() => {});
                    releaseSiteAfterDownloadStarted(data.queue[index], { site: data.queue[index].site || siteFromUrl(data.queue[index].url) }).catch(() => {});
                }
            });
        }

        setTimeout(() => {
            suggest({ filename: upcoming.path, conflictAction: 'uniquify' });
        }, 0);
        return true; 
    }

    if (!isImage) {
        handleFilenameAsync(downloadItem, suggest);
        return true; 
    } else {
        setTimeout(() => suggest(), 0);
        return true;
    }
});

async function handleFilenameAsync(downloadItem, suggest) {
    let d = await chrome.storage.local.get({ queue: [], qSettings: DEFAULT_Q_SETTINGS, activeDownloadIntent: null });
    let task = d.queue.find(q => q.downloadId === downloadItem.id) || filenameTasksByDownloadId.get(downloadItem.id);
    let retries = 0;
    while (!task && retries < 15) {
        await new Promise(r => setTimeout(r, 80));
        d = await chrome.storage.local.get({ queue: [], qSettings: DEFAULT_Q_SETTINGS, activeDownloadIntent: null });
        task = d.queue.find(q => q.downloadId === downloadItem.id) || filenameTasksByDownloadId.get(downloadItem.id);
        retries++;
    }

    if (!task) {
        task = recentIntentTaskForDownload(downloadItem, d.queue, d.activeDownloadIntent)
            || findActiveTaskForDownload(downloadItem, d.queue)
            || findCurrentTaskForFilename(downloadItem, d.queue)
            || fallbackTaskFromRecentXxxIntent(downloadItem, d.activeDownloadIntent);
        if (task) {
            task = await bindDownloadToTask(d, task, downloadItem.id, { status: "DOWNLOADING" });
            if (task) await releaseSiteAfterDownloadStarted(task);
        }
    }

    if (task) {
        const unifiedPath = buildDownloadFilename(task, d.qSettings, downloadItem);
        console.log("Async fallback match succeeded:", unifiedPath);
        setTimeout(() => suggest({ filename: unifiedPath, conflictAction: 'uniquify' }), 0);
    } else {
        console.log("Allowing intercept: task metadata not found", downloadItem.id);
        setTimeout(() => suggest(), 0);
    }
}

chrome.downloads.onChanged.addListener((delta) => { if (!delta.state) return; handleDownloadChange(delta, 0); });

async function handleDownloadChange(delta, retryCount = 0) {
    let data = await chrome.storage.local.get({ queue: [], history: [] });
    let queue = data.queue, history = data.history;
    let index = queue.findIndex(q => q.downloadId === delta.id);

    if (index === -1) {
        if (delta.state.current === 'complete') {
            const items = await chrome.downloads.search({ id: delta.id }).catch(() => []);
            const downloadItem = items[0] || null;
            if (isSuccessfulArchiveDownloadItem(downloadItem)) {
                const matchedTask = findActiveTaskForDownload(downloadItem, queue)
                    || queue.find(task => task.status === "DOWNLOADING" && !task.downloadId && isDownloadForTask(downloadItem, task, siteStateForTask(task.id), false));
                const matchedIndex = matchedTask ? queue.findIndex(task => task.id === matchedTask.id) : -1;
                if (matchedIndex !== -1) {
                    console.log('Recovered completed download before id binding finished:', delta.id);
                    await finishQueueTaskFromDownload(queue, history, matchedIndex, downloadItem);
                    await chrome.storage.local.set({ queue, history });
                    processQueue(taskSite(matchedTask));
                    return;
                }
            }
            if (await removeIfRecentDuplicateArchive(downloadItem)) return;
        }
        if (retryCount < 5) setTimeout(() => handleDownloadChange(delta, retryCount + 1), 500);
        return;
    }

    if (delta.state.current === 'complete') {
        let dls = await chrome.downloads.search({ id: delta.id });
        let dl = dls[0];
        if (!isSuccessfulArchiveDownloadItem(dl)) {
            console.log('Download completed but is not a usable archive; retrying task:', delta.id, dl?.state, dl?.mime, dl?.fileSize || dl?.totalBytes || 0, dl?.exists);
            if (dl?.exists !== false) chrome.downloads.removeFile(delta.id).catch(() => {});
            filenameTasksByDownloadId.delete(delta.id);
            let failedTask = queue.splice(index, 1)[0];
            cooldownStartedTaskIds.delete(failedTask.id);
            await clearActiveDownloadIntentForTask(failedTask.id);
            const failedSite = taskSite(failedTask);
            failedTask.status = 'WAITING (download result invalid retry)';
            delete failedTask.downloadId;
            queue.push(failedTask);
            await chrome.storage.local.set({ queue: queue });
            if (failedSite === "xxx") {
                await saveSiteCooldown("xxx", XXX_CLICK_COOLDOWN_MS);
                setTimeout(() => processQueue("xxx"), XXX_CLICK_COOLDOWN_MS + 250);
            } else {
                processQueue(failedSite);
            }
            return;
        }

        // Keep MIME type and file size validation.
        if (dl && (dl.mime === 'text/html' || (dl.fileSize > 0 && dl.fileSize < 256000))) {
            console.log('Detected false success (bad size or HTML error page); forcing retry flow:', delta.id);
            chrome.downloads.removeFile(delta.id).catch(() => {});
            
            filenameTasksByDownloadId.delete(delta.id);
            let failedTask = queue.splice(index, 1)[0];
            cooldownStartedTaskIds.delete(failedTask.id);
            await clearActiveDownloadIntentForTask(failedTask.id);
            
            const failedSite = taskSite(failedTask);
            failedTask.status = 'WAITING (Server protection or no response retry)';
            delete failedTask.downloadId; 
            queue.push(failedTask); 
            
            await chrome.storage.local.set({ queue: queue });
            
            if (failedSite === "xxx") {
                await saveSiteCooldown("xxx", XXX_CLICK_COOLDOWN_MS); 
                setTimeout(() => processQueue("xxx"), XXX_CLICK_COOLDOWN_MS + 250);
            } else { 
                processQueue(failedSite); 
            }
            return;
        }

        console.log('Archive download completed; removing task:', delta.id);
        filenameTasksByDownloadId.delete(delta.id);
        let finishedTask = queue.splice(index, 1)[0];
        cooldownStartedTaskIds.delete(finishedTask.id);
        await clearActiveDownloadIntentForTask(finishedTask.id);
        const finishedSite = taskSite(finishedTask);
        const confirmedDownload = await confirmFinishedTaskDownload(finishedTask).catch(error => {
            console.warn("download confirmation failed", error);
            return false;
        });
        if (!confirmedDownload) {
            if (dl?.exists !== false) chrome.downloads.removeFile(delta.id).catch(() => {});
            finishedTask.status = 'WAITING (Download content mismatch retry)';
            delete finishedTask.downloadId;
            queue.push(finishedTask);
            await chrome.storage.local.set({ queue });
            processQueue(finishedSite);
            return;
        }
        pushHistoryUrl(history, finishedTask.url);
        await chrome.storage.local.set({ queue: queue, history: history });
        
        processQueue(finishedSite);
    } else if (delta.state.current === 'interrupted') {
        console.log('Archive download interrupted; returning task to queue:', delta.id);
        filenameTasksByDownloadId.delete(delta.id);
        let failedTask = queue.splice(index, 1)[0];
        cooldownStartedTaskIds.delete(failedTask.id);
        await clearActiveDownloadIntentForTask(failedTask.id);
        const failedSite = taskSite(failedTask);
        failedTask.status = 'WAITING (Download interrupted retry)';
        delete failedTask.downloadId; queue.push(failedTask); 
        await chrome.storage.local.set({ queue: queue });
        if (failedSite === "xxx") {
            await saveSiteCooldown("xxx", XXX_CLICK_COOLDOWN_MS); setTimeout(() => processQueue("xxx"), XXX_CLICK_COOLDOWN_MS + 250);
        } else { processQueue(failedSite); }
    }
}

function stateFromRequest(request, senderState) {
    if (senderState) {
        if (request?.taskId && !senderState.processingTaskId) senderState.processingTaskId = request.taskId;
        return senderState;
    }
    if (request?.taskId) {
        const state = siteStateForTask(request.taskId);
        if (state) return state;
    }
    if (request?.site) {
        const state = getSiteState(request.site);
        if (request?.taskId && !state.processingTaskId) state.processingTaskId = request.taskId;
        return state;
    }
    return siteStateForTask(processingTaskId);
}

function taskIdFromRequest(request, state) { return request?.taskId || state?.processingTaskId || ""; }

function recentIntentTask(queue, intent, maxAgeMs = 60000) {
    if (!intent?.taskId || Date.now() - Number(intent.startedAt || 0) > maxAgeMs) return null;
    return queue.find(q => q.id === intent.taskId) || null;
}

function recentIntentTaskForDownload(downloadItem, queue, intent) {
    if (isImageDownloadItem(downloadItem)) return null;
    const task = recentIntentTask(queue, intent);
    if (!task) return null;
    if (isDownloadForTask(downloadItem, task, null, false)) return task;
    const taskSiteName = intent?.site || taskSite(task);
    const startedAfterIntent = downloadStartMs(downloadItem) >= Number(intent?.startedAt || 0) - 3000;
    const withinIntentWindow = Date.now() - Number(intent?.startedAt || 0) < 60000;
    if (taskSiteName === "xxx" && startedAfterIntent && withinIntentWindow) return task;
    return null;
}

function fallbackTaskFromRecentXxxIntent(downloadItem, intent, maxAgeMs = 60000) {
    if (isImageDownloadItem(downloadItem)) return null;
    if (intent?.site !== "xxx" || !intent?.taskId) return null;
    if (Date.now() - Number(intent.startedAt || 0) > maxAgeMs) return null;
    if (downloadStartMs(downloadItem) < Number(intent.startedAt || 0) - 3000) return null;
    const galleryId = extractGalleryId(intent.token || "");
    return { id: intent.taskId, url: intent.token || "", site: "xxx", title: galleryId ? `Gallery ${galleryId}` : "nhentai.xxx download", meta: {} };
}

async function cancelDuplicateArchiveDownload(downloadId, reason = "duplicate task download") {
    if (!downloadId) return;
    console.warn("cancel duplicate archive download", downloadId, reason);
    await chrome.downloads.cancel(Number(downloadId)).catch(() => {});
    await chrome.downloads.removeFile(Number(downloadId)).catch(() => {});
    filenameTasksByDownloadId.delete(Number(downloadId));
}

function taskHasDifferentDownload(task, downloadId) {
    return Boolean(task?.downloadId && Number(task.downloadId) !== Number(downloadId));
}

async function shouldKeepExistingTaskDownload(task, nextDownloadId) {
    if (!taskHasDifferentDownload(task, nextDownloadId)) return false;
    const items = await chrome.downloads.search({ id: Number(task.downloadId) }).catch(() => []);
    const current = items[0] || null;
    if (!current) return false;
    if (current.state === "interrupted" || current.exists === false) return false;
    if (current.state === "complete") return isSuccessfulArchiveDownloadItem(current);
    return current.state === "in_progress" && !isImageDownloadItem(current);
}

async function bindDownloadToTask(data, task, downloadId, options = {}) {
    if (!task || !downloadId) return task || null;
    const queue = data.queue || []; const index = queue.findIndex(q => q.id === task.id);
    const boundTask = index !== -1 ? queue[index] : task;
    const previousDownloadId = boundTask.downloadId;
    if (await shouldKeepExistingTaskDownload(boundTask, downloadId)) {
        await cancelDuplicateArchiveDownload(downloadId, `task ${boundTask.id} already bound to ${boundTask.downloadId}`);
        return null;
    }
    if (previousDownloadId && Number(previousDownloadId) !== Number(downloadId)) filenameTasksByDownloadId.delete(Number(previousDownloadId));
    boundTask.downloadId = downloadId; boundTask.site = taskSite(boundTask);
    if (options.status) boundTask.status = options.status;
    if (index !== -1) { queue[index] = boundTask; await chrome.storage.local.set({ queue }); }
    filenameTasksByDownloadId.set(downloadId, { ...boundTask });
    return boundTask;
}

async function clearActiveDownloadIntentForTask(taskId) {
    if (!taskId) return;
    const data = await chrome.storage.local.get({ activeDownloadIntent: null });
    if (data.activeDownloadIntent?.taskId === taskId) await chrome.storage.local.remove("activeDownloadIntent");
}

async function closeTaskTab(taskId, state = null) {
    const tabIds = [];
    if (state?.currentTabId) tabIds.push(state.currentTabId);

    if (taskId) {
        const data = await chrome.storage.local.get({ activeDownloadIntent: null });
        if (data.activeDownloadIntent?.taskId === taskId && data.activeDownloadIntent.tabId) {
            tabIds.push(data.activeDownloadIntent.tabId);
        }
    }

    const uniqueTabIds = [...new Set(tabIds.filter(Boolean))];
    await Promise.all(uniqueTabIds.map((tabId) => chrome.tabs.remove(tabId).catch(() => {})));
    if (state) state.currentTabId = null;
}

async function releaseSiteAfterDownloadStarted(task, options = {}) {
    if (!task?.id) return;
    const site = options.site || taskSite(task);
    const state = options.state || siteStateForTask(task.id);
    if (state && state.processingTaskId !== task.id) return;

    if (state) {
        clearAllTimers(state);
        state.isWaitingForDownload = false;
        state.expectedDownloadUrlToken = "";
        state.downloadListenStartedAt = 0;
        state.processingTaskId = null;
        state.isProcessing = false;
    }
    await closeTaskTab(task.id, state);
    await clearActiveDownloadIntentForTask(task.id);

    if (site === "xxx") {
        await startDownloadCooldown("xxx", task.id);
        return;
    }

    setTimeout(() => processQueue(site), Number(options.delayMs || 0));
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const senderState = sender?.tab?.id ? siteStateForTab(sender.tab.id) : null;
    const requestState = stateFromRequest(request, senderState);
    if (request.action === 'ADD_TO_QUEUE') { addToQueue(request.payload); sendResponse({ received: true }); }
    else if (request.action === 'CLEAR_WAITING_QUEUE') { clearWaitingQueue(request.site).then(() => sendResponse({ received: true })); return true; }
    else if (request.action === 'MANUAL_RECOVER_QUEUE') { manualRecoverQueue({ recoverActiveStale: true }).then(sendResponse); return true; }
    else if (request.action === 'SHOW_DOWNLOAD') { showDownloadLocation(request.downloadId).then(sendResponse); return true; }
    else if (request.action === 'PREPARE_DOWNLOAD_CLICK') {
        prepareDownloadTracking(requestState, {
            taskId: taskIdFromRequest(request, requestState),
            site: request.site,
            tabId: sender?.tab?.id || 0,
        }).then((received) => sendResponse({ received }));
        return true;
    }
    else if (request.action === 'STATUS_UPDATE') {
        const taskId = taskIdFromRequest(request, requestState);
        updateStatus(taskId, request.text);
        const statusText = String(request.text || "");
        if (statusText === 'Triggering download...') {
            prepareDownloadTracking(requestState, { taskId, site: request.site, tabId: sender?.tab?.id || 0 }).then((received) => sendResponse({ received }));
            return true;
        }
        sendResponse({ received: true });
    } 
    else if (request.action === 'RATE_LIMIT_HIT') { handleRateLimit(requestState); sendResponse({ received: true }); } 
    // Accept dynamic cooldown from content.js.
    else if (request.action === 'DYNAMIC_COOLDOWN') { handleDynamicCooldown(requestState, request.seconds); sendResponse({ received: true }); }
    else if (request.action === 'SERVER_ERROR') {
        if (requestState) { failCurrentTask('Server 500 error', requestState); sendResponse({ received: true }); return true; }
        failCurrentTask('Server 500 error'); sendResponse({ received: true });
    } else if (request.action === 'NOT_FOUND_TIMEOUT') {
        if (requestState) { failCurrentTask('Button not found', requestState); sendResponse({ received: true }); return true; }
        failCurrentTask('Button not found'); sendResponse({ received: true });
    } else if (request.action === 'SET_META') {
        updateTaskMeta(taskIdFromRequest(request, requestState), request.payload).then(() => { sendResponse({ received: true }); });
        return true; 
    }
    return true; 
});

async function showDownloadLocation(downloadId) {
    if (!downloadId) return { ok: false, error: "No download id is available for this book." };
    const items = await chrome.downloads.search({ id: Number(downloadId) });
    if (!items.length) return { ok: false, error: "The browser no longer has this download record." };
    try { chrome.downloads.show(Number(downloadId)); return { ok: true }; } catch (error) { return { ok: false, error: error?.message || "Could not show this download." }; }
}

async function addToQueue(item) {
    const cleanUrl = normalizeGalleryUrl(item?.url); if (!cleanUrl) return false;
    const site = siteFromUrl(cleanUrl);
    const galleryId = galleryIdFromUrl(cleanUrl);
    let d = await chrome.storage.local.get({ queue: [], history: [] });
    const changed = dedupeQueueByGallery(d.queue);
    const isInHistory = historyHasGallery(d.history, site, galleryId);
    if (queueHasGallery(d.queue, site, galleryId) || isInHistory) {
        if (changed) await chrome.storage.local.set({ queue: d.queue });
        return false;
    }
    const now = Date.now();
    item.id = `${now}-${Math.random().toString(36).slice(2, 8)}`; item.url = cleanUrl; item.site = siteFromUrl(cleanUrl); item.title = String(item.title || 'Task').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Task';
    item.status = 'WAITING'; item.statusUpdatedAt = now; item.queuedAt = now; item.retries = 0; d.queue.push(item);
    await chrome.storage.local.set({ queue: d.queue }); processQueue();
    return true;
}

async function clearWaitingQueue(site = null) {
    let d = await chrome.storage.local.get({ queue: [] });
    const activeTaskIds = new Set(SITE_KEYS.map((site) => getSiteState(site).processingTaskId).filter(Boolean));
    const targetSite = site === "net" || site === "xxx" ? site : null;
    const queue = d.queue.filter(q => {
        if (isActiveTaskStatus(q.status) || activeTaskIds.has(q.id)) return true;
        return targetSite ? taskSite(q) !== targetSite : false;
    });
    await chrome.storage.local.set({ queue });
}

async function manualRecoverQueue(options = {}) {
    await syncDownloadStates();
    const data = await chrome.storage.local.get({ queue: [], siteCooldowns: emptySiteCooldowns(), globalCooldownUntil: 0, cooldownTotal: 0, activeDownloadIntent: null });
    const queue = data.queue || [];
    const activeTaskIds = new Set(SITE_KEYS.map((site) => getSiteState(site).processingTaskId).filter(Boolean));
    const sitesWithBoundDownloads = new Set(queue
        .filter(task => task.status === "DOWNLOADING" && task.downloadId)
        .map(task => taskSite(task)));
    const touchedSites = new Set();
    let recovered = 0;
    let changed = normalizeQueueSites(queue);
    const now = Date.now();
    const recoverActiveStale = Boolean(options.recoverActiveStale);
    const staleOnly = Boolean(options.staleOnly);
    const statusText = options.statusText || "WAITING (manual resume)";

    for (const task of queue) {
        if (!task) continue;
        const status = String(task.status || "");
        const stuckWithoutDownload = !task.downloadId && (status === "DOWNLOADING" || isManualRecoverableStatus(status));
        if (!stuckWithoutDownload) continue;

        const activeState = activeTaskIds.has(task.id) ? siteStateForTask(task.id) : null;
        const isStale = queueTaskStatusAgeMs(task, now) >= AUTO_RECOVER_STALE_TASK_MS;
        if (activeState && !(recoverActiveStale && isStale)) continue;
        if (!activeState && staleOnly && !isStale) continue;

        if (activeState) {
            clearAllTimers(activeState);
            activeState.isWaitingForDownload = false;
            activeState.expectedDownloadUrlToken = "";
            activeState.downloadListenStartedAt = 0;
            await closeTaskTab(task.id, activeState);
            activeState.processingTaskId = null;
            activeState.isProcessing = false;
        }

        task.status = statusText;
        task.site = taskSite(task);
        task.statusUpdatedAt = now;
        delete task.downloadId;
        delete task.triggerStartedAt;
        if (data.activeDownloadIntent?.taskId === task.id) {
            if (data.activeDownloadIntent.tabId) chrome.tabs.remove(data.activeDownloadIntent.tabId).catch(() => {});
            chrome.storage.local.remove("activeDownloadIntent").catch(() => {});
        }
        touchedSites.add(task.site);
        recovered++;
        changed = true;
    }

    if (changed) await chrome.storage.local.set({ queue });
    if (touchedSites.has("xxx")) await saveSiteCooldown("xxx", XXX_CLICK_COOLDOWN_MS);

    const waitingSites = new Set(queue.filter(task => isWaitingStatus(task.status)).map(task => taskSite(task)));
    SITE_KEYS.forEach((site) => {
        if (sitesWithBoundDownloads.has(site)) return;
        if (touchedSites.has(site) || waitingSites.has(site)) processQueue(site);
    });

    return { recovered };
}

async function updateStatus(taskId, text) {
    if (!taskId) return; let d = await chrome.storage.local.get({ queue: [] });
    let index = d.queue.findIndex(q => q.id === taskId);
    if (index !== -1) {
        d.queue[index].status = text;
        d.queue[index].statusUpdatedAt = Date.now();
        if (isTriggeringDownloadStatus(text)) d.queue[index].triggerStartedAt = Date.now();
        else delete d.queue[index].triggerStartedAt;
        await chrome.storage.local.set({ queue: d.queue });
    }
}

async function updateTaskMeta(taskId, meta) {
    if (!taskId) return; let d = await chrome.storage.local.get({ queue: [] });
    let index = d.queue.findIndex(q => q.id === taskId);
    if (index !== -1) { d.queue[index].meta = meta; await chrome.storage.local.set({ queue: d.queue }); }
}

async function processQueue(site = null) {
    if (!site) { SITE_KEYS.forEach((siteKey) => processQueue(siteKey)); return; }
    const state = getSiteState(site);
    if (state.isProcessing) return; 
    if (site === "xxx" && (state.processingTaskId || state.currentTabId)) return;
    state.isProcessing = true; 

    await syncDownloadStates();

    let d = await chrome.storage.local.get({ queue: [], siteCooldowns: emptySiteCooldowns(), globalCooldownUntil: 0, cooldownTotal: 0 });
    const siteCooldowns = normalizeSiteCooldowns(d);
    let changed = normalizeQueueSites(d.queue);
    changed = dedupeQueueByGallery(d.queue) || changed;
    changed = resetStaleTransientStatuses(d.queue) || changed;
    if (d.globalCooldownUntil || d.cooldownTotal) changed = true;
    if (changed) { await chrome.storage.local.set({ queue: d.queue, siteCooldowns, globalCooldownUntil: 0, cooldownTotal: 0 }); }

    const now = Date.now();
    if (site === "xxx" && hasActiveDownloadForSite(d.queue, "xxx")) { state.isProcessing = false; return; }
    const maxActiveDownloads = 5;
    if (await activeArchiveDownloadCount(d.queue) >= maxActiveDownloads) {
        state.isProcessing = false;
        setTimeout(() => processQueue(site), 5000);
        return;
    }

    let waitingIndex = d.queue.findIndex(q => isWaitingStatus(q.status) && taskSite(q) === site && !isSiteCooling(siteCooldowns, site, now));
    if (waitingIndex === -1) {
        if (d.queue.some(q => isWaitingStatus(q.status) && taskSite(q) === site)) scheduleNextCooldownAlarm(siteCooldowns);
        state.isProcessing = false; return;
    }

    state.isWaitingForDownload = false; state.expectedDownloadUrlToken = ""; state.downloadListenStartedAt = 0; clearAllTimers(state); 
    state.processingTaskId = d.queue[waitingIndex].id;

    await updateStatus(state.processingTaskId, 'Loading environment...');
    
    // Keep a 150 second overall timeout guard.
    state.taskOverallTimer = setTimeout(() => failCurrentTask('Timeout', state), 150000);
    
    try {
        const tab = await chrome.tabs.create({ url: d.queue[waitingIndex].url, active: false, pinned: true });
        state.currentTabId = tab.id;
        await chrome.storage.local.set({
            activeDownloadIntent: { taskId: state.processingTaskId, site, tabId: tab.id, token: String(d.queue[waitingIndex].url || "").toLowerCase(), startedAt: Date.now() }
        });
        let pings = 0;
        const i = setInterval(() => {
            pings++; if (!state.currentTabId) { clearInterval(i); return; }
            chrome.tabs.sendMessage(state.currentTabId, { action: 'DO_YOUR_JOB', taskId: state.processingTaskId, site }, (r) => { if (!chrome.runtime.lastError && r?.ack) clearInterval(i); });
            if (pings >= 60) { clearInterval(i); failCurrentTask('Script failed', state); }
        }, 500); 
    } catch (e) { failCurrentTask('Internal error', state); }
}

async function recoverTaskFromDownloads(state, task, index, data) {
    if (!task || index === -1) return false;
    const downloads = await chrome.downloads.search({ orderBy: ["-startTime"], limit: 50 });
    const candidates = downloads.filter(dl => !isImageDownloadItem(dl));
    const matched = candidates.find(dl => isDownloadForTask(dl, task, state, false)) || candidates.find(dl => isDownloadForTask(dl, task, state, true));
    if (!matched) return false;
    task.downloadId = matched.id; task.site = task.site || siteFromUrl(task.url);
    if (matched.state === "complete") {
        if (!isSuccessfulArchiveDownloadItem(matched)) return false;
        const finishedTask = data.queue.splice(index, 1)[0]; finishedTask.downloadId = matched.id;
        const confirmed = await confirmFinishedTaskDownload(finishedTask).catch(error => { console.warn("download confirmation failed", error); return false; });
        if (!confirmed) {
            finishedTask.status = 'WAITING (Download content mismatch retry)';
            delete finishedTask.downloadId;
            data.queue.push(finishedTask);
            await chrome.storage.local.set({ queue: data.queue, history: data.history });
            return true;
        }
        pushHistoryUrl(data.history, finishedTask.url);
        await chrome.storage.local.set({ queue: data.queue, history: data.history });
        return true;
    }
    if (matched.state === "in_progress") {
        data.queue[index].downloadId = matched.id; data.queue[index].status = "DOWNLOADING";
        await chrome.storage.local.set({ queue: data.queue });
        await startDownloadCooldown(taskSite(data.queue[index]), data.queue[index].id);
        return true;
    }
    return false;
}

async function failCurrentTask(reason, state = null) {
    state = state || siteStateForTask(processingTaskId);
    if (!state) return;
    clearAllTimers(state); state.isWaitingForDownload = false; state.expectedDownloadUrlToken = "";
    await closeTaskTab(state.processingTaskId, state);
    
    let d = await chrome.storage.local.get({ queue: [], history: [] });
    let index = d.queue.findIndex(q => q.id === state.processingTaskId);
    let retrySite = SITE_KEYS.find((site) => getSiteState(site) === state) || null;
    if (index !== -1) {
        const recovered = await recoverTaskFromDownloads(state, d.queue[index], index, d);
        if (recovered) {
            state.processingTaskId = null; state.isProcessing = false; state.downloadListenStartedAt = 0;
            if (retrySite === "xxx") await saveSiteCooldown("xxx", XXX_CLICK_COOLDOWN_MS);
            setTimeout(() => processQueue(retrySite), retrySite === "xxx" ? XXX_CLICK_COOLDOWN_MS + 250 : 500);
            return;
        }
        let failedTask = d.queue.splice(index, 1)[0]; 
        cooldownStartedTaskIds.delete(failedTask.id);
        await clearActiveDownloadIntentForTask(failedTask.id);
        retrySite = failedTask.site || siteFromUrl(failedTask.url); failedTask.retries = (failedTask.retries || 0) + 1;
        failedTask.status = `WAITING (${reason}retrying ${failedTask.retries})`;
        d.queue.push(failedTask);
        await chrome.storage.local.set({ queue: d.queue });
    }
    state.processingTaskId = null; state.downloadListenStartedAt = 0; state.isProcessing = false; 
    const nextSite = retrySite || SITE_KEYS.find((site) => getSiteState(site) === state) || null;
    if (nextSite === "xxx") await saveSiteCooldown("xxx", XXX_CLICK_COOLDOWN_MS);
    setTimeout(() => processQueue(nextSite), nextSite === "xxx" ? XXX_CLICK_COOLDOWN_MS + 250 : 1500); 
}

async function handleRateLimit(state = null) {
    state = state || siteStateForTask(processingTaskId); if (!state) return;
    clearAllTimers(state); state.isWaitingForDownload = false; state.expectedDownloadUrlToken = "";
    await closeTaskTab(state.processingTaskId, state);
    let cooldownSite = "net";
    if (state.processingTaskId) {
        let d = await chrome.storage.local.get({ queue: [] });
        let index = d.queue.findIndex(q => q.id === state.processingTaskId);
        if (index !== -1) {
            d.queue[index].site = siteFromUrl(d.queue[index].url); cooldownSite = d.queue[index].site;
            d.queue[index].status = `WAITING (${siteLabel(cooldownSite)} cooldown retry)`;
            await clearActiveDownloadIntentForTask(d.queue[index].id);
            await chrome.storage.local.set({ queue: d.queue });
        }
        state.processingTaskId = null;
    }
    const netCooldownMs = DEFAULT_NET_COOLDOWN_MS;
    const cd = cooldownSite === "xxx" ? XXX_CLICK_COOLDOWN_MS : netCooldownMs;
    await saveSiteCooldown(cooldownSite, cd);
    state.isProcessing = false; setTimeout(() => processQueue(cooldownSite), 500);
}

// Handle exact dynamic wait time requested by the site.
async function handleDynamicCooldown(state, seconds) {
    state = state || siteStateForTask(processingTaskId); 
    if (!state) return;
    
    clearAllTimers(state); 
    state.isWaitingForDownload = false; 
    state.expectedDownloadUrlToken = "";
    
    await closeTaskTab(state.processingTaskId, state);
    
    let cooldownSite = "xxx";
    
    if (state.processingTaskId) {
        let d = await chrome.storage.local.get({ queue: [] });
        let index = d.queue.findIndex(q => q.id === state.processingTaskId);
        if (index !== -1) {
            cooldownSite = d.queue[index].site || siteFromUrl(d.queue[index].url);
            d.queue[index].status = `WAITING (Site requested wait ${seconds}s)`;
            await clearActiveDownloadIntentForTask(d.queue[index].id);
            await chrome.storage.local.set({ queue: d.queue });
        }
        state.processingTaskId = null;
    }
    
    // Add a 2 second buffer.
    const cdMs = (seconds + 2) * 1000;
    
    await saveSiteCooldown(cooldownSite, cdMs);
    state.isProcessing = false; 
    
    setTimeout(() => processQueue(cooldownSite), cdMs + 250);
}
