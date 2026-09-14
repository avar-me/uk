#!/usr/bin/env python3
"""Профиль сайта: цвета, имена словарей, подписи.

Клон репозитория меняет только profile.json (id + host) и CNAME.
Каталог тем — src/profiles/{id}.json.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
PROFILES_DIR = Path(__file__).resolve().parent / "profiles"

# Мелкие UI-указатели в app.js/tma/app.js ("Формы:", "См. также:", …),
# инжектятся в window.__SITE__.ui — см. site_payload().
UI_STRINGS: dict[str, dict[str, object]] = {
    "ru": {
        "forms": "Формы",
        "byGender": "По родам",
        "seeAlso": "См. также",
        "exclamation": "Восклицательная форма",
        "genderHints": ["м. р.", "ж. р.", "ср. р."],
        "searchPlaceholder": "Введите слово для поиска…",
        "clear": "Очистить",
        "loading": "Загрузка…",
        "phrasesLink": "Поиск по фразам →",
        "phrasesTitle": "Поиск по фразам",
        "phrasesDesc": "Поиск по фразам и примерам",
        "phrasesSubtitle": "Ищет текст внутри примеров и переводов — не только заглавные слова",
        "phrasesPlaceholder": "Слово или часть фразы…",
        "phrasesLoading": "Загрузка фраз…",
        "wordCol": "Слово",
        "translationCol": "Перевод",
        "noResults": "Ничего не найдено",
        "tryDifferentQuery": "Попробуйте изменить запрос",
        "noResultsForTpl": 'Ничего не найдено для "{query}"',
        "wordsStartingWithMoreTpl": "Слова на «{query}» (показаны первые {n})",
        "wordsStartingWithTpl": "Слова на «{query}» — {n}",
        "foundMoreTpl": "Найдено {n} · показаны первые {max}",
        "foundTpl": "Найдено {n}",
        "enterMoreCharsTpl": "Введите ещё {n} симв.",
        "openArticleTpl": "Открыть статью «{word}»",
    },
    "en": {
        "forms": "Forms",
        "byGender": "By gender",
        "seeAlso": "See also",
        "exclamation": "Exclamatory form",
        "genderHints": ["m.", "f.", "n."],
        "searchPlaceholder": "Enter a word to search…",
        "clear": "Clear",
        "loading": "Loading…",
        "phrasesLink": "Phrase search →",
        "phrasesTitle": "Phrase search",
        "phrasesDesc": "Phrase and example search",
        "phrasesSubtitle": "Searches text inside examples and translations — not just headwords",
        "phrasesPlaceholder": "Word or part of a phrase…",
        "phrasesLoading": "Loading phrases…",
        "wordCol": "Word",
        "translationCol": "Translation",
        "noResults": "Nothing found",
        "tryDifferentQuery": "Try a different search",
        "noResultsForTpl": 'Nothing found for "{query}"',
        "wordsStartingWithMoreTpl": 'Words starting with "{query}" (showing first {n})',
        "wordsStartingWithTpl": 'Words starting with "{query}" — {n}',
        "foundMoreTpl": "Found {n} · showing first {max}",
        "foundTpl": "Found {n}",
        "enterMoreCharsTpl": "Enter {n} more character(s)",
        "openArticleTpl": 'Open entry "{word}"',
    },
    "de": {
        "forms": "Formen",
        "byGender": "Nach Genus",
        "seeAlso": "Siehe auch",
        "exclamation": "Ausrufeform",
        "genderHints": ["m.", "f.", "n."],
        "searchPlaceholder": "Wort zur Suche eingeben…",
        "clear": "Löschen",
        "loading": "Wird geladen…",
        "phrasesLink": "Phrasensuche →",
        "phrasesTitle": "Phrasensuche",
        "phrasesDesc": "Suche nach Phrasen und Beispielen",
        "phrasesSubtitle": "Durchsucht Text in Beispielen und Übersetzungen — nicht nur Stichwörter",
        "phrasesPlaceholder": "Wort oder Teil einer Phrase…",
        "phrasesLoading": "Phrasen werden geladen…",
        "wordCol": "Wort",
        "translationCol": "Übersetzung",
        "noResults": "Nichts gefunden",
        "tryDifferentQuery": "Versuchen Sie eine andere Suche",
        "noResultsForTpl": 'Nichts gefunden für "{query}"',
        "wordsStartingWithMoreTpl": 'Wörter mit "{query}" (erste {n} angezeigt)',
        "wordsStartingWithTpl": 'Wörter mit "{query}" — {n}',
        "foundMoreTpl": "{n} gefunden · erste {max} angezeigt",
        "foundTpl": "{n} gefunden",
        "enterMoreCharsTpl": "Noch {n} Zeichen eingeben",
        "openArticleTpl": 'Eintrag "{word}" öffnen',
    },
    "fr": {
        "forms": "Formes",
        "byGender": "Par genre",
        "seeAlso": "Voir aussi",
        "exclamation": "Forme exclamative",
        "genderHints": ["m.", "f.", "n."],
        "searchPlaceholder": "Entrez un mot à rechercher…",
        "clear": "Effacer",
        "loading": "Chargement…",
        "phrasesLink": "Recherche de phrases →",
        "phrasesTitle": "Recherche de phrases",
        "phrasesDesc": "Recherche de phrases et d'exemples",
        "phrasesSubtitle": "Recherche dans le texte des exemples et des traductions — pas seulement les entrées",
        "phrasesPlaceholder": "Mot ou partie de phrase…",
        "phrasesLoading": "Chargement des phrases…",
        "wordCol": "Mot",
        "translationCol": "Traduction",
        "noResults": "Aucun résultat",
        "tryDifferentQuery": "Essayez une autre recherche",
        "noResultsForTpl": 'Aucun résultat pour "{query}"',
        "wordsStartingWithMoreTpl": 'Mots pour "{query}" (les {n} premiers)',
        "wordsStartingWithTpl": 'Mots pour "{query}" — {n}',
        "foundMoreTpl": "{n} trouvés · les {max} premiers",
        "foundTpl": "{n} trouvés",
        "enterMoreCharsTpl": "Entrez encore {n} caractère(s)",
        "openArticleTpl": "Ouvrir l'entrée \"{word}\"",
    },
    "tr": {
        "forms": "Biçimler",
        "byGender": "Cinsiyete göre",
        "seeAlso": "Ayrıca bakınız",
        "exclamation": "Ünlem biçimi",
        "genderHints": ["er.", "di.", "nö."],
        "searchPlaceholder": "Aramak için bir kelime girin…",
        "clear": "Temizle",
        "loading": "Yükleniyor…",
        "phrasesLink": "İfade arama →",
        "phrasesTitle": "İfade arama",
        "phrasesDesc": "İfade ve örnek arama",
        "phrasesSubtitle": "Örnekler ve çeviriler içindeki metni arar — yalnızca madde başlarını değil",
        "phrasesPlaceholder": "Kelime veya ifade parçası…",
        "phrasesLoading": "İfadeler yükleniyor…",
        "wordCol": "Kelime",
        "translationCol": "Çeviri",
        "noResults": "Hiçbir şey bulunamadı",
        "tryDifferentQuery": "Başka bir arama deneyin",
        "noResultsForTpl": '"{query}" için hiçbir şey bulunamadı',
        "wordsStartingWithMoreTpl": '"{query}" ile başlayan kelimeler (ilk {n} gösteriliyor)',
        "wordsStartingWithTpl": '"{query}" ile başlayan kelimeler — {n}',
        "foundMoreTpl": "{n} bulundu · ilk {max} gösteriliyor",
        "foundTpl": "{n} bulundu",
        "enterMoreCharsTpl": "{n} karakter daha girin",
        "openArticleTpl": '"{word}" girişini aç',
    },
    "uk": {
        "forms": "Форми",
        "byGender": "За родом",
        "seeAlso": "Див. також",
        "exclamation": "Оклична форма",
        "genderHints": ["ч. р.", "ж. р.", "с. р."],
        "searchPlaceholder": "Введіть слово для пошуку…",
        "clear": "Очистити",
        "loading": "Завантаження…",
        "phrasesLink": "Пошук по фразах →",
        "phrasesTitle": "Пошук по фразах",
        "phrasesDesc": "Пошук фраз і прикладів",
        "phrasesSubtitle": "Шукає текст усередині прикладів і перекладів — не лише заголовні слова",
        "phrasesPlaceholder": "Слово або частина фрази…",
        "phrasesLoading": "Завантаження фраз…",
        "wordCol": "Слово",
        "translationCol": "Переклад",
        "noResults": "Нічого не знайдено",
        "tryDifferentQuery": "Спробуйте змінити запит",
        "noResultsForTpl": 'Нічого не знайдено для "{query}"',
        "wordsStartingWithMoreTpl": "Слова на «{query}» (показано перші {n})",
        "wordsStartingWithTpl": "Слова на «{query}» — {n}",
        "foundMoreTpl": "Знайдено {n} · показано перші {max}",
        "foundTpl": "Знайдено {n}",
        "enterMoreCharsTpl": "Введіть ще {n} символ(ів)",
        "openArticleTpl": "Відкрити статтю «{word}»",
    },
    "be": {
        "forms": "Формы",
        "byGender": "Па родах",
        "seeAlso": "Гл. таксама",
        "exclamation": "Клічная форма",
        "genderHints": ["м. р.", "ж. р.", "н. р."],
        "searchPlaceholder": "Увядзіце слова для пошуку…",
        "clear": "Ачысціць",
        "loading": "Загрузка…",
        "phrasesLink": "Пошук па фразах →",
        "phrasesTitle": "Пошук па фразах",
        "phrasesDesc": "Пошук фраз і прыкладаў",
        "phrasesSubtitle": "Шукае тэкст унутры прыкладаў і перакладаў — не толькі загалоўныя словы",
        "phrasesPlaceholder": "Слова або частка фразы…",
        "phrasesLoading": "Загрузка фраз…",
        "wordCol": "Слова",
        "translationCol": "Пераклад",
        "noResults": "Нічога не знойдзена",
        "tryDifferentQuery": "Паспрабуйце змяніць запыт",
        "noResultsForTpl": 'Нічога не знойдзена для "{query}"',
        "wordsStartingWithMoreTpl": "Словы на «{query}» (паказаны першыя {n})",
        "wordsStartingWithTpl": "Словы на «{query}» — {n}",
        "foundMoreTpl": "Знойдзена {n} · паказаны першыя {max}",
        "foundTpl": "Знойдзена {n}",
        "enterMoreCharsTpl": "Увядзіце яшчэ {n} сімвал(аў)",
        "openArticleTpl": "Адкрыць артыкул «{word}»",
    },
}


def _hex_rgb(color: str) -> tuple[int, int, int]:
    h = color.removeprefix("#")
    if len(h) != 6:
        raise ValueError(f"ожидался #RRGGBB, получено {color!r}")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def _darken(color: str, factor: float = 0.82) -> str:
    r, g, b = _hex_rgb(color)
    return f"#{int(r * factor):02x}{int(g * factor):02x}{int(b * factor):02x}"


def _rgba(color: str, alpha: float) -> str:
    r, g, b = _hex_rgb(color)
    return f"rgba({r}, {g}, {b}, {alpha})"


def load_site(root: Path | None = None) -> dict:
    root = root or REPO_ROOT
    site_path = root / "profile.json"
    site = json.loads(site_path.read_text(encoding="utf-8"))
    pid = site.get("id")
    if not pid:
        raise SystemExit("profile.json: нет поля id")
    catalog_path = PROFILES_DIR / f"{pid}.json"
    if not catalog_path.is_file():
        known = ", ".join(p.stem for p in sorted(PROFILES_DIR.glob("*.json")))
        raise SystemExit(f"нет профиля {pid!r}. Есть: {known}")
    profile = json.loads(catalog_path.read_text(encoding="utf-8"))
    target = profile["target"]
    host = site.get("host") or f"{pid}.avar.me"
    accent = profile["accent"]
    dict_av = f"av-{target}"
    dict_xx = f"{target}-av"
    label_av = profile["label_av"]
    label_xx = profile["label_xx"]
    return {
        "id": pid,
        "target": target,
        "host": host,
        "html_lang": profile.get("html_lang", "av"),
        "accent": accent,
        "accent_hover": profile.get("accent_hover") or _darken(accent),
        "accent_glow": profile.get("accent_glow") or _rgba(accent, 0.25),
        "accent_light": profile.get("accent_light") or _rgba(accent, 0.12),
        "bg_wash": profile.get("bg_wash") or _rgba(accent, 0.14),
        "label_av": label_av,
        "label_xx": label_xx,
        "label_av_xx": f"{label_av} → {label_xx}",
        "label_xx_av": f"{label_xx} → {label_av}",
        "title_av_xx": profile["title_av_xx"],
        "title_xx_av": profile["title_xx_av"],
        "description": profile["description"],
        "header_tag": profile["header_tag"],
        "stage": profile.get("stage", "experimental"),
        "ui": UI_STRINGS.get(target, UI_STRINGS["ru"]),
        "dict_av": dict_av,
        "dict_xx": dict_xx,
        "dicts": [dict_av, dict_xx],
    }


def site_payload(site: dict) -> dict:
    host = site["host"]
    return {
        "id": site["id"],
        "host": host,
        "dicts": [
            {
                "id": site["dict_av"],
                "label": site["label_av_xx"],
                "title": f"{site['title_av_xx']} — {host}",
                "shortAv": site["label_av"],
                "shortXx": site["label_xx"],
                "avFirst": True,
            },
            {
                "id": site["dict_xx"],
                "label": site["label_xx_av"],
                "title": f"{site['title_xx_av']} — {host}",
                "shortAv": site["label_av"],
                "shortXx": site["label_xx"],
                "avFirst": False,
            },
        ],
        "ui": site["ui"],
    }


def theme_css(site: dict) -> str:
    return (
        "/* Сгенерировано apply_profile.py из профиля "
        f"{site['id']} — не править руками */\n"
        ":root {\n"
        f"  --accent:         {site['accent']};\n"
        f"  --accent-hover:   {site['accent_hover']};\n"
        f"  --accent-glow:    {site['accent_glow']};\n"
        f"  --accent-light:   {site['accent_light']};\n"
        f"  --bg-wash:        {site['bg_wash']};\n"
        "}\n"
    )


def placeholders(site: dict, build_id: str) -> dict[str, str]:
    payload = json.dumps(site_payload(site), ensure_ascii=False)
    return {
        "__ASSET_VERSION__": build_id,
        "__SITE_JSON__": payload,
        "__PROFILE_ID__": site["id"],
        "__HTML_LANG__": site["html_lang"],
        "__DICT_AV__": site["dict_av"],
        "__DICT_XX__": site["dict_xx"],
        "__LABEL_AV__": site["label_av"],
        "__LABEL_XX__": site["label_xx"],
        "__LABEL_AV_XX__": site["label_av_xx"],
        "__LABEL_XX_AV__": site["label_xx_av"],
        "__SITE_TITLE__": site["title_av_xx"],
        "__SITE_TITLE_REV__": site["title_xx_av"],
        "__SITE_DESC__": site["description"],
        "__SITE_HOST__": site["host"],
        "__SITE_TAG__": site["header_tag"],
        "__SITE_STAGE__": site["stage"],
        "__UI_SEARCH_PLACEHOLDER__": site["ui"]["searchPlaceholder"],
        "__UI_CLEAR__": site["ui"]["clear"],
        "__UI_LOADING__": site["ui"]["loading"],
        "__UI_PHRASES_LINK__": site["ui"]["phrasesLink"],
        "__UI_PHRASES_TITLE__": site["ui"]["phrasesTitle"],
        "__UI_PHRASES_DESC__": site["ui"]["phrasesDesc"],
        "__UI_PHRASES_SUBTITLE__": site["ui"]["phrasesSubtitle"],
        "__UI_PHRASES_PLACEHOLDER__": site["ui"]["phrasesPlaceholder"],
        "__UI_PHRASES_LOADING__": site["ui"]["phrasesLoading"],
    }


def resolve_build_id(docs: Path, site: dict) -> str:
    manifest_path = docs / "data" / site["dict_av"] / "manifest.json"
    if manifest_path.is_file():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        build_id = manifest.get("build_id") or ""
        if build_id:
            return str(build_id)
        date = str(manifest.get("build_date") or "")
        if date:
            return date.replace(":", "").replace("-", "")[:15]
    return "dev"


def _stamp(text: str, mapping: dict[str, str]) -> str:
    for key, value in mapping.items():
        text = text.replace(key, value)
    return text


def apply(docs: Path, root: Path | None = None) -> str:
    site = load_site(root)
    build_id = resolve_build_id(docs, site)
    mapping = placeholders(site, build_id)
    (docs / "theme.css").write_text(theme_css(site), encoding="utf-8")
    current = f'data-lang="{site["id"]}"'
    current_marked = f'{current} class="is-current"'
    for name in ("index.html", "phrases.html"):
        path = docs / name
        if not path.is_file():
            continue
        text = _stamp(path.read_text(encoding="utf-8"), mapping)
        text = text.replace(current, current_marked)
        path.write_text(text, encoding="utf-8")
    tma_index = docs / "tma" / "index.html"
    if tma_index.is_file():
        tma_index.write_text(
            _stamp(tma_index.read_text(encoding="utf-8"), mapping), encoding="utf-8"
        )
    print(f"профиль={site['id']} host={site['host']} dicts={','.join(site['dicts'])} build_id={build_id}")
    return build_id


def main() -> None:
    parser = argparse.ArgumentParser(description="Профиль сайта avar.me")
    parser.add_argument("--print-dicts", action="store_true")
    parser.add_argument("--print-id", action="store_true")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--docs", type=Path, default=None)
    args = parser.parse_args()
    site = load_site()
    if args.print_id:
        print(site["id"])
        return
    if args.print_dicts:
        for name in site["dicts"]:
            print(name)
        return
    if args.apply:
        docs = args.docs or REPO_ROOT / "docs"
        apply(docs)
        return
    parser.print_help()
    sys.exit(2)


if __name__ == "__main__":
    main()
