import { escapeHtml } from './utils.js';

const cloneRegexGlobal = (regex) => {
    const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
    return new RegExp(regex.source, flags);
};

const wrap = (className, text) => `<span class="tok-${className}">${text}</span>`;

const applyRulesSafely = (text, rules) => {
    let segments = [{ text, className: null }];

    for (const [regex, className] of rules) {
        const nextSegments = [];

        for (const segment of segments) {
            if (segment.className || !segment.text) {
                nextSegments.push(segment);
                continue;
            }

            const pattern = cloneRegexGlobal(regex);
            let cursor = 0;
            let matched = false;

            for (const match of segment.text.matchAll(pattern)) {
                const matchText = match[0] || '';
                const start = match.index ?? 0;
                if (!matchText) continue;

                matched = true;

                if (start > cursor) {
                    nextSegments.push({
                        text: segment.text.slice(cursor, start),
                        className: null
                    });
                }

                nextSegments.push({ text: matchText, className });
                cursor = start + matchText.length;
            }

            if (!matched) {
                nextSegments.push(segment);
                continue;
            }

            if (cursor < segment.text.length) {
                nextSegments.push({
                    text: segment.text.slice(cursor),
                    className: null
                });
            }
        }

        segments = nextSegments;
    }

    return segments.map((segment) => {
        const escaped = escapeHtml(segment.text);
        if (!segment.className) return escaped;
        return `<span class="tok-${segment.className}">${escaped}</span>`;
    }).join('');
};

const applyInlineMarkdown = (line) => {
    const rules = [
        [/(`[^`\n]+`)/g, 'code'],
        [/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, 'string'],
        [/(\[[^\]]+\]\([^\)]+\))/g, 'link'],
        [/[(){}\[\]]/g, 'bracket']
    ];

    return applyRulesSafely(line, rules);
};

const highlightMarkdown = (text) => {
    const lines = text.split('\n');
    let inFence = false;
    let fenceMarker = '';
    const out = [];

    for (const line of lines) {
        const trimmed = line.trim();

        if (!inFence && (trimmed.startsWith('```') || trimmed.startsWith('~~~'))) {
            inFence = true;
            fenceMarker = trimmed.startsWith('```') ? '```' : '~~~';
            out.push(wrap('code', escapeHtml(line)));
            continue;
        }

        if (inFence) {
            out.push(wrap('code', escapeHtml(line)));
            if (trimmed.startsWith(fenceMarker)) {
                inFence = false;
                fenceMarker = '';
            }
            continue;
        }

        if (/^\s*#{1,6}\s/.test(line)) {
            out.push(wrap('title', escapeHtml(line)));
            continue;
        }

        if (/^\s*>/.test(line)) {
            out.push(wrap('comment', escapeHtml(line)));
            continue;
        }

        if (/^\s*(?:[-*+]\s|\d+\.\s|-\s\[[ xX]\]\s)/.test(line)) {
            out.push(wrap('keyword', applyInlineMarkdown(line)));
            continue;
        }

        if (/^\s*(?:---|\*\*\*|___)\s*$/.test(line)) {
            out.push(wrap('keyword', escapeHtml(line)));
            continue;
        }

        out.push(applyInlineMarkdown(line));
    }

    return out.join('\n');
};

const pythonRules = [
    [/(#.*)$/gm, 'comment'],
    [/("""[\s\S]*?"""|'''[\s\S]*?''')/g, 'string'],
    [/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, 'string'],
    [/(\b(?:def|class|if|elif|else|for|while|try|except|finally|return|import|from|as|pass|break|continue|with|lambda|yield|True|False|None|and|or|not|in|is)\b)/g, 'keyword'],
    [/(\b\d+(?:\.\d+)?\b)/g, 'number']
];

const javaRules = [
    [/(\/\*[\s\S]*?\*\/|\/\/.*$)/gm, 'comment'],
    [/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, 'string'],
    [/(\b(?:public|private|protected|class|interface|enum|static|final|void|int|long|double|float|char|boolean|new|return|if|else|switch|case|for|while|do|break|continue|try|catch|finally|throw|throws|extends|implements|import|package|null|true|false|this|super)\b)/g, 'keyword'],
    [/(\b\d+(?:\.\d+)?\b)/g, 'number'],
    [/(@[A-Za-z_][A-Za-z0-9_]*)/g, 'meta']
];

const yamlRules = [
    [/(#.*)$/gm, 'comment'],
    [/^(\s*[A-Za-z0-9_-]+:)/gm, 'keyword'],
    [/(\b(?:true|false|null)\b)/g, 'keyword'],
    [/(\b\d+(?:\.\d+)?\b)/g, 'number'],
    [/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, 'string']
];

const jsonRules = [
    [/("(?:[^"\\]|\\.)*"\s*:)/g, 'keyword'],
    [/("(?:[^"\\]|\\.)*")/g, 'string'],
    [/(\b(?:true|false|null)\b)/g, 'keyword'],
    [/(\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)/g, 'number']
];

const bracketRule = [/[(){}\[\]]/g, 'bracket'];

const rulesByLanguage = {
    python: [...pythonRules, bracketRule],
    java: [...javaRules, bracketRule],
    yaml: [...yamlRules, bracketRule],
    json: [...jsonRules, bracketRule]
};

export const highlightText = (text, language = 'markdown') => {
    const source = text || '';
    let html = '';

    if (language === 'markdown') {
        html = highlightMarkdown(source);
    } else {
        const rules = rulesByLanguage[language] || rulesByLanguage.python;
        html = applyRulesSafely(source, rules);
    }

    if (html.length === 0) {
        html = ' ';
    }

    if (source.endsWith('\n')) {
        html += ' ';
    }

    return html;
};
