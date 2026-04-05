const MAX_MATCHES = 20000;

const escapeRegExp = (text) => `${text || ''}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const buildFlags = ({ matchCase }) => `g${matchCase ? '' : 'i'}m`;

const cloneRegex = (regex, forceGlobal = false) => {
    if (!regex) return null;
    const flagsSet = new Set(regex.flags.split(''));
    if (forceGlobal) flagsSet.add('g');
    if (!forceGlobal) flagsSet.delete('g');
    return new RegExp(regex.source, Array.from(flagsSet).join(''));
};

export const buildSearchRegex = (query, { useRegex, matchCase, wholeWord }) => {
    if (!query) {
        return { regex: null, error: null };
    }

    const sourceBase = useRegex ? query : escapeRegExp(query);
    const source = wholeWord ? `\\b(?:${sourceBase})\\b` : sourceBase;

    try {
        return {
            regex: new RegExp(source, buildFlags({ matchCase })),
            error: null
        };
    } catch {
        return {
            regex: null,
            error: 'Invalid regular expression'
        };
    }
};

export const getMatches = (text, regex) => {
    if (!regex) return [];

    const source = `${text || ''}`;
    const matches = [];
    regex.lastIndex = 0;

    while (matches.length < MAX_MATCHES) {
        const result = regex.exec(source);
        if (!result) break;

        const value = result[0] || '';
        const start = result.index ?? 0;
        const end = start + value.length;
        matches.push({
            start,
            end,
            value,
            captures: result
        });

        if (value.length === 0) {
            regex.lastIndex += 1;
        }
    }

    return matches;
};

export const findCurrentMatchIndex = (matches, selectionStart, selectionEnd) => {
    if (!matches.length) return -1;

    const exact = matches.findIndex((m) => m.start === selectionStart && m.end === selectionEnd);
    if (exact !== -1) return exact;

    const atOrAfter = matches.findIndex((m) => m.start >= selectionStart);
    if (atOrAfter !== -1) return atOrAfter;

    return 0;
};

export const nextMatchIndex = (matches, index, direction = 1) => {
    if (!matches.length) return -1;
    if (index < 0) return direction >= 0 ? 0 : matches.length - 1;

    if (direction >= 0) {
        return (index + 1) % matches.length;
    }

    return (index - 1 + matches.length) % matches.length;
};

export const replaceAtMatch = (text, match, replacement, { useRegex, matchCase, wholeWord, query }) => {
    if (!match) return { text, nextSelectionStart: 0, nextSelectionEnd: 0, changed: false };

    const source = `${text || ''}`;
    const before = source.slice(0, match.start);
    const after = source.slice(match.end);

    let replaced = `${replacement || ''}`;
    if (useRegex) {
        const sourceBase = query || '';
        const sourcePattern = wholeWord ? `\\b(?:${sourceBase})\\b` : sourceBase;

        try {
            const single = new RegExp(sourcePattern, `${matchCase ? '' : 'i'}m`);
            replaced = match.value.replace(single, replacement || '');
        } catch {
            replaced = `${replacement || ''}`;
        }
    }

    const nextText = `${before}${replaced}${after}`;
    const nextSelectionStart = before.length;
    const nextSelectionEnd = before.length + replaced.length;

    return {
        text: nextText,
        nextSelectionStart,
        nextSelectionEnd,
        changed: nextText !== source
    };
};

export const replaceAllMatches = (text, regex, replacement) => {
    const source = `${text || ''}`;
    if (!regex) return { text: source, replacedCount: 0, changed: false };

    const counterRegex = cloneRegex(regex, true);
    const matches = source.match(counterRegex);
    const replacedCount = matches ? matches.length : 0;
    const replaceRegex = cloneRegex(regex, true);
    const nextText = source.replace(replaceRegex, replacement || '');

    return {
        text: nextText,
        replacedCount,
        changed: nextText !== source
    };
};
