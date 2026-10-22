(() => {
  'use strict';

  const API = 'https://ja.wikipedia.org/w/api.php';
  const SUMMARY_API = 'https://ja.wikipedia.org/api/rest_v1/page/summary/';
  const DEFAULT_VIEW = { center: [35.681, 139.767], zoom: 15 }; // 東京駅付近（公開地点）
  const MIN_ZOOM_FOR_SEARCH = 10;
  const MAX_BBOX_AREA = 380e6; // GeoSearch の上限は約400km²。少し余裕を持たせる
  const FETCH_DELAY = 600;     // 地図移動後、この時間止まったら取得する（ms）
  const KEY_READ = 'da-read';
  const KEY_THEME = 'da-theme';
  const KEY_FONT = 'da-font';

  // ---------- localStorage ----------
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
      catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 保存できなくても動作は続ける */ }
    },
  };

  const readSet = new Set(store.get(KEY_READ, []));
  const saveRead = () => store.set(KEY_READ, [...readSet]);

  // ---------- 表示設定 ----------
  const root = document.documentElement;

  function applyTheme(theme) {
    root.dataset.theme = theme;
    document.querySelectorAll('#theme-seg button').forEach(b =>
      b.setAttribute('aria-pressed', String(b.dataset.theme === theme)));
  }
  function applyFont(size) {
    root.dataset.font = size;
    document.querySelectorAll('#font-seg button').forEach(b =>
      b.setAttribute('aria-pressed', String(b.dataset.font === size)));
  }

  const prefersDark = window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(store.get(KEY_THEME, prefersDark ? 'dark' : 'light'));
  applyFont(store.get(KEY_FONT, 'm'));

  document.getElementById('theme-seg').addEventListener('click', e => {
    const t = e.target.closest('button')?.dataset.theme;
    if (t) { applyTheme(t); store.set(KEY_THEME, t); }
  });
  document.getElementById('font-seg').addEventListener('click', e => {
    const f = e.target.closest('button')?.dataset.font;
    if (f) { applyFont(f); store.set(KEY_FONT, f); updateBarHeight(); }
  });

  const menu = document.getElementById('menu');
  const btnMenu = document.getElementById('btn-menu');
  btnMenu.addEventListener('click', e => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    btnMenu.setAttribute('aria-expanded', String(!menu.hidden));
  });
  document.addEventListener('click', e => {
    if (!menu.hidden && !menu.contains(e.target)) {
      menu.hidden = true;
      btnMenu.setAttribute('aria-expanded', 'false');
    }
  });

  document.getElementById('btn-clear-read').addEventListener('click', () => {
    if (!readSet.size || !confirm('既読の記録をすべて消去しますか？')) return;
    readSet.clear();
    saveRead();
    markers.forEach((m, id) => m.setIcon(pinIcon(id)));
    cluster.refreshClusters();
  });

  function updateBarHeight() {
    root.style.setProperty('--bar-h', document.querySelector('.bar').offsetHeight + 'px');
  }
  updateBarHeight();
  window.addEventListener('resize', updateBarHeight);

  // ---------- 地図 ----------
  const GSI_ATTR = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">出典：国土地理院</a>';
  const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';

  const baseLayers = {
    '淡色地図': L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png',
      { attribution: GSI_ATTR, maxNativeZoom: 18, maxZoom: 19 }),
    '標準地図': L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png',
      { attribution: GSI_ATTR, maxNativeZoom: 18, maxZoom: 19 }),
    '航空写真': L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg',
      { attribution: GSI_ATTR, maxNativeZoom: 18, maxZoom: 19 }),
    'OpenStreetMap': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      { attribution: OSM_ATTR, maxZoom: 19 }),
  };

  const map = L.map('map', { zoomControl: true, layers: [baseLayers['淡色地図']] })
    .setView(DEFAULT_VIEW.center, DEFAULT_VIEW.zoom);
  map.attributionControl.setPrefix(false);
  L.control.layers(baseLayers, null, { position: 'topright' }).addTo(map);
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);

  // ---------- ピン ----------
  const pinIcon = id => L.divIcon({
    className: '',
    html: `<div class="pin${readSet.has(id) ? ' read' : ''}${selected?.pageid === id ? ' sel' : ''}"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
    popupAnchor: [0, -8],
  });

  const cluster = L.markerClusterGroup({
    maxClusterRadius: 45,
    disableClusteringAtZoom: 18,
    showCoverageOnHover: false,
    chunkedLoading: true,
    iconCreateFunction(c) {
      const children = c.getAllChildMarkers();
      const allRead = children.every(m => readSet.has(m.options.pageid));
      const n = c.getChildCount();
      const size = n < 10 ? 28 : n < 100 ? 34 : 40;
      return L.divIcon({
        className: '',
        html: `<div class="cluster${allRead ? ' read' : ''}" style="width:${size}px;height:${size}px">${n}</div>`,
        iconSize: [size, size],
      });
    },
  }).addTo(map);

  const markers = new Map(); // pageid -> marker

  function addMarker(item) {
    const m = L.marker([item.lat, item.lon], { icon: pinIcon(item.pageid), pageid: item.pageid, title: item.title });
    m.bindPopup(() => popupShell(item), { maxWidth: 280, minWidth: 200, autoPanPadding: [10, 10] });
    m.on('popupopen', () => { loadSummary(item, m); showArticle(item); });
    markers.set(item.pageid, m);
    return m;
  }

  function markRead(id) {
    if (readSet.has(id)) return;
    readSet.add(id);
    saveRead();
    refreshPin(id);
    cluster.refreshClusters(markers.get(id));
  }

  // ---------- ポップアップ ----------
  const esc = s => String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const articleUrl = title =>
    'https://ja.m.wikipedia.org/wiki/' + encodeURIComponent(title.replace(/ /g, '_'));

  function distanceText(item) {
    if (!here) return '現在地からの距離：未取得';
    const d = map.distance(here, [item.lat, item.lon]);
    return '現在地から ' + (d < 1000 ? Math.round(d) + 'm' : (d / 1000).toFixed(d < 10000 ? 1 : 0) + 'km');
  }

  function popupShell(item, body = '<p class="extract">読み込み中…</p>', url = articleUrl(item.title)) {
    const el = document.createElement('div');
    el.className = 'pop';
    el.innerHTML =
      `<h2>${esc(item.title)}</h2>` +
      `<div class="dist">${esc(distanceText(item))}</div>` +
      body +
      `<div class="clear"></div>` +
      `<a class="link" href="${esc(url)}" target="_blank" rel="noopener">記事を開く</a>`;
    el.querySelector('.link').addEventListener('click', () => markRead(item.pageid));
    return el;
  }

  // 取得中の Promise ごと保存し、吹き出しとパネルで同じ取得を共有する。失敗したら消して再取得できるようにする
  function cached(cache, key, load) {
    if (!cache.has(key)) cache.set(key, load().catch(e => { cache.delete(key); throw e; }));
    return cache.get(key);
  }

  const summaryCache = new Map();
  const getSummary = item => cached(summaryCache, item.pageid, async () => {
    const res = await fetch(SUMMARY_API + encodeURIComponent(item.title.replace(/ /g, '_')));
    if (!res.ok) throw new Error(res.status);
    return res.json();
  });

  // 記事冒頭（導入部）の全文
  const introCache = new Map();
  const getIntro = item => cached(introCache, item.pageid, async () => {
    const params = new URLSearchParams({
      action: 'query',
      prop: 'extracts',
      exintro: '1',
      explaintext: '1',
      pageids: String(item.pageid),
      format: 'json',
      formatversion: '2',
      origin: '*',
    });
    const data = await (await fetch(`${API}?${params}`)).json();
    return data.query?.pages?.[0]?.extract || '';
  });

  async function loadSummary(item, marker) {
    let s;
    try {
      s = await getSummary(item);
    } catch {
      if (marker.isPopupOpen()) {
        marker.setPopupContent(popupShell(item, '<p class="extract err">要約を取得できませんでした。</p>'));
      }
      return;
    }
    if (!marker.isPopupOpen()) return;
    const thumb = s.thumbnail?.source
      ? `<img class="thumb" src="${esc(s.thumbnail.source)}" alt="" loading="lazy">` : '';
    const extract = s.extract ? esc(s.extract) : '要約はありません。';
    const url = s.content_urls?.mobile?.page || articleUrl(item.title);
    marker.setPopupContent(popupShell(item, `${thumb}<p class="extract">${extract}</p>`, url));
  }

  // ---------- 記事パネル（スマホは地図の下、広い画面は左） ----------
  const panel = document.getElementById('panel');
  const panelBody = document.getElementById('panel-body');
  let selected = null; // パネルに表示中の記事

  function refreshPin(id) {
    const m = markers.get(id);
    if (!m) return;
    m.setIcon(pinIcon(id));
    m.setZIndexOffset(selected?.pageid === id ? 1000 : 0);
  }

  function renderPanel(item, body, url = articleUrl(item.title)) {
    panelBody.innerHTML =
      `<h2>${esc(item.title)}</h2>` +
      `<div class="dist">${esc(distanceText(item))}</div>` +
      body +
      `<div class="actions"><button class="btn small read-full" type="button">全文を読む</button>` +
      `<a class="link" href="${esc(url)}" target="_blank" rel="noopener">別タブで開く</a></div>`;
    panelBody.querySelector('.link').addEventListener('click', () => markRead(item.pageid));
    panelBody.querySelector('.read-full').addEventListener('click', () => openReader(item));
  }

  // ---------- 全文表示（記事ページを iframe で埋め込む） ----------
  const isFull = () => panel.classList.contains('full');

  function openReader(item) {
    const url = articleUrl(item.title);
    markRead(item.pageid);
    if (!isFull()) {
      panel.classList.add('full');
      // Android の戻る操作で全文表示を閉じられるよう、履歴を1つ積む
      history.pushState({ reader: true }, '');
    }
    panelBody.innerHTML =
      `<div class="reader-bar">` +
      `<button class="btn small back" type="button">戻る</button>` +
      `<span class="rtitle">${esc(item.title)}</span>` +
      `<a class="link" href="${esc(url)}" target="_blank" rel="noopener">別タブ</a>` +
      `</div>` +
      `<iframe class="reader" src="${esc(url)}" title="${esc(item.title)}"></iframe>`;
    // 記事内のリンクをたどった後は history.back() が iframe 側に効くので、ボタンでは直接閉じる
    panelBody.querySelector('.back').addEventListener('click', exitReader);
    map.invalidateSize();
  }

  function exitReader() {
    panel.classList.remove('full');
    map.invalidateSize();
    if (selected) showArticle(selected);
  }

  window.addEventListener('popstate', () => { if (isFull()) exitReader(); });

  async function showArticle(item) {
    const prev = selected;
    selected = item;
    if (prev) refreshPin(prev.pageid);
    refreshPin(item.pageid);
    if (isFull()) { openReader(item); return; } // 全文表示中に別のピンを選んだら、その記事の全文に切り替える
    renderPanel(item, '<p>読み込み中…</p>');
    panel.scrollTop = 0;
    if (panel.hidden) {
      panel.hidden = false;
      map.invalidateSize();
      // パネルで地図が狭くなり、ピンが隠れたら寄せる
      const ll = L.latLng(item.lat, item.lon);
      if (!map.getBounds().contains(ll)) map.panTo(ll);
    }

    const [s, intro] = await Promise.all([
      getSummary(item).catch(() => null),
      getIntro(item).catch(() => null),
    ]);
    if (selected !== item) return;
    if (!s && intro === null) {
      renderPanel(item, '<p class="err">記事を取得できませんでした。</p>');
      return;
    }
    const img = s?.thumbnail?.source
      ? `<img class="image" src="${esc(s.thumbnail.source)}" alt="">` : '';
    const text = intro || s?.extract || '';
    const paras = text.split(/\n+/).filter(Boolean).map(p => `<p>${esc(p)}</p>`).join('');
    renderPanel(item, `${img}<div class="intro">${paras || '<p>説明はありません。</p>'}</div>`,
      s?.content_urls?.mobile?.page || articleUrl(item.title));
  }

  function closePanel() {
    if (panel.hidden) return;
    panel.classList.remove('full');
    const prev = selected;
    selected = null;
    if (prev) refreshPin(prev.pageid);
    panel.hidden = true;
    map.closePopup();
    map.invalidateSize();
  }

  document.getElementById('panel-close').addEventListener('click', closePanel);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closePanel(); });

  // ---------- 記事の取得 ----------
  const statusEl = document.getElementById('status');
  const setStatus = t => { statusEl.textContent = t; };

  let timer = null;
  let controller = null;

  // 表示範囲が上限を超えるときは、中心を保ったまま縮める
  function searchBounds() {
    const b = map.getBounds();
    const c = b.getCenter();
    const w = map.distance([c.lat, b.getWest()], [c.lat, b.getEast()]);
    const h = map.distance([b.getSouth(), c.lng], [b.getNorth(), c.lng]);
    const area = w * h;
    if (area <= MAX_BBOX_AREA) return { bounds: b, clipped: false };
    const k = Math.sqrt(MAX_BBOX_AREA / area);
    const dLat = (b.getNorth() - b.getSouth()) * k / 2;
    const dLng = (b.getEast() - b.getWest()) * k / 2;
    return {
      bounds: L.latLngBounds([c.lat - dLat, c.lng - dLng], [c.lat + dLat, c.lng + dLng]),
      clipped: true,
    };
  }

  function scheduleFetch() {
    clearTimeout(timer);
    timer = setTimeout(fetchArticles, FETCH_DELAY);
  }

  async function fetchArticles() {
    if (map.getZoom() < MIN_ZOOM_FOR_SEARCH) {
      if (controller) controller.abort();
      setStatus('拡大すると記事を表示します');
      return;
    }
    const { bounds, clipped } = searchBounds();
    const f = n => n.toFixed(6);
    const params = new URLSearchParams({
      action: 'query',
      list: 'geosearch',
      gsbbox: [f(bounds.getNorth()), f(bounds.getWest()), f(bounds.getSouth()), f(bounds.getEast())].join('|'),
      gslimit: '500',
      format: 'json',
      formatversion: '2',
      origin: '*',
    });

    if (controller) controller.abort();
    controller = new AbortController();
    setStatus('読み込み中…');
    try {
      const res = await fetch(`${API}?${params}`, { signal: controller.signal });
      const data = await res.json();
      if (data.error) throw new Error(data.error.code);
      updateMarkers(data.query?.geosearch || []);
      const n = data.query?.geosearch?.length || 0;
      setStatus(`${n}件${n >= 500 ? '（上限）' : ''}${clipped ? '・中心付近のみ' : ''}`);
    } catch (e) {
      if (e.name === 'AbortError') return;
      setStatus('記事を取得できませんでした');
    }
  }

  function updateMarkers(items) {
    const ids = new Set(items.map(i => i.pageid));
    const toRemove = [];
    markers.forEach((m, id) => {
      if (!ids.has(id) && !m.isPopupOpen() && selected?.pageid !== id) { toRemove.push(m); markers.delete(id); }
    });
    cluster.removeLayers(toRemove);
    const toAdd = items.filter(i => !markers.has(i.pageid)).map(addMarker);
    cluster.addLayers(toAdd);
  }

  map.on('moveend', scheduleFetch);

  // ---------- 現在地 ----------
  // 位置は実行中のメモリにだけ持ち、保存はしない
  let here = null;
  let hereMarker = null;
  let hereCircle = null;
  const btnLocate = document.getElementById('btn-locate');

  function locate(silent) {
    if (!('geolocation' in navigator)) {
      if (!silent) alert('この端末では位置情報を利用できません。');
      return;
    }
    btnLocate.classList.add('busy');
    navigator.geolocation.getCurrentPosition(pos => {
      btnLocate.classList.remove('busy');
      here = L.latLng(pos.coords.latitude, pos.coords.longitude);
      const acc = pos.coords.accuracy;
      if (!hereMarker) {
        hereMarker = L.marker(here, {
          icon: L.divIcon({ className: '', html: '<div class="here"></div>', iconSize: [14, 14] }),
          interactive: false,
          zIndexOffset: 1000,
        }).addTo(map);
        hereCircle = L.circle(here, { radius: acc, weight: 1, color: '#e53e3e', fillOpacity: .08, interactive: false }).addTo(map);
      } else {
        hereMarker.setLatLng(here);
        hereCircle.setLatLng(here).setRadius(acc);
      }
      map.setView(here, Math.max(map.getZoom(), 15));
      const dist = panelBody.querySelector('.dist');
      if (selected && dist) dist.textContent = distanceText(selected);
    }, err => {
      btnLocate.classList.remove('busy');
      if (!silent) {
        alert(err.code === err.PERMISSION_DENIED
          ? '位置情報の利用が許可されていません。'
          : '現在地を取得できませんでした。');
      }
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
  }

  btnLocate.addEventListener('click', () => locate(false));

  // 起動時：まず既定の地点で取得し、現在地が取れたら移動する
  fetchArticles();
  locate(true);
})();
