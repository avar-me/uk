/**
 * Аварско-русский словарь - Telegram Mini App
 */

// ============================================================================
// TELEGRAM WEB APP INTEGRATION
// ============================================================================

let tg = null;

function initTelegram() {
    if (typeof Telegram !== 'undefined' && Telegram.WebApp) {
        tg = Telegram.WebApp;
        
        // Expand to full height
        tg.expand();
        
        // Enable closing confirmation (only if supported)
        if (tg.enableClosingConfirmation && parseFloat(tg.version) >= 6.1) {
            tg.enableClosingConfirmation();
        }
        
        // Set header color
        tg.setHeaderColor('secondary_bg_color');
        
        // Apply theme colors
        applyTelegramTheme();
        
        console.log('Telegram Web App initialized');
    }
}

function applyTelegramTheme() {
    if (!tg) return;
    
    const root = document.documentElement;
    const themeParams = tg.themeParams;
    
    if (themeParams.bg_color) root.style.setProperty('--tg-bg', themeParams.bg_color);
    if (themeParams.text_color) root.style.setProperty('--tg-text', themeParams.text_color);
    if (themeParams.hint_color) root.style.setProperty('--tg-hint', themeParams.hint_color);
    if (themeParams.link_color) root.style.setProperty('--tg-link', themeParams.link_color);
    if (themeParams.button_color) root.style.setProperty('--tg-button', themeParams.button_color);
    if (themeParams.button_text_color) root.style.setProperty('--tg-button-text', themeParams.button_text_color);
    if (themeParams.secondary_bg_color) root.style.setProperty('--tg-secondary-bg', themeParams.secondary_bg_color);
}

function hapticFeedback(type = 'light') {
    if (tg && tg.HapticFeedback) {
        switch (type) {
            case 'light':
                tg.HapticFeedback.impactOccurred('light');
                break;
            case 'medium':
                tg.HapticFeedback.impactOccurred('medium');
                break;
            case 'heavy':
                tg.HapticFeedback.impactOccurred('heavy');
                break;
            case 'success':
                tg.HapticFeedback.notificationOccurred('success');
                break;
            case 'error':
                tg.HapticFeedback.notificationOccurred('error');
                break;
        }
    }
}

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
    MAX_SUGGESTIONS: 20,
    DEBOUNCE_DELAY: 150,
    CHUNK_CACHE_SIZE: 50,
    DEFAULT_DICT_TYPE: (typeof window !== 'undefined' && window.__SITE__ && window.__SITE__.dicts && window.__SITE__.dicts[0].id) || 'av-ru'
};

const SITE_UI = (typeof window !== 'undefined' && window.__SITE__ && window.__SITE__.ui) || {
    forms: 'Формы',
    byGender: 'По родам',
    seeAlso: 'См. также',
    exclamation: 'Восклицательная форма',
    genderHints: ['м. р.', 'ж. р.', 'ср. р.'],
};

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

const state = {
    currentDictType: CONFIG.DEFAULT_DICT_TYPE,
    wordsIndex: null,
    manifest: null,
    chunkCache: new Map(),
    currentQuery: '',
    isLoading: false
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function debounce(func, delay) {
    let timeoutId;
    return function (...args) {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => func.apply(this, args), delay);
    };
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function isHomonymLabel(label) {
    const s = String(label).trim().toLowerCase().replace(/\s+/g, '');
    return s === 'омоним' || (s.startsWith('омоним') && /^\d+$/.test(s.slice(6)));
}

function filterDisplayLabels(labels) {
    return (labels || []).filter(l => l && !isHomonymLabel(l));
}

const GENDER_FORM_HINTS = SITE_UI.genderHints;

const VOWEL_RE = /[аеёиоуыэюяӀӏ]/iu;

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
        html += i === si
            ? `<span class="stress-vowel">${escapeHtml(chars[i])}</span>`
            : escapeHtml(chars[i]);
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

function formatGlossWithNote(main, note) {
    const text = main ? (Array.isArray(main) ? main.join('; ') : String(main)) : '';
    if (!text && !note) return '';
    if (!note) return escapeHtml(text);
    const mainHtml = text ? `<span class="gloss-main">${escapeHtml(text)}</span>` : '';
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

function binarySearchPrefix(words, prefix) {
    const prefixNorm = normalizeWord(prefix);
    let left = 0;
    let right = words.length - 1;
    let result = -1;

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

function normalizeWord(word) {
    let normalized = word.toLowerCase().trim();
    // Replace all variants of stick (1, I, i, l, L, |, !, Ӏ) with ӏ (U+04CF)
    // Include both U+04C0 (Ӏ) and U+04CF (ӏ) for compatibility
    // Added: ! (exclamation), ǀ (latin letter dental click), various other pipe-like chars
    normalized = normalized.replace(/[1IiｌlL|!ǀӀІ]/g, 'ӏ');
    return normalized;
}

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

// ============================================================================
// DATA LOADING
// ============================================================================

async function loadWordsIndex(dictType) {
    try {
        const response = await fetch(`data/${dictType}/index.words.txt`);
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

async function loadManifest(dictType) {
    try {
        const response = await fetch(`data/${dictType}/manifest.json`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        
        const manifest = await response.json();
        console.log(`Loaded manifest for ${dictType}: ${manifest.chunks.length} chunks`);
        return manifest;
    } catch (error) {
        console.error('Error loading manifest:', error);
        throw new Error('Не удалось загрузить манифест');
    }
}

async function loadChunk(dictType, chunkFile) {
    const cacheKey = `${dictType}:${chunkFile}`;
    
    if (state.chunkCache.has(cacheKey)) {
        return state.chunkCache.get(cacheKey);
    }
    
    try {
        const response = await fetch(`data/${dictType}/chunks/${chunkFile}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        
        const data = await response.json();
        
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

function renderWordCard(wordData) {
    let html = '<div class="word-card">';
    
    html += `<div class="word-header">`;
    html += `<div class="word-title-row">`;
    html += `<h2 class="word-title">${escapeHtml(wordData.word)}</h2>`;
    if (wordData.exclamation) {
        html += `<span class="word-excl" title="${escapeHtml(SITE_UI.exclamation)}">${escapeHtml(wordData.exclamation)}</span>`;
    }
    html += `</div>`;
    if (wordData.gender_forms && wordData.gender_forms.length > 0) {
        html += '<div class="word-gender-forms">';
        html += `<span class="forms-label">${escapeHtml(SITE_UI.byGender)}:</span> `;
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
    
    if (wordData.results && wordData.results.length > 0) {
        for (const result of wordData.results) {
            html += '<div class="result-block">';
            
            const senseLabels = filterDisplayLabels(result.labels);
            if (senseLabels.length > 0) {
                html += '<div class="result-labels">';
                html += senseLabels
                    .map(label => `<span class="label">${escapeHtml(label)}</span>`)
                    .join('');
                html += '</div>';
            }
            
            if (result.precomment) {
                html += `<div class="result-precomment">${escapeHtml(result.precomment)}</div>`;
            }
            
            const trans = result.translation;
            const comm = result.comment;
            if (trans || comm) {
                const c = comm ? (Array.isArray(comm) ? comm.join('; ') : comm) : '';
                html += `<div class="result-translation">${formatGlossWithNote(trans, c || null)}</div>`;
            }
            
            if (result.forms && result.forms.length > 0) {
                html += '<div class="result-forms">';
                html += `<span class="forms-label">${escapeHtml(SITE_UI.forms)}:</span> `;
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
                        return `<div class="example-item">${escapeHtml(ex.orig || ex)}</div>`;
                    })
                    .join('');
                html += '</div>';
            }
            
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
            
            if (result.lookup && result.lookup.length > 0) {
                html += '<div class="result-lookup">';
                html += `<span class="lookup-label">${escapeHtml(SITE_UI.seeAlso)}:</span> `;
                html += result.lookup
                    .map(word => `<span class="lookup-link" data-word="${escapeHtml(word)}">${escapeHtml(word)}</span>`)
                    .join(', ');
                html += '</div>';
            }
            
            html += '</div>';
        }
    }
    
    html += '</div>';
    return html;
}

function renderResults(results) {
    const resultsEl = document.getElementById('results');
    const randomSection = document.getElementById('randomWordsSection');
    
    if (results.length === 0) {
        resultsEl.innerHTML = `
            <div class="no-results">
                <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
                    <circle cx="24" cy="24" r="20" stroke="currentColor" stroke-width="2"/>
                    <path d="M24 16v12M24 32v.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                </svg>
                <p>Ничего не найдено</p>
            </div>
        `;
        resultsEl.style.display = 'block';
        if (randomSection) randomSection.style.display = 'none';
        return;
    }
    
    resultsEl.innerHTML = results.map(renderWordCard).join('');
    resultsEl.style.display = 'block';
    if (randomSection) randomSection.style.display = 'none';
    
    // Add click handlers for lookup links
    resultsEl.querySelectorAll('.lookup-link').forEach(link => {
        link.addEventListener('click', () => {
            hapticFeedback('light');
            const word = link.dataset.word;
            const searchInput = document.getElementById('searchInput');
            searchInput.value = word;
            loadAndDisplayWord(word);
        });
    });
}

/**
 * Render random words on start page
 */
function renderRandomWords() {
    const randomWordsEl = document.getElementById('randomWords');
    if (!randomWordsEl || !state.wordsIndex || state.wordsIndex.length === 0) return;
    
    // Get 10 random words
    const randomWords = [];
    const usedIndices = new Set();
    const wordsCount = state.wordsIndex.length;
    
    while (randomWords.length < 10 && usedIndices.size < wordsCount) {
        const randomIndex = Math.floor(Math.random() * wordsCount);
        if (!usedIndices.has(randomIndex)) {
            usedIndices.add(randomIndex);
            randomWords.push(state.wordsIndex[randomIndex]);
        }
    }
    
    randomWordsEl.innerHTML = randomWords
        .map(word => `
            <div class="random-word-item" data-word="${escapeHtml(word)}">
                <span class="random-word-text">${escapeHtml(word)}</span>
            </div>
        `)
        .join('');
    
    // Add click handlers
    randomWordsEl.addEventListener('click', (e) => {
        const item = e.target.closest('.random-word-item');
        if (item) {
            hapticFeedback('light');
            const word = item.dataset.word;
            const searchInput = document.getElementById('searchInput');
            searchInput.value = word;
            loadAndDisplayWord(word);
        }
    });
}

function showLoading(show = true) {
    const loadingEl = document.getElementById('loading');
    const resultsEl = document.getElementById('results');
    const randomSection = document.getElementById('randomWordsSection');
    
    if (show) {
        loadingEl.style.display = 'flex';
        resultsEl.style.display = 'none';
        if (randomSection) randomSection.style.display = 'none';
    } else {
        loadingEl.style.display = 'none';
        // Don't automatically show results - let other functions control visibility
    }
}

function showError(message) {
    hapticFeedback('error');
    const errorEl = document.getElementById('error');
    errorEl.textContent = message;
    errorEl.style.display = 'block';
    
    setTimeout(() => {
        errorEl.style.display = 'none';
    }, 5000);
}

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

const handleSearchInput = debounce(async (query) => {
    state.currentQuery = query;
    
    const randomSection = document.getElementById('randomWordsSection');
    const resultsEl = document.getElementById('results');
    
    if (!query || query.length < 1) {
        renderSuggestions([]);
        if (resultsEl) {
            resultsEl.innerHTML = '';
            resultsEl.style.display = 'none';
        }
        updateSearchStats('', 0);
        if (randomSection) randomSection.style.display = 'block';
        return;
    }
    
    const suggestions = binarySearchPrefix(state.wordsIndex, query);
    renderSuggestions(suggestions);
    
    const exactWord =
        findExactWordInIndex(state.wordsIndex, query) ||
        suggestions.find(w => normalizeWord(w) === normalizeWord(query));

    if (exactWord) {
        await loadAndDisplayWord(exactWord);
    } else {
        await loadAndDisplayWord(query);
    }
}, CONFIG.DEBOUNCE_DELAY);

async function loadAndDisplayWord(word) {
    try {
        showLoading(true);
        
        const wordData = await getWordData(word, state.currentDictType);
        
        showLoading(false);
        
        if (wordData) {
            renderResults([wordData]);
            updateSearchStats(word, 1);
            hapticFeedback('success');
        } else {
            renderResults([]);
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

async function switchDictType(newType) {
    if (newType === state.currentDictType) return;
    
    try {
        showLoading(true);
        hapticFeedback('medium');
        
        state.currentDictType = newType;
        
        [state.wordsIndex, state.manifest] = await Promise.all([
            loadWordsIndex(newType),
            loadManifest(newType),
        ]);

        state.chunkCache.clear();
        renderSuggestions([]);
        updateSearchStats('', 0);
        
        document.querySelectorAll('.toggle-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.type === newType);
        });
        
        const searchInput = document.getElementById('searchInput');
        searchInput.value = '';
        
        // Hide results and show random words section
        const resultsEl = document.getElementById('results');
        const randomSection = document.getElementById('randomWordsSection');
        
        if (resultsEl) {
            resultsEl.innerHTML = '';
            resultsEl.style.display = 'none';
        }
        
        if (randomSection) {
            randomSection.style.display = 'block';
            renderRandomWords();
        }
        
        searchInput.focus();
        
        showLoading(false);
        hapticFeedback('success');
        
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

function initEventListeners() {
    const searchInput = document.getElementById('searchInput');
    const clearBtn = document.getElementById('clearBtn');
    const suggestionsEl = document.getElementById('suggestions');
    
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
    
    clearBtn.addEventListener('click', () => {
        hapticFeedback('light');
        searchInput.value = '';
        clearBtn.style.display = 'none';
        renderSuggestions([]);
        updateSearchStats('', 0);
        
        // Hide results and show random words section
        const resultsEl = document.getElementById('results');
        const randomSection = document.getElementById('randomWordsSection');
        
        if (resultsEl) {
            resultsEl.innerHTML = '';
            resultsEl.style.display = 'none';
        }
        
        if (randomSection) randomSection.style.display = 'block';
        
        searchInput.focus();
    });
    
    // Home button
    const homeBtn = document.getElementById('homeBtn');
    if (homeBtn) {
        homeBtn.addEventListener('click', () => {
            hapticFeedback('medium');
            
            // Clear search input
            searchInput.value = '';
            clearBtn.style.display = 'none';
            
            // Clear suggestions
            renderSuggestions([]);
            updateSearchStats('', 0);
            
            // Hide results and show random words section
            const resultsEl = document.getElementById('results');
            const randomSection = document.getElementById('randomWordsSection');
            
            if (resultsEl) {
                resultsEl.innerHTML = '';
                resultsEl.style.display = 'none';
            }
            
            if (randomSection) {
                randomSection.style.display = 'block';
                renderRandomWords();
            }
            
            // Clear URL parameters
            const url = new URL(window.location);
            url.searchParams.delete('word');
            window.history.pushState({}, '', url);
            
            // Focus search input
            searchInput.focus();
        });
    }
    
    suggestionsEl.addEventListener('click', (e) => {
        const item = e.target.closest('.suggestion-item');
        if (item) {
            hapticFeedback('light');
            const word = item.dataset.word;
            searchInput.value = word;
            renderSuggestions([]);
            loadAndDisplayWord(word);
        }
    });
    
    document.querySelectorAll('.toggle-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            switchDictType(btn.dataset.type);
        });
    });
    
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.search-container')) {
            renderSuggestions([]);
        }
    });
}

// ============================================================================
// INITIALIZATION
// ============================================================================

async function init() {
    try {
        
        // Initialize Telegram
        initTelegram();
        
        showLoading(true);
        
        [state.wordsIndex, state.manifest] = await Promise.all([
            loadWordsIndex(state.currentDictType),
            loadManifest(state.currentDictType),
        ]);

        initEventListeners();
        
        showLoading(false);
        
        // Hide results section and show random words on start
        const resultsEl = document.getElementById('results');
        const randomSection = document.getElementById('randomWordsSection');
        
        if (resultsEl) {
            resultsEl.innerHTML = '';
            resultsEl.style.display = 'none';
        }
        
        if (randomSection) {
            randomSection.style.display = 'block';
            renderRandomWords();
        }
        
        document.getElementById('searchInput').focus();
    } catch (error) {
        console.error('Initialization error:', error);
        showLoading(false);
        showError('Ошибка инициализации: ' + error.message);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
