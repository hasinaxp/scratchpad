import { escapeRegExp } from './utils.js';

const MAX_MATCHES = 20000;

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

    const replacementText = `${replacement || ''}`;

    const expandReplacementTemplate = () => {
        const execResult = match.captures;
        if (!useRegex || !execResult) {
            return replacementText;
        }

        const fullInput = source;
        const matchStart = match.start;
        const matchEnd = match.end;
        const groups = execResult.groups || {};
        const captures = Array.from(execResult);

        let out = '';
        for (let i = 0; i < replacementText.length; i += 1) {
            const ch = replacementText[i];
            if (ch !== '$') {
                out += ch;
                continue;
            }

            const next = replacementText[i + 1] || '';
            if (next === '$') {
                out += '$';
                i += 1;
                continue;
            }

            if (next === '&') {
                out += captures[0] || '';
                i += 1;
                continue;
            }

            if (next === '`') {
                out += fullInput.slice(0, matchStart);
                i += 1;
                continue;
            }

            if (next === '\'') {
                out += fullInput.slice(matchEnd);
                i += 1;
                continue;
            }

            if (next === '<') {
                const close = replacementText.indexOf('>', i + 2);
                if (close !== -1) {
                    const name = replacementText.slice(i + 2, close);
                    out += groups[name] ?? '';
                    i = close;
                    continue;
                }
            }

            if (/[0-9]/.test(next)) {
                const d1 = next;
                const d2 = replacementText[i + 2] || '';
                const candidateTwo = /[0-9]/.test(d2) ? Number.parseInt(`${d1}${d2}`, 10) : Number.NaN;
                const candidateOne = Number.parseInt(d1, 10);

                if (!Number.isNaN(candidateTwo) && candidateTwo > 0 && candidateTwo < captures.length) {
                    out += captures[candidateTwo] ?? '';
                    i += 2;
                    continue;
                }

                if (candidateOne > 0 && candidateOne < captures.length) {
                    out += captures[candidateOne] ?? '';
                    i += 1;
                    continue;
                }
            }

            out += '$';
        }

        return out;
    };

    const replaced = expandReplacementTemplate();

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
