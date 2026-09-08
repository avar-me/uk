#!/usr/bin/env python3
"""
Сборка статических данных словаря для dev.avar.me.

Источник данных — av-ru.jsonl с sources.avar.me (скачивается в build.sh).
Запись результатов:

  docs/data/av-ru/{index.words.txt,chunks/*.json,manifest.json,…}
  docs/tma/data/av-ru/  — то же для Telegram Mini App

Путь к JSONL и корень вывода настраиваются переменными окружения
DICTIONARY_JSONL и DOCS_ROOT.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from collections import defaultdict
from pathlib import Path

MAX_CHUNK_SIZE = 100 * 1024
MAX_WORDS_PER_CHUNK = 500
PHRASE_CHUNK_SIZE = 4000

# repo/src/build_data.py → parents[1] = корень репозитория
REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DICTIONARY = REPO_ROOT / "av-ru.jsonl"
DEFAULT_DOCS = REPO_ROOT / "docs"


def normalize_word(word: str) -> str:
    import re

    normalized = word.lower().strip()
    # Согласовано с normalizeWord() в app.js и normalizeQuery()/normalizeText()
    # в phrases.js (поиск, ключи чанков, порядок сортировки индекса).
    normalized = re.sub(r"[1IiｌlL|!ǀӀІ]", "ӏ", normalized)
    # ё печатают редко — «елка» должно находить «ёлка». Ё стоит вне основного
    # кириллического блока (U+0451, после «я»), поэтому это влияет и на
    # порядок сортировки индекса — см. create_index()/write_headwords_index().
    normalized = normalized.replace("ё", "е")
    return normalized


def _clean_comment_for_site(comment: str) -> str:
    """Убрать повторы в длинном комментарии словаря (много «буквально», «(на голове)» и т.д.).

    Парсер склеивает цепочку помет через «;» — на сайте показываем каждую уникальную
    часть один раз, порядок первого вхождения.
    """
    if not comment:
        return ""
    text = str(comment).replace("\n", " ").strip()
    if not text:
        return ""
    raw_parts = [p.strip() for p in text.split(";") if p.strip()]
    seen: set[str] = set()
    unique: list[str] = []
    for p in raw_parts:
        key = p.casefold()
        if key in seen:
            continue
        seen.add(key)
        unique.append(p)
    return "; ".join(unique)


def _filter_display_labels(labels: list) -> list[str]:
    """Убрать служебные метки омонимов (омоним 1, омоним2, …) — номер уже в поле homonym."""
    out: list[str] = []
    for lab in labels:
        s = str(lab).strip()
        if not s:
            continue
        low = s.casefold().replace(" ", "")
        if low == "омоним" or (low.startswith("омоним") and low[6:].isdigit()):
            continue
        if s not in out:
            out.append(s)
    return out


def _register_form_variants(form_to_word: dict[str, str], form: str, main_word: str) -> None:
    if not form:
        return
    if "/" in form:
        for variant in [x.strip() for x in form.split("/") if x.strip()]:
            form_to_word.setdefault(variant, main_word)
    else:
        form_to_word.setdefault(form, main_word)


def _see_also_refs(see_also: object) -> list[str]:
    if not see_also:
        return []
    out: list[str] = []
    for item in see_also:
        if isinstance(item, str):
            out.append(item)
        elif isinstance(item, dict):
            ref = item.get("target") or item.get("ref")
            if ref:
                out.append(str(ref))
    return out


def _relation_targets_norm(results: list[dict]) -> set[str]:
    """Нормализованные цели ссылок с грамматической пометой (мн. ч. от, масдар от, …)."""
    covered: set[str] = set()
    for r in results:
        for rel in r.get("relations") or []:
            t = (rel.get("target") or "").strip()
            if t:
                covered.add(normalize_word(t))
    return covered


def _filter_lookup_against_relations(lookup: list[str], results: list[dict]) -> list[str]:
    """Убрать из «см.» цели, уже показанные как relation с причиной."""
    covered = _relation_targets_norm(results)
    if not covered:
        return lookup
    out: list[str] = []
    for ref in lookup:
        if not ref:
            continue
        if normalize_word(str(ref)) in covered:
            continue
        if ref not in out:
            out.append(ref)
    return out


# Mapping of sense relation fields → Russian display labels
_RELATION_FIELDS: list[tuple[str, str]] = [
    ("masdarfrom",    "масдар от"),
    ("masdarforceto", "масдар понуд. к"),
    ("genitivefrom",  "род. пад. от"),
    ("pluralfor",     "мн. ч. от"),
    ("forceto",       "понуд. к"),
    ("participlefrom","прич. от"),
    ("deverbfrom",    "девербатив от"),
    ("locativefrom",  "мест. пад. от"),
    ("dativefrom",    "дат. пад. от"),
    ("ergativefrom",  "эрг. пад. от"),
    ("casefrom",      "пад. от"),
    ("ablativefrom",  "отл. пад. от"),
]


def _sense_to_result(
    sense: dict,
    entry_labels: list[str],
) -> dict:
    labels = _filter_display_labels(list(entry_labels))
    for lab in _filter_display_labels(sense.get("labels") or []):
        if lab not in labels:
            labels.append(lab)

    text = (sense.get("text") or "").strip()
    comment_raw = sense.get("comment")
    comment_clean = (
        _clean_comment_for_site(str(comment_raw).strip()) if comment_raw else ""
    )
    # Основной перевод — поле text; комментарий — отдельно (без склейки в одну «простыню»).
    if text:
        translation = text
        comment_out = comment_clean or None
    else:
        translation = comment_clean
        comment_out = None

    # precomment — помета перед переводом (курсив, мельче)
    precomment = (sense.get("precomment") or "").strip() or None

    examples_out: list[dict] = []
    for ex in sense.get("examples") or []:
        av = (ex.get("av") or "").strip()
        ru = (ex.get("ru") or "").strip()
        note_parts: list[str] = []
        for lab in ex.get("labels") or []:
            if lab and str(lab).strip() and str(lab).strip() not in note_parts:
                note_parts.append(str(lab).strip())
        ex_comm = (ex.get("comment") or "").strip()
        if ex_comm and ex_comm not in note_parts:
            note_parts.append(ex_comm)
        if av or ru or note_parts:
            item: dict = {"av": av, "ru": ru}
            if note_parts:
                item["note"] = "; ".join(note_parts)
            examples_out.append(item)

    # Relations: masdarfrom, genitivefrom, pluralfor, forceto, etc.
    relations_out: list[dict] = []
    for field, label in _RELATION_FIELDS:
        val = sense.get(field)
        if not val:
            continue
        target = str(val).strip()
        if target:
            relations_out.append({"kind": label, "target": target})

    sense_forms = sense.get("forms") or []
    out: dict = {
        "labels": labels,
        "translation": translation,
        "forms": [str(f).strip() for f in sense_forms if f and str(f).strip()],
        "examples": examples_out,
        "lookup": [],
    }
    if comment_out:
        out["comment"] = comment_out
    if precomment:
        out["precomment"] = precomment
    if relations_out:
        out["relations"] = relations_out
    return out


def convert_entry(raw: dict) -> dict:
    """Одна строка dictionary.jsonl → формат фронтенда (как в legacy av-ru JSONL)."""
    word = (raw.get("word") or "").strip()
    forms = [str(f).strip() for f in (raw.get("forms") or []) if f and str(f).strip()]
    gender_forms = [
        str(f).strip() for f in (raw.get("gender_forms") or []) if f and str(f).strip()
    ]
    entry_labels = _filter_display_labels(list(raw.get("labels") or []))

    translations = raw.get("senses") or raw.get("translations") or []
    results: list[dict] = []
    for sense in translations:
        if not isinstance(sense, dict):
            continue
        results.append(_sense_to_result(sense, entry_labels))

    if not results:
        # Статья только со см. или пустые значения
        results.append(
            {
                "labels": entry_labels,
                "translation": "",
                "forms": [],
                "examples": [],
                "lookup": [],
            }
        )

    see = _filter_lookup_against_relations(
        _see_also_refs(raw.get("see_also")), results
    )
    if see:
        results[0]["lookup"] = see

    if forms and results:
        cur = list(results[0].get("forms") or [])
        merged_forms = list(forms)
        for x in cur:
            if x not in merged_forms:
                merged_forms.append(x)
        results[0]["forms"] = merged_forms
    forms_raw = raw.get("forms_raw")
    if forms_raw and results:
        fr = str(forms_raw).strip()
        if fr:
            cur = list(results[0].get("forms") or [])
            if fr not in cur:
                results[0]["forms"] = [fr] + cur

    parts = [word]
    if raw.get("word_raw"):
        parts.append(str(raw["word_raw"]))
    for s in translations:
        if isinstance(s, dict) and s.get("text"):
            parts.append(str(s["text"]))
    data = " ".join(parts)

    entry: dict = {
        "word": word,
        "forms": forms,
        "data": data,
        "results": results,
        "word_forms": raw.get("forms_raw"),
        "page": raw.get("page"),
    }
    # stress: позиция ударной гласной (1-based) или номер гласной в слове
    stress = raw.get("stress")
    if stress is not None:
        try:
            entry["stress"] = int(stress)
        except (TypeError, ValueError):
            pass
    # stem: основа слова
    stem = (raw.get("stem") or "").strip()
    if stem:
        entry["stem"] = stem
    # exclamation: восклицательная форма слова
    excl = (raw.get("exclamation") or "").strip()
    if excl:
        entry["exclamation"] = excl
    if gender_forms:
        entry["gender_forms"] = gender_forms
    return entry


def merge_site_entries(a: dict, b: dict) -> dict:
    """Объединить две статьи с одинаковым word (омонимы / фрагменты на одной странице)."""
    merged_results = (a.get("results") or []) + (b.get("results") or [])
    forms_out: list[str] = []
    seen: set[str] = set()
    for f in (a.get("forms") or []) + (b.get("forms") or []):
        if f and f not in seen:
            seen.add(f)
            forms_out.append(f)
    lookup_merged: list[str] = []
    for src in (a, b):
        r0 = (src.get("results") or [{}])[0]
        for x in r0.get("lookup") or []:
            if x and x not in lookup_merged:
                lookup_merged.append(x)
    out = {
        "word": a["word"],
        "forms": forms_out,
        "data": f"{a.get('data', '')} {b.get('data', '')}".strip(),
        "results": merged_results,
        "word_forms": a.get("word_forms") or b.get("word_forms"),
        "page": a.get("page"),
    }
    if out["results"]:
        lookup_merged = _filter_lookup_against_relations(lookup_merged, merged_results)
        out["results"][0]["lookup"] = lookup_merged
    gf_merged: list[str] = []
    for src in (a, b):
        for x in src.get("gender_forms") or []:
            if x and x not in gf_merged:
                gf_merged.append(x)
    if gf_merged:
        out["gender_forms"] = gf_merged
    for key in ("stress", "stem", "exclamation"):
        if a.get(key) is not None:
            out[key] = a[key]
        elif b.get(key) is not None:
            out[key] = b[key]
    return out


def load_dictionary(path: Path) -> tuple[dict[str, dict], dict[str, str]]:
    entries: dict[str, dict] = {}
    form_to_word: dict[str, str] = {}
    duplicates: dict[str, list[str]] = defaultdict(list)

    print(f"Чтение словаря: {path}")
    with open(path, encoding="utf-8") as f:
        for line_num, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                raw = json.loads(line)
            except json.JSONDecodeError as e:
                print(f"  ОШИБКА JSON строка {line_num}: {e}", file=sys.stderr)
                continue
            conv = convert_entry(raw)
            w = conv["word"]
            if not w:
                continue
            if w in entries:
                duplicates[w].append(str(line_num))
                entries[w] = merge_site_entries(entries[w], conv)
                for form in conv.get("forms") or []:
                    _register_form_variants(form_to_word, form, w)
                for form in conv.get("gender_forms") or []:
                    _register_form_variants(form_to_word, form, w)
            else:
                entries[w] = conv
                for form in conv.get("forms") or []:
                    _register_form_variants(form_to_word, form, w)
                for form in conv.get("gender_forms") or []:
                    _register_form_variants(form_to_word, form, w)

    # Форма может быть и отдельной статьёй (род. пад. от, омоним) — не перекрывать lemma.
    stripped = [f for f in form_to_word if f in entries]
    for form in stripped:
        del form_to_word[form]
    if stripped:
        print(f"  Форм→lemma: пропущено {len(stripped)} (есть своя статья)")

    if duplicates:
        print(f"  Объединено дубликатов word: {len(duplicates)}")
    return entries, form_to_word


def create_index(entries: dict[str, dict]) -> list[str]:
    all_words: set[str] = set(entries.keys())
    for word, entry in entries.items():
        for form in (entry.get("forms") or []) + (entry.get("gender_forms") or []):
            if form and form.strip():
                fs = form.strip()
                if "/" in fs:
                    for variant in [v.strip() for v in fs.split("/") if v.strip()]:
                        all_words.add(variant)
                else:
                    all_words.add(fs)
    # Сортируем по normalize_word(), а не по сырому unicode-порядку: бинарный
    # поиск во фронтенде (binarySearchPrefix/findExactWordInIndex) сравнивает
    # normalizeWord(words[mid]), так что массив должен быть монотонен именно
    # по этому ключу — иначе слова на «ё» (U+0451, вне основного алфавитного
    # блока, кодовая точка после «я») не находились бы поиском по «е».
    words = sorted(all_words, key=lambda w: (normalize_word(w), w))
    print(f"Уникальных заглавных слов: {len(entries)}")
    print(f"Строк в индексе (слова + формы): {len(words)}")
    return words


def get_prefix(word: str, length: int = 2) -> str:
    normalized = normalize_word(word)
    return normalized[: min(length, len(normalized))]


def split_into_chunks(
    entries: dict[str, dict],
    words: list[str],
    form_to_word_map: dict[str, str],
) -> dict[str, dict]:
    chunks: dict[str, dict] = defaultdict(dict)
    prefix_groups: dict[str, list[str]] = defaultdict(list)
    for word in words:
        prefix_groups[get_prefix(word, 2)].append(word)

    print(f"Групп по 2-символьному префиксу: {len(prefix_groups)}")
    for prefix, prefix_words in sorted(prefix_groups.items()):
        group_data: dict[str, dict] = {}
        for w in prefix_words:
            if w in entries:
                group_data[w] = entries[w]
            elif w in form_to_word_map:
                main_word = form_to_word_map[w]
                if main_word in entries:
                    group_data[w] = entries[main_word]
        group_json = json.dumps(group_data, ensure_ascii=False)
        group_size = len(group_json.encode("utf-8"))

        if group_size > MAX_CHUNK_SIZE or len(prefix_words) > MAX_WORDS_PER_CHUNK:
            print(f"  {prefix}: {len(prefix_words)} слов, {group_size} байт — дробим на 3 символа")
            sub_groups: dict[str, list[str]] = defaultdict(list)
            for word in prefix_words:
                sub_groups[get_prefix(word, 3)].append(word)
            for sub_prefix, sub_words in sorted(sub_groups.items()):
                chunk_name = sub_prefix if sub_prefix else prefix
                chunk_data: dict[str, dict] = {}
                for w in sub_words:
                    if w in entries:
                        chunk_data[w] = entries[w]
                    elif w in form_to_word_map:
                        mw = form_to_word_map[w]
                        if mw in entries:
                            chunk_data[w] = entries[mw]
                chunks[chunk_name] = chunk_data
                cj = json.dumps(chunks[chunk_name], ensure_ascii=False)
                print(f"    {chunk_name}: {len(sub_words)} слов, {len(cj.encode('utf-8'))} байт")
        else:
            chunks[prefix] = group_data
            print(f"  {prefix}: {len(prefix_words)} слов, {group_size} байт")
    return chunks


def write_index(words: list[str], output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    index_file = output_dir / "index.words.txt"
    with open(index_file, "w", encoding="utf-8") as f:
        for word in words:
            f.write(word + "\n")
    print(f"Индекс: {index_file} ({len(words)} строк)")


def write_headwords_index(entries: dict[str, dict], output_dir: Path) -> int:
    """Только заглавные слова — для листинга по префиксу (как на avar.me)."""
    headwords = sorted(entries.keys(), key=lambda w: (normalize_word(w), w))
    path = output_dir / "index.headwords.txt"
    with open(path, "w", encoding="utf-8") as f:
        for word in headwords:
            f.write(word + "\n")
    print(f"Индекс заглавных: {path} ({len(headwords)} строк)")
    return len(headwords)


def _entry_gloss(entry: dict, max_senses: int = 3) -> str:
    parts: list[str] = []
    for r in entry.get("results") or []:
        t = (r.get("translation") or "").strip()
        if t and t not in parts:
            parts.append(t)
        if len(parts) >= max_senses:
            break
    return "; ".join(parts)


def write_form_to_headword(form_map: dict[str, str], output_dir: Path) -> None:
    """Форма / родовая форма → заглавное слово (для поиска по префиксу)."""
    compact = {k: v for k, v in form_map.items() if k and v and k != v}
    path = output_dir / "form_to_headword.json"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(compact, f, ensure_ascii=False, separators=(",", ":"))
    size_kb = path.stat().st_size // 1024
    print(f"Form→headword: {path} ({len(compact)} записей, ~{size_kb} KB)")


def write_browse(entries: dict[str, dict], output_dir: Path) -> None:
    """Краткие глоссы и формы для главной и таблицы по префиксу."""
    browse: dict[str, dict] = {}
    for word, entry in entries.items():
        gloss = _entry_gloss(entry)
        forms = [str(f).strip() for f in (entry.get("forms") or []) if f and str(f).strip()][:8]
        if gloss or forms:
            browse[word] = {"g": gloss, "forms": forms}
    path = output_dir / "browse.json"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(browse, f, ensure_ascii=False, separators=(",", ":"))
    size_kb = path.stat().st_size // 1024
    print(f"Browse: {path} ({len(browse)} статей, ~{size_kb} KB)")


def _safe_chunk_filename(prefix: str) -> str:
    """Префикс может содержать / (напр. из слова «б/ачӀ…») — недопустимо в имени файла."""
    s = prefix.replace("/", "_").replace("\\", "_").replace(":", "_")
    s = s.strip("._") or "_"
    return s


def write_chunks(chunks: dict[str, dict], output_dir: Path) -> list[dict]:
    chunks_dir = output_dir / "chunks"
    chunks_dir.mkdir(parents=True, exist_ok=True)
    chunk_info: list[dict] = []
    for chunk_name, chunk_data in sorted(chunks.items()):
        safe = _safe_chunk_filename(chunk_name)
        chunk_file = chunks_dir / f"{safe}.json"
        with open(chunk_file, "w", encoding="utf-8") as f:
            json.dump(chunk_data, f, ensure_ascii=False, indent=2)
        file_size = chunk_file.stat().st_size
        with open(chunk_file, "rb") as f:
            file_hash = hashlib.md5(f.read()).hexdigest()[:8]
        chunk_info.append(
            {
                "prefix": chunk_name,
                "file": f"{safe}.json",
                "words_count": len(chunk_data),
                "size": file_size,
                "hash": file_hash,
            }
        )
    print(f"Чанков: {len(chunks)} в {chunks_dir}")
    return chunk_info


def write_manifest(
    words: list[str],
    chunk_info: list[dict],
    output_dir: Path,
    headwords_count: int,
) -> None:
    chunk_fingerprint = hashlib.md5(
        "".join(c["hash"] for c in chunk_info).encode("utf-8")
    ).hexdigest()[:12]
    manifest = {
        "version": "3.5.0",
        "source": "dictionary.jsonl",
        "build_date": __import__("datetime").datetime.now().isoformat(),
        "build_id": chunk_fingerprint,
        "total_words": len(words),
        "headwords_count": headwords_count,
        "total_chunks": len(chunk_info),
        "chunks": chunk_info,
    }
    manifest_file = output_dir / "manifest.json"
    with open(manifest_file, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(f"Manifest: {manifest_file}")


def _direction_parts(direction: str) -> tuple[str, bool]:
    """('ru', True) для av-ru; ('en', False) для en-av."""
    left, right = direction.split("-", 1)
    av_first = left == "av"
    target = right if av_first else left
    return target, av_first


def build_phrases(dictionary_path: Path, direction: str, output_dir: Path) -> None:
    """Полнотекстовый индекс фраз для /phrases: examples + пары word:sense.text.

    direction: "av-xx" — word аварский, sense.text на языке xx;
               "xx-av" — word на xx, sense.text аварский.
    Каждая фраза — [word, av, xx, comment]. В examples ищется поле языка
    (en/tr/…) и запасной ключ ru — так в источниках часто лежит второй язык.
    """
    target, av_first = _direction_parts(direction)
    phrases: list[list[str]] = []
    with open(dictionary_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                raw = json.loads(line)
            except json.JSONDecodeError:
                continue
            word = (raw.get("word") or "").strip()
            if not word:
                continue
            senses = raw.get("senses") or raw.get("translations") or []
            word_has_phrase = False
            for sense in senses:
                if not isinstance(sense, dict):
                    continue
                text = (sense.get("text") or "").strip()
                if text:
                    word_has_phrase = True
                    if av_first:
                        phrases.append([word, word, text, ""])
                    else:
                        phrases.append([word, text, word, ""])
                for ex in sense.get("examples") or []:
                    av = (ex.get("av") or "").strip()
                    xx = (ex.get(target) or ex.get("ru") or "").strip()
                    if not av and not xx:
                        continue
                    word_has_phrase = True
                    note_parts: list[str] = []
                    for lab in ex.get("labels") or []:
                        s = str(lab).strip()
                        if s and s not in note_parts:
                            note_parts.append(s)
                    ex_comment = (ex.get("comment") or "").strip()
                    if ex_comment and ex_comment not in note_parts:
                        note_parts.append(ex_comment)
                    phrases.append([word, av, xx, "; ".join(note_parts)])
            if not word_has_phrase:
                # Статьи без sense.text и examples («см.», масдары, формы от
                # других слов) иначе выпадали из индекса — само слово было
                # ненаходимо через /phrases.
                if av_first:
                    phrases.append([word, word, "", ""])
                else:
                    phrases.append([word, "", word, ""])

            # Словоформы (напр. «лагънаялъ» для «лагъна») — иначе находится
            # только заглавная форма, а склонения/спряжения в /phrases не
            # ищутся вовсе.
            seen_forms = {word}
            for f in raw.get("forms") or []:
                f = str(f).strip()
                if not f or f in seen_forms:
                    continue
                seen_forms.add(f)
                comment = f"форма слова «{word}»"
                if av_first:
                    phrases.append([word, f, "", comment])
                else:
                    phrases.append([word, "", f, comment])

    output_dir.mkdir(parents=True, exist_ok=True)
    chunks_dir = output_dir / "chunks"
    chunks_dir.mkdir(parents=True, exist_ok=True)
    chunk_info: list[dict] = []
    for i in range(0, len(phrases), PHRASE_CHUNK_SIZE):
        chunk = phrases[i : i + PHRASE_CHUNK_SIZE]
        idx = i // PHRASE_CHUNK_SIZE
        chunk_file = chunks_dir / f"{idx}.json"
        cj = json.dumps(chunk, ensure_ascii=False, separators=(",", ":"))
        chunk_file.write_text(cj, encoding="utf-8")
        chunk_hash = hashlib.md5(cj.encode("utf-8")).hexdigest()[:8]
        chunk_info.append({"file": f"{idx}.json", "count": len(chunk), "hash": chunk_hash})

    manifest = {
        "version": "1.0.0",
        "direction": direction,
        "total_phrases": len(phrases),
        "total_chunks": len(chunk_info),
        "chunks": chunk_info,
    }
    (output_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"Фразы ({direction}): {len(phrases)} → {output_dir} ({len(chunk_info)} чанков)")


def build_av_ru(dictionary_path: Path, output_dir: Path) -> bool:
    print("=" * 60)
    print(f"Сборка {output_dir.name} → {output_dir}")
    print("=" * 60)
    entries, form_map = load_dictionary(dictionary_path)
    if not entries:
        print("Нет записей.", file=sys.stderr)
        return False
    words = create_index(entries)
    chunks = split_into_chunks(entries, words, form_map)
    output_dir.mkdir(parents=True, exist_ok=True)
    write_index(words, output_dir)
    headwords_count = write_headwords_index(entries, output_dir)
    write_form_to_headword(form_map, output_dir)
    write_browse(entries, output_dir)
    chunk_info = write_chunks(chunks, output_dir)
    write_manifest(words, chunk_info, output_dir, headwords_count)
    return True


def main() -> None:
    dict_path = Path(os.environ.get("DICTIONARY_JSONL", DEFAULT_DICTIONARY)).resolve()
    if not dict_path.is_file():
        print(f"Файл не найден: {dict_path}", file=sys.stderr)
        sys.exit(1)

    docs_root = Path(os.environ.get("DOCS_ROOT", DEFAULT_DOCS)).resolve()
    dict_name = os.environ.get("DICT_NAME", "av-ru")
    targets = [
        docs_root / "data" / dict_name,
        docs_root / "tma" / "data" / dict_name,
    ]
    ok = 0
    for out in targets:
        if build_av_ru(dict_path, out):
            ok += 1
    if ok != len(targets):
        sys.exit(1)

    # /phrases — только основной сайт, TMA не нужен
    build_phrases(dict_path, dict_name, docs_root / "data" / "phrases" / dict_name)

    print(f"\nГотово: {docs_root.name}/data/{dict_name} и {docs_root.name}/tma/data/{dict_name}")


if __name__ == "__main__":
    main()
