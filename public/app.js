"use strict";
/* Multi-Camera Live View — client.
   Talks ONLY to this app's backend (same origin). The backend holds the Trax
   credentials and proxies the API + FLV streams, so nothing sensitive lives here. */
(function(){
  /* ===================== icons ===================== */
  const SVG = (p)=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%">${p}</svg>`;
  const IC = {
    search: SVG('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/>'),
    pin: SVG('<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>'),
    cam: SVG('<rect x="2" y="6" width="13" height="12" rx="2"/><path d="M15 10l6-3v10l-6-3Z"/>'),
    camOff: SVG('<path d="M2 6h11v9M15 10l6-3v10M3 3l18 18"/>'),
    camBig: SVG('<rect x="2" y="6" width="13" height="12" rx="2"/><path d="M15 10l6-3v10l-6-3Z"/>'),
    camera: SVG('<path d="M23 19V8a2 2 0 0 0-2-2h-3l-2-3H8L6 6H3a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2Z"/><circle cx="12" cy="13" r="3.5"/>'),
    volume: SVG('<path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="M16 9a4 4 0 0 1 0 6M19 7a8 8 0 0 1 0 10"/>'),
    mute: SVG('<path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="M22 9l-6 6M16 9l6 6"/>'),
    x: SVG('<path d="M18 6 6 18M6 6l12 12"/>'),
    max: SVG('<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>'),
    min: SVG('<path d="M9 3v6H3M21 15h-6v6M3 9l6-6M15 21l6-6"/>'),
    trash: SVG('<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>'),
    video: SVG('<rect x="2" y="6" width="13" height="12" rx="2"/><path d="M15 10l6-3v10l-6-3Z"/>'),
    logout: SVG('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>'),
    alert: SVG('<path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>'),
  };

  /* ===================== API (backend, same origin) ===================== */
  const api = {
    token: null,
    setToken(t){ this.token = t || null; try { t ? sessionStorage.setItem("mcv_token", t) : sessionStorage.removeItem("mcv_token"); } catch(e){} },
    loadToken(){ try { this.token = sessionStorage.getItem("mcv_token") || null; } catch(e){ this.token = null; } return this.token; },
    async req(path, opts){
      opts = opts || {};
      const headers = Object.assign({}, opts.headers);
      if (this.token) headers["Authorization"] = "Bearer " + this.token;
      let body;
      if (opts.json !== undefined){ headers["Content-Type"] = "application/json"; body = JSON.stringify(opts.json); }
      const res = await fetch(path, { method: opts.method || "GET", headers, body });
      // sliding session: adopt the freshly-dated token the backend hands back
      const fresh = res.headers.get("X-MCV-Token");
      if (fresh && fresh !== this.token) this.setToken(fresh);
      const txt = await res.text();
      let data = null; try { data = txt ? JSON.parse(txt) : null; } catch(e){}
      if (!res.ok){ const err = new Error((data && data.error) || ("HTTP " + res.status)); err.status = res.status; throw err; }
      return data;
    },
    authenticate(database, userName, password){
      return this.req("/auth/login", { method:"POST", json:{ database, userName, password } })
        .then(r => { this.setToken(r.token); return r; });
    },
    me(){ return this.req("/auth/me"); },
    logout(){ return this.req("/auth/logout", { method:"POST" }).catch(()=>{}); },
    getDevices(){ return this.req("/api/devices"); },
    getStatuses(ids){ return this.req("/api/statuses", { method:"POST", json:{ deviceIds: ids } }); },
    getLiveMedia(deviceId){ return this.req("/api/livemedia", { method:"POST", json:{ deviceId } }); },
  };
  function isAuthError(err){ return !!err && err.status === 401; }

  /* ===================== state ===================== */
  const MAX_TILES = 16;
  const state = {
    account: null,      // {userName, database}
    devices: [],
    statuses: {},       // deviceId -> DeviceStatusInfo
    search: "",
    statusFilter: "all", // all | online | streamable
    layout: "auto",
    tiles: [],          // {id, deviceId, deviceName, channel, url}
    focus: null,
    pollTimer: null,
    clockTimer: null,
  };
  const tileEls = {};   // id -> {root, video, player, overlay, ...}
  const $ = (id)=>document.getElementById(id);

  /* ===================== status mapping ===================== */
  function statusMeta(s){
    return ({
      moving:{ c:"#12B76A", t:"Moving", bg:"#ECFDF3", fg:"#027A48" },
      idling:{ c:"#F79009", t:"Idling", bg:"#FFFAEB", fg:"#B54708" },
      stopped:{ c:"#1F7BC1", t:"Stopped", bg:"#E7F2FA", fg:"#0F5795" },
      offline:{ c:"#98A2B3", t:"Offline", bg:"#F2F4F7", fg:"#667085" },
      unknown:{ c:"#D0D5DD", t:"Checking…", bg:"#F2F4F7", fg:"#98A2B3" },
    })[s];
  }
  function bucket(info){
    if (!info) return "unknown";
    if (info.isDeviceCommunicating === false) return "offline";
    const speed = Number(info.speed) || 0;
    if (speed > 1) return "moving";
    if (info.ignition) return "idling";
    return "stopped";
  }
  function cameraOnline(info){ return !!info && (info.cameraStatus === "online" || (info.cameraStatus == null && info.isDeviceCommunicating === true)); }
  function statusText(info){
    const b = bucket(info);
    if (b === "unknown") return "Checking…";
    if (b === "offline") return "Offline";
    if (b === "moving") return "Moving · " + Math.round(Number(info.speed)||0) + " km/h";
    if (b === "idling") return "Idling";
    return "Stopped";
  }

  /* ===================== boot / auth ===================== */
  function showLogin(errMsg){
    $("app").style.display = "none";
    $("login").style.display = "flex";
    const box = $("loginError");
    if (errMsg){ $("loginErrTxt").textContent = errMsg; box.classList.add("show"); }
    else box.classList.remove("show");
    const qp = new URLSearchParams(location.search);
    if (qp.get("database") && !$("f-db").value) $("f-db").value = qp.get("database");
    if (qp.get("userName") && !$("f-user").value) $("f-user").value = qp.get("userName");
  }
  async function enterApp(account){
    state.account = account;
    $("login").style.display = "none";
    $("app").style.display = "flex";
    $("dbName").textContent = account.database;
    $("userName").textContent = account.userName;
    await loadDevices();
  }
  async function boot(){
    paintStatic();
    api.loadToken();
    if (api.token){
      try { const me = await api.me(); await enterApp(me); return; }
      catch(e){ api.setToken(null); }
    }
    showLogin();
  }

  /* ===================== devices + polling ===================== */
  async function loadDevices(){
    const list = await api.getDevices();
    state.devices = (list || []).slice().sort((a,b)=> String(a.name||"").localeCompare(String(b.name||"")));
    renderUnits();
    refreshStatuses();                 // initial sweep
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(refreshStatuses, 30000);  // every 30s
    if (!state.clockTimer){ state.clockTimer = setInterval(updateClocks, 1000); updateClocks(); }
  }
  async function refreshStatuses(){
    if (!state.devices.length) return;
    const ids = state.devices.map(d => d.id);
    try {
      const map = await api.getStatuses(ids);
      state.statuses = Object.assign({}, state.statuses, map);
    } catch(e){
      if (isAuthError(e)) return logout("Session expired. Please sign in again.");
      return;
    }
    renderUnits();
    syncTileStatuses();
  }

  /* ===================== render: static shell ===================== */
  function paintStatic(){
    $("loginLogo").innerHTML = IC.video;
    $("loginErrIc").innerHTML = IC.alert;
    $("brandMk").innerHTML = IC.video;
    $("logoutIc").innerHTML = IC.logout;
    $("searchIc").innerHTML = IC.search;
    $("clearIc").innerHTML = IC.trash;

    const fseg = $("filterSeg");
    [["all","All"],["online","Online"],["streamable","Streamable"]].forEach(([v,label])=>{
      const b = document.createElement("button");
      b.textContent = label; b.dataset.filter = v;
      b.className = state.statusFilter === v ? "on" : "";
      b.onclick = ()=>{ state.statusFilter = v; [...fseg.children].forEach(c=> c.className = c.dataset.filter===v?"on":""); renderUnits(); };
      fseg.appendChild(b);
    });
    const lseg = $("layoutSeg");
    [["auto","Auto"],["1","1×1"],["2","2×2"],["3","3×3"],["4","4×4"]].forEach(([v,label])=>{
      const b = document.createElement("button");
      b.textContent = label; b.dataset.layout = v;
      b.className = state.layout === v ? "on" : "";
      b.onclick = ()=>{ state.layout = v; [...lseg.children].forEach(c=> c.className = c.dataset.layout===v?"on":""); renderGrid(); };
      lseg.appendChild(b);
    });

    $("searchInput").addEventListener("input", (e)=>{ state.search = e.target.value; renderUnits(); });
    $("clearBtn").onclick = clearAll;
    $("logoutBtn").onclick = ()=> logout();
    $("loginForm").addEventListener("submit", onLoginSubmit);

    $("unitList").addEventListener("click", (e)=>{
      const card = e.target.closest("[data-device-id]");
      if (!card) return;
      const dev = state.devices.find(d => d.id === card.dataset.deviceId);
      if (!dev) return;
      if (card.dataset.clickable !== "1"){ showToast((dev.name || "Camera") + " is offline."); return; }
      toggleDevice(dev);
    });
  }

  function deviceActiveCount(id){ return state.tiles.filter(t => t.deviceId === id).length; }

  /* ===================== render: units ===================== */
  function renderUnits(){
    const q = state.search.trim().toLowerCase();
    const filtered = state.devices.filter(d=>{
      const info = state.statuses[d.id];
      if (q && !(String(d.name||"").toLowerCase().includes(q) || String(d.serialNumber||"").toLowerCase().includes(q))) return false;
      if (state.statusFilter === "online" && info && info.isDeviceCommunicating === false) return false;
      if (state.statusFilter === "online" && !info) return false;
      if (state.statusFilter === "streamable" && !cameraOnline(info)) return false;
      return true;
    });
    const order = { moving:0, idling:1, stopped:2, unknown:3, offline:4 };
    filtered.sort((a,b)=>{
      const ia = state.statuses[a.id], ib = state.statuses[b.id];
      const ea = cameraOnline(ia)?0:1, eb = cameraOnline(ib)?0:1;
      if (ea !== eb) return ea - eb;
      return order[bucket(ia)] - order[bucket(ib)];
    });

    const list = $("unitList");
    list.innerHTML = filtered.length ? filtered.map(unitCardHTML).join("")
      : '<div class="empty-note">No units match your search.</div>';

    $("unitCount").textContent = state.devices.length + " total";
    const streamable = state.devices.filter(d => cameraOnline(state.statuses[d.id])).length;
    $("streamableCount").textContent = streamable + " streamable";
  }

  function unitCardHTML(d){
    const info = state.statuses[d.id];
    const b = bucket(info);
    const m = statusMeta(b);
    const off = b === "offline";
    const eligible = cameraOnline(info);      // visual hint (blue "Stream"/"Live")
    const clickable = !off;                   // allow attempting a stream unless device is offline
    const active = deviceActiveCount(d.id) > 0;

    let pillStyle, pillLabel, pillIcon = "", pillDot = "";
    if (off){
      pillStyle = "background:#F9FAFB; color:#B0B7C0; border:1px solid #EAECF0;"; pillLabel = "Offline"; pillIcon = IC.camOff;
    } else if (active){
      pillStyle = "background:#136AB6; color:#fff; border:1px solid #136AB6;"; pillLabel = "Live";
      pillDot = '<span style="flex:none;width:6px;height:6px;border-radius:50%;background:#fff;animation:mcv-rec 1.3s infinite;"></span>';
    } else if (eligible){
      pillStyle = "background:#E7F2FA; color:#136AB6; border:1px solid #C8E0F3;"; pillLabel = "Stream"; pillIcon = IC.cam;
    } else {
      pillStyle = "background:#F2F4F7; color:#98A2B3; border:1px solid #EAECF0;"; pillLabel = b==="unknown"?"Checking…":"No signal"; pillIcon = IC.camOff;
    }

    let cardStyle;
    if (active) cardStyle = "background:#F4FAFD;border-color:#99C5E8;cursor:pointer;";
    else if (clickable) cardStyle = "background:#fff;cursor:pointer;";
    else cardStyle = "background:#fff;cursor:not-allowed;opacity:.72;";

    const badgeOnline = info && info.isDeviceCommunicating !== false;
    const badgeStyle = badgeOnline
      ? "background:#ECFDF3;color:#027A48;border:1px solid #A6F4C5;"
      : "background:#F2F4F7;color:#667085;border:1px solid #EAECF0;";
    const sub = d.serialNumber ? ("S/N " + d.serialNumber) : (d.model || d.vin || "Camera");

    return `<div class="unit-card" data-device-id="${escapeHTML(d.id)}" data-clickable="${clickable?1:0}" style="${cardStyle}">
      <div class="row1">
        <span style="flex:none;width:9px;height:9px;border-radius:50%;background:${m.c};"></span>
        <span class="name" style="color:${off?'#98A2B3':'#101828'};">${escapeHTML(d.name||d.id)}</span>
        <span class="badge" style="${badgeStyle}">${badgeOnline?"Online":"Offline"}</span>
        <span style="flex:1"></span>
        <span class="pill" style="${pillStyle}">${pillDot}<span class="ic">${pillIcon}</span>${pillLabel}</span>
      </div>
      <div class="row2">
        <span class="ic">${IC.pin}</span>
        <span class="sub">${escapeHTML(sub)}</span>
        <span style="font-size:12px;color:#D0D5DD;">·</span>
        <span class="sub" style="color:${m.c};font-weight:500;">${escapeHTML(statusText(info))}</span>
      </div>
    </div>`;
  }

  // Update a single unit card in place (cheap) instead of rebuilding the whole 154-row list.
  function updateUnitCard(deviceId){
    const list = $("unitList");
    const el = list && list.querySelector('[data-device-id="' + (window.CSS && CSS.escape ? CSS.escape(deviceId) : deviceId) + '"]');
    const dev = state.devices.find(d => d.id === deviceId);
    if (!el || !dev) return;
    el.outerHTML = unitCardHTML(dev);
  }

  /* ===================== streaming ===================== */
  async function toggleDevice(dev){
    if (deviceActiveCount(dev.id) > 0){
      state.tiles.filter(t => t.deviceId === dev.id).forEach(t => destroyTile(t.id));
      state.tiles = state.tiles.filter(t => t.deviceId !== dev.id);
      if (state.focus && !state.tiles.some(t=>t.id===state.focus)) state.focus = null;
      renderGrid(); updateUnitCard(dev.id); return;
    }
    let media;
    try { media = await api.getLiveMedia(dev.id); }
    catch(e){
      if (isAuthError(e)) return logout("Session expired. Please sign in again.");
      showToast("Couldn't open " + (dev.name || "camera") + " — " + (e.message || "stream unavailable") + ".");
      return;
    }
    if (!Array.isArray(media) || !media.length){
      showToast((dev.name || "Camera") + " has no live video available right now.");
      return;
    }
    media.sort((a,b)=> (a.channel||0)-(b.channel||0));
    for (const ch of media){
      if (state.tiles.length >= MAX_TILES) break;
      const id = dev.id + "|" + ch.channel;
      if (state.tiles.some(t => t.id === id)) continue;
      state.tiles.push({ id, deviceId: dev.id, deviceName: dev.name || dev.id, channel: ch.channel, url: ch.url });
    }
    renderGrid(); updateUnitCard(dev.id);
  }

  function clearAll(){
    Object.keys(tileEls).forEach(destroyTile);
    state.tiles = []; state.focus = null;
    renderGrid(); renderUnits();
  }
  function destroyTile(id){
    const te = tileEls[id];
    if (!te) return;
    if (te._stallTimer){ clearTimeout(te._stallTimer); te._stallTimer = null; }
    try { if (te.player){ te.player.destroy(); } } catch(e){}
    try { if (te.root && te.root.parentNode) te.root.parentNode.removeChild(te.root); } catch(e){}
    delete tileEls[id];
  }

  function gridStyleStr(){
    const n = state.tiles.length;
    if (state.focus) return "display:grid;grid-template-columns:1fr;gap:12px;height:100%;";
    let cols;
    if (state.layout === "auto") cols = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(n||1))));
    else cols = Number(state.layout);
    return "display:grid;grid-template-columns:repeat("+cols+",minmax(0,1fr));gap:12px;align-content:start;";
  }

  function renderGrid(){
    const canvas = $("canvas");
    const n = state.tiles.length;
    $("streamingCount").textContent = n + " streaming";
    $("clearBtn").disabled = n === 0;

    if (n === 0){
      Object.keys(tileEls).forEach(destroyTile);
      canvas.innerHTML = `<div class="empty-grid">
        <div class="bx"><span class="ic">${IC.camBig}</span></div>
        <h2>No active streams</h2>
        <p>Select an online unit on the left to stream all its cameras here. Add up to ${MAX_TILES} feeds.</p>
      </div>`;
      return;
    }
    let grid = canvas.querySelector(".grid-host");
    if (!grid){ canvas.innerHTML = ""; grid = document.createElement("div"); grid.className = "grid-host"; canvas.appendChild(grid); }
    grid.setAttribute("style", gridStyleStr());

    const liveIds = new Set(state.tiles.map(t=>t.id));
    Object.keys(tileEls).forEach(id => { if (!liveIds.has(id)) destroyTile(id); });

    state.tiles.forEach(t=>{
      let te = tileEls[t.id];
      if (!te) te = createTile(t);
      applyTileLayout(te, t);
      grid.appendChild(te.root);
    });
  }

  function applyTileLayout(te, t){
    const focused = state.focus === t.id;
    const hidden = state.focus && !focused;
    te.root.className = "tile" + (focused ? " focused" : "");
    te.root.style.display = hidden ? "none" : "flex";
    te.root.style.aspectRatio = focused ? "auto" : "16/9";
    te.root.style.height = focused ? "100%" : "";
    te.focusBtn.innerHTML = focused ? IC.min : IC.max;
  }

  function createTile(t){
    const root = document.createElement("div");
    root.className = "tile"; root.dataset.id = t.id;

    const video = document.createElement("video");
    video.muted = true; video.autoplay = true; video.playsInline = true;
    video.setAttribute("playsinline",""); video.setAttribute("muted","");
    root.appendChild(video);

    const scan = document.createElement("div"); scan.className = "scan"; root.appendChild(scan);
    const vig = document.createElement("div"); vig.className = "vig"; root.appendChild(vig);

    const top = document.createElement("div"); top.className = "tile-top";
    top.innerHTML = `<div style="display:flex;flex-direction:column;gap:3px;min-width:0;">
        <div style="display:flex;align-items:center;gap:6px;">
          <span class="tag-live"><span class="dot"></span><span class="t">LIVE</span></span>
          <span class="tile-name">${escapeHTML(t.deviceName)}</span>
        </div>
        <span class="tile-chan"><span class="ic">${IC.cam}</span><span class="t">Channel ${escapeHTML(t.channel)}</span></span>
      </div>
      <div class="bars" data-bars></div>`;
    root.appendChild(top);

    const mid = document.createElement("div"); mid.style.flex = "1"; root.appendChild(mid);

    const bottom = document.createElement("div"); bottom.className = "tile-bottom";
    const left = document.createElement("div"); left.style.display="flex"; left.style.flexDirection="column"; left.style.gap="1px";
    left.innerHTML = `<span class="tile-clock" data-tile-clock>--:--:--</span><span class="tile-date" data-tile-date>—</span>`;
    const ctrls = document.createElement("div"); ctrls.style.display="flex"; ctrls.style.alignItems="center"; ctrls.style.gap="5px";

    const snapBtn = ctrlBtn(IC.camera, "Snapshot"); snapBtn.onclick = ()=> snapshot(t.id);
    const muteBtn = ctrlBtn(IC.mute, "Audio"); muteBtn.onclick = ()=> toggleMute(t.id);
    const focusBtn = ctrlBtn(IC.max, "Fullscreen"); focusBtn.onclick = ()=> toggleFocus(t.id);
    const stopBtn = ctrlBtn(IC.x, "Stop stream"); stopBtn.classList.add("danger"); stopBtn.onclick = ()=> stopTile(t.id);
    ctrls.append(snapBtn, muteBtn, focusBtn, stopBtn);
    bottom.append(left, ctrls);
    root.appendChild(bottom);

    const barsHost = top.querySelector("[data-bars]");
    [1,2,3,4].forEach(i=>{
      const s = document.createElement("span");
      s.style.height = (4 + i*2.5) + "px"; s.style.background = "#69e09a";
      barsHost.appendChild(s);
    });

    const overlay = document.createElement("div"); overlay.className = "tile-overlay connecting";
    overlay.innerHTML = `<span class="spin"></span><span class="msg">Connecting to ${escapeHTML(t.deviceName)}…</span>`;
    root.appendChild(overlay);

    const te = { root, video, player:null, overlay, muteBtn, focusBtn, barsHost, _stallTimer:null, _lastReconnect:0 };
    tileEls[t.id] = te;

    // Video lifecycle listeners are attached ONCE per tile (not per player, so reconnects
    // don't pile up duplicates). A sustained stall (cellular gap / DVR hiccup) auto-reconnects.
    const armStall = ()=>{
      if (te._stallTimer) return;
      te._stallTimer = setTimeout(()=>{ te._stallTimer = null; if (tileEls[t.id]) reconnectTile(t.id); }, 14000);
    };
    te.video.addEventListener("playing", ()=>{
      hideOverlay(t.id);
      if (te._stallTimer){ clearTimeout(te._stallTimer); te._stallTimer = null; }
    });
    te.video.addEventListener("waiting", armStall);
    te.video.addEventListener("stalled", armStall);

    startPlayer(t, te);
    return te;
  }

  function ctrlBtn(icon, title){
    const b = document.createElement("button"); b.className = "tctrl"; b.title = title;
    b.innerHTML = `<span class="ic">${icon}</span>`; return b;
  }

  function startPlayer(t, te){
    if (!window.mpegts || !mpegts.isSupported()){
      return showTileError(t.id, "Playback unsupported", "This browser can't play FLV via MSE.");
    }
    try {
      const player = mpegts.createPlayer(
        { type:"flv", isLive:true, url:t.url, cors:true },
        {
          // NOTE: enableWorker is intentionally OFF — these StreamMax feeds contain
          // non-standard SEI NAL units that crash mpegts' worker demuxer ("Exception").
          // The main-thread demuxer tolerates them.
          enableStashBuffer: false,
          liveBufferLatencyChasing: true,   // keep latency low, but…
          liveBufferLatencyMaxLatency: 3.0,  // …only catch up when >3s behind (avoids CPU-spiky seeks)
          liveBufferLatencyMinRemain: 0.5,
          lazyLoad: false,
          autoCleanupSourceBuffer: true,         // bound memory on long-running live streams
          autoCleanupMaxBackwardDuration: 30,    // keep at most ~30s of past video buffered…
          autoCleanupMinBackwardDuration: 10,    // …trimming back down to ~10s
        }
      );
      te.player = player;
      player.attachMediaElement(te.video);
      player.on(mpegts.Events.ERROR, (typ, detail)=> showTileError(t.id, "Stream unavailable", String(detail||typ||"")));
      player.on(mpegts.Events.LOADING_COMPLETE, ()=>{ if (tileEls[t.id]) reconnectTile(t.id); }); // live feed ended -> reconnect
      player.load();
      const p = te.video.play(); if (p && p.catch) p.catch(()=>{});
    } catch(e){
      showTileError(t.id, "Stream error", String(e && e.message || e));
    }
  }
  function hideOverlay(id){ const te = tileEls[id]; if (te && te.overlay && te.overlay.classList.contains("connecting")){ te.overlay.style.display = "none"; } }
  function showTileError(id, title, sub){
    const te = tileEls[id]; if (!te) return;
    if (te._stallTimer){ clearTimeout(te._stallTimer); te._stallTimer = null; } // hard error -> manual Retry, no auto-loop
    try { if (te.player){ te.player.destroy(); te.player = null; } } catch(e){}
    te.overlay.className = "tile-overlay error";
    te.overlay.style.display = "flex";
    te.overlay.innerHTML = `<span class="emsg">${escapeHTML(title)}</span><span class="esub">${escapeHTML(sub||"")}</span><button>Retry</button>`;
    te.overlay.querySelector("button").onclick = ()=> retryTile(id);
  }
  // Debounced auto-reconnect (used by the stall watchdog + live-feed-ended event) so a
  // flapping feed can't trigger a tight reconnect storm.
  function reconnectTile(id){
    const te = tileEls[id]; if (!te) return;
    const now = Date.now();
    if (te._lastReconnect && now - te._lastReconnect < 8000) return;
    te._lastReconnect = now;
    retryTile(id);
  }

  async function retryTile(id){
    const t = state.tiles.find(x=>x.id===id); const te = tileEls[id];
    if (!t || !te) return;
    te.overlay.className = "tile-overlay connecting"; te.overlay.style.display = "flex";
    te.overlay.innerHTML = `<span class="spin"></span><span class="msg">Reconnecting…</span>`;
    try {
      const media = await api.getLiveMedia(t.deviceId);
      const fresh = Array.isArray(media) && media.find(m => m.channel === t.channel);
      if (fresh && fresh.url) t.url = fresh.url;
    } catch(e){
      if (isAuthError(e)) return logout("Session expired. Please sign in again.");
      return showTileError(id, "Stream unavailable", "Device may be offline.");
    }
    startPlayer(t, te);
  }

  function stopTile(id){
    const tile = state.tiles.find(t => t.id === id);
    destroyTile(id);
    state.tiles = state.tiles.filter(t => t.id !== id);
    if (state.focus === id) state.focus = null;
    renderGrid(); if (tile) updateUnitCard(tile.deviceId);
  }
  function toggleMute(id){
    const te = tileEls[id]; if (!te) return;
    te.video.muted = !te.video.muted;
    te.muteBtn.querySelector(".ic").innerHTML = te.video.muted ? IC.mute : IC.volume;
  }
  function toggleFocus(id){ state.focus = state.focus === id ? null : id; renderGrid(); }
  function snapshot(id){
    const te = tileEls[id]; const t = state.tiles.find(x=>x.id===id); if (!te || !t) return;
    const v = te.video;
    if (v.videoWidth && v.videoHeight){
      try {
        const c = document.createElement("canvas"); c.width = v.videoWidth; c.height = v.videoHeight;
        c.getContext("2d").drawImage(v, 0, 0);
        c.toBlob((blob)=>{
          if (!blob) return;
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = "snapshot-" + (t.deviceName||t.deviceId).replace(/[^\w-]+/g,"_") + "-ch" + t.channel + "-" + Date.now() + ".png";
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(()=> URL.revokeObjectURL(a.href), 4000);
        }, "image/png");
      } catch(e){}
    }
    const fl = document.createElement("div"); fl.className = "tile-flash"; te.root.appendChild(fl);
    setTimeout(()=> fl.remove(), 480);
  }

  function syncTileStatuses(){
    state.tiles.forEach(t=>{
      const te = tileEls[t.id]; if (!te) return;
      const info = state.statuses[t.deviceId];
      const ok = cameraOnline(info) || info == null;
      if (!ok && te.overlay && !te.overlay.classList.contains("error")){
        showTileError(t.id, "Camera offline", "The device stopped communicating.");
      }
    });
  }

  function updateClocks(){
    const now = new Date();
    const p = (x)=> String(x).padStart(2,"0");
    const time = p(now.getHours()) + ":" + p(now.getMinutes()) + ":" + p(now.getSeconds());
    const days = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    const mons = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const date = days[now.getDay()] + " " + mons[now.getMonth()] + " " + now.getDate() + ", " + now.getFullYear();
    document.querySelectorAll("[data-tile-clock]").forEach(el => el.textContent = time);
    document.querySelectorAll("[data-tile-date]").forEach(el => el.textContent = date);
  }

  /* ===================== login submit / logout ===================== */
  async function onLoginSubmit(e){
    e.preventDefault();
    const database = $("f-db").value.trim();
    const userName = $("f-user").value.trim();
    const password = $("f-pass").value;
    if (!database || !userName || !password) return;
    const btn = $("loginBtn"); btn.disabled = true; btn.textContent = "Signing in…";
    $("loginError").classList.remove("show");
    try {
      const account = await api.authenticate(database, userName, password);
      await enterApp(account);
    } catch(err){
      showLogin(err.message || "Sign in failed. Please try again.");
    } finally {
      btn.disabled = false; btn.textContent = "Sign in";
    }
  }
  function logout(msg){
    if (state.pollTimer){ clearInterval(state.pollTimer); state.pollTimer = null; }
    clearAll();
    state.devices = []; state.statuses = {};
    api.logout(); api.setToken(null);
    $("f-pass").value = "";
    showLogin(msg || "");
  }

  function showToast(msg){
    let host = document.getElementById("mcv-toasts");
    if (!host){
      host = document.createElement("div"); host.id = "mcv-toasts";
      host.style.cssText = "position:fixed;bottom:18px;left:50%;transform:translateX(-50%);z-index:9999;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none;";
      document.body.appendChild(host);
    }
    const t = document.createElement("div");
    t.textContent = msg;
    t.style.cssText = "background:#1D2738;color:#fff;font:500 13px Inter,system-ui,sans-serif;padding:10px 16px;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.35);max-width:520px;text-align:center;opacity:0;transition:opacity .2s;";
    host.appendChild(t);
    requestAnimationFrame(()=>{ t.style.opacity = "1"; });
    setTimeout(()=>{ t.style.opacity = "0"; setTimeout(()=> t.remove(), 250); }, 3800);
  }

  function escapeHTML(s){ return String(s==null?"":s).replace(/[&<>"]/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }

  /* ===================== go ===================== */
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
