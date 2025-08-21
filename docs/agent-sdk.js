(function (global) {
    const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;

    const AgentSDK = {};
    let _ws, _sessionId, _opts, _alive = false, _pingTimer = null;

    function uuidv4() {
        // lightweight uuid
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = crypto.getRandomValues(new Uint8Array(1))[0] & 15;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    function safe(fn, fallback = null) {
        try { return fn(); } catch { return fallback; }
    }

    function themeParamsObj(tp) {
        const out = {};
        if (!tp) return out;
        for (const k in tp) out[k] = tp[k];
        return out;
    }

    async function probeIndexedDB() {
        if (!('indexedDB' in window)) return 'absent';
        try {
            await new Promise((res, rej) => {
                const req = indexedDB.open('agent-sdk-smoke', 1);
                req.onupgradeneeded = () => {
                    const db = req.result;
                    if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
                };
                req.onsuccess = () => {
                    const db = req.result;
                    const tx = db.transaction('kv', 'readwrite');
                    tx.objectStore('kv').put('1', '1');
                    tx.oncomplete = () => { db.close(); res(); };
                    tx.onerror = () => rej(tx.error);
                };
                req.onerror = () => rej(req.error);
            });
            return 'ok';
        } catch { return 'fail'; }
    }

    function storageProbe(storage) {
        if (!storage) return 'absent';
        try {
            const key = '__agentsdk__';
            storage.setItem(key, '1');
            const ok = storage.getItem(key) === '1';
            storage.removeItem(key);
            return ok ? 'ok' : 'fail';
        } catch { return 'fail'; }
    }

    async function collectSnapshot() {
        const ua = navigator.userAgent || '';
        const langs = navigator.languages || [navigator.language].filter(Boolean);
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
        const tzOffset = new Date().getTimezoneOffset();

        const n = navigator;
        const scr = window.screen || {};

        const client = tg ? {
            platform: tg.platform || null,
            version: tg.version || null,
            colorScheme: tg.colorScheme || null,
            themeParams: themeParamsObj(tg.themeParams),
            viewport: {
                width: safe(() => tg.viewportStableWidth || tg.viewportWidth, window.innerWidth),
                height: safe(() => tg.viewportStableHeight || tg.viewportHeight, window.innerHeight),
                dpr: window.devicePixelRatio || 1
            }
        } : {
            platform: 'web',
            version: null,
            colorScheme: (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light',
            themeParams: {},
            viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 }
        };

        const storage = {
            localStorage: storageProbe(window.localStorage),
            sessionStorage: storageProbe(window.sessionStorage),
            indexedDB: await probeIndexedDB()
        };

        const browser = {
            userAgent: ua,
            languages: langs,
            timezone: tz,
            tzOffsetMin: tzOffset,
            hardwareConcurrency: n.hardwareConcurrency || null,
            deviceMemoryGB: n.deviceMemory || null,
            screen: {
                w: scr.width || null, h: scr.height || null,
                availW: scr.availWidth || null, availH: scr.availHeight || null,
                dpr: window.devicePixelRatio || 1
            },
            network: (n.connection ? {
                effectiveType: n.connection.effectiveType || null,
                downlinkMbps: n.connection.downlink || null,
                rttMs: n.connection.rtt || null
            } : null)
        };

        const user = tg && tg.initDataUnsafe && tg.initDataUnsafe.user ? {
            id: tg.initDataUnsafe.user.id,
            username: tg.initDataUnsafe.user.username || null,
            first_name: tg.initDataUnsafe.user.first_name || null,
            last_name: tg.initDataUnsafe.user.last_name || null,
            language_code: tg.initDataUnsafe.user.language_code || null
        } : null;

        const caps = {
            geo: 'absent',
            camera: 'absent',
            mic: 'absent',
            motion: ('DeviceMotionEvent' in window) ? 'available' : 'absent',
            serviceWorker: ('serviceWorker' in navigator) ? 'ok' : 'absent'
        };

        return {
            user, client, browser, storage, capabilities: caps, ts: Date.now()
        };
    }

    function send(evt) {
        if (_ws && _ws.readyState === WebSocket.OPEN) {
            _ws.send(JSON.stringify(evt));
            if (_opts && _opts.onUpdate) _opts.onUpdate({dir:'out', evt});
        }
    }

    function heartbeat() {
        clearInterval(_pingTimer);
        _pingTimer = setInterval(() => {
            if (_ws && _ws.readyState === WebSocket.OPEN) {
                _ws.send(JSON.stringify({type:'ping', ts: Date.now()}));
            }
        }, 25000); // keep Heroku routers happy
    }

    async function startWS() {
        const url = new URL(_opts.wsUrl);
        url.searchParams.set('role', 'agent');
        url.searchParams.set('session', _sessionId);
        if (_opts.appId) url.searchParams.set('appId', _opts.appId);

        _ws = new WebSocket(url.toString());
        _ws.onopen = async () => {
            _alive = true; heartbeat();
            const snap = await collectSnapshot();
            send({
                type: 'hello',
                sessionId: _sessionId,
                appId: _opts.appId || 'app',
                ...snap
            });
        };
        _ws.onmessage = (e) => {
            const msg = safe(() => JSON.parse(e.data), null);
            if (_opts && _opts.onUpdate) _opts.onUpdate({dir:'in', evt: msg});
            // Future: handle tasks here
        };
        _ws.onclose = () => { _alive = false; clearInterval(_pingTimer); _pingTimer = null; };
        _ws.onerror = () => { /* swallow; dashboard sees disconnect via onclose */ };
    }

    AgentSDK.init = function init(opts) {
        _opts = opts || {};
        if (!opts || !opts.wsUrl) throw new Error('AgentSDK.init: wsUrl is required');
        if (tg && tg.ready) { try { tg.ready(); tg.expand(); } catch {} }

        _sessionId = (crypto && crypto.randomUUID) ? crypto.randomUUID() : uuidv4();

        // graceful goodbye
        window.addEventListener('beforeunload', () => {
            try { send({type:'goodbye', sessionId: _sessionId, ts: Date.now()}); } catch {}
        });

        startWS();
        return _sessionId;
    };

    AgentSDK.collect = collectSnapshot;

    global.AgentSDK = AgentSDK;
})(window);
