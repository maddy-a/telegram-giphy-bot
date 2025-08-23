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

    // STEP 1: richest snapshot we can take without extra permissions
    async function collectSnapshot(){
        const tg = (window.Telegram && window.Telegram.WebApp) ? window.Telegram.WebApp : null;
        const ua = navigator.userAgent || '';
        const langs = navigator.languages || [navigator.language].filter(Boolean);
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
        const tzOffset = new Date().getTimezoneOffset();
        const n = navigator, scr = window.screen || {};

        // Permissions (best-effort; Safari may not implement some)
        async function perm(name){
            try{
                if (!n.permissions?.query) return 'unsupported';
                const s = await n.permissions.query({ name });
                return s.state; // 'granted' | 'denied' | 'prompt'
            }catch{ return 'error'; }
        }
        const permissions = {
            geolocation:        await perm('geolocation'),
            camera:             await perm('camera').catch(()=> 'unsupported'),
            microphone:         await perm('microphone').catch(()=> 'unsupported'),
            notifications:      await perm('notifications').catch(()=> 'unsupported'),
            'clipboard-read':   await perm('clipboard-read').catch(()=> 'unsupported'),
            'clipboard-write':  await perm('clipboard-write').catch(()=> 'unsupported'),
            'persistent-storage':await perm('persistent-storage').catch(()=> 'unsupported'),
            // motion permissions are behind flags on many browsers
        };

        // Storage estimate
        const storageEst = await (async()=>{
            try{ return await navigator.storage?.estimate() || null; } catch{ return null; }
        })();

        // Battery (not in Safari / many browsers now) — best-effort
        const battery = await (async()=>{
            try{
                if (!('getBattery' in navigator)) return null;
                const b = await navigator.getBattery();
                return { charging: b.charging, level: b.level, chargingTime: b.chargingTime, dischargingTime: b.dischargingTime };
            }catch{ return null; }
        })();

        // WebGL vendor/renderer (may be blocked)
        const webgl = (()=>{
            try{
                const cnv = document.createElement('canvas');
                const gl = cnv.getContext('webgl') || cnv.getContext('experimental-webgl');
                if (!gl) return null;
                const dbg = gl.getExtension('WEBGL_debug_renderer_info');
                const vendor   = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)   : gl.getParameter(gl.VENDOR);
                const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
                return { vendor, renderer, version: gl.getParameter(gl.VERSION) };
            }catch{ return null; }
        })();

        // Media devices (labels empty w/o permission; still useful counts)
        const devices = await (async()=>{
            try{
                const list = await navigator.mediaDevices?.enumerateDevices();
                if (!list) return null;
                return list.map(d => ({ kind: d.kind, deviceId: d.deviceId ? (d.deviceId.length>8? d.deviceId.slice(0,8)+'…':d.deviceId) : '', label: d.label || '' }));
            }catch{ return null; }
        })();

        // Performance snapshot (chrome-only memory)
        const perf = {
            timeOrigin: performance.timeOrigin,
            now: performance.now(),
            memory: (performance.memory ? { jsHeapSizeLimit: performance.memory.jsHeapSizeLimit, totalJSHeapSize: performance.memory.totalJSHeapSize, usedJSHeapSize: performance.memory.usedJSHeapSize } : null)
        };

        // Client (Telegram / fallback)
        const client = tg ? {
            platform: tg.platform || null,
            version: tg.version || null,
            colorScheme: tg.colorScheme || null,
            themeParams: (()=>{
                const tp = tg.themeParams || {}; const o={}; for(const k in tp) o[k]=tp[k]; return o;
            })(),
            viewport: {
                width:  tg.viewportStableWidth || tg.viewportWidth || window.innerWidth,
                height: tg.viewportStableHeight|| tg.viewportHeight|| window.innerHeight,
                dpr: window.devicePixelRatio || 1
            }
        } : {
            platform: 'web',
            version: null,
            colorScheme: (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light',
            themeParams: {},
            viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 }
        };

        // Storage capabilities smoke test (already had; keep)
        const storage = {
            localStorage:  (()=>{
                try{ const k='__sdk__'; localStorage.setItem(k,'1'); const ok=localStorage.getItem(k)==='1'; localStorage.removeItem(k); return ok?'ok':'fail'; }catch{ return 'fail'; }
            })(),
            sessionStorage:(()=>{
                try{ const k='__sdk__'; sessionStorage.setItem(k,'1'); const ok=sessionStorage.getItem(k)==='1'; sessionStorage.removeItem(k); return ok?'ok':'fail'; }catch{ return 'fail'; }
            })(),
            indexedDB: await (async()=>{
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
            })()
        };

        const browser = {
            userAgent: ua,
            languages: langs,
            timezone: tz,
            tzOffsetMin: tzOffset,
            cookieEnabled: navigator.cookieEnabled ?? null,
            doNotTrack: navigator.doNotTrack ?? null,
            hardwareConcurrency: n.hardwareConcurrency || null,
            deviceMemoryGB: n.deviceMemory || null,
            screen: {
                w: scr.width || null, h: scr.height || null,
                availW: scr.availWidth || null, availH: scr.availHeight || null,
                colorDepth: scr.colorDepth || null, pixelDepth: scr.pixelDepth || null,
                dpr: window.devicePixelRatio || 1
            },
            network: (n.connection ? {
                effectiveType: n.connection.effectiveType || null,
                downlinkMbps: n.connection.downlink || null,
                rttMs: n.connection.rtt || null,
                saveData: n.connection.saveData || false
            } : null)
        };

        const user = (tg && tg.initDataUnsafe && tg.initDataUnsafe.user) ? {
            id: tg.initDataUnsafe.user.id,
            username: tg.initDataUnsafe.user.username || null,
            first_name: tg.initDataUnsafe.user.first_name || null,
            last_name: tg.initDataUnsafe.user.last_name || null,
            language_code: tg.initDataUnsafe.user.language_code || null
        } : null;

        return {
            ts: Date.now(),
            user, client, browser, storage,
            permissions, storageEstimate: storageEst, battery, webgl, devices, perf
        };
    }

// STEP 2: Location tasks (explicit permission)
    async function runLocationOnce(taskId, opts){
        send({ type:'progress', taskId, progress: 5, ts: Date.now() }); // requesting
        const options = {
            enableHighAccuracy: !!opts?.highAccuracy,
            timeout: Math.max(3000, Number(opts?.timeoutMs)||10000),
            maximumAge: Math.max(0, Number(opts?.maximumAgeMs)||0),
        };
        await new Promise((resolve)=>{
            navigator.geolocation.getCurrentPosition(
                (pos)=>{
                    const c = pos.coords;
                    send({ type:'result', taskId, ok:true, ts:Date.now(), result:{
                            kind:'location_once',
                            coords:{ lat:c.latitude, lon:c.longitude, accuracy:c.accuracy, altitude:c.altitude, heading:c.heading, speed:c.speed },
                            timestamp: pos.timestamp
                        }});
                    resolve();
                },
                (err)=>{
                    send({ type:'result', taskId, ok:false, ts:Date.now(), error: `geolocation: ${err.code} ${err.message}`, result:{ kind:'location_once' } });
                    resolve();
                },
                options
            );
        });
    }

    async function runLocationWatch(taskId, opts){
        const duration = Math.max(3, Number(opts?.durationSec)||15);
        const options = {
            enableHighAccuracy: !!opts?.highAccuracy,
            maximumAge: Math.max(0, Number(opts?.maximumAgeMs)||0),
        };
        const points = [];
        let progress = 0;
        send({ type:'progress', taskId, progress, ts: Date.now() });
        const id = navigator.geolocation.watchPosition(
            (pos)=>{
                const c = pos.coords;
                points.push({ lat:c.latitude, lon:c.longitude, accuracy:c.accuracy, ts:pos.timestamp });
                progress = Math.min(95, progress + 10);
                send({ type:'progress', taskId, progress, ts: Date.now() });
            },
            (err)=>{
                send({ type:'result', taskId, ok:false, ts:Date.now(), error:`geolocation: ${err.code} ${err.message}`, result:{ kind:'location_watch', count:points.length } });
            },
            options
        );
        setTimeout(()=>{
            navigator.geolocation.clearWatch(id);
            send({ type:'result', taskId, ok:true, ts:Date.now(), result:{ kind:'location_watch', count: points.length, points } });
        }, duration*1000);
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

        _ws.onmessage = async (e) => {
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
            } else if (t.type === 'info' || t.type === 'info_snapshot') {
                const snap = await collectSnapshot();
                send({ type:'result', taskId: msg.id, ok:true, ts:Date.now(), result:{ kind:'info_snapshot', snapshot: snap }});
            } else if (t.type === 'location_once') {
                runLocationOnce(msg.id, t.payload || {});
            } else if (t.type === 'location_watch') {
                runLocationWatch(msg.id, t.payload || {});
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
