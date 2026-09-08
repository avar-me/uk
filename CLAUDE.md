# Инструкции для AI-ассистентов в этом репозитории

Этот файл — общая инструкция для Claude, Copilot, Cursor и других. Если вы агент — прочитайте до начала любых изменений.

## Что это за репозиторий

`dev.avar.me` — статический сайт аварско-русского словаря. Публикуется на GitHub Pages из этого репозитория. Домен — `CNAME`.

**Данные здесь не хранятся.** При сборке `build.sh` выкачивает jsonl из sources.avar.me по именам из профиля (`av-ru` / `ru-av` здесь, в клонах — `av-en`, `av-tr`, …). Источник правды — репозиторий [`avar-me/sources`](https://github.com/avar-me/sources). Не коммитьте сюда jsonl, не правьте словарь в этом репозитории.

## Главное правило

1. **В репо только исходники.** Шаблоны (`src/templates/`), профили (`src/profiles/`, `profile.json`), скрипты сборки (`src/build_data.py`, `src/apply_profile.py`, `build.sh`), workflow (`.github/workflows/deploy.yml`), `CNAME`, документация. **Ни единого артефакта сборки, ни единого jsonl.** Если хочется добавить файл — спросите себя, не выкинут ли его при следующем «причешем репо».
2. **`docs/` — gitignored.** Это выход `build.sh`. Никогда не коммитьте, никогда не правьте руками.
3. **`*.jsonl` — gitignored.** Скачиваются в корень при сборке, в репо не лежат.
4. **Правки данных** — не сюда, а в [`avar-me/sources`](https://github.com/avar-me/sources). После их пересборки workflow тут возьмет свежие данные при следующем запуске (раз в сутки по cron или `workflow_dispatch`).
5. **Внешний вид строго как сейчас.** Шаблоны переехали из старого репозитория `dev3.avar.me` без изменений; дизайн, разметка, цвета, шрифты, поведение — те же. Любые UI-правки делайте только по явному запросу пользователя.

## Поток работы

```
profile.json (id=ru|en|tr|…)
            │
            ▼
sources.avar.me/data/{av-xx,xx-av}.jsonl
            │
            ▼
        build.sh ──► src/build_data.py ──► docs/data/{av-xx,xx-av}/…
            │                            ──► docs/tma/data/…
            └─► копирует шаблоны, apply_profile.py пишет theme.css
                и подставляет подписи / __ASSET_VERSION__
                            │
                            ▼
                  GitHub Actions ──► GitHub Pages
```

Этот репозиторий — шаблон. Клон для другого языка: скопировать репо, в `profile.json` поставить `id` (`en`, `tr`, `fr`, `de`, `uk`, `be`) и `host`, в `CNAME` — домен. Цвета флага и имена словарей (`av-en` / `en-av`, …) берутся из `src/profiles/{id}.json`. Новый язык — новый файл в `src/profiles/`.

1. Пользователь сообщает об ошибке в данных в чате [@avarme_chat](https://t.me/avarme_chat).
2. Админ правит `data/av-ru.jsonl` в `avar-me/sources` и пушит.
3. GitHub Actions в `avar-me/sources` пересобирает sources.avar.me.
4. Раз в сутки (или вручную через `workflow_dispatch`) Actions здесь пересобирает dev.avar.me, скачивая свежий jsonl.

## Аварская графика

Аварский — на кириллице с диграфами: **тӏ, лъ, гь, гъ, гӏ, кь, къ, кӏ, хь, хъ, хӏ, цӏ, чӏ**.

Палочка может приходить разными глифами (`I`, `l`, `|`, `Ӏ`, `ӏ`, `1`, `!`). Нормализуется в каноническую U+04CF (`ӏ`) — см. `normalize_word()` в `src/build_data.py` и `normalizeWord()` в `src/templates/html/app.js`. Эти две функции должны оставаться согласованными — иначе ключи чанков перестанут сходиться с тем, что ищет фронтенд.

## Что менять, а что нет

| Хочется поменять | Куда лезть |
|------------------|-----------|
| Опечатка / перевод / пример | НЕ сюда. В `avar-me/sources`, `data/av-*.jsonl`. |
| Язык клона / цвета / имена словарей | `profile.json` + `src/profiles/{id}.json`. |
| Внешний вид (общее) | `src/templates/html/styles.css` (или `tma/styles.css`). |
| Поиск / саджесты / рандомайзер | `src/templates/html/app.js`. |
| Логика разбиения данных на чанки | `src/build_data.py`. |
| Доменное имя | `CNAME` и поле `host` в `profile.json`. |
| Деплой / cron расписание | `.github/workflows/deploy.yml`. |

## Стиль кода

- Сайт — статический. Ни SSR, ни сборщиков, ни npm. Шрифты — Google Fonts (Onest UI + Literata serif).
- Никаких эмодзи в шаблонах и текстах. Кроме SVG `☀` в favicon — он часть бренда avar.me.
- Дизайн — в линию с [index.avar.me](https://index.avar.me) и [sources.avar.me](https://sources.avar.me): мягкий кремовый фон, акцент `--accent: #9a7b1a`.

## Когда сомневаетесь

Спросите перед тем как:

- Добавлять любой новый файл / каталог / зависимость в корень.
- Менять верстку или поведение фронтенда.
- Трогать структуру чанков или формат `manifest.json` (есть фронтенд-кеш в `localStorage`, завязанный на `build_id`).
- Переименовывать пути в `docs/data/` — на них опирается `app.js`.

## Полезные ссылки

- Канал координации: [@avarlangme](https://t.me/avarlangme)
- Чат правок: [@avarme_chat](https://t.me/avarme_chat)
- Главный сайт проекта: [avar.me](https://avar.me)
- Источник данных: [sources.avar.me](https://sources.avar.me) ([репо](https://github.com/avar-me/sources))
- Этот репозиторий: <https://github.com/avar-me/dev>
