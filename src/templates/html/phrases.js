/**
 * Поиск по фразам (dev.avar.me/phrases.html)
 * Полнотекстовый поиск по examples и sense.text обоих словарей (av-ru, ru-av).
 */

function getSite() {
    const s = typeof window !== 'undefined' ? window.__SITE__ : null;
    if (s && Array.isArray(s.dicts) && s.dicts.length >= 2) return s;
    return {
        id: 'ru',
        host: 'dev.avar.me',
        dicts: [
            { id: 'av-ru', label: 'Авар → Рус', shortAv: 'Авар', shortXx: 'Рус', avFirst: true },
            { id: 'ru-av', label: 'Рус → Авар', shortAv: 'Авар', shortXx: 'Рус', avFirst: false },
        ],
    };
}

const SITE = getSite();

const CONFIG = {
    MIN_QUERY_LEN: 2,
    DEBOUNCE_DELAY: 200,
    MAX_RESULTS: 200,
};

/** Подставляется при сборке (phrases.html); сбрасывает кэш Cloudflare для data/*. */
const ASSET_VERSION = (typeof window !== 'undefined' && window.__DICT_ASSET_V__) || '';

function assetUrl(path) {
    if (!ASSET_VERSION) return path;
    const sep = path.includes('?') ? '&' : '?';
    return `${path}${sep}v=${encodeURIComponent(ASSET_VERSION)}`;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/** Согласовано с normalizeWord() в app.js и normalize_word() в build_data.py. */
function normalizeQuery(word) {
    return word.toLowerCase().trim().replace(/[1IiｌlL|!ǀӀІ]/g, 'ӏ').replace(/ё/g, 'е');
}

/**
 * Без .trim() — сохраняет 1:1 соответствие индексов символов с исходным
 * текстом фразы, это нужно для подсветки совпадения (highlightMatch).
 * ё->е тоже 1:1 по длине, индексы не сдвигаются.
 */
function normalizeText(s) {
    return s.toLowerCase().replace(/[1IiｌlL|!ǀӀІ]/g, 'ӏ').replace(/ё/g, 'е');
}

function highlightMatch(original, normalized, queryNorm) {
    if (!queryNorm) return escapeHtml(original);
    const idx = normalized.indexOf(queryNorm);
    if (idx === -1) return escapeHtml(original);
    const before = original.slice(0, idx);
    const match = original.slice(idx, idx + queryNorm.length);
    const after = original.slice(idx + queryNorm.length);
    return `${escapeHtml(before)}<mark class="phrase-hl">${escapeHtml(match)}</mark>${escapeHtml(after)}`;
}

function debounce(func, delay) {
    let timeoutId;
    const debounced = function (...args) {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => func.apply(this, args), delay);
    };
    debounced.cancel = () => clearTimeout(timeoutId);
    return debounced;
}

const state = {
    fwd: null,
    rev: null,
};

/**
 * Скачать все чанки фраз для словаря и собрать плоский индекс с
 * предпосчитанными нормализованными полями (для быстрого поиска подстроки).
 */
async function loadPhraseSet(dictName) {
    const manifestRes = await fetch(assetUrl(`data/phrases/${dictName}/manifest.json`));
    if (!manifestRes.ok) throw new Error(`HTTP ${manifestRes.status}`);
    const manifest = await manifestRes.json();

    const chunkArrays = await Promise.all(
        manifest.chunks.map(async (c) => {
            const res = await fetch(assetUrl(`data/phrases/${dictName}/chunks/${c.file}`));
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        })
    );

    const records = chunkArrays.flat();
    return records.map(([w, av, ru, c]) => {
        const avNorm = normalizeText(av);
        const ruNorm = normalizeText(ru);
        return { w, av, ru, c, avNorm, ruNorm, combined: avNorm + '' + ruNorm };
    });
}

/** Полный проход по индексу — размер (60-90k записей) позволяет не кэшировать частичные срезы. */
function searchPhrases(index, queryNorm, limit) {
    const results = [];
    let total = 0;
    for (let i = 0; i < index.length; i++) {
        const item = index[i];
        if (item.combined.indexOf(queryNorm) !== -1) {
            total++;
            if (results.length < limit) results.push(item);
        }
    }
    return { results, total };
}

function wordLink(word, dict) {
    return `index.html#dict=${encodeURIComponent(dict)}&word=${encodeURIComponent(word)}`;
}

function renderRows(items, dict, queryNorm, reversed) {
    if (!items.length) return '<p class="phrase-empty">Ничего не найдено</p>';
    const rows = items
        .map((item) => {
            const avHtml = highlightMatch(item.av, item.avNorm, queryNorm);
            const ruHtml = highlightMatch(item.ru, item.ruNorm, queryNorm);
            const leftHtml = reversed ? ruHtml : avHtml;
            const rightHtml = reversed ? avHtml : ruHtml;
            const commentHtml = item.c ? `<div class="phrase-comment">${escapeHtml(item.c)}</div>` : '';
            return `
                <div class="phrase-row">
                    <div class="phrase-cell phrase-cell-a">${leftHtml}</div>
                    <div class="phrase-cell phrase-cell-b">${rightHtml}</div>
                    <a class="phrase-link" href="${wordLink(item.w, dict)}" title="Открыть статью «${escapeHtml(item.w)}»">${escapeHtml(item.w)}</a>
                    ${commentHtml}
                </div>
            `;
        })
        .join('');
    return `<div class="phrase-list">${rows}</div>`;
}

function renderSection(containerId, index, dict, queryNorm, reversed, leftLabel, rightLabel) {
    const container = document.getElementById(containerId);
    if (!index) {
        container.innerHTML = '';
        return;
    }
    const { results, total } = searchPhrases(index, queryNorm, CONFIG.MAX_RESULTS);
    const caption =
        total > CONFIG.MAX_RESULTS
            ? `Найдено ${total} · показаны первые ${CONFIG.MAX_RESULTS}`
            : `Найдено ${total}`;
    const header = `
        <div class="phrase-header-row">
            <div>${escapeHtml(leftLabel)}</div>
            <div>${escapeHtml(rightLabel)}</div>
            <div>Слово</div>
        </div>
    `;
    container.innerHTML = `<p class="phrase-table-caption">${caption}</p>${header}${renderRows(results, dict, queryNorm, reversed)}`;
}

function sectionLabels(dict) {
    if (dict.avFirst) return [dict.shortAv, dict.shortXx, false];
    return [dict.shortXx, dict.shortAv, true];
}

function renderEmptyState() {
    document.getElementById('tableAvRu').innerHTML = '';
    document.getElementById('tableRuAv').innerHTML = '';
    document.getElementById('phraseStats').textContent = '';
}

/** #text=... в URL — чтобы на найденную фразу можно было дать ссылку. */
function updateHash(query) {
    const url = query
        ? `${window.location.pathname}${window.location.search}#text=${encodeURIComponent(query)}`
        : window.location.pathname + window.location.search;
    history.replaceState(null, '', url);
}

function runSearch(query) {
    const statsEl = document.getElementById('phraseStats');
    if (!query || query.length < CONFIG.MIN_QUERY_LEN) {
        renderEmptyState();
        if (query) statsEl.textContent = `Введите ещё ${CONFIG.MIN_QUERY_LEN - query.length} симв.`;
        return;
    }
    statsEl.textContent = '';
    const queryNorm = normalizeQuery(query);
    const [fwd, rev] = SITE.dicts;
    const [fwdL, fwdR, fwdRev] = sectionLabels(fwd);
    const [revL, revR, revRev] = sectionLabels(rev);
    renderSection('tableAvRu', state.fwd, fwd.id, queryNorm, fwdRev, fwdL, fwdR);
    renderSection('tableRuAv', state.rev, rev.id, queryNorm, revRev, revL, revR);
}

const handleInput = debounce((query) => {
    updateHash(query);
    runSearch(query);
}, CONFIG.DEBOUNCE_DELAY);

function showLoading(show) {
    document.getElementById('phraseLoading').style.display = show ? 'flex' : 'none';
    document.getElementById('phraseResults').style.display = show ? 'none' : 'flex';
}

function showError(message) {
    const el = document.getElementById('phraseError');
    el.textContent = message;
    el.style.display = 'block';
    setTimeout(() => {
        el.style.display = 'none';
    }, 5000);
}

function readHashQuery() {
    const params = new URLSearchParams(window.location.hash.slice(1));
    return params.get('text') || '';
}

async function init() {
    const input = document.getElementById('phraseSearchInput');
    const clearBtn = document.getElementById('phraseClearBtn');

    showLoading(true);
    try {
        const [fwd, rev] = SITE.dicts;
        const [fwdIndex, revIndex] = await Promise.all([
            loadPhraseSet(fwd.id),
            loadPhraseSet(rev.id),
        ]);
        state.fwd = fwdIndex;
        state.rev = revIndex;
        console.log(`Phrases loaded: ${fwd.id}=${fwdIndex.length}, ${rev.id}=${revIndex.length}`);
    } catch (error) {
        console.error('Error loading phrases:', error);
        showError('Не удалось загрузить данные для поиска по фразам');
    }
    showLoading(false);

    input.addEventListener('input', (e) => {
        let value = e.target.value;
        const cursorPos = e.target.selectionStart;

        const normalizedValue = value.replace(/[1IiｌlL|!ǀӀІ]/g, 'ӏ');
        if (normalizedValue !== value) {
            e.target.value = normalizedValue;
            e.target.setSelectionRange(cursorPos, cursorPos);
            value = normalizedValue;
        }

        const query = value.trim();
        clearBtn.style.display = query ? 'block' : 'none';
        handleInput(query);
    });

    clearBtn.addEventListener('click', () => {
        handleInput.cancel();
        input.value = '';
        clearBtn.style.display = 'none';
        updateHash('');
        renderEmptyState();
        input.focus();
    });

    // Назад/вперёд в браузере — пока поле в фокусе, значит пользователь
    // печатает и сам обновляет хэш через updateHash(); не перебиваем его.
    window.addEventListener('hashchange', () => {
        if (document.activeElement === input) return;
        const query = readHashQuery();
        input.value = query;
        clearBtn.style.display = query ? 'block' : 'none';
        runSearch(query);
    });

    // #text=... в ссылке — сразу показать результат
    const initialQuery = readHashQuery();
    if (initialQuery) {
        input.value = initialQuery;
        clearBtn.style.display = 'block';
        runSearch(initialQuery);
    }

    input.focus();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
