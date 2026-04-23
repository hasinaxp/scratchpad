const normalizeMode = (mode) => {
    const raw = `${mode || 'text'}`.toLowerCase();
    if (raw === 'markdown' || raw === 'python' || raw === 'java' || raw === 'yaml') return 'text';
    if (raw === 'json' || raw === 'diff' || raw === 'table') return raw;
    return 'text';
};

const isCodeMode = (mode) => normalizeMode(mode) !== 'diff';

const normalize = (value) => `${value || ''}`.toLowerCase();

const tokenizeQuery = (query) => normalize(query)
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

const scoreSubsequence = (needle, haystack) => {
    if (!needle || !haystack) return 0;

    let score = 0;
    let h = 0;
    let prevMatch = -2;

    for (let n = 0; n < needle.length; n += 1) {
        const ch = needle[n];
        let matched = false;

        while (h < haystack.length) {
            if (haystack[h] !== ch) {
                h += 1;
                continue;
            }

            matched = true;
            score += 1;

            const isContiguous = h === prevMatch + 1;
            if (isContiguous) {
                score += 2;
            }

            const prevChar = h === 0 ? ' ' : haystack[h - 1];
            if (!/[a-z0-9]/.test(prevChar)) {
                score += 2;
            }

            prevMatch = h;
            h += 1;
            break;
        }

        if (!matched) return 0;
    }

    return score;
};

const lineMatchScore = (queryTokens, line) => {
    const normalizedLine = normalize(line);
    if (!normalizedLine) return 0;

    let score = 0;

    for (const token of queryTokens) {
        if (normalizedLine.includes(token)) {
            score += 40 + (token.length * 3);
            continue;
        }

        const fuzzy = scoreSubsequence(token, normalizedLine);
        if (!fuzzy) return 0;
        score += fuzzy;
    }

    return score;
};

const trimSnippet = (line, maxLength = 180) => {
    const clean = `${line || ''}`.replace(/\t/g, '    ');
    if (clean.length <= maxLength) return clean;
    return `${clean.slice(0, maxLength - 3)}...`;
};

const firstTokenIndex = (line, queryTokens) => {
    const lowered = normalize(line);
    let best = -1;

    for (const token of queryTokens) {
        const index = lowered.indexOf(token);
        if (index === -1) continue;
        if (best === -1 || index < best) best = index;
    }

    return best;
};

export const findTabMatches = (tabs, query, maxResults = 120) => {
    const queryTokens = tokenizeQuery(query);
    if (!queryTokens.length) return [];

    const matches = [];

    for (const tab of tabs) {
        const mode = normalizeMode(tab.mode);
        if (!isCodeMode(mode)) continue;

        const content = `${tab.content || ''}`;
        if (!content) continue;

        const lines = content.replaceAll('\r\n', '\n').split('\n');
        let offset = 0;

        for (let i = 0; i < lines.length; i += 1) {
            const line = lines[i];
            const score = lineMatchScore(queryTokens, line);
            if (score > 0) {
                const index = firstTokenIndex(line, queryTokens);
                const matchStart = index === -1 ? 0 : index;
                const matchLength = queryTokens[0]?.length || 1;

                matches.push({
                    tabId: tab.id,
                    tabTitle: tab.title,
                    mode,
                    lineNumber: i + 1,
                    offset: offset + matchStart,
                    length: Math.max(1, matchLength),
                    snippet: trimSnippet(line),
                    score: score + Math.max(0, 20 - i)
                });
            }

            offset += line.length + 1;
        }
    }

    return matches
        .sort((a, b) => b.score - a.score || a.tabTitle.localeCompare(b.tabTitle) || a.lineNumber - b.lineNumber)
        .slice(0, maxResults);
};
