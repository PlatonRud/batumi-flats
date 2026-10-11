(() => {
  'use strict';

  const BATUMI = [41.64, 41.622];
  const COMPACT_BELOW_ZOOM = 15; // на мелком масштабе вместо цен показываются точки
  const TYPE_LABELS = { studio: 'Студия', 1: '1 спальня', 2: '2 спальни', 3: '3 спальни', 4: '4+ спальни' };
  const TYPE_FILTERS = [['all', 'Все'], ['studio', 'Студия'], ['1', '1 спальня'], ['2', '2 спальни'], ['3+', '3+ спальни']];
  const PRICE_FILTERS = [[0, 'Любая цена'], [400, 'до 400 $'], [600, 'до 600 $'], [800, 'до 800 $'], [1000, 'до 1000 $']];
  const $ = (id) => document.getElementById(id);

  const state = { tab: 'map', type: 'all', maxPrice: 0, selected: null };
  let data = { channel: '', updated: null, listings: [] };
  let map;
  let markerLayer;
  let groups = new Map(); // ключ координат → квартиры одного дома

  function el(tag, className, ...children) {
    const node = document.createElement(tag);
    node.className = className;
    node.append(...children.filter((child) => child !== null && child !== ''));
    return node;
  }

  function plural(n, one, few, many) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
  }
  const flatsLabel = (n) => `${n} ${plural(n, 'квартира', 'квартиры', 'квартир')}`;

  function daysAgo(iso) {
    const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const days = Math.round((startOfDay(new Date()) - startOfDay(new Date(iso))) / 86400000);
    if (days <= 0) return 'сегодня';
    if (days === 1) return 'вчера';
    return `${days} ${plural(days, 'день', 'дня', 'дней')} назад`;
  }

  const formatPrice = (listing) => `${listing.price.toLocaleString('ru-RU')} ${listing.currency === 'USD' ? '$' : '₾'}`;
  const postUrl = (listing) => `https://t.me/${data.channel}/${listing.id}`;

  // ——— Фильтры ———

  function matches(listing) {
    if (state.maxPrice && listing.price > state.maxPrice) return false;
    if (state.type === 'all') return true;
    if (state.type === '3+') return Number(listing.type) >= 3;
    return listing.type === state.type;
  }

  function renderChips(container, options, current, onPick) {
    container.textContent = '';
    for (const [value, label] of options) {
      const chip = el('button', 'chip', label);
      chip.type = 'button';
      chip.setAttribute('aria-pressed', String(value === current));
      chip.addEventListener('click', () => onPick(value));
      container.append(chip);
    }
  }

  function renderFilters() {
    renderChips($('types'), TYPE_FILTERS, state.type, (value) => {
      state.type = value;
      render();
    });
    renderChips($('prices'), PRICE_FILTERS, state.maxPrice, (value) => {
      state.maxPrice = value;
      render();
    });
  }

  // ——— Карточка квартиры ———

  function photoImage(url) {
    const image = new Image();
    image.alt = '';
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
    image.src = url;
    return image;
  }

  // Лента фото вверху карточки; нажатие открывает фото на весь экран
  function photoStrip(listing) {
    const strip = el('div', 'photos');
    for (const [url, ratio] of listing.photos) {
      const image = photoImage(url);
      image.loading = 'lazy';
      const photo = el('button', 'photo', image);
      photo.type = 'button';
      photo.style.aspectRatio = String(ratio);
      photo.setAttribute('aria-label', 'Открыть фото');
      photo.addEventListener('click', () => openGallery(listing, listing.photos.findIndex((p) => p[0] === url)));
      // ссылка на фото устарела — убираем пустую рамку
      image.addEventListener('error', () => photo.remove());
      strip.append(photo);
    }
    return el(
      'div',
      'photos-wrap',
      strip,
      el('span', 'photos-chip photos-date', daysAgo(listing.date)),
      el('span', 'photos-chip photos-count', `${listing.photos.length} фото`)
    );
  }

  function card(listing, { withAddress }) {
    const hasPhotos = Array.isArray(listing.photos) && listing.photos.length > 0;
    const heading = [TYPE_LABELS[listing.type] || 'Квартира', listing.area && `${listing.area} м²`].filter(Boolean).join(' · ');
    const price = el('div', 'card-price', formatPrice(listing), el('small', '', 'в месяц'));
    const badges = el(
      'div',
      'badges',
      ...[listing.floor && `${listing.floor} этаж`, listing.complex, listing.heating]
        .filter(Boolean)
        .map((text) => el('span', 'badge', text))
    );

    const details = el('button', 'btn btn-secondary', 'Подробнее');
    details.type = 'button';
    details.addEventListener('click', () => openPost(listing));

    const write = el('a', 'btn btn-primary', 'Написать');
    write.href = listing.realtor ? `https://t.me/${listing.realtor}` : postUrl(listing);
    write.target = '_blank';
    write.rel = 'noopener';

    const meta = [!hasPhotos && daysAgo(listing.date), listing.number && `№ ${listing.number}`].filter(Boolean).join(' · ');

    return el(
      'li',
      'card',
      hasPhotos ? photoStrip(listing) : null,
      el(
        'div',
        'card-body',
        el('div', 'card-head', el('h3', 'card-title', heading), price),
        withAddress ? el('p', 'card-address', listing.address + (listing.lat ? '' : ' · нет на карте')) : null,
        listing.title ? el('p', 'card-text', listing.title) : null,
        badges,
        meta ? el('p', 'card-meta', meta) : null,
        el('div', 'card-actions', details, write)
      )
    );
  }

  // ——— Карта ———

  function initMap() {
    map = L.map('map', {
      zoomControl: false,
      minZoom: 11,
      maxZoom: 19,
      maxBounds: [[41.45, 41.4], [41.8, 41.9]],
    }).setView(BATUMI, 13);
    map.attributionControl.setPrefix(false);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
    }).addTo(map);
    markerLayer = L.layerGroup().addTo(map);

    map.on('click', () => select(null));
    map.on('zoomend', updateCompact);
    updateCompact();
  }

  function updateCompact() {
    $('map').classList.toggle('compact', map.getZoom() < COMPACT_BELOW_ZOOM);
  }

  function groupByPlace(listings) {
    const result = new Map();
    for (const listing of listings) {
      if (!listing.lat) continue;
      const key = `${listing.lat.toFixed(5)},${listing.lng.toFixed(5)}`;
      if (!result.has(key)) result.set(key, { key, lat: listing.lat, lng: listing.lng, approx: listing.approx, items: [] });
      result.get(key).items.push(listing);
    }
    return result;
  }

  function renderMarkers() {
    markerLayer.clearLayers();
    for (const group of groups.values()) {
      const cheapest = group.items.reduce((a, b) => (a.price <= b.price ? a : b));
      const many = group.items.length > 1;
      const classes = ['pin', group.approx && 'approx', group.key === state.selected && 'selected'].filter(Boolean).join(' ');
      const label = formatPrice(cheapest); // для дома с несколькими квартирами — минимальная цена
      const count = many ? `<span class="pin-count">${group.items.length}</span>` : '';

      const marker = L.marker([group.lat, group.lng], {
        icon: L.divIcon({ className: 'pin-anchor', iconSize: [0, 0], html: `<span class="${classes}"><span>${label}</span>${count}</span>` }),
        bubblingMouseEvents: false,
        zIndexOffset: group.key === state.selected ? 1000 : 0,
        title: `${group.items[0].address}: ${flatsLabel(group.items.length)}`,
      });
      marker.on('click', () => select(group.key));
      markerLayer.addLayer(marker);
    }
  }

  // Стартовый вид — на медиану точек: пара квартир за городом не должна отдалять всю карту
  function centerOnListings() {
    const places = [...groups.values()];
    if (!places.length) return;
    const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
    map.setView([median(places.map((p) => p.lat)), median(places.map((p) => p.lng))], COMPACT_BELOW_ZOOM, { animate: false });
  }

  // ——— Квартиры выбранного дома ———

  function select(key) {
    state.selected = key && groups.has(key) ? key : null;
    renderMarkers();
    renderSheet();
  }

  function renderSheet() {
    const group = groups.get(state.selected);
    const sheet = $('sheet');
    sheet.hidden = !group;
    if (!group) return;

    $('sheet-title').textContent = group.items[0].address;
    $('sheet-note').textContent =
      flatsLabel(group.items.length) + (group.approx ? ' · место примерное: показана улица, дом на карте не найден' : '');
    const items = $('sheet-items');
    items.textContent = '';
    items.scrollTop = 0;
    for (const listing of group.items) items.append(card(listing, { withAddress: false }));

    map.panInside([group.lat, group.lng], {
      paddingTopLeft: [50, topHeight() + 50],
      paddingBottomRight: [50, sheet.offsetHeight + 30],
    });
  }

  // ——— Пост Telegram с фото ———

  // Пост открывается отдельной записью в истории, чтобы работал системный жест «назад»
  function openPost(listing) {
    history.pushState({ post: listing.id }, '');
    showPost(listing);
  }

  function showPost(listing) {
    $('viewer-title').textContent = listing.number ? `Объявление № ${listing.number}` : 'Объявление';
    $('viewer-post').href = postUrl(listing);
    $('viewer-realtor').href = listing.realtor ? `https://t.me/${listing.realtor}` : postUrl(listing);

    // Официальная вставка Telegram: фото и текст остаются на стороне канала
    const widget = document.createElement('script');
    widget.async = true;
    widget.src = 'https://telegram.org/js/telegram-widget.js?22';
    widget.dataset.telegramPost = `${data.channel}/${listing.id}`;
    widget.dataset.width = '100%';
    widget.dataset.dark = '1';
    $('viewer-body').replaceChildren(widget);
    $('viewer').hidden = false;
  }

  // ——— Фото на весь экран ———

  function openGallery(listing, index) {
    history.pushState({ gallery: listing.id, index }, '');
    showGallery(listing, index);
  }

  function showGallery(listing, index) {
    const track = $('gallery-track');
    track.replaceChildren(...listing.photos.map(([url]) => el('div', 'gallery-slide', photoImage(url))));
    $('gallery').hidden = false;
    track.scrollLeft = index * track.clientWidth;
    updateGalleryCount();
  }

  function updateGalleryCount() {
    const track = $('gallery-track');
    const current = Math.round(track.scrollLeft / Math.max(track.clientWidth, 1)) + 1;
    $('gallery-count').textContent = `${current} / ${track.children.length}`;
  }

  function route() {
    const current = history.state || {};
    const find = (id) => data.listings.find((l) => l.id === id);

    const post = find(current.post);
    if (post) {
      showPost(post);
    } else {
      $('viewer').hidden = true;
      $('viewer-body').replaceChildren();
    }

    const gallery = find(current.gallery);
    if (gallery) {
      showGallery(gallery, current.index || 0);
    } else {
      $('gallery').hidden = true;
      $('gallery-track').replaceChildren();
    }
  }

  // ——— Отрисовка ———

  function topHeight() {
    return $('top').offsetHeight;
  }

  function render() {
    const visible = data.listings.filter(matches);
    groups = groupByPlace(visible);
    if (!groups.has(state.selected)) state.selected = null;

    renderFilters();
    renderMarkers();
    renderSheet();

    const list = $('list-items');
    list.textContent = '';
    for (const listing of visible) list.append(card(listing, { withAddress: true }));
    $('list-empty').hidden = visible.length > 0;

    const onMap = visible.filter((l) => l.lat).length;
    const parts = [flatsLabel(visible.length)];
    if (state.tab === 'map' && onMap < visible.length) parts.push(`на карте ${onMap}`);
    if (data.updated) parts.push(`обновлено ${daysAgo(data.updated)}`);
    $('status').textContent = parts.join(' · ');

    document.documentElement.style.setProperty('--top-height', `${topHeight()}px`);
  }

  function showTab(tab) {
    state.tab = tab;
    document.querySelector('.app').classList.toggle('tab-list', tab === 'list');
    $('list').hidden = tab !== 'list';
    for (const id of ['map', 'list']) {
      if (id === tab) $(`nav-${id}`).setAttribute('aria-current', 'page');
      else $(`nav-${id}`).removeAttribute('aria-current');
    }
    if (tab === 'list') select(null);
    render();
    if (tab === 'map') map.invalidateSize();
  }

  // ——— Запуск ———

  $('nav-map').addEventListener('click', () => showTab('map'));
  $('nav-list').addEventListener('click', () => showTab('list'));
  $('sheet-close').addEventListener('click', () => select(null));
  $('viewer-back').addEventListener('click', () => history.back());
  $('gallery-close').addEventListener('click', () => history.back());
  $('gallery-track').addEventListener('scroll', updateGalleryCount, { passive: true });
  window.addEventListener('popstate', route);

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js'));
  }

  initMap();
  showTab('map');

  fetch('data/listings.json')
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .then((loaded) => {
      data = loaded;
      render();
      centerOnListings();
      route();
    })
    .catch(() => {
      $('status').textContent = 'Не удалось загрузить объявления. Проверьте интернет и откройте приложение заново.';
    });
})();
