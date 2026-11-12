const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ytdl = require('@distube/ytdl-core');

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const TOKEN = (process.env.YEMOT_TOKEN || '').trim();
const GEMINI_KEY = (process.env.GEMINI_API_KEY || '').trim();
const YT_KEY = (process.env.YOUTUBE_API_KEY || '').trim();
const YM = 'https://www.call2all.co.il/ym/api/';
const ADMIN_LOG_EXT = '8';

let cachedModelName = null;
const folderCounters = {};
const userNamesCache = new Map();
const configuredPlayfileDirs = new Set();
const approvedChannelsCache = new Set();
const approvedVideosCache = new Set();

function lastVal(param) {
    if (Array.isArray(param)) {
        return String(param[param.length - 1] || '').trim();
    }
    return String(param || '').trim();
}

async function fetchWithTimeout(url, options = {}, timeout = 20000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(id);
        return response;
    } catch (err) {
        clearTimeout(id);
        throw err;
    }
}

// שליפת עמוד מ-Netube במקביל (הראשון שמחזיר תשובה תקינה מנצח)
async function fetchNetubeFastRace(targetUrl, timeoutMs = 5000) {
    const candidates = [
        targetUrl,
        `https://r.jina.ai/${targetUrl}`,
        `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`,
        `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(targetUrl)}`
    ];

    const racePromises = candidates.map(async (u) => {
        const res = await fetchWithTimeout(u, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/json,*/*;q=0.8',
                'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7'
            }
        }, timeoutMs);

        if (!res.ok) throw new Error(`HTTP_${res.status}`);
        const text = await res.text();
        if (!text || text.length < 20 || text.includes('Just a moment...') || text.includes('Attention Required!') || text.includes('Access Denied')) {
            throw new Error('CLOUDFLARE_OR_EMPTY');
        }
        return text;
    });

    try {
        return await Promise.any(racePromises);
    } catch (e) {
        return null;
    }
}

// בדיקה קפדנית האם מזהה סרטון מופיע כחלון/נגן/תמונה של יוטיוב בתוך תוכן העמוד (ולא סתם כהד של שורת החיפוש!)
function hasStrictVideoEmbedInContent(content, videoId) {
    if (!content || !videoId) return false;
    const escaped = videoId.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    const strictPatterns = [
        new RegExp(`(?:youtube\\.com\\/(?:watch\\?v=|embed\\/|v\\/)|youtu\\.be\\/|ytimg\\.com\\/vi\\/|data-video-id=["']|video_id["']\\s*:\\s*["'])${escaped}`, 'i')
    ];
    return strictPatterns.some(reg => reg.test(content));
}

// חילוץ כל מזהי סרטוני היוטיוב המוטמעים באמת בתוך דף של Netube
function extractEmbeddedVideoIds(content) {
    if (!content) return new Set();
    const ids = new Set();
    const reg = /(?:youtube\.com\/(?:watch\?v=|embed\/|v\/)|youtu\.be\/|ytimg\.com\/vi\/|data-video-id=["']|video_id["']\s*:\s*["'])([a-zA-Z0-9_-]{11})/gi;
    let m;
    while ((m = reg.exec(content)) !== null) {
        if (m[1]) ids.add(m[1]);
    }
    return ids;
}

// אימות מרוץ קפדני: מאשר אך ורק אם נמצא חלון/קישור אמיתי של הסרטון או שהערוץ רשום כפוסט אמיתי ב-Netube
async function findFirstApprovedYoutubeItemOnNetube(ytItems, userQuery) {
    if (!ytItems || ytItems.length === 0) return null;

    // 1. בדיקת מטמון של סרטונים וערוצים שכבר אומתו בהצלחה
    for (const item of ytItems) {
        const vid = item.id?.videoId;
        const chId = item.snippet?.channelId;
        if (vid && (approvedVideosCache.has(vid) || (chId && approvedChannelsCache.has(chId)))) {
            console.log(`[Fast Cache Match] Video ${vid} or Channel ${chId} already strictly verified on Netube!`);
            return item;
        }
    }

    const checkTasks = [];

    // משימה א': בדיקה מול ה-WP-JSON הרשמי של Netube לפי שאילתת החיפוש
    // (ב-WP-JSON חוזר מערך [] ריק אם אין פוסטים מאושרים באתר - אין שם הד של שורת החיפוש!)
    checkTasks.push((async () => {
        const jsonStr = await fetchNetubeFastRace(`https://netube.co.il/wp-json/wp/v2/posts?search=${encodeURIComponent(userQuery)}&per_page=10`, 5500);
        if (!jsonStr) throw new Error('NO_JSON_RESP');
        let posts;
        try { posts = JSON.parse(jsonStr); } catch (e) { throw new Error('INVALID_JSON'); }
        if (!Array.isArray(posts) || posts.length === 0) throw new Error('EMPTY_POSTS_ARRAY');

        const fullJsonText = JSON.stringify(posts);
        const embeddedIds = extractEmbeddedVideoIds(fullJsonText);

        for (const item of ytItems) {
            const vid = item.id?.videoId;
            const chId = item.snippet?.channelId;
            const chTitle = (item.snippet?.channelTitle || '').trim();
            if (vid && (embeddedIds.has(vid) || fullJsonText.includes(vid))) {
                console.log(`[Netube Strict Winner] WP-JSON verified exact Video ID ${vid}!`);
                approvedVideosCache.add(vid);
                if (chId) approvedChannelsCache.add(chId);
                return item;
            }
            // בדיקה אם שם הערוץ מופיע בתוך כותרת או תוכן של פוסט מאושר ב-Netube
            if (chTitle.length >= 4 && posts.some(p => (p.title?.rendered || '').includes(chTitle) || (p.content?.rendered || '').includes(chTitle))) {
                console.log(`[Netube Strict Winner] WP-JSON verified Channel "${chTitle}" in approved Netube posts!`);
                if (chId) approvedChannelsCache.add(chId);
                if (vid) approvedVideosCache.add(vid);
                return item;
            }
        }
        throw new Error('NO_STRICT_MATCH_IN_WP_JSON');
    })());

    // משימה ב': בדיקת דף החיפוש ב-Netube אך ורק עבור מזהי יוטיוב שמוטמעים כנגן/תמונה (לא טקסט חופשי בשורת החיפוש!)
    checkTasks.push((async () => {
        const html = await fetchNetubeFastRace(`https://netube.co.il/?s=${encodeURIComponent(userQuery)}`, 5500);
        if (!html || html.includes('לא נמצאו תוצאות') || html.includes('Nothing Found')) {
            throw new Error('NO_SEARCH_RESULTS');
        }
        const embeddedIds = extractEmbeddedVideoIds(html);
        if (embeddedIds.size === 0) throw new Error('NO_EMBEDDED_VIDEOS_ON_PAGE');

        for (const item of ytItems) {
            const vid = item.id?.videoId;
            const chId = item.snippet?.channelId;
            if (vid && embeddedIds.has(vid)) {
                console.log(`[Netube Strict Winner] Found embedded video player/thumbnail for ${vid} on Netube search page!`);
                approvedVideosCache.add(vid);
                if (chId) approvedChannelsCache.add(chId);
                return item;
            }
        }
        throw new Error('EMBEDDED_IDS_DID_NOT_MATCH_YT_RESULTS');
    })());

    // משימה ג': בדיקת 3 התוצאות הראשונות מול ה-WP-JSON של Netube לפי מזהה סרטון ולפי שם ערוץ
    for (const item of ytItems.slice(0, 3)) {
        const vid = item.id?.videoId;
        const chId = item.snippet?.channelId;
        const chTitle = (item.snippet?.channelTitle || '').trim();

        if (vid) {
            checkTasks.push((async () => {
                // חיפוש ב-WP-JSON לפי ה-Video ID או בדיקת הטמעה קפדנית בדף
                const html = await fetchNetubeFastRace(`https://netube.co.il/?s=${encodeURIComponent(vid)}`, 5500);
                if (html && !html.includes('לא נמצאו תוצאות') && hasStrictVideoEmbedInContent(html, vid)) {
                    console.log(`[Netube Strict Winner] Verified strict video embed for ID ${vid} on Netube!`);
                    approvedVideosCache.add(vid);
                    if (chId) approvedChannelsCache.add(chId);
                    return item;
                }
                throw new Error(`VID_${vid}_NOT_EMBEDDED`);
            })());
        }

        if (chTitle.length >= 3) {
            checkTasks.push((async () => {
                const jsonStr = await fetchNetubeFastRace(`https://netube.co.il/wp-json/wp/v2/posts?search=${encodeURIComponent(chTitle)}&per_page=5`, 5500);
                if (!jsonStr) throw new Error('NO_CH_JSON');
                let posts;
                try { posts = JSON.parse(jsonStr); } catch (e) { throw new Error('BAD_CH_JSON'); }
                if (!Array.isArray(posts) || posts.length === 0) throw new Error('CH_EMPTY_POSTS');

                // מוודאים ששם הערוץ באמת מופיע בכותרת או בתוכן של פוסט מאושר ב-Netube
                const matchedPost = posts.some(p => {
                    const t = (p.title?.rendered || '');
                    const c = (p.content?.rendered || '');
                    return t.includes(chTitle) || c.includes(chTitle) || (chId && c.includes(chId));
                });

                if (matchedPost) {
                    console.log(`[Netube Strict Winner] Channel "${chTitle}" strictly verified in Netube database! Approving video ${vid}.`);
                    if (chId) approvedChannelsCache.add(chId);
                    if (vid) approvedVideosCache.add(vid);
                    return item;
                }
                throw new Error('CH_NOT_IN_POSTS');
            })());
        }
    }

    try {
        const winnerItem = await Promise.any(checkTasks);
        return winnerItem;
    } catch (allFailedErr) {
        console.log(`[Filter Check] STRICT BLOCK: Query "${userQuery}" is NOT on Netube (all strict checks rejected).`);
        return null;
    }
}

// בדיקה אם משתמש כבר רשום במערכת
async function getUserNameIfRegistered(phone) {
    if (userNamesCache.has(phone)) {
        return userNamesCache.get(phone);
    }
    const folderPath = `ivr2:/users/${phone}`;
    try {
        const url = `${YM}GetIVR2Dir?token=${encodeURIComponent(TOKEN)}&path=${encodeURIComponent(folderPath)}`;
        const res = await fetchWithTimeout(url, {}, 6000);
        if (res.ok) {
            const data = await res.json();
            const files = data.files || [];
            const hasNameFile = files.some(f => {
                const fname = (typeof f === 'string') ? f : (f && (f.name || f.fileName || ''));
                const low = String(fname).toLowerCase();
                return low === 'name.txt' || low === 'name.wav';
            });
            if (hasNameFile) {
                try {
                    const dlUrl = `${YM}DownloadFile?token=${encodeURIComponent(TOKEN)}&path=${encodeURIComponent(folderPath + '/name.txt')}`;
                    const dlRes = await fetchWithTimeout(dlUrl, {}, 5000);
                    if (dlRes.ok) {
                        const nameTxt = (await dlRes.text()).trim();
                        if (nameTxt && !nameTxt.includes('responseStatus') && !nameTxt.includes('EXCEPTION')) {
                            userNamesCache.set(phone, nameTxt);
                            return nameTxt;
                        }
                    }
                } catch (e) {}
                userNamesCache.set(phone, 'משתמש רשום');
                return 'משתמש רשום';
            }
        }
    } catch (e) {
        console.warn('[Check User Warning]', e.message);
    }
    return null;
}

// הגדרת תיקייה אישית כשלוחת השמעת קבצים רגילה בימות המשיח (מחוץ לשרת)
async function ensurePlayfileExtension(folderPathStr) {
    const clean = String(folderPathStr).replace(/^ivr2:\/*/, '').replace(/^\/*/, '').replace(/\/*$/, '');
    if (configuredPlayfileDirs.has(clean)) return;
    try {
        const body = new URLSearchParams({
            token: TOKEN,
            path: `ivr2:/${clean}`,
            type: 'playfile'
        });
        await fetchWithTimeout(`${YM}UpdateExtension`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body
        }, 7000);
        configuredPlayfileDirs.add(clean);
    } catch (e) {
        console.warn(`[Ensure Playfile ${clean}]`, e.message);
    }
}

// איתור המספר הפנוי הבא בתיקייה בימות המשיח
async function getNextFileNumberStr(folder, reserveCount = 1) {
    const cleanFolder = String(folder || '').replace(/^ivr2:\/*/, '').replace(/^\/*/, '').replace(/\/*$/, '');
    const folderPath = cleanFolder ? `ivr2:/${cleanFolder}` : `ivr2:/`;
    let maxExisting = -1;

    try {
        const url = `${YM}GetIVR2Dir?token=${encodeURIComponent(TOKEN)}&path=${encodeURIComponent(folderPath)}`;
        const res = await fetchWithTimeout(url, {}, 7000);
        if (res.ok) {
            const data = await res.json();
            const files = data.files || [];
            for (const f of files) {
                const fname = (typeof f === 'string') ? f : (f && (f.name || f.fileName || ''));
                const m = String(fname).match(/^(\d+)\.(wav|tts|txt|mp3)$/i);
                if (m) {
                    const num = parseInt(m[1], 10);
                    if (!isNaN(num) && num < 900 && num > maxExisting) {
                        maxExisting = num;
                    }
                }
            }
        }
    } catch (e) {
        console.warn(`[GetIVR2Dir] Warning checking ${folderPath}:`, e.message);
    }

    const currentMem = (folderCounters[cleanFolder] !== undefined) ? folderCounters[cleanFolder] : -1;
    const baseNum = Math.max(maxExisting, currentMem);
    const startNum = baseNum + 1;
    folderCounters[cleanFolder] = baseNum + reserveCount;

    const result = [];
    for (let i = 0; i < reserveCount; i++) {
        result.push(String(startNum + i).padStart(3, '0'));
    }
    return reserveCount === 1 ? result[0] : result;
}

// העלאת קובץ WAV מוכן לימות המשיח
async function uploadWavBufferToExactPath(wavBuffer, exactTargetPath, fileNameLabel = 'audio.wav', timeoutMs = 45000) {
    const formData = new FormData();
    formData.append('token', TOKEN);
    formData.append('path', exactTargetPath);
    formData.append('convertAudio', '0');
    formData.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), fileNameLabel);

    const upRes = await fetchWithTimeout(`${YM}UploadFile`, {
        method: 'POST',
        body: formData
    }, timeoutMs);

    const upText = await upRes.text();
    console.log(`[Yemot Upload -> ${exactTargetPath}] (${wavBuffer.length} bytes) Response:`, upText.slice(0, 180));
    return upText;
}

// העלאת קובץ טקסט לימות המשיח
async function uploadTextToExactPath(textContent, exactTargetPath, fileNameLabel = 'file.txt') {
    const form = new FormData();
    form.append('token', TOKEN);
    form.append('path', exactTargetPath);
    form.append('convertAudio', '0');
    form.append('file', new Blob([Buffer.from(textContent, 'utf8')], { type: 'text/plain; charset=utf-8' }), fileNameLabel);
    await fetchWithTimeout(`${YM}UploadFile`, { method: 'POST', body: form }, 12000);
}

// תיעוד פעולות והורדות למנהל המערכת בשלוחה 8
async function saveAdminLogToExt8(callerPhone, userName, categoryLabel, searchQuery, downloadedTitle, statusText) {
    try {
        const nextNum = await getNextFileNumberStr(ADMIN_LOG_EXT, 1);
        const nowStr = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
        
        const ttsSummary = `משתמש ${userName} טלפון ${callerPhone} חיפש ב${categoryLabel} את ${searchQuery}. סטטוס: ${statusText}`;
        await uploadTextToExactPath(ttsSummary, `ivr2:/${ADMIN_LOG_EXT}/${nextNum}.tts`, `${nextNum}.tts`);

        const txtDetails = [
            `שם משתמש: ${userName}`,
            `מספר טלפון: ${callerPhone}`,
            `קובץ הקלטת שם: ivr2:/users/${callerPhone}/name.wav`,
            `קטגוריה: ${categoryLabel}`,
            `מילות חיפוש: ${searchQuery}`,
            `כותרת סרטון: ${downloadedTitle || 'לא הורד'}`,
            `סטטוס: ${statusText}`,
            `זמן פעולה: ${nowStr}`
        ].join('\r\n') + '\r\n';

        await uploadTextToExactPath(txtDetails, `ivr2:/${ADMIN_LOG_EXT}/${nextNum}.txt`, `${nextNum}.txt`);
    } catch (err) {
        console.warn('[Admin Log Ext 8] Error:', err.message);
    }
}

// הורדת הקלטה מימות המשיח
async function downloadRecordingFromYemot(recordPath, apiDir) {
    const cleanPath = String(recordPath).replace(/^ivr2:\/*/, '').replace(/^\/*/, '');
    const cleanDir = String(apiDir || '').replace(/^ivr2:\/*/, '').replace(/^\/*/, '').replace(/\/*$/, '');
    
    const candidates = [
        `ivr2:/${cleanPath}`,
        `ivr2:${cleanPath}`
    ];
    if (cleanDir && !cleanPath.startsWith(cleanDir + '/')) {
        candidates.unshift(`ivr2:/${cleanDir}/${cleanPath}`);
    }
    if (!cleanPath.toLowerCase().endsWith('.wav')) {
        candidates.unshift(`ivr2:/${cleanPath}.wav`);
        if (cleanDir) candidates.unshift(`ivr2:/${cleanDir}/${cleanPath}.wav`);
    }

    const uniquePaths = [...new Set(candidates)];
    let lastYemotResponse = '';
    for (const p of uniquePaths) {
        const url = `${YM}DownloadFile?token=${encodeURIComponent(TOKEN)}&path=${encodeURIComponent(p)}`;
        try {
            const res = await fetchWithTimeout(url, {}, 10000);
            if (!res.ok) {
                lastYemotResponse = `HTTP_${res.status}`;
                continue;
            }
            const buf = Buffer.from(await res.arrayBuffer());
            const headStr = buf.toString('utf8', 0, Math.min(buf.length, 150));
            
            if (buf.length > 200 && !headStr.includes('responseStatus') && !headStr.includes('EXCEPTION')) {
                console.log(`[Yemot Download] Success from ${p} (${buf.length} bytes)`);
                return buf;
            } else {
                lastYemotResponse = headStr;
            }
        } catch (e) {
            lastYemotResponse = e.message;
        }
    }
    throw new Error('YEMOT_DOWNLOAD_ERR: ' + lastYemotResponse);
}

// בחירת מודל Gemini מהיר לתמלול
async function getFastGeminiModels() {
    const defaultFastOrder = [
        'gemini-flash-lite-latest',
        'gemini-3.5-flash-lite',
        'gemini-3.5-flash',
        'gemini-3.5-transcribe',
        'gemini-flash-latest',
        'gemini-3.6-flash'
    ];
    if (cachedModelName) {
        return [cachedModelName, ...defaultFastOrder.filter(m => m !== cachedModelName)];
    }
    try {
        const res = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_KEY}`, {}, 6000);
        if (res.ok) {
            const data = await res.json();
            const available = (data.models || [])
                .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
                .map(m => m.name.replace('models/', ''))
                .filter(m => !m.includes('2.5') && !m.includes('1.5') && !m.includes('tts') && !m.includes('image') && !m.includes('robotics') && !m.includes('research') && !m.includes('computer-use'));

            const matched = [];
            for (const pref of defaultFastOrder) {
                if (available.includes(pref)) matched.push(pref);
            }
            for (const m of available) {
                if ((m.includes('flash') || m.includes('transcribe')) && !matched.includes(m)) {
                    matched.push(m);
                }
            }
            if (matched.length > 0) {
                cachedModelName = matched[0];
                return matched;
            }
        }
    } catch (e) {}
    return defaultFastOrder;
}

async function transcribeAudio(audioBase64) {
    const modelsToTry = await getFastGeminiModels();
    const prompt = "תמלל את ההקלטה לעברית. החזר אך ורק את המילים שנאמרו בהקלטה ללא שום תוספת, ללא סימני פיסוק וללא הסברים.";

    let lastErr = '';
    for (const model of modelsToTry.slice(0, 4)) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
        try {
            const res = await fetchWithTimeout(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{
                        parts: [
                            { text: prompt },
                            { inlineData: { mimeType: 'audio/wav', data: audioBase64 } }
                        ]
                    }],
                    generationConfig: {
                        temperature: 0.1,
                        maxOutputTokens: 60
                    }
                })
            }, 10000);

            if (res.ok) {
                cachedModelName = model;
                const data = await res.json();
                const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
                console.log(`[Gemini] Model ${model} success:`, JSON.stringify(text));
                return text;
            }

            lastErr = await res.text();
            if (cachedModelName === model) cachedModelName = null;
        } catch (err) {
            lastErr = err.message;
            if (cachedModelName === model) cachedModelName = null;
        }
    }
    throw new Error('GEMINI_ERR: ' + lastErr);
}

// חיתוך והמרה מהירה של מקטע ספציפי לקובץ WAV תקני לימות המשיח (8000Hz Mono PCM)
async function convertSegmentToWavFast(inputPath, outputWavPath, startSec = 0, durationSec = 900) {
    await new Promise((resolve, reject) => {
        const ffTimer = setTimeout(() => reject(new Error('Local FFmpeg segment timeout')), 25000);
        let cmd = ffmpeg(inputPath);
        if (startSec > 0) {
            cmd = cmd.setStartTime(startSec);
        }
        cmd.duration(durationSec)
            .format('wav')
            .audioCodec('pcm_s16le')
            .audioChannels(1)
            .audioFrequency(8000)
            .on('end', () => {
                clearTimeout(ffTimer);
                resolve();
            })
            .on('error', (err) => {
                clearTimeout(ffTimer);
                reject(err);
            })
            .save(outputWavPath);
    });
}

// איתור קישורי פרוקסי מהירים להורדת השמע
async function getFastStreamUrls(videoId) {
    const urls = [];

    const invidiousHosts = [
        'https://yt.chocolatemoo53.com',
        'https://invidious.nerdvpn.de',
        'https://inv.tux.pizza',
        'https://invidious.privacyredirect.com',
        'https://inv.nadeko.net'
    ];

    for (const host of invidiousHosts) {
        try {
            const apiRes = await fetchWithTimeout(`${host}/api/v1/videos/${videoId}`, {
                headers: { 'User-Agent': 'Mozilla/5.0' }
            }, 3000);
            if (apiRes.ok) {
                const data = await apiRes.json();
                const formats = (data.adaptiveFormats || []).filter(f => (f.type || '').startsWith('audio/'));
                if (formats.length > 0) {
                    formats.sort((a, b) => (parseInt(a.bitrate) || 999999) - (parseInt(b.bitrate) || 999999));
                    for (const fmt of formats.slice(0, 2)) {
                        const itag = fmt.itag || 139;
                        urls.push(`${host}/latest_version?id=${videoId}&itag=${itag}&local=true`);
                    }
                    if (urls.length >= 2) break;
                }
            }
        } catch (e) {}
    }

    for (const host of invidiousHosts.slice(0, 4)) {
        urls.push(`${host}/latest_version?id=${videoId}&itag=139&local=true`);
        urls.push(`${host}/latest_version?id=${videoId}&itag=249&local=true`);
        urls.push(`${host}/latest_version?id=${videoId}&itag=140&local=true`);
    }

    return [...new Set(urls)];
}

// הורדה מואצת במקטעים
async function downloadStreamFastToLocalFile(streamUrl, targetFilePath, maxBytes, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let downloaded = 0;

    try {
        const res = await fetch(streamUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Range': `bytes=0-${maxBytes}`
            },
            signal: controller.signal
        });

        if (!res.ok && res.status !== 206) {
            throw new Error(`HTTP ${res.status}`);
        }

        const cType = (res.headers.get('content-type') || '').toLowerCase();
        if (cType.includes('text/html') || cType.includes('application/json')) {
            throw new Error(`Invalid content-type: ${cType}`);
        }

        const fileStream = fs.createWriteStream(targetFilePath);
        for await (const chunk of res.body) {
            downloaded += chunk.length;
            fileStream.write(chunk);
            if (downloaded >= maxBytes) {
                try { controller.abort(); } catch (e) {}
                break;
            }
        }

        await new Promise(r => fileStream.end(r));
        clearTimeout(timer);

        if (downloaded < 30000) {
            throw new Error(`Downloaded too small (${downloaded} bytes)`);
        }
        return downloaded;
    } catch (e) {
        clearTimeout(timer);
        if (downloaded >= 250000 && fs.existsSync(targetFilePath)) {
            return downloaded;
        }
        throw e;
    }
}

// הורדה להשמעה מיידית בחיפוש + העברה ברקע לשלוחה האישית (1 או 2) בסדר הפוך
async function downloadAndUploadChainedAndArchive(videoId, livePlayFolder, archiveUserFolder, title) {
    const cleanLive = String(livePlayFolder).replace(/^ivr2:\/*/, '').replace(/^\/*/, '').replace(/\/*$/, '');
    const cleanArchive = String(archiveUserFolder).replace(/^ivr2:\/*/, '').replace(/^\/*/, '').replace(/\/*$/, '');

    const partNums = await getNextFileNumberStr(cleanLive, 4);
    const partPaths = partNums.map(num => `ivr2:/${cleanLive}/${num}.wav`);
    const partCmds = partNums.map(num => `f-/${cleanLive}/${num}`);
    const chainedPlayCommand = partCmds.join('.');

    const streamUrls = await getFastStreamUrls(videoId);
    let workingUrl = null;
    const tmpQuickInput = path.join(os.tmpdir(), `quick_in_${videoId}_${Date.now()}.audio`);
    const tmpQuickWav = path.join(os.tmpdir(), `quick_out_${videoId}_${Date.now()}.wav`);

    try {
        for (const sUrl of streamUrls.slice(0, 6)) {
            try {
                await downloadStreamFastToLocalFile(sUrl, tmpQuickInput, 5.5 * 1024 * 1024, 8000);
                await convertSegmentToWavFast(tmpQuickInput, tmpQuickWav, 0, 900);
                if (fs.existsSync(tmpQuickWav) && fs.statSync(tmpQuickWav).size > 20000) {
                    workingUrl = sUrl;
                    break;
                }
            } catch (err) {
                console.warn(`[Part 1 Fast Start] URL attempt failed: ${err.message}`);
            }
        }

        if (!workingUrl) {
            await new Promise((resolve, reject) => {
                let dl = 0;
                const ws = fs.createWriteStream(tmpQuickInput);
                const st = ytdl(`https://www.youtube.com/watch?v=${videoId}`, { filter: 'audioonly', quality: 'lowestaudio' });
                const tm = setTimeout(() => { try { st.destroy(); } catch (e) {} ws.end(resolve); }, 8500);
                st.on('data', c => {
                    dl += c.length;
                    ws.write(c);
                    if (dl >= 5 * 1024 * 1024) {
                        clearTimeout(tm);
                        try { st.destroy(); } catch (e) {}
                        ws.end(resolve);
                    }
                });
                st.on('end', () => { clearTimeout(tm); ws.end(resolve); });
                st.on('error', e => { clearTimeout(tm); ws.end(() => reject(e)); });
            });
            await convertSegmentToWavFast(tmpQuickInput, tmpQuickWav, 0, 900);
        }

        const quickWavBuf = await fs.promises.readFile(tmpQuickWav);
        await uploadWavBufferToExactPath(quickWavBuf, partPaths[0], `${partNums[0]}.wav`, 20000);

        fs.promises.unlink(tmpQuickInput).catch(() => null);
        fs.promises.unlink(tmpQuickWav).catch(() => null);

        (async () => {
            const tmpFullIn = path.join(os.tmpdir(), `full_in_${videoId}_${Date.now()}.audio`);
            const allPartsForArchive = [
                { partNumber: 1, buffer: quickWavBuf }
            ];

            try {
                let fullBytes = 0;
                if (workingUrl) {
                    fullBytes = await downloadStreamFastToLocalFile(workingUrl, tmpFullIn, 26 * 1024 * 1024, 55000);
                } else {
                    await new Promise((resolve, reject) => {
                        const ws = fs.createWriteStream(tmpFullIn);
                        const st = ytdl(`https://www.youtube.com/watch?v=${videoId}`, { filter: 'audioonly', quality: 'lowestaudio' });
                        const tm = setTimeout(() => { try { st.destroy(); } catch (e) {} ws.end(resolve); }, 55000);
                        st.on('data', c => {
                            fullBytes += c.length;
                            ws.write(c);
                            if (fullBytes >= 26 * 1024 * 1024) {
                                clearTimeout(tm);
                                try { st.destroy(); } catch (e) {}
                                ws.end(resolve);
                            }
                        });
                        st.on('end', () => { clearTimeout(tm); ws.end(resolve); });
                        st.on('error', e => { clearTimeout(tm); ws.end(() => reject(e)); });
                    });
                }

                const segments = [
                    { index: 1, start: 900, duration: 900 },
                    { index: 2, start: 1800, duration: 900 },
                    { index: 3, start: 2700, duration: 900 }
                ];

                for (const seg of segments) {
                    const tmpPartWav = path.join(os.tmpdir(), `part_${seg.index}_${videoId}_${Date.now()}.wav`);
                    try {
                        await convertSegmentToWavFast(tmpFullIn, tmpPartWav, seg.start, seg.duration);
                        if (fs.existsSync(tmpPartWav)) {
                            const stat = fs.statSync(tmpPartWav);
                            if (stat.size > 80000) {
                                const partBuf = await fs.promises.readFile(tmpPartWav);
                                await uploadWavBufferToExactPath(partBuf, partPaths[seg.index], `${partNums[seg.index]}.wav`, 40000);
                                allPartsForArchive.push({ partNumber: seg.index + 1, buffer: partBuf });
                            } else {
                                fs.promises.unlink(tmpPartWav).catch(() => null);
                                break;
                            }
                        }
                    } catch (segErr) {
                        fs.promises.unlink(tmpPartWav).catch(() => null);
                        break;
                    }
                    fs.promises.unlink(tmpPartWav).catch(() => null);
                }
            } catch (bgErr) {
                console.warn('[Background Parts 2-4] Warning:', bgErr.message);
            } finally {
                fs.promises.unlink(tmpFullIn).catch(() => null);
            }

            try {
                await ensurePlayfileExtension(cleanArchive);
                const rawArchNums = await getNextFileNumberStr(cleanArchive, allPartsForArchive.length);
                const archNums = Array.isArray(rawArchNums) ? rawArchNums : [rawArchNums];
                const reversedParts = [...allPartsForArchive].reverse();

                for (let i = 0; i < reversedParts.length; i++) {
                    const partObj = reversedParts[i];
                    const archNum = archNums[i];
                    const archTargetPath = `ivr2:/${cleanArchive}/${archNum}.wav`;
                    await uploadWavBufferToExactPath(partObj.buffer, archTargetPath, `${archNum}.wav`, 40000);
                }
                console.log(`[Archive Complete] Uploaded ${reversedParts.length} parts to ivr2:/${cleanArchive}`);
            } catch (archErr) {
                console.warn('[Archive Upload Error]:', archErr.message);
            }
        })();

        return chainedPlayCommand;

    } catch (e) {
        fs.promises.unlink(tmpQuickInput).catch(() => null);
        fs.promises.unlink(tmpQuickWav).catch(() => null);
        throw e;
    }
}

const MAIN_MENU_TEXT = 'לשמיעת הפלייליסט שלכם הקישו 1 לשמיעת שיעורי התורה שלכם הקישו 2 לחיפוש מוזיקה חדש הקישו 3 לחיפוש שיעור חדש הקישו 4 שימו לב כי הקבצים מתעדכנים בשלוחה אחת ושתים רק לאחר כחצי דקה משמיעת הקובץ בחיפוש לפי אורך הקובץ';

app.get('/', (req, res) => { res.send('YouTube Personal Line Server v19.0 (Strict Netube Embed & WP-JSON Verification) OK'); });

app.all(['/yemot', '/yemot/:e'], async (req, res) => {
    const q = { ...req.query, ...req.body };
    res.type('text/plain; charset=utf-8');

    console.log('[Yemot Request]', JSON.stringify(q));

    try {
        if (q.hangup === 'yes') return res.send('noop');

        const callerPhone = lastVal(q.ApiPhone).replace(/[^0-9]/g, '');
        if (!callerPhone) {
            return res.send('id_list_message=t-שגיאה בזיהוי מספר הטלפון&go_to_folder=/');
        }

        const menuChoice = lastVal(q.MenuChoice);
        const searchMusic = lastVal(q.SearchMusic);
        const searchTorah = lastVal(q.SearchTorah);
        const recordName = lastVal(q.RecordName);

        const userFolder = `users/${callerPhone}`;
        const tempRecFolder = `users/${callerPhone}/temp`;
        const musicExtFolder = `1/${callerPhone}`;
        const torahExtFolder = `2/${callerPhone}`;

        // --- עדיפות 1: אם המשתמש כבר הקליט חיפוש מוזיקה או שיעור תורה ---
        if (searchMusic || searchTorah) {
            const isMusic = Boolean(searchMusic);
            const recordPath = searchMusic || searchTorah;
            const archiveFolder = isMusic ? musicExtFolder : torahExtFolder;
            const categoryFilter = isMusic ? 'מוזיקה חסידית קודש' : 'שיעור תורה';
            const categoryLabel = isMusic ? 'מוזיקה' : 'שיעורי תורה';
            const registeredName = (await getUserNameIfRegistered(callerPhone)) || 'משתמש רשום';

            let audioBuf;
            try {
                audioBuf = await downloadRecordingFromYemot(recordPath, lastVal(q.ApiExtension));
            } catch (dlErr) {
                return res.send('id_list_message=t-שגיאה בהורדת ההקלטה מימות המשיח&go_to_folder=/');
            }

            let rawText = '';
            try {
                rawText = await transcribeAudio(audioBuf.toString('base64'));
            } catch (gemErr) {
                return res.send('id_list_message=t-שגיאה בתקשורת עם מנוע זיהוי הדיבור&go_to_folder=/');
            }

            const cleanQuery = rawText.replace(/[^א-תa-zA-Z0-9\s]/g, ' ').trim().replace(/\s+/g, ' ');
            if (!cleanQuery) {
                return res.send('id_list_message=t-לא הצלחתי לשמוע את הבקשה אנא נסו שנית&go_to_folder=/');
            }

            // שלב א': חיפוש הסרטון ביוטיוב
            const ytUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(cleanQuery + ' ' + categoryFilter)}&type=video&maxResults=6&key=${YT_KEY}`;
            const ytRes = await fetchWithTimeout(ytUrl, {}, 6500);
            const ytData = await ytRes.json();

            if (!ytRes.ok) {
                return res.send('id_list_message=t-שגיאה במפתח החיפוש&go_to_folder=/');
            }

            if (!ytData.items || ytData.items.length === 0) {
                saveAdminLogToExt8(callerPhone, registeredName, categoryLabel, cleanQuery, '', 'לא נמצאו תוצאות ביוטיוב');
                return res.send(`id_list_message=t-לא נמצאו תוצאות עבור ${cleanQuery}&go_to_folder=/`);
            }

            // שלב ב': אימות קפדני (Strict Mode) מול Netube - מוודא שהסרטון או הערוץ באמת מוטמעים ב-Netube
            const approvedItem = await findFirstApprovedYoutubeItemOnNetube(ytData.items, cleanQuery);

            if (!approvedItem) {
                saveAdminLogToExt8(callerPhone, registeredName, categoryLabel, cleanQuery, '', 'נחסם - לא נמצא סרטון או ערוץ ב-Netube');
                return res.send('id_list_message=t-הסרטון אינו נמצא יתכן שחיפשתם תוכן שאינו ראוי שימו לב לאחר כמה נסיונות לתוכן כזה תיחסמו מהמערכת&go_to_folder=/');
            }

            const approvedVideoId = approvedItem.id.videoId;
            const approvedTitle = (approvedItem.snippet?.title || cleanQuery).replace(/[^א-תa-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

            // שלב ג': הורדה מהירה להשמעה מיידית + העברה ברקע לשלוחות 1 ו-2 הרגילות
            try {
                const chainedPlayCmd = await downloadAndUploadChainedAndArchive(approvedVideoId, tempRecFolder, archiveFolder, approvedTitle);
                saveAdminLogToExt8(callerPhone, registeredName, categoryLabel, cleanQuery, approvedTitle, `הורד בהצלחה לשלוחה ${archiveFolder}`);
                return res.send(`id_list_message=t-משמיע ${approvedTitle}.${chainedPlayCmd}&go_to_folder=/`);
            } catch (audioErr) {
                console.error('[Download Error]', audioErr.message);
                return res.send(`id_list_message=t-נמצא ${approvedTitle} אך אירעה שגיאה בטעינת הקובץ&go_to_folder=/`);
            }
        }

        // --- עדיפות 2: תפריט ראשי ---
        if (menuChoice) {
            if (menuChoice === '1') {
                await ensurePlayfileExtension(musicExtFolder);
                return res.send(`go_to_folder=/${musicExtFolder}`);
            }
            if (menuChoice === '2') {
                await ensurePlayfileExtension(torahExtFolder);
                return res.send(`go_to_folder=/${torahExtFolder}`);
            }
            if (menuChoice === '3') {
                const recNum = await getNextFileNumberStr(tempRecFolder, 1);
                return res.send(`read=t-אנא אמרו את שם השיר המבוקש ובסיום הקישו סולמית=SearchMusic,no,record,/${tempRecFolder},${recNum},no,7,1`);
            }
            if (menuChoice === '4') {
                const recNum = await getNextFileNumberStr(tempRecFolder, 1);
                return res.send(`read=t-אנא אמרו את שם השיעור המבוקש ובסיום הקישו סולמית=SearchTorah,no,record,/${tempRecFolder},${recNum},no,7,1`);
            }
            return res.send(`id_list_message=t-בחירה שגויה&read=t-${MAIN_MENU_TEXT}=MenuChoice,no,1,1,7,Digits,no`);
        }

        // --- עדיפות 3: טיפול בהקלטת שם של משתמש חדש ---
        if (recordName) {
            let audioBuf;
            try {
                audioBuf = await downloadRecordingFromYemot(recordName, lastVal(q.ApiExtension));
            } catch (dlErr) {
                return res.send('id_list_message=t-שגיאה בקליטת ההקלטה אנא נסו שנית&go_to_folder=/');
            }

            let rawName = '';
            try {
                rawName = await transcribeAudio(audioBuf.toString('base64'));
            } catch (e) {}
            const cleanName = rawName.replace(/[^א-תa-zA-Z0-9\s]/g, ' ').trim().replace(/\s+/g, ' ') || 'משתמש רשום';

            await uploadWavBufferToExactPath(audioBuf, `ivr2:/${userFolder}/name.wav`, 'name.wav');
            await uploadTextToExactPath(cleanName, `ivr2:/${userFolder}/name.txt`, 'name.txt');
            userNamesCache.set(callerPhone, cleanName);

            await ensurePlayfileExtension(musicExtFolder);
            await ensurePlayfileExtension(torahExtFolder);

            saveAdminLogToExt8(callerPhone, cleanName, 'רישום למערכת', 'הקלטת שם משתמש', '', 'נרשם בהצלחה');

            return res.send(`id_list_message=t-שלום ${cleanName} נרשמתם בהצלחה&read=t-${MAIN_MENU_TEXT}=MenuChoice,no,1,1,7,Digits,no`);
        }

        // --- עדיפות 4: כניסה ראשונית לשלוחה (בדיקה אם המשתמש רשום) ---
        const registeredName = await getUserNameIfRegistered(callerPhone);
        if (!registeredName) {
            return res.send(`read=t-ברוכים הבאים אנא הקליטו את שמכם המלא ובסיום הקישו סולמית=RecordName,no,record,/${tempRecFolder},name_rec,no,7,1`);
        }

        return res.send(`read=t-${MAIN_MENU_TEXT}=MenuChoice,no,1,1,7,Digits,no`);

    } catch (e) {
        console.error('[General Error v19.0]', e.message);
        if (!res.headersSent) {
            return res.send('id_list_message=t-אירעה תקלה כללית בשרת&go_to_folder=/');
        }
    }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`=== Server v19.0 Ready on port ${port} ===`));
