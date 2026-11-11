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
const ADMIN_LOG_EXT = '8'; // שלוחה 8 ליומן מעקב למנהל המערכת

let cachedModelName = null;
const folderCounters = {};
const userNamesCache = new Map();
const configuredPlayfileDirs = new Set();

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

// בדיקת סטטוס סרטון מול נטפרי (מחזירה true אך ורק אם הסרטון פתוח בנטפרי)
async function isVideoApprovedByNetFree(videoId) {
    try {
        const url = `https://public.netfree.link/api/check-video?v=${encodeURIComponent(videoId)}`;
        const res = await fetchWithTimeout(url, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        }, 6000);
        if (res.ok) {
            const data = await res.json();
            if (data && (data.status === 'open' || data.status === 'approved' || data.open === true || data.isBlocked === false)) {
                return true;
            }
        }
        return false;
    } catch (e) {
        console.error('[NetFree Check Error]', e.message);
        return false;
    }
}

// בדיקה אם משתמש כבר רשום במערכת ושליפת שמו מקובץ name.txt
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
                return String(fname).toLowerCase() === 'name.txt';
            });
            if (hasNameFile) {
                try {
                    const dlUrl = `${YM}DownloadFile?token=${encodeURIComponent(TOKEN)}&path=${encodeURIComponent(folderPath + '/name.txt')}`;
                    const dlRes = await fetchWithTimeout(dlUrl, {}, 5000);
                    if (dlRes.ok) {
                        const nameTxt = (await dlRes.text()).trim();
                        if (nameTxt && !nameTxt.includes('responseStatus')) {
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

// הגדרת תיקייה אישית כשלוחת השמעת קבצים (playfile) בימות המשיח
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

// איתור קישורי פרוקסי מהירים
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
            }, 3500);
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

// הורדה ישירה לשלוחה האישית של המאזין (ללא שמירה בשלוחת ה-API הכללית)
async function downloadAndUploadToUserFolder(videoId, targetUserFolder, title) {
    const cleanTarget = String(targetUserFolder).replace(/^ivr2:\/*/, '').replace(/^\/*/, '').replace(/\/*$/, '');
    await ensurePlayfileExtension(cleanTarget);

    // שריון 4 מספרי קבצים עוקבים בתיקייה האישית של המשתמש
    const partNums = await getNextFileNumberStr(cleanTarget, 4);
    const partPaths = partNums.map(num => `ivr2:/${cleanTarget}/${num}.wav`);
    const partCmds = partNums.map(num => `f-/${cleanTarget}/${num}`);
    const chainedPlayCommand = partCmds.join('.');

    // שמירת כותרת השיר/השיעור בקובץ טקסט לצד הקובץ הראשון בתיקיית המשתמש
    uploadTextToExactPath(title, `ivr2:/${cleanTarget}/${partNums[0]}.txt`, `${partNums[0]}.txt`).catch(() => null);

    const streamUrls = await getFastStreamUrls(videoId);
    let workingUrl = null;
    const tmpQuickInput = path.join(os.tmpdir(), `quick_in_${videoId}_${Date.now()}.audio`);
    const tmpQuickWav = path.join(os.tmpdir(), `quick_out_${videoId}_${Date.now()}.wav`);

    try {
        for (const sUrl of streamUrls.slice(0, 6)) {
            try {
                const bytes = await downloadStreamFastToLocalFile(sUrl, tmpQuickInput, 5.5 * 1024 * 1024, 9000);
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

        // העלאת החלק הראשון ישירות לתיקייה האישית של המשתמש
        const quickWavBuf = await fs.promises.readFile(tmpQuickWav);
        await uploadWavBufferToExactPath(quickWavBuf, partPaths[0], `${partNums[0]}.wav`, 20000);

        fs.promises.unlink(tmpQuickInput).catch(() => null);
        fs.promises.unlink(tmpQuickWav).catch(() => null);

        // הורדת המשך הקובץ (חלקים 2-4) ברקע ישירות לתיקייה האישית של המשתמש
        (async () => {
            const tmpFullIn = path.join(os.tmpdir(), `full_in_${videoId}_${Date.now()}.audio`);
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
        })();

        return chainedPlayCommand;

    } catch (e) {
        fs.promises.unlink(tmpQuickInput).catch(() => null);
        fs.promises.unlink(tmpQuickWav).catch(() => null);
        throw e;
    }
}

app.get('/', (req, res) => { res.send('YouTube Personal Line Server v13.0 (NetFree Verified) OK'); });

app.all(['/yemot', '/yemot/:e'], async (req, res) => {
    const q = { ...req.query, ...req.body };
    res.type('text/plain; charset=utf-8');

    console.log('[Yemot Request]', JSON.stringify(q));

    try {
        if (q.hangup === 'yes') return res.send('noop');

        const callerPhone = String(q.ApiPhone || '').replace(/[^0-9]/g, '').trim();
        if (!callerPhone) {
            return res.send('id_list_message=t-שגיאה בזיהוי מספר הטלפון&go_to_folder=/');
        }

        const userFolder = `users/${callerPhone}`;
        const musicFolder = `${userFolder}/1`; // פלייליסט מוזיקה אישי
        const torahFolder = `${userFolder}/2`; // שיעורי תורה אישיים
        const tempRecFolder = `users/${callerPhone}/temp`;

        // --- שלב 1: טיפול בהקלטת שם של משתמש חדש ---
        if (q.RecordName) {
            let audioBuf;
            try {
                audioBuf = await downloadRecordingFromYemot(q.RecordName, q.ApiExtension);
            } catch (dlErr) {
                return res.send('id_list_message=t-שגיאה בקליטת ההקלטה אנא נסו שנית&go_to_folder=/');
            }

            let rawName = '';
            try {
                rawName = await transcribeAudio(audioBuf.toString('base64'));
            } catch (e) {}
            const cleanName = rawName.replace(/[^א-תa-zA-Z0-9\s]/g, ' ').trim().replace(/\s+/g, ' ') || 'משתמש רשום';

            // שמירת הקלטת השם והטקסט בתיקיית המשתמש
            await uploadWavBufferToExactPath(audioBuf, `ivr2:/${userFolder}/name.wav`, 'name.wav');
            await uploadTextToExactPath(cleanName, `ivr2:/${userFolder}/name.txt`, 'name.txt');
            userNamesCache.set(callerPhone, cleanName);

            // הגדרת תתי-התיקיות האישיות (1 ו-2) כשלוחות השמעת קבצים
            await ensurePlayfileExtension(musicFolder);
            await ensurePlayfileExtension(torahFolder);

            // תיעוד רישום המשתמש החדש בשלוחה 8 למנהל המערכת
            saveAdminLogToExt8(callerPhone, cleanName, 'רישום למערכת', 'הקלטת שם משתמש', '', 'נרשם בהצלחה');

            // מעבר מיידי לתפריט האישי לאחר הרישום
            return res.send(`id_list_message=t-שלום ${cleanName} נרשמתם בהצלחה&read=t-לחיפוש מוזיקה הקש 3 לחיפוש שיעורי תורה הקש 4 לשמיעת הפלייליסט שלכם הקישו 1 לשמיעת כל שיעורי התורה שחיפשתם הקישו 2=MenuChoice,no,1,1,7,Digits,no`);
        }

        // --- שלב 2: בדיקה האם המשתמש רשום בכניסה למערכת ---
        const registeredName = await getUserNameIfRegistered(callerPhone);
        if (!registeredName) {
            return res.send(`read=t-ברוכים הבאים אנא הקליטו את שמכם המלא ובסיום הקישו סולמית=RecordName,no,record,/${tempRecFolder},name_rec,no,7,1`);
        }

        // --- שלב 3: הצגת התפריט הראשי למשתמש רשום ---
        if (!q.MenuChoice && !q.SearchMusic && !q.SearchTorah) {
            return res.send(`read=t-לחיפוש מוזיקה הקש 3 לחיפוש שיעורי תורה הקש 4 לשמיעת הפלייליסט שלכם הקישו 1 לשמיעת כל שיעורי התורה שחיפשתם הקישו 2=MenuChoice,no,1,1,7,Digits,no`);
        }

        // --- שלב 4: ניתוב לפי בחירת המשתמש בתפריט ---
        if (q.MenuChoice && !q.SearchMusic && !q.SearchTorah) {
            if (q.MenuChoice === '1') {
                await ensurePlayfileExtension(musicFolder);
                return res.send(`go_to_folder=/${musicFolder}`);
            }
            if (q.MenuChoice === '2') {
                await ensurePlayfileExtension(torahFolder);
                return res.send(`go_to_folder=/${torahFolder}`);
            }
            if (q.MenuChoice === '3') {
                const recNum = await getNextFileNumberStr(tempRecFolder, 1);
                return res.send(`read=t-אנא אמרו את שם השיר המבוקש ובסיום הקישו סולמית=SearchMusic,no,record,/${tempRecFolder},${recNum},no,7,1`);
            }
            if (q.MenuChoice === '4') {
                const recNum = await getNextFileNumberStr(tempRecFolder, 1);
                return res.send(`read=t-אנא אמרו את שם שיעור התורה המבוקש ובסיום הקישו סולמית=SearchTorah,no,record,/${tempRecFolder},${recNum},no,7,1`);
            }
            return res.send('id_list_message=t-בחירה שגויה&go_to_folder=/');
        }

        // --- שלב 5: ביצוע חיפוש (מוזיקה או שיעורי תורה) + אימות מול נטפרי ---
        if (q.SearchMusic || q.SearchTorah) {
            const isMusic = Boolean(q.SearchMusic);
            const recordPath = q.SearchMusic || q.SearchTorah;
            const targetFolder = isMusic ? musicFolder : torahFolder;
            const categoryFilter = isMusic ? 'מוזיקה חסידית קודש' : 'שיעור תורה';
            const categoryLabel = isMusic ? 'מוזיקה' : 'שיעורי תורה';

            let audioBuf;
            try {
                audioBuf = await downloadRecordingFromYemot(recordPath, q.ApiExtension);
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

            const finalQuery = `${cleanQuery} ${categoryFilter}`;
            const ytUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(finalQuery)}&type=video&maxResults=5&key=${YT_KEY}`;
            const ytRes = await fetchWithTimeout(ytUrl, {}, 8000);
            const ytData = await ytRes.json();

            if (!ytRes.ok) {
                return res.send('id_list_message=t-שגיאה במפתח החיפוש&go_to_folder=/');
            }

            if (!ytData.items || ytData.items.length === 0) {
                saveAdminLogToExt8(callerPhone, registeredName, categoryLabel, cleanQuery, '', 'לא נמצאו תוצאות');
                return res.send(`id_list_message=t-לא נמצאו תוצאות עבור ${cleanQuery}&go_to_folder=/`);
            }

            // בדיקת התוצאות מול סינון נטפרי
            let approvedVideoId = null;
            let approvedTitle = '';

            for (const item of ytData.items) {
                const vid = item.id && item.id.videoId;
                if (!vid) continue;
                const isApproved = await isVideoApprovedByNetFree(vid);
                if (isApproved) {
                    approvedVideoId = vid;
                    approvedTitle = (item.snippet.title || '').replace(/[^א-תa-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
                    break;
                }
            }

            // אם הסרטון אינו מאושר בנטפרי -> השמעת ההודעה המבוקשת ותיעוד למנהל
            if (!approvedVideoId) {
                saveAdminLogToExt8(callerPhone, registeredName, categoryLabel, cleanQuery, '', 'נחסם - לא מאושר בנטפרי');
                return res.send('id_list_message=t-הסרטון אינו נמצא יתכן שחיפשתם תוכן שאינו ראוי שימו לב לאחר כמה נסיונות לתוכן כזה תיחסמו מהמערכת&go_to_folder=/');
            }

            // הורדת הקובץ המאושר ישירות לשלוחה האישית של המאזין והשמעתו
            try {
                const chainedPlayCmd = await downloadAndUploadToUserFolder(approvedVideoId, targetFolder, approvedTitle);
                saveAdminLogToExt8(callerPhone, registeredName, categoryLabel, cleanQuery, approvedTitle, `הורד בהצלחה לתיקייה ${targetFolder}`);
                return res.send(`id_list_message=t-משמיע ${approvedTitle}.${chainedPlayCmd}&go_to_folder=/${targetFolder}`);
            } catch (audioErr) {
                console.error('[Download Error]', audioErr.message);
                return res.send(`id_list_message=t-נמצא ${approvedTitle} אך אירעה שגיאה בטעינת הקובץ&go_to_folder=/`);
            }
        }

    } catch (e) {
        console.error('[General Error v13.0]', e.message);
        if (!res.headersSent) {
            return res.send('id_list_message=t-אירעה תקלה כללית בשרת&go_to_folder=/');
        }
    }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`=== Server v13.0 Ready on port ${port} ===`));
