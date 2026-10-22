# сигналы – свой радар трендов

<!-- aim-public-links:start -->
[Лабы AI Mindset](https://aimindset.org/?utm_source=website&utm_medium=article&utm_campaign=start&utm_content=github-signals-board#learning) · [База знаний](https://base.aimindset.org/?utm_source=website&utm_medium=article&utm_campaign=start&utm_content=github-signals-board)
<!-- aim-public-links:end -->

Каждый день собирает самые популярные ролики TikTok и YouTube у авторов в вашей теме и показывает их на сайте: плиткой или радаром, с коротким разбором – почему залетело и как сделать такой же приём у себя.

- **TikTok и YouTube** читаются без ключей.
- **Разбор** пишет модель: нужен один ключ OpenRouter или Anthropic, около $0.6 в месяц. Без ключа борд работает, просто без разборов.
- **Сайт** живёт на GitHub Pages в вашем аккаунте, бесплатно.
- **Новостные зацепки** (по желанию): жирные новости темы из [ClawDigest](https://clawdigest.live), что по ним уже сняли и где окно снять своё – [docs/news-hooks.md](docs/news-hooks.md).

## Как забрать за 10 минут

1. Откройте страницу настройки [ai-mindset-org.github.io/signals-board/setup.html](https://ai-mindset-org.github.io/signals-board/setup.html?utm_source=website&utm_medium=article&utm_campaign=start&utm_content=github-signals-board) (пример борда – [ai-mindset-org.github.io/signals-board](https://ai-mindset-org.github.io/signals-board/?utm_source=website&utm_medium=article&utm_campaign=start&utm_content=github-signals-board)), впишите тему.
2. Скопируйте задание и отдайте его своему агенту – Claude Code, Codex или Cursor.
3. Агент сделает остальное по [AGENTS.md](AGENTS.md): создаст репозиторий, сам подберёт и проверит авторов по теме, попросит положить ключ в секреты, включит сайт и пришлёт адрес.

## Руками

```bash
node scripts/collect.mjs --probe tiktok:handle,youtube:handle   # проверить авторов
node scripts/collect.mjs                                        # собрать
OPENROUTER_API_KEY=… node scripts/compose.mjs                   # разбор моделью
node scripts/check.mjs                                          # проверить данные
npx serve site                                                  # посмотреть сайт локально
```

Нужен Node.js 20+. Зависимостей нет.
