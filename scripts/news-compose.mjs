// Подача по новостным зацепкам: какой ролик снять команде по сюжету, в каком
// формате, с какой первой фразы, и чем поискать точнее в следующий прогон.
//
//   node scripts/news-compose.mjs            записать подачу в site/data/news.json
//   node scripts/news-compose.mjs --dry-run  напечатать ответ модели, ничего не писать
//
// Ключ тот же, что у compose.mjs: OPENROUTER_API_KEY или ANTHROPIC_API_KEY.
// Без ключа шаг завершается, зацепки остаются без подачи. Модель зовётся
// только для сюжетов без подачи (новых или сменивших вердикт), не чаще одного
// вызова за прогон.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(ROOT, 'signals.config.json');
const NEWS_PATH = path.join(ROOT, 'site', 'data', 'news.json');
const DRY_RUN = process.argv.includes('--dry-run');
const MAX_PER_RUN = 6;

const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
const data = JSON.parse(await readFile(NEWS_PATH, 'utf8').catch(() => '{"stories":[]}'));
const language = config.language || 'ru';
const modelOR = config.model || 'anthropic/claude-sonnet-5';
const modelAnthropic = modelOR.replace(/^anthropic\//, '');
const audience = String(config.audience || '').trim();
const product = String(config.product || '').trim();

const queue = (data.stories || []).filter((s) => s.verdict && !s.pitch).slice(0, MAX_PER_RUN);
if (!queue.length) {
  console.log('новых зацепок без подачи нет');
  process.exit(0);
}

const SYSTEM = `Ты помогаешь команде, которая делает короткие ролики и посты по теме «${config.theme}».
${audience ? `Аудитория: ${audience}.\n` : ''}${product ? `Продукт команды: ${product}.\n` : ''}
По каждой новости ты видишь, что по ней уже вышло на YouTube и у авторов, за которыми следит команда: названия, просмотры, возраст.
Вердикт: gap – никто не снял, early – снимают, но мало смотрят, covered – уже залетает.
Пиши на языке: ${language}. Коротко, без эмодзи, без фактов, которых нет в данных. Ты не видишь сами ролики, только названия и числа.
Коды вердикта (gap, early, covered) в тексте не пиши – говори словами: «никто не снял», «снимают, но мало смотрят», «уже залетает».

Верни ТОЛЬКО валидный JSON без markdown:
{"items": [{"id": "<id сюжета>",
  "pitch": "одна фраза: какой ролик снять команде по этой новости и под каким углом для аудитории",
  "format": "reels/shorts 30-45 с | карусель | разбор 6-10 мин",
  "hook": "первая фраза ролика, до 12 слов",
  "why_now": "одна фраза: почему сейчас, опираясь на вердикт и числа",
  "queries": ["2-3 поисковые фразы на английском, по которым искать ролики об этой новости точнее"]}]}`;

const facts = (s) => [
  `id: ${s.id}`,
  `новость: ${s.title}`,
  `изданий: ${s.story_sources}, опубликовано: ${s.published_ts} UTC`,
  `вердикт: ${s.verdict.code}`,
  (s.videos || []).length
    ? `ролики:\n${s.videos.map((v) => `- ${v.kind}, ${v.views ?? '?'} просмотров${v.age_hours != null ? `, ${Math.round(v.age_hours)} ч назад` : ''}: ${v.title}`).join('\n')}`
    : 'ролики: нет',
].join('\n');

const user = `разбери ${queue.length} новостей, ровно ${queue.length} элементов в items:\n\n${queue.map(facts).join('\n\n')}`;

function parseJson(text) {
  const t = String(text || '');
  const json = (t.match(/```(?:json)?\s*([\s\S]*?)```/i) || [])[1] || t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1);
  return JSON.parse(json);
}

// Тот же вызов модели, что в compose.mjs. Общий модуль – следующий шаг.
async function ask() {
  const or = process.env.OPENROUTER_API_KEY;
  const an = process.env.ANTHROPIC_API_KEY;
  if (an) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': an, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: modelAnthropic, max_tokens: 3000, temperature: 0.5, system: SYSTEM, messages: [{ role: 'user', content: user }] }),
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error?.message || `Anthropic HTTP ${res.status}`);
    return parseJson(payload.content?.map((c) => c.text).join(''));
  }
  if (or) {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${or}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelOR,
        max_tokens: 3000,
        temperature: 0.5,
        reasoning: { enabled: false },
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
      }),
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error?.message || `OpenRouter HTTP ${res.status}`);
    return parseJson(payload.choices?.[0]?.message?.content);
  }
  console.error('нет ни OPENROUTER_API_KEY, ни ANTHROPIC_API_KEY: подача пропущена, зацепки работают без неё');
  process.exit(0);
}

const clean = (text) => String(text || '').replace(/—/g, '–').trim();
const result = await ask();
if (DRY_RUN) {
  console.log(JSON.stringify(result, null, 1));
  process.exit(0);
}

const byId = new Map(queue.map((s) => [String(s.id), s]));
let done = 0;
for (const item of result.items || []) {
  const story = byId.get(String(item.id));
  if (!story || !item.pitch) continue;
  story.pitch = {
    text: clean(item.pitch),
    format: clean(item.format),
    hook: clean(item.hook),
    why_now: clean(item.why_now),
    verdict: story.verdict.code,
  };
  // Запросы модели news.mjs возьмёт в следующий прогон поиска.
  if (Array.isArray(item.queries)) story.queries_llm = item.queries.map(clean).filter(Boolean).slice(0, 3);
  done += 1;
}
await writeFile(NEWS_PATH, `${JSON.stringify(data, null, 1)}\n`);
console.log(`подача: ${done} из ${queue.length}`);
