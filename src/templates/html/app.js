/**
 * Avar-Russian dictionary (dev.avar.me)
 * Static client; UI strings are UTF-8
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

function getSite() {
    const s = typeof window !== 'undefined' ? window.__SITE__ : null;
    if (s && Array.isArray(s.dicts) && s.dicts.length >= 2) return s;
    return {
        id: 'ru',
        host: 'dev.avar.me',
        dicts: [
            { id: 'av-ru', label: 'Авар → Рус', title: 'Аварско-русский словарь — dev.avar.me', shortAv: 'Авар', shortXx: 'Рус', avFirst: true },
            { id: 'ru-av', label: 'Рус → Авар', title: 'Русско-аварский словарь — dev.avar.me', shortAv: 'Авар', shortXx: 'Рус', avFirst: false },
        ],
        ui: {
            forms: 'Формы',
            byGender: 'По родам',
            seeAlso: 'См. также',
            exclamation: 'Восклицательная форма',
            genderHints: ['м. р.', 'ж. р.', 'ср. р.'],
        },
    };
}

const SITE = getSite();

const CONFIG = {
    MAX_SUGGESTIONS: 20,
    MAX_PREFIX_LIST: 150,
    MIN_PREFIX_LIST: 2,
    HOME_SAMPLES: 14,
    DEBOUNCE_DELAY: 150,
    CHUNK_CACHE_SIZE: 50,
    DEFAULT_DICT_TYPE: SITE.dicts[0].id
};

/** Подставляется при сборке (index.html); сбрасывает кэш Cloudflare для data/*. */
const ASSET_VERSION = (typeof window !== 'undefined' && window.__DICT_ASSET_V__) || '';

function assetUrl(path) {
    if (!ASSET_VERSION) return path;
    const sep = path.includes('?') ? '&' : '?';
    return `${path}${sep}v=${encodeURIComponent(ASSET_VERSION)}`;
}

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

const state = {
    currentDictType: CONFIG.DEFAULT_DICT_TYPE,
    wordsIndex: null,
    headwordsIndex: null,
    headwordsSet: null,
    formToHeadword: null,
    browse: null,
    manifest: null,
    chunkCache: new Map(),
    currentQuery: '',
    isLoading: false
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Debounce function to limit API calls
 */
function debounce(func, delay) {
    let timeoutId;
    const debounced = function (...args) {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => func.apply(this, args), delay);
    };
    debounced.cancel = () => clearTimeout(timeoutId);
    return debounced;
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/** Служебные метки омонимов не показываем (номер омонима не выводится в UI). */
function isHomonymLabel(label) {
    const s = String(label).trim().toLowerCase().replace(/\s+/g, '');
    return s === 'омоним' || (s.startsWith('омоним') && /^\d+$/.test(s.slice(6)));
}

function filterDisplayLabels(labels) {
    return (labels || []).filter(l => l && !isHomonymLabel(l));
}

const GENDER_FORM_HINTS = SITE.ui.genderHints;

const VOWEL_RE = /[аеёиоуыэюяӀӏ]/iu;

/**
 * Индекс ударной гласной: stress — позиция в слове (1-based) или номер гласной.
 */
function stressVowelIndex(word, stress) {
    if (!word || !stress || stress < 1) return -1;
    const chars = [...word];
    const pos = stress - 1;
    if (pos < chars.length && VOWEL_RE.test(chars[pos])) return pos;

    const vowelIdxs = [];
    for (let i = 0; i < chars.length; i++) {
        if (VOWEL_RE.test(chars[i])) vowelIdxs.push(i);
    }
    if (stress >= 1 && stress <= vowelIdxs.length) return vowelIdxs[stress - 1];
    return -1;
}

function formatWordWithStress(word, stress, applyStress = true) {
    if (!word) return '';
    if (!applyStress || stress == null) return escapeHtml(word);

    const chars = [...word];
    const si = stressVowelIndex(word, stress);
    if (si < 0) return escapeHtml(word);

    let html = '';
    for (let i = 0; i < chars.length; i++) {
        if (i === si) {
            html += `<span class="stress-vowel">${escapeHtml(chars[i])}</span>`;
        } else {
            html += escapeHtml(chars[i]);
        }
    }
    return html;
}

function effectiveStemPrefix(stem) {
    if (!stem) return '';
    return String(stem).replace(/\([^)]*\)/g, '');
}

function splitStemSuffix(form, stem) {
    if (!form || !stem) return null;
    const flat = effectiveStemPrefix(stem);
    if (flat.length >= 1 && form.startsWith(flat) && form.length > flat.length) {
        return { stem: flat, suffix: form.slice(flat.length) };
    }
    const expanded = stem.replace(/\(([^)]*)\)/g, '$1').replace(/[()]/g, '');
    if (expanded.length > flat.length && form.startsWith(expanded) && form.length > expanded.length) {
        return { stem: expanded, suffix: form.slice(expanded.length) };
    }
    return null;
}

/**
 * Разбить перевод по ";" на строки — на мобильных короткая колонка
 * иначе превращает несколько значений в нечитаемую простыню.
 * ";" и перенос строки переключаются CSS-медиа-запросом (см. .gloss-break,
 * .gloss-semicolon): на десктопе — "; " как раньше, на мобильных — перенос
 * строки вместо точки с запятой.
 */
function formatGlossMultiline(text) {
    if (!text) return '';
    return text
        .split(';')
        .map(part => part.trim())
        .filter(Boolean)
        .map(escapeHtml)
        .join('<span class="gloss-semicolon">; </span><br class="gloss-break">');
}

/** Перевод + помета/комментарий: основной текст и подстрочная строка. */
function formatGlossWithNote(main, note) {
    const text = main ? (Array.isArray(main) ? main.join('; ') : String(main)) : '';
    if (!text && !note) return '';
    if (!note) return escapeHtml(text);
    const mainHtml = text
        ? `<span class="gloss-main">${escapeHtml(text)}</span>`
        : '';
    return `${mainHtml}<span class="gloss-sub">${escapeHtml(note)}</span>`;
}

function exampleRuParts(ex) {
    if (ex.note) return { ru: ex.ru || '', note: ex.note };
    const ru = ex.ru || '';
    const m = ru.match(/^(.+?)\s+\(([^)]+)\)\s*$/);
    if (m) return { ru: m[1].trim(), note: m[2].trim() };
    return { ru, note: null };
}

function formatFormDisplay(form, headword, stem, stress) {
    const showStress = headword && normalizeWord(form) === normalizeWord(headword);
    const parts = splitStemSuffix(form, stem);
    if (parts) {
        return (
            `<span class="form-stem">${formatWordWithStress(parts.stem, stress, showStress)}</span>` +
            `<span class="form-suffix">${escapeHtml(parts.suffix)}</span>`
        );
    }
    return formatWordWithStress(form, stress, showStress);
}

/**
 * Binary search to find words starting with prefix
 */
function binarySearchPrefix(words, prefix) {
    const prefixNorm = normalizeWord(prefix);
    let left = 0;
    let right = words.length - 1;
    let result = -1;

    // Find first word >= prefix
    while (left <= right) {
        const mid = Math.floor((left + right) / 2);
        const wordNorm = normalizeWord(words[mid]);

        if (wordNorm >= prefixNorm) {
            result = mid;
            right = mid - 1;
        } else {
            left = mid + 1;
        }
    }

    if (result === -1) return [];

    // Collect all words with this prefix
    const matches = [];
    for (let i = result; i < words.length && matches.length < CONFIG.MAX_SUGGESTIONS; i++) {
        if (normalizeWord(words[i]).startsWith(prefixNorm)) {
            matches.push(words[i]);
        } else {
            break;
        }
    }

    return matches;
}

/**
 * Все заглавные слова с префиксом (листинг при неполном вводе).
 */
function collectPrefixMatches(words, prefix, limit = CONFIG.MAX_PREFIX_LIST) {
    const prefixNorm = normalizeWord(prefix);
    if (!prefixNorm) return [];

    let left = 0;
    let right = words.length - 1;
    let start = -1;

    while (left <= right) {
        const mid = Math.floor((left + right) / 2);
        const wordNorm = normalizeWord(words[mid]);
        if (wordNorm >= prefixNorm) {
            start = mid;
            right = mid - 1;
        } else {
            left = mid + 1;
        }
    }

    if (start === -1) return [];

    const matches = [];
    for (let i = start; i < words.length && matches.length < limit; i++) {
        if (normalizeWord(words[i]).startsWith(prefixNorm)) {
            matches.push(words[i]);
        } else {
            break;
        }
    }
    return matches;
}

/**
 * Exact match in sorted index (для gender_forms и словоформ, не только заглавных слов).
 */
function findExactWordInIndex(words, query) {
    const qn = normalizeWord(query);
    if (!qn) return null;

    let left = 0;
    let right = words.length - 1;

    while (left <= right) {
        const mid = Math.floor((left + right) / 2);
        const wn = normalizeWord(words[mid]);

        if (wn === qn) {
            return words[mid];
        }
        if (wn < qn) {
            left = mid + 1;
        } else {
            right = mid - 1;
        }
    }

    return null;
}

/**
 * Normalize word for comparison (handle special characters)
 * Replaces various "stick" characters with Cyrillic Palochka (U+04CF)
 */
function normalizeWord(word) {
    let normalized = word.toLowerCase().trim();
    // Replace all variants of stick (1, I, i, l, L, |, !, Ӏ) with ӏ (U+04CF)
    // Include both U+04C0 (Ӏ) and U+04CF (ӏ) for compatibility
    // Added: ! (exclamation), ǀ (latin letter dental click), various other pipe-like chars
    normalized = normalized.replace(/[1IiｌlL|!ǀӀІ]/g, 'ӏ');
    // ё печатают редко — «елка» должно находить «ёлка». Согласовано с
    // normalize_word() в build_data.py (там же см. про порядок сортировки
    // индекса — ё вне основного кириллического блока, U+0451, после «я»).
    normalized = normalized.replace(/ё/g, 'е');
    return normalized;
}

// ============================================================================
// DATA LOADING
// ============================================================================

/**
 * Load words index from file
 */
async function loadWordsIndex(dictType) {
    try {
        const response = await fetch(assetUrl(`data/${dictType}/index.words.txt`));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        
        const text = await response.text();
        const words = text.trim().split('\n').filter(w => w.length > 0);
        
        console.log(`Loaded ${words.length} words for ${dictType}`);
        return words;
    } catch (error) {
        console.error('Error loading words index:', error);
        throw new Error('Не удалось загрузить индекс слов');
    }
}

async function loadHeadwordsIndex(dictType) {
    const response = await fetch(assetUrl(`data/${dictType}/index.headwords.txt`));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    const words = text.trim().split('\n').filter(w => w.length > 0);
    console.log(`Loaded ${words.length} headwords for ${dictType}`);
    return words;
}

async function loadBrowse(dictType) {
    const response = await fetch(assetUrl(`data/${dictType}/browse.json`));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    console.log(`Loaded browse.json (${Object.keys(data).length} entries)`);
    return data;
}

async function loadFormToHeadword(dictType) {
    const response = await fetch(assetUrl(`data/${dictType}/form_to_headword.json`));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    console.log(`Loaded form_to_headword.json (${Object.keys(data).length} forms)`);
    return data;
}

/** Заглавное слово для строки из индекса (форма, родовая форма или lemma). */
function resolveToHeadword(word) {
    if (!word) return null;
    if (state.headwordsSet && state.headwordsSet.has(word)) return word;
    if (state.formToHeadword && state.formToHeadword[word]) {
        return state.formToHeadword[word];
    }
    return null;
}

/** #word= в URL: статья (lemma), для чистой формы без статьи — заглавное слово. */
function wordForUrl(query) {
    if (!query) return query;
    if (state.headwordsSet && state.headwordsSet.has(query)) return query;
    const head = resolveToHeadword(query);
    return head || query;
}

/**
 * Префикс по всему индексу (формы + gender_forms), в таблице — заглавные слова.
 */
function collectPrefixHeadwords(query) {
    if (!state.wordsIndex) return [];

    const raw = collectPrefixMatches(
        state.wordsIndex,
        query,
        CONFIG.MAX_PREFIX_LIST * 3
    );
    const seen = new Set();
    const headwords = [];

    for (const w of raw) {
        const head = resolveToHeadword(w);
        if (!head || seen.has(head)) continue;
        seen.add(head);
        headwords.push(head);
        if (headwords.length >= CONFIG.MAX_PREFIX_LIST) break;
    }

    return headwords;
}

function getBrowseEntry(word) {
    return (state.browse && state.browse[word]) || { g: '', forms: [] };
}

function formatFormsPreview(word, forms) {
    if (!forms || !forms.length) return '';
    const headNorm = normalizeWord(word);
    const others = forms.filter(f => normalizeWord(f) !== headNorm);
    const show = (others.length ? others : forms.slice(1)).slice(0, 4);
    return show.join(', ');
}

/**
 * Load manifest with chunk information
 */
async function loadManifest(dictType) {
    try {
        const response = await fetch(assetUrl(`data/${dictType}/manifest.json`));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        
        const manifest = await response.json();
        console.log(`Loaded manifest for ${dictType}: ${manifest.chunks.length} chunks`);
        return manifest;
    } catch (error) {
        console.error('Error loading manifest:', error);
        throw new Error('Не удалось загрузить манифест');
    }
}

/**
 * Load chunk data
 */
async function loadChunk(dictType, chunkFile) {
    const cacheKey = `${dictType}:${chunkFile}`;
    
    // Check cache
    if (state.chunkCache.has(cacheKey)) {
        return state.chunkCache.get(cacheKey);
    }
    
    try {
        const response = await fetch(assetUrl(`data/${dictType}/chunks/${chunkFile}`));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        
        const data = await response.json();
        
        // Update cache (LRU-like: remove oldest if too large)
        if (state.chunkCache.size >= CONFIG.CHUNK_CACHE_SIZE) {
            const firstKey = state.chunkCache.keys().next().value;
            state.chunkCache.delete(firstKey);
        }
        state.chunkCache.set(cacheKey, data);
        
        return data;
    } catch (error) {
        console.error(`Error loading chunk ${chunkFile}:`, error);
        throw new Error(`Не удалось загрузить данные для "${chunkFile}"`);
    }
}

/**
 * Find which chunk contains a word
 */
function findChunkForWord(word, manifest) {
    const wordNorm = normalizeWord(word);
    
    // Find the longest matching prefix
    let bestMatch = null;
    let longestPrefixLength = 0;
    
    for (const chunk of manifest.chunks) {
        const prefixNorm = normalizeWord(chunk.prefix);
        if (wordNorm.startsWith(prefixNorm) && prefixNorm.length > longestPrefixLength) {
            bestMatch = chunk.file;
            longestPrefixLength = prefixNorm.length;
        }
    }
    
    return bestMatch;
}

/**
 * Get word data from chunk
 */
async function getWordData(word, dictType) {
    const manifest = state.manifest;
    if (!manifest) throw new Error('Manifest not loaded');
    
    const chunkFile = findChunkForWord(word, manifest);
    if (!chunkFile) {
        return null;
    }
    
    const chunkData = await loadChunk(dictType, chunkFile);
    
    // chunkData is an object with words as keys: {word: entry, ...}
    // Try direct lookup first
    if (chunkData[word]) {
        return chunkData[word];
    }
    
    // Fallback: case-insensitive search
    const wordNorm = normalizeWord(word);
    for (const [key, entry] of Object.entries(chunkData)) {
        if (normalizeWord(key) === wordNorm) {
            return entry;
        }
    }
    
    return null;
}

// ============================================================================
// UI RENDERING
// ============================================================================

/**
 * Render suggestions dropdown
 */
function renderSuggestions(suggestions) {
    const suggestionsEl = document.getElementById('suggestions');
    
    if (suggestions.length === 0) {
        suggestionsEl.style.display = 'none';
        return;
    }
    
    suggestionsEl.innerHTML = suggestions
        .map(word => `
            <div class="suggestion-item" data-word="${escapeHtml(word)}">
                ${escapeHtml(word)}
            </div>
        `)
        .join('');
    
    suggestionsEl.style.display = 'block';
}

/**
 * Render word card
 */
function renderWordCard(wordData) {
    let html = '<div class="word-card">';
    
    // Header
    html += `<div class="word-header">`;
    html += `<div class="word-title-row">`;
    html += `<h2 class="word-title">${escapeHtml(wordData.word)}</h2>`;
    if (wordData.exclamation) {
        html += `<span class="word-excl" title="${escapeHtml(SITE.ui.exclamation)}">${escapeHtml(wordData.exclamation)}</span>`;
    }
    html += `</div>`;
    if (wordData.gender_forms && wordData.gender_forms.length > 0) {
        html += '<div class="word-gender-forms">';
        html += `<span class="forms-label">${escapeHtml(SITE.ui.byGender)}:</span> `;
        html += wordData.gender_forms
            .map((form, i) => {
                const hint = GENDER_FORM_HINTS[i] || '';
                const titleAttr = hint ? ` title="${escapeHtml(hint)}"` : '';
                return `<span class="form-chip gender-form-chip lookup-link" data-word="${escapeHtml(form)}"${titleAttr}>${escapeHtml(form)}</span>`;
            })
            .join(' ');
        html += '</div>';
    }
    html += `</div>`;

    // Process results
    if (wordData.results && wordData.results.length > 0) {
        for (const result of wordData.results) {
            html += '<div class="result-block">';
            
            // Labels (части речи, грамматика)
            const senseLabels = filterDisplayLabels(result.labels);
            if (senseLabels.length > 0) {
                html += '<div class="result-labels">';
                html += senseLabels
                    .map(label => `<span class="label">${escapeHtml(label)}</span>`)
                    .join('');
                html += '</div>';
            }
            
            // precomment — пометка перед переводом
            if (result.precomment) {
                html += `<div class="result-precomment">${escapeHtml(result.precomment)}</div>`;
            }

            // Translation: основной глосс; comment — сноска (длинные пометы без дублей в JSON)
            const trans = result.translation;
            const comm = result.comment;
            if (trans || comm) {
                const c = comm ? (Array.isArray(comm) ? comm.join('; ') : comm) : '';
                html += `<div class="result-translation">${formatGlossWithNote(trans, c || null)}</div>`;
            }
            
            // Forms (формы слова)
            if (result.forms && result.forms.length > 0) {
                html += '<div class="result-forms">';
                html += `<span class="forms-label">${escapeHtml(SITE.ui.forms)}:</span> `;
                html += result.forms
                    .map(form => {
                        const inner = formatFormDisplay(
                            form, wordData.word, wordData.stem, wordData.stress
                        );
                        return `<span class="form-chip">${inner}</span>`;
                    })
                    .join(' ');
                html += '</div>';
            }
            
            // Examples (примеры) - NEW: Support for split av/ru format
            if (result.examples && result.examples.length > 0) {
                html += '<div class="result-examples">';
                html += result.examples
                    .map(ex => {
                        if (typeof ex === 'object' && ex !== null && ex.av && (ex.ru || ex.note)) {
                            const { ru, note } = exampleRuParts(ex);
                            return `<div class="example-item example-grid">` +
                                   `<span class="example-av">${escapeHtml(ex.av)}</span>` +
                                   `<span class="example-ru">${formatGlossWithNote(ru, note)}</span>` +
                                   `</div>`;
                        }
                        // Fallback for old format or if only one part exists
                        return `<div class="example-item">${escapeHtml(ex.orig || ex)}</div>`;
                    })
                    .join('');
                html += '</div>';
            }
            
            // Relations (масдар от, род.пад. от, мн.ч. от, понуд. к, ...)
            if (result.relations && result.relations.length > 0) {
                html += '<div class="result-relations">';
                html += result.relations
                    .map(rel => {
                        const kind = escapeHtml(rel.kind);
                        const target = escapeHtml(rel.target);
                        return `<span class="relation-item"><span class="relation-kind">${kind}:</span> ` +
                               `<span class="relation-link lookup-link" data-word="${target}">${target}</span></span>`;
                    })
                    .join(' ');
                html += '</div>';
            }

            // Lookup (связанные слова)
            if (result.lookup && result.lookup.length > 0) {
                html += '<div class="result-lookup">';
                html += `<span class="lookup-label">${escapeHtml(SITE.ui.seeAlso)}:</span> `;
                html += result.lookup
                    .map(word => `<span class="lookup-link" data-word="${escapeHtml(word)}">${escapeHtml(word)}</span>`)
                    .join(', ');
                html += '</div>';
            }
            
            html += '</div>'; // result-block
        }
    }
    
    html += '</div>'; // word-card
    return html;
}

/**
 * Пустой экран: случайные слова, без «ничего не найдено».
 */
function clearSearchView() {
    const resultsEl = document.getElementById('results');
    const randomSection = document.getElementById('randomWordsSection');

    renderSuggestions([]);
    if (resultsEl) {
        resultsEl.innerHTML = '';
        resultsEl.style.display = 'block';
    }
    updateSearchStats('', 0);
    showLoading(false);

    if (randomSection) {
        randomSection.style.display = 'block';
        renderHomeSamples();
    }

    if (window.location.hash) {
        history.replaceState(null, '', window.location.pathname + window.location.search);
    }
}

/**
 * Запрос был, совпадений нет.
 */
function renderNotFound() {
    const resultsEl = document.getElementById('results');
    const randomSection = document.getElementById('randomWordsSection');

    resultsEl.innerHTML = `
        <div class="no-results">
            <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
                <circle cx="24" cy="24" r="20" stroke="currentColor" stroke-width="2"/>
                <path d="M24 16v12M24 32v.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
            <p>Ничего не найдено</p>
            <p class="no-results-hint">Попробуйте изменить запрос</p>
        </div>
    `;
    resultsEl.style.display = 'block';
    if (randomSection) randomSection.style.display = 'none';
}

/**
 * Render search results
 */
function renderResults(results) {
    const resultsEl = document.getElementById('results');
    const randomSection = document.getElementById('randomWordsSection');

    if (!results || results.length === 0) {
        renderNotFound();
        return;
    }

    resultsEl.innerHTML = results.map(renderWordCard).join('');
    resultsEl.style.display = 'block';
    if (randomSection) randomSection.style.display = 'none';
    
    // Add click handlers for lookup links
    resultsEl.querySelectorAll('.lookup-link').forEach(link => {
        link.addEventListener('click', () => {
            const word = link.dataset.word;
            const searchInput = document.getElementById('searchInput');
            searchInput.value = word;
            loadAndDisplayWord(word);
        });
    });
}

/**
 * Таблица слов с формами и кратким переводом (avar.me).
 */
function renderWordListTable(words, options = {}) {
    const { caption = '' } = options;
    const rows = words.map(word => {
        const { g, forms } = getBrowseEntry(word);
        const formsText = formatFormsPreview(word, forms);
        // На мобильных колонка "Формы" скрыта (styles.css) — формы показываются
        // мелким шрифтом под словом внутри той же ячейки.
        const formsInline = formsText
            ? `<span class="word-list-forms-inline">${escapeHtml(formsText)}</span>`
            : '';
        return `
            <tr class="word-list-row" data-word="${escapeHtml(word)}" tabindex="0" role="button">
                <td class="word-list-word">${escapeHtml(word)}${formsInline}</td>
                <td class="word-list-forms">${escapeHtml(formsText)}</td>
                <td class="word-list-gloss">${formatGlossMultiline(g)}</td>
            </tr>
        `;
    }).join('');

    const cap = caption
        ? `<p class="word-list-caption">${escapeHtml(caption)}</p>`
        : '';

    return `
        ${cap}
        <div class="word-list-scroll">
            <table class="word-list">
                <thead>
                    <tr>
                        <th>Слово</th>
                        <th>Формы</th>
                        <th>Перевод</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `;
}

/**
 * Листинг по префиксу (неполное слово).
 */
function renderPrefixList(query, headwords) {
    const resultsEl = document.getElementById('results');
    const randomSection = document.getElementById('randomWordsSection');
    const caption =
        headwords.length >= CONFIG.MAX_PREFIX_LIST
            ? `Слова на «${query}» (показаны первые ${CONFIG.MAX_PREFIX_LIST})`
            : `Слова на «${query}» — ${headwords.length}`;

    resultsEl.innerHTML = renderWordListTable(headwords, { caption });
    resultsEl.style.display = 'block';
    if (randomSection) randomSection.style.display = 'none';
    updateSearchStats('', 0);
}

/**
 * Случайные статьи на главной.
 */
function renderHomeSamples() {
    const container = document.getElementById('homeSamples');
    if (!container || !state.headwordsIndex || !state.headwordsIndex.length) return;

    const picks = [];
    const used = new Set();
    const n = Math.min(CONFIG.HOME_SAMPLES, state.headwordsIndex.length);

    while (picks.length < n) {
        const idx = Math.floor(Math.random() * state.headwordsIndex.length);
        if (used.has(idx)) continue;
        used.add(idx);
        picks.push(state.headwordsIndex[idx]);
    }

    container.innerHTML = renderWordListTable(picks);
}

/**
 * Show loading state
 */
function showLoading(show = true) {
    const loadingEl = document.getElementById('loading');
    const resultsEl = document.getElementById('results');
    
    if (show) {
        loadingEl.style.display = 'flex';
        resultsEl.style.display = 'none';
    } else {
        loadingEl.style.display = 'none';
        resultsEl.style.display = 'block';
    }
}

/**
 * Show error message
 */
function showError(message) {
    const errorEl = document.getElementById('error');
    errorEl.textContent = message;
    errorEl.style.display = 'block';
    
    setTimeout(() => {
        errorEl.style.display = 'none';
    }, 5000);
}

/**
 * Update search stats
 */
function updateSearchStats(query, resultsCount) {
    const statsEl = document.getElementById('searchStats');
    
    if (!query) {
        statsEl.textContent = '';
        return;
    }
    
    if (resultsCount === 0) {
        statsEl.textContent = `Ничего не найдено для "${query}"`;
    } else {
        statsEl.textContent = '';
    }
}

// ============================================================================
// SEARCH LOGIC
// ============================================================================

/**
 * Handle search input
 */
const handleSearchInput = debounce(async (query) => {
    state.currentQuery = query;
    
    const randomSection = document.getElementById('randomWordsSection');
    
    if (!query || query.length < 1) {
        clearSearchView();
        return;
    }
    
    if (randomSection) randomSection.style.display = 'none';
    showLoading(true);

    const suggestions = binarySearchPrefix(state.wordsIndex, query);
    renderSuggestions(suggestions);
    
    const exactWord =
        findExactWordInIndex(state.wordsIndex, query) ||
        suggestions.find(w => normalizeWord(w) === normalizeWord(query));

    if (exactWord) {
        await loadAndDisplayWord(exactWord);
        return;
    }

    let chunkHit = null;
    try {
        chunkHit = await getWordData(query, state.currentDictType);
    } catch (err) {
        console.warn('Chunk lookup:', err);
    }
    if (chunkHit) {
        showLoading(false);
        renderResults([chunkHit]);
        window.location.hash = `word=${encodeURIComponent(wordForUrl(query))}`;
        updateSearchStats('', 0);
        return;
    }

    // Неполное слово — листинг (заглавные + совпадения по формам и gender_forms)
    if (query.length >= CONFIG.MIN_PREFIX_LIST) {
        const headwords = collectPrefixHeadwords(query);
        if (headwords.length > 0) {
            showLoading(false);
            renderPrefixList(query, headwords);
            return;
        }
    }

    showLoading(false);
    renderNotFound();
    updateSearchStats(query, 0);
}, CONFIG.DEBOUNCE_DELAY);

/**
 * Load and display word data
 */
async function loadAndDisplayWord(word) {
    try {
        showLoading(true);
        
        const wordData = await getWordData(word, state.currentDictType);
        
        showLoading(false);
        
        if (wordData) {
            renderResults([wordData]);
            updateSearchStats(word, 1);
            const urlWord = wordForUrl(word);
            window.location.hash = `word=${encodeURIComponent(urlWord)}`;
        } else {
            renderNotFound();
            updateSearchStats(word, 0);
        }
    } catch (error) {
        console.error('Error loading word:', error);
        showLoading(false);
        showError(error.message);
    }
}

// ============================================================================
// DICTIONARY TYPE SWITCHING
// ============================================================================

const DICT_TITLES = Object.fromEntries(
    SITE.dicts.map((d) => [d.id, { doc: d.title }])
);

/**
 * Switch dictionary type (av-ru / ru-av)
 */
async function switchDictType(newType) {
    if (newType === state.currentDictType) return;

    const searchInput = document.getElementById('searchInput');

    try {
        showLoading(true);

        // Update state
        state.currentDictType = newType;

        // Load new index and manifest — параллельно, см. init()
        const [wordsIndex, headwordsIndex, formToHeadword, browse, manifest] = await Promise.all([
            loadWordsIndex(newType),
            loadHeadwordsIndex(newType),
            loadFormToHeadword(newType),
            loadBrowse(newType),
            loadManifest(newType),
        ]);
        state.wordsIndex = wordsIndex;
        state.headwordsIndex = headwordsIndex;
        state.headwordsSet = new Set(headwordsIndex);
        state.formToHeadword = formToHeadword;
        state.browse = browse;
        state.manifest = manifest;

        // Clear cache
        state.chunkCache.clear();

        // Update UI
        document.querySelectorAll('.toggle-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.type === newType);
        });
        const t = DICT_TITLES[newType];
        if (t) {
            document.title = t.doc;
        }

        // Строка поиска могла быть заполнена и до переключения, и во время
        // загрузки нового словаря — в обоих случаях не затираем её, а ищем
        // введённый запрос уже в новом словаре. Чистим только пустое поле.
        const query = searchInput.value.trim();
        if (query) {
            const clearBtn = document.getElementById('clearBtn');
            if (clearBtn) clearBtn.style.display = 'block';
            handleSearchInput(query);
        } else {
            clearSearchView();
        }
        searchInput.focus();

        showLoading(false);

        console.log(`Switched to ${newType}`);
    } catch (error) {
        console.error('Error switching dictionary type:', error);
        showError(error.message);
        showLoading(false);
    }
}

// ============================================================================
// EVENT HANDLERS
// ============================================================================

/**
 * Initialize event listeners
 */
function initEventListeners() {
    const searchInput = document.getElementById('searchInput');
    const clearBtn = document.getElementById('clearBtn');
    const suggestionsEl = document.getElementById('suggestions');
    
    // Search input
    searchInput.addEventListener('input', (e) => {
        let value = e.target.value;
        const cursorPos = e.target.selectionStart;
        
        // Auto-replace 1, I, i, l, L, | with ӏ in the input field
        const normalizedValue = value.replace(/[1IiｌlL|!ǀӀІ]/g, 'ӏ');
        
        if (normalizedValue !== value) {
            e.target.value = normalizedValue;
            // Restore cursor position
            e.target.setSelectionRange(cursorPos, cursorPos);
            value = normalizedValue;
        }
        
        const query = value.trim();
        clearBtn.style.display = query ? 'block' : 'none';
        handleSearchInput(query);
    });
    
    // Clear button
    clearBtn.addEventListener('click', () => {
        handleSearchInput.cancel();
        state.currentQuery = '';
        searchInput.value = '';
        clearBtn.style.display = 'none';
        clearSearchView();
        searchInput.focus();
    });
    
    // Строка таблицы (главная или листинг по префиксу)
    document.addEventListener('click', (e) => {
        const row = e.target.closest('.word-list-row');
        if (!row) return;
        const word = row.dataset.word;
        if (!word) return;
        searchInput.value = word;
        clearBtn.style.display = 'block';
        renderSuggestions([]);
        loadAndDisplayWord(word);
    });

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const row = e.target.closest('.word-list-row');
        if (!row) return;
        e.preventDefault();
        row.click();
    });

    // Suggestion click
    suggestionsEl.addEventListener('click', (e) => {
        const item = e.target.closest('.suggestion-item');
        if (item) {
            const word = item.dataset.word;
            searchInput.value = word;
            renderSuggestions([]);
            loadAndDisplayWord(word);
        }
    });
    
    // Dictionary type toggle (несколько словарей; в dev3 только av-ru)
    document.querySelectorAll('.toggle-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            switchDictType(btn.dataset.type);
        });
    });
    
    // Close suggestions on outside click
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.search-container')) {
            renderSuggestions([]);
        }
    });
    
    // Handle URL hash (back/forward, открытие по ссылке).
    // Пока строка поиска в фокусе — пользователь печатает, хэш меняется
    // из-за резолва формы в лемму (loadAndDisplayWord), а не из-за навигации.
    window.addEventListener('hashchange', () => {
        if (document.activeElement === searchInput) return;

        const hash = window.location.hash.slice(1);
        const params = new URLSearchParams(hash);
        const word = params.get('word');

        if (word) {
            searchInput.value = word;
            loadAndDisplayWord(word);
        }
    });
}

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize the application
 */
async function init() {
    try {
        console.log('Initializing dictionary app...');

        showLoading(true);

        // #dict=ru-av&word=... — ссылка извне (напр. со страницы /phrases)
        // указывает, какой словарь открыть, до того как данные загружены.
        const initialHash = window.location.hash.slice(1);
        const initialParams = new URLSearchParams(initialHash);
        const dictParam = initialParams.get('dict');
        if (dictParam && DICT_TITLES[dictParam]) {
            state.currentDictType = dictParam;
        }

        // Load initial data — параллельно, а не по очереди (RTT одного запроса
        // вместо суммы пяти).
        const initDictType = state.currentDictType;
        const [wordsIndex, headwordsIndex, formToHeadword, browse, manifest] = await Promise.all([
            loadWordsIndex(initDictType),
            loadHeadwordsIndex(initDictType),
            loadFormToHeadword(initDictType),
            loadBrowse(initDictType),
            loadManifest(initDictType),
        ]);
        state.wordsIndex = wordsIndex;
        state.headwordsIndex = headwordsIndex;
        state.headwordsSet = new Set(headwordsIndex);
        state.formToHeadword = formToHeadword;
        state.browse = browse;
        state.manifest = manifest;

        // Mark initial active toggle button
        document.querySelectorAll('.toggle-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.type === state.currentDictType);
        });
        const initialTitle = DICT_TITLES[state.currentDictType];
        if (initialTitle) {
            document.title = initialTitle.doc;
        }

        // Initialize event listeners
        initEventListeners();

        showLoading(false);

        // Check URL hash for initial word
        const word = initialParams.get('word');

        if (word) {
            const searchInput = document.getElementById('searchInput');
            searchInput.value = word;
            document.getElementById('clearBtn').style.display = 'block';
            await loadAndDisplayWord(word);
        } else {
            renderHomeSamples();
        }
        
        // Focus search input
        document.getElementById('searchInput').focus();
        
        console.log('Dictionary app initialized successfully');
    } catch (error) {
        console.error('Initialization error:', error);
        showLoading(false);
        showError('Ошибка инициализации приложения: ' + error.message);
    }
}

// Start the app when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
