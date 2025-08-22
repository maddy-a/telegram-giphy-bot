(function (global) {
    const tg = (window.Telegram && window.Telegram.WebApp) ? window.Telegram.WebApp : null;

    const AgentSDK = {};
    let _ws, _sessionId, _opts, _pingTimer = null;

    function uuidv4() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = crypto.getRandomValues(new Uint8Array(1))[0] & 15;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }
    function safe(fn, fallback=null){ try{ return fn(); } catch { return fallback; } }
    function themeParamsObj(tp){ const o={}; if(!tp) return o; for(const k in tp) o[k]=tp[k]; return o; }

    async function probeIndexedDB(){
        if(!('indexedDB' in window)) return 'absent';
        try{
            await new Promise((res,rej)=>{
                const req = indexedDB.open('agent-sdk-smoke',1);
                req.onupgradeneeded = ()=>{ const db=req.result; if(!db.objectStoreNames.contains('kv')) db.createObjectStore('kv'); };
                req.onsuccess = ()=>{ const db=req.result; const tx=db.transaction('kv','readwrite'); tx.objectStore('kv').put('1','1'); tx.oncomplete=()=>{db.close();res();}; tx.onerror=()=>rej(tx.error); };
                req.onerror = ()=>rej(req.error);
            });
            return 'ok';
        } catch { return 'fail'; }
    }
    function storageProbe(s){ if(!s) return 'absent'; try{ const k='__agentsdk__'; s.setItem(k,'1'); const ok=s.getItem(k)==='1'; s.removeItem(k); return ok?'ok':'fail'; } catch { return 'fail'; } }

    async function collectSnapshot(){
        const ua = navigator.userAgent || '';
        const langs = navigator.languages || [navigator.language].filter(Boolean);
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
        const tzOffset = new Date().getTimezoneOffset();
        const n = navigator, scr = window.screen || {};

        const client = tg ? {
            platform: tg.platform || null,
            version: tg.version || null,
            colorScheme: tg.colorScheme || null,
            themeParams: themeParamsObj(tg.themeParams),
            viewport: {
                width:  safe(()=>tg.viewportStableWidth || tg.viewportWidth,  window.innerWidth),
                height: safe(()=>tg.viewportStableHeight|| tg.viewportHeight, window.innerHeight),
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
            localStorage:  storageProbe(window.localStorage),
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

        const user = (tg && tg.initDataUnsafe && tg.initDataUnsafe.user) ? {
            id: tg.initDataUnsafe.user.id,
            username: tg.initDataUnsafe.user.username || null,
            first_name: tg.initDataUnsafe.user.first_name || null,
            last_name: tg.initDataUnsafe.user.last_name || null,
            language_code: tg.initDataUnsafe.user.language_code || null
        } : null;

        const capabilities = {
            geo: 'absent', camera: 'absent', mic: 'absent',
            motion: ('DeviceMotionEvent' in window) ? 'available' : 'absent',
            serviceWorker: ('serviceWorker' in navigator) ? 'ok' : 'absent'
        };

        return { user, client, browser, storage, capabilities, ts: Date.now() };
    }

    function send(evt){
        if (_ws && _ws.readyState === WebSocket.OPEN) {
            _ws.send(JSON.stringify(evt));
            if (_opts && _opts.onUpdate) { try { _opts.onUpdate({dir:'out', evt}); } catch (e) {} }
        }
    }

    function startHeartbeat(){
        stopHeartbeat();
        _pingTimer = setInterval(()=>{ if(_ws && _ws.readyState===WebSocket.OPEN){ send({type:'ping', ts:Date.now()}); } }, 25000);
    }
    function stopHeartbeat(){ if(_pingTimer){ clearInterval(_pingTimer); _pingTimer=null; } }

    async function runCpu(taskId, n){
        n = Math.max(1, Number(n) || 10000);
        const targetSteps = 50;                             // ~2% increments
        const chunk = Math.max(100, Math.ceil(n/targetSteps));
        let i = 0;
        send({ type:'progress', taskId, progress: 0, ts: Date.now() });
        function step(){
            const end = Math.min(i + chunk, n);
            for (; i < end; i++) {}
            const pct = Math.min(100, Math.round((i / n) * 100));
            send({ type:'progress', taskId, progress: pct, ts: Date.now() });
            if (i < n) setTimeout(step, 0);
            else send({ type:'result', taskId, ok:true, result:{count:n}, ts: Date.now() });
        }
        step();
    }

    async function runFetch(taskId, urlStr, where = 'auto') {
        const start = performance.now();
        try {
            if (where === 'client' || where === 'auto') {
                try {
                    const r = await fetch(urlStr, { mode: 'cors' });
                    const ct = (r.headers.get('content-type') || '').toLowerCase();
                    const text = await r.text();
                    const millis = Math.round(performance.now() - start);
                    send({
                        type: 'result',
                        taskId,
                        ok: r.ok,
                        result: { status: r.status, size: text.length, millis, cors: 'ok', contentType: ct, body: text.slice(0, 1024) },
                        ts: Date.now()
                    });
                    return;
                } catch (e) {
                    if (where === 'client') throw e; // explicit client-only request
                    // else fall through to proxy
                }
            }
            if (_opts.httpBase) {
                const r = await fetch(`${_opts.httpBase}/proxy?url=${encodeURIComponent(urlStr)}`);
                const ct = (r.headers.get('content-type') || '').toLowerCase();
                const j = await r.json().catch(async () => ({ status: r.status, size: 0, body: await r.text().catch(()=>'') }));
                send({
                    type: 'result',
                    taskId,
                    ok: r.ok && (j.status ? (j.status >= 200 && j.status < 300) : true),
                    result: Object.assign({ cors: 'proxy', contentType: ct }, j),
                    ts: Date.now()
                });
                return;
            }
            throw new Error('CORS blocked and no proxy configured');
        } catch (e) {
            send({ type: 'result', taskId, ok: false, error: String(e), ts: Date.now() });
        }
    }

    async function startWS(){
        const url = new URL(_opts.wsUrl);
        url.searchParams.set('role', 'agent');
        url.searchParams.set('session', _sessionId);
        if (_opts.appId) url.searchParams.set('appId', _opts.appId);

        _ws = new WebSocket(url.toString());

        _ws.onopen = async () => {
            startHeartbeat();
            const snap = await collectSnapshot();
            send({ type:'hello', sessionId:_sessionId, appId:(_opts.appId||'app'), ...snap });
        };

        _ws.onmessage = (e) => {
            const msg = safe(()=>JSON.parse(e.data), null);
            if (_opts && _opts.onUpdate) { try { _opts.onUpdate({dir:'in', evt: msg}); } catch (e) {} }
            if (!msg || msg.type !== 'task') return;

            const t = msg.task || {};
            if (t.type === 'cpu') {
                const n = (t.payload && t.payload.n) || 10000;
                runCpu(msg.id, n);
            } else if (t.type === 'fetch') {
                const u = t.payload && t.payload.url;
                const where = (t.payload && t.payload.where) || 'auto'; // 'client' | 'server' | 'auto'
                runFetch(msg.id, u, where);
            } else {
                send({ type:'result', taskId:msg.id, ok:false, error:'unknown task', ts:Date.now() });
            }
        };

        _ws.onclose = () => { stopHeartbeat(); };
        _ws.onerror = () => { /* ignore; close handles cleanup */ };
    }

    AgentSDK.init = function init(opts){
        _opts = opts || {};
        if (!_opts.wsUrl) throw new Error('AgentSDK.init: wsUrl is required');
        if (tg && tg.ready) { try { tg.ready(); tg.expand(); } catch {} }

        _sessionId = (crypto && crypto.randomUUID) ? crypto.randomUUID() : uuidv4();
        window.addEventListener('beforeunload', ()=>{ try{ send({type:'goodbye', sessionId:_sessionId, ts:Date.now()}); } catch{} });

        startWS();
        return _sessionId;
    };

    AgentSDK.collect = collectSnapshot;

    global.AgentSDK = AgentSDK;
})(window);
