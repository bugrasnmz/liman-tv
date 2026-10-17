/* Liman TV — istemci uygulaması */
(() => {
  'use strict';

  /* ────────────────────────────── Kısayollar ────────────────────────────── */
  const $ = (sel, root = document) => root.querySelector(sel);
  const el = {
    loginView: $('#login-view'),
    loginForm: $('#login-form'),
    loginPassword: $('#login-password'),
    loginError: $('#login-error'),
    loginSubmit: $('#login-submit'),
    app: $('#app'),
    sidebar: $('#sidebar'),
    scrim: $('#scrim'),
    sidebarOpen: $('#sidebar-open'),
    sidebarClose: $('#sidebar-close'),
    categorySearch: $('#category-search'),
    specialList: $('#special-list'),
    categoryList: $('#category-list'),
    account: $('#account-box'),
    channelHeading: $('#channel-heading'),
    channelCount: $('#channel-count'),
    channelSearch: $('#channel-search'),
    channelList: $('#channel-list'),
    channelSentinel: $('#channel-sentinel'),
    channelEmpty: $('#channel-empty'),
    playerShell: $('#player-shell'),
    video: $('#video'),
    idle: $('#player-idle'),
    resumeBtn: $('#resume-btn'),
    resumeLabel: $('#resume-label'),
    loading: $('#player-loading'),
    loadingText: $('#loading-text'),
    error: $('#player-error'),
    errorText: $('#player-error-text'),
    retryBtn: $('#retry-btn'),
    altFormatBtn: $('#alt-format-btn'),
    nowLogo: $('#now-logo'),
    nowTitle: $('#now-title'),
    nowCategory: $('#now-category'),
    liveDot: $('#live-dot'),
    prevBtn: $('#prev-btn'),
    nextBtn: $('#next-btn'),
    favBtn: $('#fav-btn'),
    pipBtn: $('#pip-btn'),
    fsBtn: $('#fs-btn'),
    formatSelect: $('#format-select'),
    epg: $('#epg'),
    toast: $('#toast'),
  };

  /* ────────────────────────────── Yardımcılar ────────────────────────────── */
  const escapeHtml = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const normalize = (s) =>
    String(s || '')
      .toLocaleLowerCase('tr')
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .replace(/ı/g, 'i');

  const initials = (name) =>
    String(name || '?')
      .replace(/[^\p{L}\p{N} ]/gu, ' ')
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toLocaleUpperCase('tr') || '•';

  const timeFmt = new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' });
  const dateFmt = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' });

  const debounce = (fn, ms) => {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  };

  const store = {
    get(key, fallback) {
      try {
        return JSON.parse(localStorage.getItem(`liman:${key}`)) ?? fallback;
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(`liman:${key}`, JSON.stringify(value));
      } catch {
        /* gizli sekme vb. */
      }
    },
  };

  let toastTimer;
  function toast(message) {
    el.toast.textContent = message;
    el.toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('is-visible'), 3400);
  }

  async function api(path, options = {}) {
    const res = await fetch(path, {
      credentials: 'same-origin',
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    if (res.status === 401 && !path.startsWith('/api/login')) {
      showLogin();
      throw new Error('Oturum gerekli');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Bir sorun oluştu (${res.status})`);
    return data;
  }

  /* ────────────────────────────── Durum ────────────────────────────── */
  const state = {
    categories: [],
    catNames: new Map(),
    total: 0,
    view: store.get('view', { type: 'all' }),
    items: [],
    filtered: [],
    rendered: 0,
    viewToken: 0,
    current: null,
    favorites: new Set(store.get('favorites', [])),
    recents: store.get('recents', []),
    format: store.get('format', 'auto'),
    authRequired: false,
  };

  const BATCH = 120;

  /* ────────────────────────────── Giriş ────────────────────────────── */
  function showLogin() {
    teardownPlayer();
    el.app.hidden = true;
    el.loginView.hidden = false;
    el.loginError.textContent = '';
    requestAnimationFrame(() => el.loginPassword.focus());
  }

  el.loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = el.loginPassword.value;
    if (!password) {
      el.loginError.textContent = 'Şifreni yazman yeterli.';
      return;
    }
    el.loginSubmit.disabled = true;
    el.loginError.textContent = '';
    try {
      await api('/api/login', { method: 'POST', body: JSON.stringify({ password }) });
      el.loginPassword.value = '';
      startApp();
    } catch (err) {
      el.loginError.textContent = err.message;
      el.loginPassword.select();
    } finally {
      el.loginSubmit.disabled = false;
    }
  });

  /* ────────────────────────────── Kategoriler ────────────────────────────── */
  function specialViews() {
    return [
      { type: 'all', name: 'Tüm Kanallar', icon: 'i-grid', count: state.total },
      { type: 'fav', name: 'Favoriler', icon: 'i-star', count: state.favorites.size },
      { type: 'recent', name: 'Son İzlediklerin', icon: 'i-clock', count: state.recents.length },
    ];
  }

  const isActiveView = (v) => state.view.type === v.type && (v.type !== 'cat' || state.view.id === v.id);

  function catButton(v) {
    const dataId = v.type === 'cat' ? ` data-id="${escapeHtml(v.id)}"` : '';
    return `<li><button class="cat-btn" type="button" data-type="${v.type}"${dataId} aria-current="${isActiveView(v)}">
      <svg aria-hidden="true"><use href="#${v.icon}"/></svg>
      <span class="cat-name">${escapeHtml(v.name)}</span>
      <span class="cat-count">${v.count.toLocaleString('tr-TR')}</span>
    </button></li>`;
  }

  function renderSpecial() {
    el.specialList.innerHTML = specialViews().map(catButton).join('');
  }

  function renderCategories() {
    const q = normalize(el.categorySearch.value).trim();
    const list = q ? state.categories.filter((c) => normalize(c.name).includes(q)) : state.categories;
    el.categoryList.innerHTML = list.length
      ? list.map((c) => catButton({ type: 'cat', id: c.id, name: c.name, icon: 'i-folder', count: c.count })).join('')
      : `<li class="empty small">Bu isimde bir kategori yok.</li>`;
  }

  async function loadCategories() {
    const data = await api('/api/live/categories');
    state.categories = data.categories;
    state.total = data.total;
    state.catNames = new Map(data.categories.map((c) => [c.id, c.name]));
    if (state.view.type === 'cat' && !state.catNames.has(state.view.id)) state.view = { type: 'all' };
    renderSpecial();
    renderCategories();
  }

  function onCategoryClick(e) {
    const btn = e.target.closest('.cat-btn');
    if (!btn) return;
    const view = { type: btn.dataset.type };
    if (view.type === 'cat') view.id = btn.dataset.id;
    selectView(view);
    closeDrawer();
  }
  el.specialList.addEventListener('click', onCategoryClick);
  el.categoryList.addEventListener('click', onCategoryClick);
  el.categorySearch.addEventListener('input', debounce(renderCategories, 120));

  /* ────────────────────────────── Kanallar ────────────────────────────── */
  function viewTitle(view) {
    if (view.type === 'all') return 'Tüm Kanallar';
    if (view.type === 'fav') return 'Favoriler';
    if (view.type === 'recent') return 'Son İzlediklerin';
    return state.catNames.get(view.id) || 'Kategori';
  }

  async function selectView(view) {
    state.view = view;
    store.set('view', view);
    renderSpecial();
    renderCategories();
    el.channelHeading.textContent = viewTitle(view);
    el.channelCount.textContent = 'Yükleniyor…';
    el.channelSearch.value = '';

    const token = ++state.viewToken;
    let items = [];
    try {
      if (view.type === 'fav' || view.type === 'recent') {
        const ids = view.type === 'fav' ? [...state.favorites] : state.recents;
        items = ids.length ? (await api(`/api/live/streams?ids=${ids.join(',')}`)).items : [];
      } else {
        const cat = view.type === 'cat' ? encodeURIComponent(view.id) : 'all';
        items = (await api(`/api/live/streams?category=${cat}`)).items;
      }
    } catch (err) {
      if (token !== state.viewToken) return;
      el.channelCount.textContent = '';
      el.channelList.innerHTML = '';
      el.channelEmpty.hidden = false;
      el.channelEmpty.textContent = err.message;
      return;
    }
    if (token !== state.viewToken) return;
    items.forEach((it) => (it._q = normalize(it.name)));
    state.items = items;
    applyFilter();
    el.channelList.closest('.channel-scroll').scrollTop = 0;
  }

  function applyFilter() {
    const q = normalize(el.channelSearch.value).trim();
    const terms = q ? q.split(/\s+/) : [];
    state.filtered = terms.length ? state.items.filter((it) => terms.every((t) => it._q.includes(t))) : state.items;
    el.channelCount.textContent = q
      ? `${state.filtered.length.toLocaleString('tr-TR')} / ${state.items.length.toLocaleString('tr-TR')} kanal`
      : `${state.items.length.toLocaleString('tr-TR')} kanal`;
    renderChannels();
  }
  el.channelSearch.addEventListener('input', debounce(applyFilter, 140));

  function emptyMessage() {
    if (el.channelSearch.value.trim()) return 'Aradığın isimde bir kanal bulamadım.<br>Belki farklı bir yazımla?';
    if (state.view.type === 'fav') return 'Henüz favorin yok.<br>Sevdiğin kanalların yanındaki yıldıza dokunman yeterli.';
    if (state.view.type === 'recent') return 'Burası şimdilik sessiz.<br>İzlediğin kanallar burada birikecek.';
    return 'Bu kategoride şu an kanal görünmüyor.';
  }

  function channelRow(ch) {
    const fav = state.favorites.has(ch.id);
    const current = state.current?.id === ch.id;
    const logo = ch.logo
      ? `<img src="${escapeHtml(ch.logo)}" alt="" loading="lazy" decoding="async" data-initials="${escapeHtml(initials(ch.name))}">`
      : escapeHtml(initials(ch.name));
    return `<li class="ch-item">
      <button class="ch" type="button" data-id="${ch.id}" aria-current="${current}">
        <span class="ch-num">${ch.num}</span>
        <span class="ch-logo">${logo}</span>
        <span class="ch-name">${escapeHtml(ch.name)}</span>
        <span class="ch-playing" aria-hidden="true"><i></i><i></i><i></i></span>
      </button>
      <button class="ch-fav" type="button" data-fav="${ch.id}" aria-pressed="${fav}" aria-label="${fav ? 'Favorilerden çıkar' : 'Favorilere ekle'}: ${escapeHtml(ch.name)}">
        <svg aria-hidden="true"><use href="#${fav ? 'i-star-fill' : 'i-star'}"/></svg>
      </button>
    </li>`;
  }

  function renderChannels() {
    state.rendered = 0;
    el.channelList.innerHTML = '';
    el.channelEmpty.hidden = state.filtered.length > 0;
    if (!state.filtered.length) el.channelEmpty.innerHTML = emptyMessage();
    renderMore();
  }

  function renderMore() {
    if (state.rendered >= state.filtered.length) return;
    const next = state.filtered.slice(state.rendered, state.rendered + BATCH);
    el.channelList.insertAdjacentHTML('beforeend', next.map(channelRow).join(''));
    state.rendered += next.length;
  }

  // Liste sonuna yaklaşıldıkça yeni satırlar ekle (binlerce kanalda bile akıcı kalsın).
  new IntersectionObserver((entries) => entries[0].isIntersecting && renderMore(), { rootMargin: '600px' }).observe(
    el.channelSentinel,
  );

  // Kırık logoları baş harflerle değiştir (CSP nedeniyle inline onerror kullanılmıyor).
  function handleImgError(e) {
    const img = e.target;
    if (img.tagName !== 'IMG') return;
    const holder = img.parentElement;
    holder.textContent = img.dataset.initials || '•';
  }
  el.channelList.addEventListener('error', handleImgError, true);
  el.nowLogo.addEventListener('error', handleImgError, true);

  el.channelList.addEventListener('click', (e) => {
    const favBtn = e.target.closest('.ch-fav');
    if (favBtn) return toggleFavorite(Number(favBtn.dataset.fav));
    const btn = e.target.closest('.ch');
    if (!btn) return;
    const ch = state.filtered.find((c) => c.id === Number(btn.dataset.id));
    if (ch) playChannel(ch);
  });

  function markCurrentRow() {
    for (const btn of el.channelList.querySelectorAll('.ch[aria-current="true"]')) btn.setAttribute('aria-current', 'false');
    if (!state.current) return;
    const row = el.channelList.querySelector(`.ch[data-id="${state.current.id}"]`);
    if (row) {
      row.setAttribute('aria-current', 'true');
      row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  /* ────────────────────────────── Favoriler & geçmiş ────────────────────────────── */
  function toggleFavorite(id) {
    const adding = !state.favorites.has(id);
    if (adding) state.favorites.add(id);
    else state.favorites.delete(id);
    store.set('favorites', [...state.favorites]);

    const btn = el.channelList.querySelector(`.ch-fav[data-fav="${id}"]`);
    if (btn) {
      btn.setAttribute('aria-pressed', String(adding));
      btn.querySelector('use').setAttribute('href', adding ? '#i-star-fill' : '#i-star');
    }
    if (state.current?.id === id) updateFavButton();
    renderSpecial();
    toast(adding ? 'Favorilerine eklendi.' : 'Favorilerinden çıkarıldı.');
    if (state.view.type === 'fav' && !adding) {
      state.items = state.items.filter((it) => it.id !== id);
      applyFilter();
    }
  }

  function updateFavButton() {
    const fav = state.current && state.favorites.has(state.current.id);
    el.favBtn.setAttribute('aria-pressed', String(Boolean(fav)));
    el.favBtn.setAttribute('aria-label', fav ? 'Favorilerden çıkar' : 'Favorilere ekle');
    el.favBtn.querySelector('use').setAttribute('href', fav ? '#i-star-fill' : '#i-star');
  }

  function pushRecent(id) {
    state.recents = [id, ...state.recents.filter((r) => r !== id)].slice(0, 30);
    store.set('recents', state.recents);
    renderSpecial();
  }

  /* ────────────────────────────── Oynatıcı ────────────────────────────── */
  const player = { mpegts: null, hls: null, token: 0, mode: null, fallbackTried: false, watchdog: null };

  function canPlayTs() {
    const m = window.mpegts;
    return Boolean(m && m.isSupported() && m.getFeatureList().mseLivePlayback);
  }

  function resolveMode(preferred = state.format) {
    if (preferred === 'hls') return 'hls';
    if (preferred === 'ts') return canPlayTs() ? 'ts' : 'hls';
    return canPlayTs() ? 'ts' : 'hls';
  }

  function teardownPlayer() {
    clearTimeout(player.watchdog);
    if (player.mpegts) {
      try {
        player.mpegts.pause();
        player.mpegts.unload();
        player.mpegts.detachMediaElement();
        player.mpegts.destroy();
      } catch {
        /* zaten kapanmış */
      }
      player.mpegts = null;
    }
    if (player.hls) {
      player.hls.destroy();
      player.hls = null;
    }
    el.video.removeAttribute('src');
    el.video.load();
  }

  function showOverlay(name, text) {
    el.idle.hidden = name !== 'idle';
    el.loading.hidden = name !== 'loading';
    el.error.hidden = name !== 'error';
    if (name === 'loading') el.loadingText.textContent = text || 'Yayın hazırlanıyor…';
    if (name === 'error') el.errorText.textContent = text || '';
    el.liveDot.classList.toggle('is-live', name === null);
  }

  function setLogo(container, ch) {
    container.innerHTML = ch.logo
      ? `<img src="${escapeHtml(ch.logo)}" alt="" data-initials="${escapeHtml(initials(ch.name))}">`
      : escapeHtml(initials(ch.name));
  }

  async function playChannel(ch, { mode } = {}) {
    teardownPlayer();
    const token = ++player.token;
    player.fallbackTried = Boolean(mode);
    state.current = ch;
    store.set('last', ch.id);

    document.title = `${ch.name} — Liman TV`;
    el.nowTitle.textContent = ch.name;
    el.nowCategory.textContent = state.catNames.get(ch.cat) || 'Canlı yayın';
    setLogo(el.nowLogo, ch);
    updateFavButton();
    markCurrentRow();
    pushRecent(ch.id);
    loadEpg(ch);
    updateMediaSession(ch);

    showOverlay('loading', 'Yayın bağlantısı hazırlanıyor…');
    try {
      const sources = await api(`/api/playback/${ch.id}`);
      if (token !== player.token) return;
      player.sources = sources;
      startPlayback(ch, token, mode || resolveMode());
    } catch (err) {
      if (token === player.token) showOverlay('error', err.message);
    }
  }

  function startPlayback(ch, token, mode) {
    player.mode = mode;
    showOverlay('loading', mode === 'ts' ? 'Yayın hazırlanıyor…' : 'Yayın hazırlanıyor (HLS)…');

    clearTimeout(player.watchdog);
    player.watchdog = setTimeout(() => {
      if (token === player.token && el.video.readyState < 3) {
        onPlaybackError(token, ch, mode, { message: 'Yayın 25 saniyedir yanıt vermiyor.' });
      }
    }, 25_000);

    if (mode === 'ts') startTs(ch, token);
    else startHls(ch, token);
    safePlay();
  }

  function startTs(ch, token) {
    const mp = window.mpegts.createPlayer(
      { type: 'mpegts', isLive: true, url: player.sources.ts },
      {
        enableWorker: true,
        lazyLoad: false,
        autoCleanupSourceBuffer: true,
        liveBufferLatencyChasing: true,
        liveBufferLatencyMaxLatency: 10,
        liveBufferLatencyMinRemain: 3,
      },
    );
    mp.on(window.mpegts.Events.ERROR, (type, detail, info) => {
      onPlaybackError(token, ch, 'ts', { code: info?.code, type, detail, message: info?.msg });
    });
    mp.attachMediaElement(el.video);
    mp.load();
    player.mpegts = mp;
  }

  function startHls(ch, token) {
    const src = player.sources.hls;
    const Hls = window.Hls;
    if (Hls && Hls.isSupported()) {
      let recovered = false;
      const hls = new Hls({ enableWorker: true, backBufferLength: 30, liveSyncDurationCount: 3 });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) {
          recovered = true;
          hls.recoverMediaError();
          return;
        }
        onPlaybackError(token, ch, 'hls', { code: data.response?.code, detail: data.details });
      });
      hls.loadSource(src);
      hls.attachMedia(el.video);
      player.hls = hls;
    } else if (el.video.canPlayType('application/vnd.apple.mpegurl')) {
      el.video.src = src; // Safari / iOS yerel HLS
    } else {
      onPlaybackError(token, ch, 'hls', { message: 'Bu tarayıcı canlı yayın oynatmayı desteklemiyor.' });
    }
  }

  async function safePlay() {
    try {
      await el.video.play();
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        el.video.muted = true;
        try {
          await el.video.play();
          toast('Yayın sessiz başladı; sesi açmak için oynatıcıya dokun.');
        } catch {
          /* kullanıcı oynat tuşuna basacak */
        }
      }
    }
  }

  function describeError(info, mode) {
    if (info.message && !info.code && !info.detail) return info.message;
    switch (info.code) {
      case 401:
        return 'Oturum gerekli veya sağlayıcı hesabı geçersiz. Yeniden giriş yapıp hesap durumunu kontrol et.';
      case 403:
        return 'Sağlayıcı bu bağlantıya izin vermiyor. Hesabın ülke kısıtlamasını ve eşzamanlı bağlantı sınırını kontrol et. Sunucunun bulunduğu ülkeye sağlayıcının izin vermesi gerekir.';
      case 404:
        return 'Bu kanal sağlayıcıda şu an yayında görünmüyor.';
      case 502:
      case 504:
        return 'Sağlayıcıya ulaşılamadı. Biraz bekleyip yeniden deneyebilirsin.';
    }
    if (info.type === 'MediaError' || /codec|media/i.test(info.detail || '')) {
      return 'Tarayıcın bu yayının görüntü/ses biçimini çözemedi (ör. HEVC). Diğer biçimi ya da Safari/Edge’i deneyebilirsin.';
    }
    return mode === 'ts' ? 'MPEG-TS akışı başlatılamadı.' : 'HLS akışı başlatılamadı.';
  }

  function onPlaybackError(token, ch, mode, info = {}) {
    if (token !== player.token) return;
    const authBlocked = info.code === 401 || info.code === 403;
    // Otomatik modda TS başarısız olursa bir kez HLS ile dene.
    if (state.format === 'auto' && mode === 'ts' && !player.fallbackTried && !authBlocked) {
      player.fallbackTried = true;
      teardownPlayer();
      toast('MPEG-TS açılmadı, HLS ile deniyorum…');
      startPlayback(ch, token, 'hls');
      return;
    }
    clearTimeout(player.watchdog);
    teardownPlayer();
    el.altFormatBtn.textContent = mode === 'ts' ? 'HLS ile dene' : 'MPEG-TS ile dene';
    el.altFormatBtn.hidden = mode === 'hls' && !canPlayTs();
    showOverlay('error', describeError(info, mode));
  }

  el.video.addEventListener('playing', () => {
    clearTimeout(player.watchdog);
    showOverlay(null);
  });
  el.video.addEventListener('waiting', () => {
    if (state.current && el.error.hidden) showOverlay('loading', 'Yayın tamponlanıyor…');
  });
  el.video.addEventListener('error', () => {
    // Yalnızca yerel (Safari) HLS hataları burada yakalanır; MSE oynatıcılar kendi olaylarını kullanır.
    if (!player.mpegts && !player.hls && state.current && el.video.getAttribute('src')) {
      onPlaybackError(player.token, state.current, 'hls', { type: 'MediaError', detail: 'media' });
    }
  });
  el.video.addEventListener('click', () => {
    if (el.video.muted) el.video.muted = false;
  });

  el.retryBtn.addEventListener('click', () => state.current && playChannel(state.current, { mode: player.mode }));
  el.altFormatBtn.addEventListener('click', () => {
    if (!state.current) return;
    playChannel(state.current, { mode: player.mode === 'ts' ? 'hls' : 'ts' });
  });

  function step(delta) {
    const list = state.filtered.length ? state.filtered : state.items;
    if (!list.length) return;
    const idx = state.current ? list.findIndex((c) => c.id === state.current.id) : -1;
    const next = list[(idx + delta + list.length) % list.length];
    // Hedef satır henüz çizilmediyse çiz, böylece vurgulanabilsin.
    const nextIndex = list.indexOf(next);
    while (state.rendered <= nextIndex && state.rendered < state.filtered.length) renderMore();
    playChannel(next);
  }

  el.prevBtn.addEventListener('click', () => step(-1));
  el.nextBtn.addEventListener('click', () => step(1));
  el.favBtn.addEventListener('click', () => state.current && toggleFavorite(state.current.id));

  el.fsBtn.addEventListener('click', toggleFullscreen);
  function toggleFullscreen() {
    if (document.fullscreenElement) return document.exitFullscreen();
    if (el.playerShell.requestFullscreen) return el.playerShell.requestFullscreen().catch(() => {});
    if (el.video.webkitEnterFullscreen) el.video.webkitEnterFullscreen(); // iOS
  }

  if (!document.pictureInPictureEnabled) el.pipBtn.hidden = true;
  el.pipBtn.addEventListener('click', async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await el.video.requestPictureInPicture();
    } catch {
      toast('Resim içinde resim için önce yayının başlaması gerekiyor.');
    }
  });

  el.formatSelect.value = state.format;
  el.formatSelect.addEventListener('change', () => {
    state.format = el.formatSelect.value;
    store.set('format', state.format);
    if (state.current) playChannel(state.current);
  });

  function updateMediaSession(ch) {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: ch.name,
      artist: 'Liman TV',
      artwork: ch.logo ? [{ src: ch.logo, sizes: '256x256' }] : [],
    });
    navigator.mediaSession.setActionHandler('previoustrack', () => step(-1));
    navigator.mediaSession.setActionHandler('nexttrack', () => step(1));
  }

  /* ────────────────────────────── Yayın akışı (EPG) ────────────────────────────── */
  let epgTimer;
  async function loadEpg(ch) {
    clearInterval(epgTimer);
    el.epg.innerHTML = '<p class="muted small">Yayın akışı getiriliyor…</p>';
    let listings = [];
    try {
      listings = (await api(`/api/epg/${ch.id}`)).listings;
    } catch {
      /* EPG isteğe bağlı */
    }
    if (state.current?.id !== ch.id) return;
    renderEpg(listings);
    epgTimer = setInterval(() => {
      if (listings.length && Date.now() > listings[0].end) return loadEpg(ch);
      renderEpg(listings);
    }, 30_000);
  }

  function renderEpg(listings) {
    const now = Date.now();
    const current = listings.find((l) => l.start <= now && l.end > now);
    const upcoming = listings.filter((l) => l.start > now).slice(0, 4);
    if (!current && !upcoming.length) {
      el.epg.innerHTML = '<p class="muted small">Bu kanal için yayın akışı paylaşılmamış. Sadece izle, yeter.</p>';
      return;
    }
    let html = '';
    if (current) {
      const pct = Math.min(100, Math.max(0, ((now - current.start) / (current.end - current.start)) * 100));
      html += `<article class="epg-now">
        <span class="epg-label">Şimdi</span>
        <h3>${escapeHtml(current.title)}</h3>
        <span class="epg-time">${timeFmt.format(current.start)} – ${timeFmt.format(current.end)} · ${Math.max(1, Math.round((current.end - now) / 60000))} dk kaldı</span>
        <div class="progress" role="progressbar" aria-label="Program ilerlemesi" aria-valuenow="${Math.round(pct)}" aria-valuemin="0" aria-valuemax="100"><span style="--p:${pct.toFixed(1)}%"></span></div>
        ${current.desc ? `<p class="epg-desc">${escapeHtml(current.desc)}</p>` : ''}
      </article>`;
    }
    if (upcoming.length) {
      html += `<ul class="epg-next" aria-label="Sıradaki programlar">${upcoming
        .map((l) => `<li><time>${timeFmt.format(l.start)}</time><span>${escapeHtml(l.title)}</span></li>`)
        .join('')}</ul>`;
    }
    el.epg.innerHTML = html;
  }

  /* ────────────────────────────── Hesap kutusu ────────────────────────────── */
  async function loadAccount() {
    let info = null;
    try {
      info = await api('/api/account');
    } catch {
      /* hesap bilgisi isteğe bağlı */
    }
    const active = info && /active/i.test(info.status);
    el.account.innerHTML = `
      ${
        info
          ? `<div class="account-row"><span class="status-pill ${active ? '' : 'is-off'}">${active ? 'Hesap aktif' : escapeHtml(info.status)}</span>
             ${info.maxConnections ? `<span>${info.activeConnections}/${info.maxConnections} bağlantı</span>` : ''}</div>
             ${info.expiresAt ? `<div class="account-row"><span>Bitiş</span><strong>${dateFmt.format(info.expiresAt)}</strong></div>` : ''}`
          : ''
      }
      <div class="account-actions">
        <button id="refresh-btn" class="icon-btn" type="button" aria-label="Listeyi yenile" title="Listeyi yenile"><svg><use href="#i-refresh"/></svg></button>
        ${state.authRequired ? `<button id="logout-btn" class="icon-btn" type="button" aria-label="Çıkış yap" title="Çıkış yap"><svg><use href="#i-logout"/></svg></button>` : ''}
      </div>`;
  }

  el.account.addEventListener('click', async (e) => {
    if (e.target.closest('#refresh-btn')) {
      toast('Liste tazeleniyor…');
      try {
        await api('/api/refresh', { method: 'POST' });
        await loadCategories();
        await selectView(state.view);
        loadAccount();
        toast('Liste güncel.');
      } catch (err) {
        toast(err.message);
      }
    }
    if (e.target.closest('#logout-btn')) {
      await api('/api/logout', { method: 'POST' }).catch(() => {});
      showLogin();
    }
  });

  /* ────────────────────────────── Çekmece (tablet/telefon) ────────────────────────────── */
  const compactQuery = matchMedia('(max-width: 1180px)');
  function syncDrawerInert() {
    const hidden = compactQuery.matches && !el.app.classList.contains('drawer-open');
    el.sidebar.inert = hidden;
  }
  function openDrawer() {
    el.app.classList.add('drawer-open');
    syncDrawerInert();
    el.categorySearch.focus();
  }
  function closeDrawer() {
    if (!el.app.classList.contains('drawer-open')) return;
    el.app.classList.remove('drawer-open');
    syncDrawerInert();
  }
  el.sidebarOpen.addEventListener('click', openDrawer);
  el.sidebarClose.addEventListener('click', () => {
    closeDrawer();
    el.sidebarOpen.focus();
  });
  el.scrim.addEventListener('click', closeDrawer);
  compactQuery.addEventListener('change', syncDrawerInert);

  /* ────────────────────────────── Klavye ────────────────────────────── */
  document.addEventListener('keydown', (e) => {
    if (el.app.hidden) return;
    if (e.key === 'Escape') return closeDrawer();
    const typing = e.target.closest('input, select, textarea');
    if (typing) return;
    if (e.key === '/') {
      e.preventDefault();
      el.channelSearch.focus();
    } else if (e.key === 'f' || e.key === 'F') {
      toggleFullscreen();
    } else if (e.key === 'm' || e.key === 'M') {
      el.video.muted = !el.video.muted;
      toast(el.video.muted ? 'Ses kapalı.' : 'Ses açık.');
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'PageUp' || e.key === 'PageDown') && state.current) {
      const inList = e.target.closest('.channel-scroll, .cat-scroll');
      if (inList && !e.key.startsWith('Page')) return;
      e.preventDefault();
      step(e.key === 'ArrowUp' || e.key === 'PageUp' ? -1 : 1);
    }
  });

  /* ────────────────────────────── Başlangıç ────────────────────────────── */
  async function offerResume() {
    const lastId = store.get('last', null);
    if (!lastId) return;
    try {
      const { items } = await api(`/api/live/streams?ids=${lastId}`);
      const ch = items[0];
      if (!ch || state.current) return;
      el.resumeLabel.textContent = `Kaldığın yerden: ${ch.name}`;
      el.resumeBtn.hidden = false;
      el.resumeBtn.onclick = () => playChannel(ch);
    } catch {
      /* sessizce geç */
    }
  }

  async function startApp() {
    el.loginView.hidden = true;
    el.app.hidden = false;
    syncDrawerInert();
    showOverlay('idle');
    try {
      await loadCategories();
    } catch (err) {
      el.categoryList.innerHTML = `<li class="empty small">${escapeHtml(err.message)}</li>`;
      el.channelCount.textContent = '';
      toast(err.message);
      return;
    }
    selectView(state.view);
    loadAccount();
    offerResume();
  }

  async function boot() {
    try {
      const session = await fetch('/api/session', { credentials: 'same-origin' }).then((r) => r.json());
      state.authRequired = session.authRequired;
      if (session.authRequired && !session.authed) return showLogin();
      startApp();
    } catch {
      toast('Sunucuya ulaşılamadı.');
    }
  }

  boot();
})();
