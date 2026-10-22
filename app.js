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
  const KEY_BM = 'da-bookmarks';
  const KEY_READER = 'da-reader';

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
    markers.forEach((_, id) => refreshPin(id));
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
  const pinIcon = id => {
    const sel = selected?.pageid === id ? ' sel' : '';
    if (isSaved(id)) {
      return L.divIcon({
        className: '',
        html: `<div class="star${sel}">★</div>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      });
    }
    return L.divIcon({
      className: '',
      html: `<div class="pin${readSet.has(id) ? ' read' : ''}${sel}"></div>`,
      iconSize: [16, 16],
      iconAnchor: [8, 8],
    });
  };

  const cluster = L.markerClusterGroup({
    // 記事名が見えるよう、拡大するほどまとめる範囲を狭くする
    maxClusterRadius: z => (z >= 16 ? 18 : z >= 15 ? 28 : 45),
    disableClusteringAtZoom: 17,
    showCoverageOnHover: false,
    chunkedLoading: true,
    iconCreateFunction(c) {
      const children = c.getAllChildMarkers();
      const allRead = children.every(m => readSet.has(m.options.pageid));
      const hasSaved = children.some(m => isSaved(m.options.pageid));
      const n = c.getChildCount();
      const size = n < 10 ? 28 : n < 100 ? 34 : 40;
      return L.divIcon({
        className: '',
        html: `<div class="cluster${allRead ? ' read' : ''}${hasSaved ? ' saved' : ''}" style="width:${size}px;height:${size}px">${n}</div>`,
        iconSize: [size, size],
      });
    },
  }).addTo(map);

  const markers = new Map(); // pageid -> marker

  // 既読の記事名は薄く表示する（ブックマーク済みは目立たせたいので除く）
  const labelClass = id => 'label' + (readSet.has(id) && !isSaved(id) ? ' read' : '');

  // 広域では記事名が重なって読めないので、ズーム15未満では隠す
  const LABEL_MIN_ZOOM = 15;
  const updateLabels = () =>
    map.getContainer().classList.toggle('no-labels', map.getZoom() < LABEL_MIN_ZOOM);
  map.on('zoomend', updateLabels);
  updateLabels();

  function addMarker(item) {
    const m = L.marker([item.lat, item.lon], { icon: pinIcon(item.pageid), pageid: item.pageid });
    // 記事名を常に表示。名前をタップしてもピンと同じく開く（tooltip の click はマーカーに伝わる）
    m.bindTooltip(esc(item.title), {
      permanent: true,
      direction: 'right',
      offset: [8, 0],
      interactive: true,
      className: labelClass(item.pageid),
    });
    m.on('click', () => showArticle(item));
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

  // ---------- 記事データの取得と表示の共通部品 ----------
  const esc = s => String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const articleUrl = title =>
    'https://ja.m.wikipedia.org/wiki/' + encodeURIComponent(title.replace(/ /g, '_'));

  function distanceText(item) {
    if (!here) return '現在地からの距離：未取得';
    const d = map.distance(here, [item.lat, item.lon]);
    return '現在地から ' + (d < 1000 ? Math.round(d) + 'm' : (d / 1000).toFixed(d < 10000 ? 1 : 0) + 'km');
  }

  // 取得中の Promise ごと保存し、同じ記事を選び直しても取り直さない。失敗したら消して再取得できるようにする
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


  // ---------- 記事パネル（スマホは地図の下、広い画面は左） ----------
  const panel = document.getElementById('panel');
  const panelBody = document.getElementById('panel-body');
  let selected = null; // パネルに表示中の記事

  function refreshPin(id) {
    const m = markers.get(id);
    if (!m) return;
    m.setIcon(pinIcon(id));
    const tip = m.getTooltip();
    if (tip) {
      tip.options.className = labelClass(id);
      tip.getElement()?.classList.toggle('read', readSet.has(id) && !isSaved(id));
    }
    m.setZIndexOffset(selected?.pageid === id ? 1000 : 0);
  }

  // パネルで地図が狭くなり、ピンが隠れたら寄せる
  function keepInView(item) {
    const ll = L.latLng(item.lat, item.lon);
    if (!map.getBounds().contains(ll)) map.panTo(ll);
  }

  function renderPanel(item, body, url = articleUrl(item.title)) {
    panelBody.innerHTML =
      `<h2>${esc(item.title)}</h2>` +
      `<div class="dist">${esc(distanceText(item))}</div>` +
      body +
      `<div class="actions"><button class="btn small read-full" type="button">全文を読む</button>` +
      `<button class="btn small bm" type="button"></button>` +
      `<a class="link" href="${esc(url)}" target="_blank" rel="noopener">別タブで開く</a></div>` +
      `<div class="bm-lists"></div>`;
    panelBody.querySelector('.link').addEventListener('click', () => markRead(item.pageid));
    panelBody.querySelector('.read-full').addEventListener('click', () => openReader(item));
    panelBody.querySelector('.bm').addEventListener('click', () => toggleBookmark(item));
    updateBmUi(item);
  }

  // ---------- 全文表示（記事ページを iframe で埋め込む） ----------
  const isFull = () => panel.classList.contains('full');
  let readerMode = store.get(KEY_READER, false); // true：ピンを選んだら全文で開く
  let readerMax = false; // スマホで全文を全面に広げているか（次の記事にも引き継ぐ）

  function setReaderMode(on) {
    readerMode = on;
    store.set(KEY_READER, on);
  }

  function openReader(item) {
    const url = articleUrl(item.title);
    setReaderMode(true);
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
      `<button class="btn small size" type="button"></button>` +
      `<button class="btn small bm icon" type="button"></button>` +
      `<a class="link" href="${esc(url)}" target="_blank" rel="noopener">別タブ</a>` +
      `</div>` +
      `<iframe class="reader" src="${esc(url)}" title="${esc(item.title)}"></iframe>`;
    panelBody.querySelector('.bm').addEventListener('click', () => toggleBookmark(item));
    updateBmUi(item);
    const sizeBtn = panelBody.querySelector('.size');
    const applySize = () => {
      panel.classList.toggle('max', readerMax);
      sizeBtn.textContent = readerMax ? '縮める' : '広げる';
      map.invalidateSize();
      if (!readerMax) keepInView(item);
    };
    sizeBtn.addEventListener('click', () => { readerMax = !readerMax; applySize(); });
    applySize();
    // 記事内のリンクをたどった後は history.back() が iframe 側に効くので、ボタンでは直接閉じる
    panelBody.querySelector('.back').addEventListener('click', exitReader);
    map.invalidateSize();
  }

  function exitReader() {
    setReaderMode(false);
    panel.classList.remove('full', 'max');
    map.invalidateSize();
    if (selected) showArticle(selected);
  }

  window.addEventListener('popstate', () => { if (isFull()) exitReader(); });

  // ---------- ブックマーク（このアプリ内のみ。localStorage に保存） ----------
  // items: { pageid: { title, lat, lon, lists: [リストID, ...] } }
  const bm = (() => {
    const d = store.get(KEY_BM, null);
    if (d && Array.isArray(d.lists) && d.lists.length && d.items) {
      if (!d.lists.some(l => l.id === d.target)) d.target = d.lists[0].id;
      return d;
    }
    return { lists: [{ id: 'default', name: 'ブックマーク' }], target: 'default', items: {} };
  })();
  const saveBm = () => store.set(KEY_BM, bm);
  const listName = id => bm.lists.find(l => l.id === id)?.name || '';
  function isSaved(id) { return !!bm.items[id]; }

  // 事前に選んだ保存先リストに追加する。すでに入っていれば外す
  function toggleBookmark(item) {
    const e = bm.items[item.pageid];
    if (e?.lists.includes(bm.target)) {
      e.lists = e.lists.filter(l => l !== bm.target);
      if (!e.lists.length) delete bm.items[item.pageid];
    } else if (e) {
      e.lists.push(bm.target);
    } else {
      bm.items[item.pageid] = { title: item.title, lat: item.lat, lon: item.lon, lists: [bm.target] };
    }
    saveBm();
    refreshPin(item.pageid);
    cluster.refreshClusters(markers.get(item.pageid));
    updateBmUi(item);
  }

  function updateBmUi(item) {
    const btn = panelBody.querySelector('.bm');
    if (btn) {
      const on = !!bm.items[item.pageid]?.lists.includes(bm.target);
      // 全文表示の上の帯は狭いので、記号だけにする
      btn.textContent = btn.classList.contains('icon') ? (on ? '★' : '☆') : (on ? '★ 保存済み' : '☆ 保存');
      btn.setAttribute('aria-pressed', String(on));
      btn.title = '保存先：' + listName(bm.target);
    }
    const el = panelBody.querySelector('.bm-lists');
    if (el) {
      const e = bm.items[item.pageid];
      el.textContent = e ? '保存先：' + e.lists.map(listName).join('、') : '';
    }
  }

  // 設定メニューのリスト操作
  const bmSelect = document.getElementById('bm-target');
  function renderBmSelect() {
    bmSelect.innerHTML = bm.lists.map(l => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('');
    bmSelect.value = bm.target;
    document.getElementById('btn-bm-del').disabled = bm.lists.length <= 1;
    if (selected) updateBmUi(selected);
  }
  renderBmSelect();

  bmSelect.addEventListener('change', () => {
    bm.target = bmSelect.value;
    saveBm();
    renderBmSelect();
  });
  document.getElementById('btn-bm-new').addEventListener('click', () => {
    const name = prompt('新しいリストの名前', '')?.trim();
    if (!name) return;
    const id = 'l' + Date.now().toString(36);
    bm.lists.push({ id, name });
    bm.target = id;
    saveBm();
    renderBmSelect();
  });
  document.getElementById('btn-bm-rename').addEventListener('click', () => {
    const list = bm.lists.find(l => l.id === bm.target);
    const name = prompt('リストの名前', list.name)?.trim();
    if (!name) return;
    list.name = name;
    saveBm();
    renderBmSelect();
  });
  document.getElementById('btn-bm-del').addEventListener('click', () => {
    if (bm.lists.length <= 1) return;
    const id = bm.target;
    if (!confirm(`リスト「${listName(id)}」を削除しますか？`)) return;
    bm.lists = bm.lists.filter(l => l.id !== id);
    const changed = [];
    for (const [pid, e] of Object.entries(bm.items)) {
      if (!e.lists.includes(id)) continue;
      e.lists = e.lists.filter(l => l !== id);
      if (!e.lists.length) delete bm.items[pid];
      changed.push(+pid);
    }
    bm.target = bm.lists[0].id;
    saveBm();
    changed.forEach(refreshPin);
    cluster.refreshClusters();
    renderBmSelect();
  });

  async function showArticle(item) {
    const prev = selected;
    selected = item;
    if (prev) refreshPin(prev.pageid);
    refreshPin(item.pageid);
    // 「全文を読む」を選んだ後は、最初から全文で開く（「戻る」で要約表示に戻すまで）
    if (readerMode) {
      panel.hidden = false;
      openReader(item);
      return;
    }
    renderPanel(item, '<p>読み込み中…</p>');
    panel.scrollTop = 0;
    if (panel.hidden) {
      panel.hidden = false;
      map.invalidateSize();
      keepInView(item);
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
    panel.classList.remove('full', 'max');
    const prev = selected;
    selected = null;
    if (prev) refreshPin(prev.pageid);
    panel.hidden = true;
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
      updateMarkers(data.query?.geosearch || [], map.getBounds());
      const n = data.query?.geosearch?.length || 0;
      setStatus(`${n}件${n >= 500 ? '（上限）' : ''}${clipped ? '・中心付近のみ' : ''}`);
    } catch (e) {
      if (e.name === 'AbortError') return;
      setStatus('記事を取得できませんでした');
    }
  }

  function updateMarkers(found, view) {
    // 検索結果に入らなかった（上限・中心付近のみ等）ブックマーク済み記事も、表示範囲内なら出す
    const ids = new Set(found.map(i => i.pageid));
    const extra = Object.entries(bm.items)
      .filter(([pid, e]) => !ids.has(+pid) && view.contains([e.lat, e.lon]))
      .map(([pid, e]) => ({ pageid: +pid, title: e.title, lat: e.lat, lon: e.lon }));
    const items = found.concat(extra);
    extra.forEach(i => ids.add(i.pageid));
    const toRemove = [];
    markers.forEach((m, id) => {
      if (!ids.has(id) && selected?.pageid !== id) { toRemove.push(m); markers.delete(id); }
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
