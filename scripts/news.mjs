// Новостные зацепки: жирные новости темы из ClawDigest → что по ним уже снимают
// на YouTube и у авторов борда → где окно снять своё.
//
//   node scripts/news.mjs                       обновить site/data/news.json
//   node scripts/news.mjs --dry-run             собрать и напечатать, ничего не писать
//   node scripts/news.mjs --story "заголовок"   прогнать поиск по одному заголовку
//
// Новости: ClawDigest, сюжеты, о которых написали несколько изданий
// (/api/v2/trending с CLAWDIGEST_API_KEY или публичный /api/trending без ключа).
// YouTube: страница поиска, ключ не нужен. TikTok: поиска без ключа нет –
// страница поиска рендерится в браузере подписанными запросами. Вместо него
// берутся ролики авторов борда (site/data/signals.json), совпавшие с новостью
// по словам; платный поиск подключается в searchTiktok(). Настройки – блок
// news в signals.config.json.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(ROOT, 'signals.config.json');
const SIGNALS_PATH = path.join(ROOT, 'site', 'data', 'signals.json');
const NEWS_PATH = path.join(ROOT, 'site', 'data', 'news.json');

const UA = 'signals-board/1.0 (news hooks)';
const DRY_RUN = process.argv.includes('--dry-run');
const GAP_MS = 1500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOUR = 3_600_000;

const DEFAULTS = {
  enabled: false,
  category: 'ai', // категория ClawDigest: ai, security, devops, web, crypto, general
  region: '', // us, eu, china, …; пусто – все
  hours: 24, // окно новостей
  min_sources: 2, // «жирная» новость: о ней написали хотя бы столько изданий
  max_new_per_run: 4, // сколько сюжетов искать за прогон (каждый – запрос к YouTube)
  refresh_hours: 6, // через сколько часов перепроверять уже найденный сюжет
  keep_hours: 72, // сколько держать сюжет на борде
  search_window_hours: 72, // ролики старше этого к новости не относятся
  min_relevance: 0.5, // доля общих слов от более короткого из двух текстов
  big_views: 10_000, // столько просмотров у лучшего ролика – тема уже залетает
};

// ——— слова ———————————————————————————————————————————————————
const STOP = new Set(('the a an and or but to of in on for with without from by as is are was were be been this that these those it its '
  + 'at into over under about after before via new now says say will has have had how why what when who you your just than more '
  + 'и в во на с со к ко по о об от до за из у для что как это его её их не но а ли же бы то так уже ещё').split(' '));

function tokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[’']s\b/g, '')
    .split(/[^\p{L}\p{N}.+#-]+/u)
    .map((t) => t.replace(/^[.+#-]+|[.+#-]+$/g, ''))
    .filter((t) => t.length >= 2 && !STOP.has(t));
}

// Слова, которые есть почти в каждом ролике темы: совпадение по ним одному
// ничего не значит.
const GENERIC = new Set(['ai', 'ии', 'new', 'agent', 'agents', 'model', 'models', 'update', 'news', 'tool', 'tools', 'app']);

// Имена, модели и числа из заголовка: слова с заглавной буквы или цифрой.
function strongTokens(title) {
  return [...new Set(String(title).split(/\s+/)
    .filter((w) => /^[A-ZА-ЯЁ0-9]/.test(w) || /\d/.test(w))
    .flatMap((w) => tokens(w))
    .filter((t) => !GENERIC.has(t)))];
}

// Похожесть ролика на новость: доля общих слов от более короткого текста
// (у официального «Introducing Claude Duet» три слова, у новости восемь).
// Ролик засчитывается, только если общих слов хотя бы два и среди них есть
// имя собственное: «AI agent» без Claude и Duet – не про эту новость.
function relevance(story, title) {
  const have = new Set(tokens(title));
  const common = story.tokens.filter((t) => have.has(t));
  if (common.length < 2 || !story.strong.some((t) => have.has(t))) return 0;
  return common.length / Math.min(story.tokens.length, have.size);
}

function storyTerms(title) {
  return { tokens: [...new Set(tokens(title))], strong: strongTokens(title) };
}

// Поисковый запрос из заголовка: имена, модели и числа важнее общих слов.
// Модель в news-compose.mjs может дописать свои запросы (story.queries_llm).
function queryOf(title) {
  // Имена первыми; если их меньше двух, запрос добивается словами заголовка,
  // иначе «walmart» в одиночку приносит ролики про скидки.
  return [...new Set([...strongTokens(title), ...tokens(title)])].slice(0, 4).join(' ');
}

// Самая длинная цепочка слов с заглавной подряд – обычно название продукта
// или модели («Claude Duet», «Gemini 3 Pro»). Второй запрос к поиску.
function entityQuery(title) {
  let best = [];
  let run = [];
  for (const word of String(title).split(/\s+/)) {
    const clean = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (clean && (/^[A-ZА-ЯЁ0-9]/.test(clean)) && !GENERIC.has(clean.toLowerCase())) {
      run.push(clean);
      if (run.length > best.length) best = [...run];
    } else {
      run = [];
    }
    if (/[,:;!?]$/.test(word)) run = [];
  }
  return best.length >= 2 ? best.join(' ') : '';
}

// ——— clawdigest ——————————————————————————————————————————————
async function fetchStories(news) {
  const base = String(process.env.CLAWDIGEST_API_BASE_URL || 'https://clawdigest.live').replace(/\/$/, '');
  const key = process.env.CLAWDIGEST_API_KEY;
  const params = new URLSearchParams({ hours: String(news.hours), limit: '20' });
  if (news.category) params.set('category', news.category);
  if (news.region) params.set('region', news.region);
  const endpoint = `${base}${key ? '/api/v2/trending' : '/api/trending'}?${params}`;
  const res = await fetch(endpoint, {
    headers: { 'User-Agent': UA, ...(key ? { 'X-API-Key': key } : {}) },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`ClawDigest HTTP ${res.status}`);
  const payload = await res.json();
  return { endpoint: endpoint.replace(base, ''), items: Array.isArray(payload.items) ? payload.items : [] };
}

// ——— youtube ———————————————————————————————————————————————————
const AGE_HOURS = { second: 1 / 3600, sec: 1 / 3600, s: 1 / 3600, minute: 1 / 60, min: 1 / 60, m: 1 / 60, hour: 1, h: 1, day: 24, d: 24, week: 168, w: 168, month: 720, mo: 720, year: 8760, y: 8760 };
function ageHours(text) {
  const m = String(text || '').toLowerCase().match(/(\d+)\s*(second|sec|minute|min|hour|day|week|month|year|mo|[smhdwy])/);
  return m ? Number(m[1]) * (AGE_HOURS[m[2]] ?? 1) : null;
}
function viewsOf(text) {
  const t = String(text || '').toLowerCase().replace(/,/g, '');
  const m = t.match(/([\d.]+)\s*(k|m|b|thousand|million|billion)?\s*views?/);
  if (!m) return /no views/.test(t) ? 0 : null;
  const scale = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, billion: 1e9 }[m[2]] || 1;
  return Math.round(Number(m[1]) * scale);
}

// Результаты поиска за неделю: обычные ролики (videoRenderer) и Shorts
// (shortsLockupViewModel). У Shorts в выдаче нет возраста – только просмотры.
async function searchYoutube(query) {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIIAw%253D%253D`;
  // Изредка YouTube отдаёт страницу без данных (согласие, лимит) – один повтор.
  let raw = null;
  let status = 0;
  for (let attempt = 0; attempt < 2 && !raw; attempt += 1) {
    if (attempt) await sleep(4000);
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' }, signal: AbortSignal.timeout(25_000) });
    status = res.status;
    if (!res.ok) continue;
    raw = ((await res.text()).match(/(?:var ytInitialData|window\["ytInitialData"\])\s*=\s*(\{[\s\S]*?\});\s*<\/script>/) || [])[1] || null;
  }
  if (!raw) throw new Error(status && status !== 200 ? `YouTube HTTP ${status}` : 'на странице поиска нет ytInitialData');
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.videoRenderer?.videoId) {
      const v = node.videoRenderer;
      out.push({
        platform: 'youtube',
        kind: 'видео',
        id: `youtube:${v.videoId}`,
        url: `https://www.youtube.com/watch?v=${v.videoId}`,
        title: (v.title?.runs || []).map((r) => r.text).join('').slice(0, 200),
        channel: v.ownerText?.runs?.[0]?.text || '',
        views: viewsOf(v.viewCountText?.simpleText || v.viewCountText?.runs?.map((r) => r.text).join('')),
        age_hours: ageHours(v.publishedTimeText?.simpleText),
      });
    } else if (node.shortsLockupViewModel) {
      const s = node.shortsLockupViewModel;
      const id = s.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId;
      if (id) {
        out.push({
          platform: 'youtube',
          kind: 'shorts',
          id: `youtube:${id}`,
          url: `https://www.youtube.com/shorts/${id}`,
          title: String(s.overlayMetadata?.primaryText?.content || s.accessibilityText || '').slice(0, 200),
          channel: '',
          views: viewsOf(s.overlayMetadata?.secondaryText?.content || s.accessibilityText),
          age_hours: null,
        });
      }
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(JSON.parse(raw));
  return out;
}

// ——— tiktok ——————————————————————————————————————————————————
// Поиска TikTok без ключа нет. Сюда подключается платный провайдер (Apify,
// RapidAPI и т. п.): вернуть ролики в том же виде, что searchYoutube().
// Ключ провайдера – секретом репозитория, как OPENROUTER_API_KEY.
async function searchTiktok(_query) {
  return [];
}

// Ролики авторов борда, которые уже говорят о новости.
function boardMatches(terms, signals, news) {
  return (signals || [])
    .map((post) => ({
      platform: post.platform,
      kind: 'с борда',
      id: post.id,
      url: post.url,
      title: post.title,
      channel: post.source,
      views: post.popularity,
      age_hours: post.posted_at ? (Date.now() - new Date(post.posted_at).getTime()) / HOUR : null,
      relevance: relevance(terms, `${post.title} ${post.about || ''}`),
    }))
    .filter((v) => v.relevance >= news.min_relevance);
}

// ——— сюжет ———————————————————————————————————————————————————
function verdictOf(videos, news) {
  if (!videos.length) return { code: 'gap', text: 'никто ещё не снял – окно снять первыми' };
  const best = Math.max(...videos.map((v) => v.views || 0));
  if (best < news.big_views) return { code: 'early', text: 'снимают, но мало смотрят – успеваем со своей подачей' };
  return { code: 'covered', text: 'уже залетает – смотреть подачу и делать свой угол' };
}

async function searchStory(story, signals, news, report) {
  const terms = storyTerms(story.title);
  const queries = [...new Set([entityQuery(story.title), queryOf(story.title), ...(story.queries_llm || [])].filter(Boolean))].slice(0, 2);
  const found = new Map();
  for (const query of queries) {
    for (const [name, search] of [['youtube', searchYoutube], ['tiktok', searchTiktok]]) {
      try {
        for (const v of await search(query)) {
          const rel = relevance(terms, v.title);
          if (rel < news.min_relevance) continue;
          if (v.age_hours !== null && v.age_hours > news.search_window_hours) continue;
          if (!found.has(v.id)) found.set(v.id, { ...v, relevance: Number(rel.toFixed(2)) });
        }
        report.push({ source: `${name}: ${query}`, ok: true });
      } catch (error) {
        report.push({ source: `${name}: ${query}`, ok: false, error: String(error.message || error) });
      }
      await sleep(GAP_MS);
    }
  }
  for (const v of boardMatches(terms, signals, news)) if (!found.has(v.id)) found.set(v.id, { ...v, relevance: Number(v.relevance.toFixed(2)) });

  // Скорость = просмотры в час: свежий ролик с 20 тыс. за 5 часов важнее
  // недельного со 100 тыс. У Shorts в выдаче нет возраста: поиск идёт за
  // неделю, поэтому для сортировки берётся середина окна (velocity = null).
  const pace = (v) => v.velocity ?? (v.views || 0) / Math.max(1, Math.min(news.search_window_hours, 168) / 2);
  const videos = [...found.values()]
    .map((v) => ({ ...v, velocity: v.views && v.age_hours ? Math.round(v.views / Math.max(1, v.age_hours)) : null }))
    .sort((a, b) => pace(b) - pace(a))
    .slice(0, 6);
  return { queries, videos, verdict: verdictOf(videos, news) };
}

// Один и тот же сюжет ClawDigest может сменить ведущую запись, когда о нём
// пишут новые издания, поэтому сюжет узнаётся по любому общему id.
function storyIds(item) {
  return [item.id, ...(item.related || []).map((r) => r.id)].filter(Boolean).map(String);
}

// ——— прогон ——————————————————————————————————————————————————
async function main() {
  const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  const news = { ...DEFAULTS, ...(config.news || {}) };
  const signals = JSON.parse(await readFile(SIGNALS_PATH, 'utf8').catch(() => '{"signals":[]}')).signals || [];

  const storyAt = process.argv.indexOf('--story');
  if (storyAt !== -1) {
    const title = process.argv[storyAt + 1] || '';
    console.log(JSON.stringify(await searchStory({ title }, signals, news, []), null, 1));
    return;
  }
  if (!news.enabled) {
    console.log('news.enabled = false в signals.config.json: зацепки выключены');
    return;
  }

  let library = { stories: [] };
  try {
    library = JSON.parse(await readFile(NEWS_PATH, 'utf8'));
  } catch {
    // первый прогон
  }
  // Прогон идёт каждые 15 минут; файл переписывается, только если изменились
  // сами сюжеты, иначе каждый прогон давал бы пустой коммит.
  const before = JSON.stringify(library.stories || []);
  const now = Date.now();
  const { endpoint, items } = await fetchStories(news);
  const strong = items
    .filter((it) => Number(it.story_sources || 1) >= news.min_sources)
    .sort((a, b) => (b.score_norm || 0) - (a.score_norm || 0));

  const stories = (library.stories || []).filter((s) => now - new Date(s.published_ts.replace(' ', 'T') + 'Z').getTime() < news.keep_hours * HOUR);
  const report = [];
  let searched = 0;
  for (const item of strong) {
    const ids = storyIds(item);
    let story = stories.find((s) => s.ids.some((id) => ids.includes(id)));
    if (!story) {
      story = { first_seen: new Date(now).toISOString() };
      stories.push(story);
    }
    Object.assign(story, {
      id: story.id || String(item.id),
      ids: [...new Set([...(story.ids || []), ...ids])],
      title: item.title,
      url: item.url,
      source_id: item.source_id,
      published_ts: item.published_ts || item.created_at,
      story_sources: item.story_sources || 1,
      score_norm: item.score_norm ?? null,
      related_news: (item.related || []).slice(0, 4).map((r) => ({ source_id: r.source_id, title: r.title, url: r.url })),
    });
    const stale = !story.searched_at || now - new Date(story.searched_at).getTime() > news.refresh_hours * HOUR;
    if (!stale || searched >= news.max_new_per_run) continue;
    const verdictBefore = story.verdict?.code;
    Object.assign(story, await searchStory(story, signals, news, report), { searched_at: new Date().toISOString() });
    // Подача пересобирается моделью, только когда сменился вердикт.
    if (verdictBefore && verdictBefore !== story.verdict.code) delete story.pitch;
    searched += 1;
  }

  const output = {
    generated_at: new Date(now).toISOString(),
    source: { name: 'clawdigest', endpoint, category: news.category, hours: news.hours, min_sources: news.min_sources },
    search_report: report,
    stories: stories.sort((a, b) => (b.score_norm || 0) - (a.score_norm || 0) || b.first_seen.localeCompare(a.first_seen)),
  };
  if (DRY_RUN) {
    console.log(JSON.stringify(output, null, 1));
    return;
  }
  if (JSON.stringify(output.stories) === before) {
    console.log(`без изменений: новостей ${items.length}, жирных ${strong.length}, на борде ${output.stories.length}`);
    return;
  }
  await mkdir(path.dirname(NEWS_PATH), { recursive: true });
  await writeFile(NEWS_PATH, `${JSON.stringify(output, null, 1)}\n`);
  const byVerdict = output.stories.reduce((acc, s) => ({ ...acc, [s.verdict?.code || 'не искали']: (acc[s.verdict?.code || 'не искали'] || 0) + 1 }), {});
  console.log(`новостей ${items.length}, жирных ${strong.length}, искали ${searched}, на борде ${output.stories.length}: ${JSON.stringify(byVerdict)}`);
  for (const row of report.filter((r) => !r.ok)) console.log(`  молчит ${row.source}: ${row.error}`);
}

await main();
