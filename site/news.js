// Вкладка «новости»: жирные новости темы и что по ним уже снимают.
// Читает data/news.json (scripts/news.mjs), ничего не пишет и никуда не ходит.

const el = (id) => document.getElementById(id);
const esc = (text) => String(text ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const fmt = (v) => (v == null ? '?' : v >= 1e6 ? `${(v / 1e6).toFixed(1)} млн` : v >= 1000 ? `${Math.round(v / 1000)} тыс` : String(v));
const hoursAgo = (ts) => Math.max(0, Math.round((Date.now() - new Date(String(ts).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? '' : 'Z')).getTime()) / 3_600_000));
const age = (h) => (h == null ? '' : h < 1 ? 'меньше часа' : h < 48 ? `${Math.round(h)} ч` : `${Math.round(h / 24)} дн`);

const VERDICT = {
  gap: { tag: 'окно', cls: 'is-gap' },
  early: { tag: 'рано', cls: 'is-early' },
  covered: { tag: 'залетает', cls: 'is-covered' },
};

function video(v) {
  const meta = [v.kind, `${fmt(v.views)} просм.`, v.age_hours != null ? age(v.age_hours) : '', v.channel].filter(Boolean).join(' · ');
  return `<li><a href="${esc(v.url)}" target="_blank" rel="noreferrer noopener">${esc(v.title || v.url)}</a><span class="meta">${esc(meta)}</span></li>`;
}

function story(s) {
  const verdict = VERDICT[s.verdict?.code] || { tag: 'не искали', cls: '' };
  const pitch = s.pitch
    ? `<div class="pitch"><p><b>снять:</b> ${esc(s.pitch.text)}</p>${s.pitch.hook ? `<p><b>первая фраза:</b> «${esc(s.pitch.hook)}»</p>` : ''}<p class="meta">${esc([s.pitch.format, s.pitch.why_now].filter(Boolean).join(' · '))}</p></div>`
    : s.verdict ? `<p class="meta">${esc(s.verdict.text)}</p>` : '';
  const videos = (s.videos || []).length ? `<ul class="videos">${s.videos.map(video).join('')}</ul>` : '';
  return `
    <article class="story">
      <div class="row"><span class="tag ${verdict.cls}">${verdict.tag}</span><span class="tag">${s.story_sources} изд.</span><span>${hoursAgo(s.published_ts)} ч назад</span></div>
      <h3><a href="${esc(s.url)}" target="_blank" rel="noreferrer noopener">${esc(s.title)}</a></h3>
      ${pitch}
      ${videos}
    </article>`;
}

async function boot() {
  const box = el('news');
  if (!box) return;
  const data = await fetch('./data/news.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!data || !(data.stories || []).length) {
    box.innerHTML = '<p class="empty">зацепок пока нет: включите news в signals.config.json и запустите Actions → news</p>';
    return;
  }
  const order = { gap: 0, early: 1, covered: 2 };
  const stories = [...data.stories].sort((a, b) => (order[a.verdict?.code] ?? 3) - (order[b.verdict?.code] ?? 3) || (b.score_norm || 0) - (a.score_norm || 0));
  box.innerHTML = stories.map(story).join('');
}

boot();
