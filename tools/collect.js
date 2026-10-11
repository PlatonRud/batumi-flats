// Сборщик объявлений: читает публичную страницу Telegram-канала, достаёт из постов факты
// (адрес, цена, площадь, этаж) и ссылки на фото, ставит адреса на карту и пишет data/listings.json.
// Сами фото не скачиваются: в файл попадают ссылки на серверы Telegram. Они живут ограниченное время,
// поэтому сборщик нужно запускать регулярно — каждый запуск обновляет ссылки.
//
// Запуск: node tools/collect.js [--days 7] [--max-pages 150] [--no-geocode]
'use strict';

const fs = require('fs');
const path = require('path');

const CHANNEL = 'batumi_prop';
const DATA_DIR = path.join(__dirname, '..', 'data');
const LISTINGS_FILE = path.join(DATA_DIR, 'listings.json');
const GEOCACHE_FILE = path.join(DATA_DIR, 'geocache.json');
const USER_AGENT = 'batumi-flats-map/0.1 (+https://github.com/PlatonRud)';

// Рамка Батуми и окрестностей: запад, север, восток, юг
const VIEWBOX = [41.52, 41.72, 41.76, 41.54];

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(args[i + 1]);
};
const DAYS = option('days', 7);
const MAX_PAGES = option('max-pages', 150);
const GEOCODE = !args.includes('--no-geocode');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchText(url, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'ru' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      if (attempt >= attempts) throw new Error(`${url}: ${error.message}`);
      await sleep(2000 * attempt);
    }
  }
}

// ——— Чтение канала ———

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function htmlToText(html) {
  return html
    .replace(/<s>[\s\S]*?<\/s>/g, '') // зачёркнутая старая цена
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/g, (match, name) => ENTITIES[name] || match);
}

function parsePage(html) {
  const marker = new RegExp(`data-post="${CHANNEL}/(\\d+)"`, 'g');
  const starts = [...html.matchAll(marker)];
  return starts.map((match, i) => {
    const chunk = html.slice(match.index, i + 1 < starts.length ? starts[i + 1].index : html.length);
    const text = chunk.match(/<div class="tgme_widget_message_text js-message_text"[^>]*>([\s\S]*?)<\/div>/);
    const time = chunk.match(/<time datetime="([^"]+)"/);
    return {
      id: Number(match[1]),
      date: time ? time[1] : null,
      text: text ? htmlToText(text[1]) : '',
      photos: parsePhotos(chunk),
    };
  });
}

// Пары [ссылка, отношение ширины к высоте]: пропорции нужны, чтобы карточка не прыгала при загрузке фото
function parsePhotos(chunk) {
  return [...chunk.matchAll(/<a class="tgme_widget_message_photo_wrap[^>]*>/g)]
    .map(([tag]) => {
      const url = tag.match(/background-image:url\('([^']+)'\)/);
      const ratio = tag.match(/data-ratio="([\d.]+)"/);
      return url ? [url[1], ratio ? Number(ratio[1]) : 0.75] : null;
    })
    .filter(Boolean);
}

async function readChannel() {
  const since = Date.now() - DAYS * 24 * 60 * 60 * 1000;
  const posts = new Map();
  let before = null;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `https://t.me/s/${CHANNEL}` + (before ? `?before=${before}` : '');
    const batch = parsePage(await fetchText(url));
    if (batch.length === 0) break;
    for (const post of batch) posts.set(post.id, post);

    const oldest = batch.reduce((a, b) => (a.id < b.id ? a : b));
    if (oldest.id === before || (oldest.date && Date.parse(oldest.date) < since)) break;
    before = oldest.id;
    if (page % 10 === 0) console.log(`  страниц: ${page}, постов: ${posts.size}`);
    await sleep(400);
  }

  return [...posts.values()].filter((p) => p.date && Date.parse(p.date) >= since).sort((a, b) => b.id - a.id);
}

// ——— Разбор объявления ———

function parseListing(post) {
  const lines = post.text.split('\n').map((line) => line.trim()).filter(Boolean);
  const addressLine = lines.find((line) => line.includes('📍'));
  const priceLine = lines.find((line) => line.includes('💰'));
  if (!addressLine || !priceLine) return null;

  const price = priceLine.match(/(\d[\d\s.,]*)\s*(\$|usd|долл|₾|gel|лари)/i);
  if (!price) return null;

  const tags = [...post.text.matchAll(/#([\p{L}\p{N}_]+)/gu)].map((m) => m[1].toLowerCase());
  const title = lines.find((line) => !line.startsWith('#') && !line.startsWith('№') && /\p{L}/u.test(line)) || '';
  const area = post.text.match(/(\d+(?:[.,]\d+)?)\s*(?:м²|м2|кв\.?\s*м|m²|m2)/i);
  const floor = post.text.match(/(\d+)\s*этаж/i);
  const heating = lines.find((line) => /отоплен/i.test(line));
  const number = post.text.match(/№\s*(\d+)/);
  const realtor = [...post.text.matchAll(/@([A-Za-z0-9_]{4,})/g)].map((m) => m[1]).find((name) => !/review/i.test(name));

  return {
    id: post.id,
    date: post.date,
    number: number ? number[1] : null,
    type: detectType(tags, title),
    title: cleanTitle(title),
    complex: detectComplex(post.text),
    address: cleanAddress(addressLine),
    area: area ? Number(area[1].replace(',', '.')) : null,
    floor: floor ? Number(floor[1]) : null,
    heating: heating ? heating.replace(/^[^\p{L}]+/u, '') : null,
    price: Number(price[1].replace(/[\s.,]/g, '')),
    currency: /\$|usd|долл/i.test(price[2]) ? 'USD' : 'GEL',
    realtor: realtor || null,
    photos: post.photos,
  };
}

// studio — студия, 1…4 — число спален
function detectType(tags, title) {
  if (tags.includes('студия') || /студи/i.test(title)) return 'studio';
  const fromTag = tags.map((tag) => tag.match(/^(\d)\s*спальн/)).find(Boolean);
  const fromTitle = title.match(/(\d)\s*спальн/i);
  const bedrooms = fromTag ? fromTag[1] : fromTitle ? fromTitle[1] : null;
  return bedrooms ? String(Math.min(Number(bedrooms), 4)) : null;
}

// Жилой комплекс в канале отмечают хештегом латиницей: #DarTower → «Dar Tower»
function detectComplex(text) {
  const tag = text.match(/#([A-Za-z][A-Za-z0-9]+)/);
  if (!tag) return null;
  return tag[1].replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
}

// «…в #DarTower на Аллее Героев🔝» → «…в DarTower на Аллее Героев»
function cleanTitle(line) {
  return line.replace(/#/g, '').replace(/[^\p{L}\p{N})!?»"]+$/u, '').replace(/\s+/g, ' ').trim();
}

function cleanAddress(line) {
  return line.replace(/^[^\p{L}\p{N}]+/u, '').replace(/\s+/g, ' ').trim();
}

// ——— Координаты ———

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function nominatim(query) {
  const url =
    'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=ru&bounded=1' +
    `&viewbox=${VIEWBOX.join(',')}&q=${encodeURIComponent(query)}`;
  const results = JSON.parse(await fetchText(url));
  await sleep(1100); // правило сервиса: не больше одного запроса в секунду
  if (!results[0]) return null;
  // category «highway» — нашлась улица, а не дом
  return { lat: Number(results[0].lat), lng: Number(results[0].lon), isStreet: results[0].category === 'highway' };
}

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'p', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sh',
  ъ: '', ы: 'i', ь: '', э: 'e', ю: 'iu', я: 'ia',
};

// Названия улиц в канале русские, а на карте часть улиц подписана только латиницей
function transliterate(text) {
  return text
    .toLowerCase()
    .replace(/дж/g, 'j')
    .replace(/[а-яё]/g, (letter) => TRANSLIT[letter]);
}

// Ищем дом; если его нет на карте — улицу (такая точка помечается как приблизительная).
// Улицу пробуем по полному названию, по фамилии и в латинской записи.
async function geocode(address) {
  const full = address
    .replace(/\(.*?\)/g, ' ')
    .replace(/(^|\s)(ул\.?|улица|пр\.?|проспект)(?=\s)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const house = full.match(/[,\s]+(\d+\s*[а-яa-z]?(?:\s*[/-]\s*\d+\s*[а-яa-z]?)?)\s*$/i);
  const street = house ? full.slice(0, house.index).trim() : full;
  const surname = street.split(' ').pop();
  const names = [...new Set([street, surname])];
  const queries = [
    ...names.map((name) => [name, 'Батуми']),
    ...names.map((name) => [transliterate(name), 'Batumi']),
  ];

  if (house) {
    for (const [name, city] of queries) {
      const hit = await nominatim(`${name} ${house[1]}, ${city}`);
      if (hit) return { lat: hit.lat, lng: hit.lng, approx: hit.isStreet };
    }
  }
  for (const [name, city] of queries) {
    const hit = await nominatim(`${name}, ${city}`);
    if (hit) return { lat: hit.lat, lng: hit.lng, approx: Boolean(house) || hit.isStreet };
  }
  return null;
}

async function addCoordinates(listings) {
  const cache = loadJson(GEOCACHE_FILE, {});
  const pending = [...new Set(listings.map((l) => l.address))].filter((address) => !(address in cache));
  console.log(`Адресов для поиска: ${pending.length} (в кэше ${Object.keys(cache).length})`);

  for (const [i, address] of pending.entries()) {
    try {
      cache[address] = await geocode(address);
    } catch (error) {
      console.warn(`  не удалось найти «${address}»: ${error.message}`);
      continue; // в кэш не пишем — попробуем в следующий запуск
    }
    if ((i + 1) % 20 === 0) {
      console.log(`  найдено ${i + 1} из ${pending.length}`);
      fs.writeFileSync(GEOCACHE_FILE, JSON.stringify(cache, null, 1));
    }
  }
  fs.writeFileSync(GEOCACHE_FILE, JSON.stringify(cache, null, 1));

  for (const listing of listings) {
    const point = cache[listing.address];
    if (point) Object.assign(listing, { lat: point.lat, lng: point.lng, approx: point.approx });
  }
}

// ——— Запуск ———

async function main() {
  console.log(`Читаю @${CHANNEL} за ${DAYS} дн.`);
  const posts = await readChannel();
  const listings = posts.map(parseListing).filter(Boolean);
  console.log(`Постов: ${posts.length}, объявлений: ${listings.length}`);

  if (GEOCODE) await addCoordinates(listings);

  const onMap = listings.filter((l) => l.lat).length;
  console.log(`На карте: ${onMap} из ${listings.length} (точно: ${listings.filter((l) => l.lat && !l.approx).length})`);

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    LISTINGS_FILE,
    JSON.stringify({ channel: CHANNEL, updated: new Date().toISOString(), listings }, null, 1)
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
