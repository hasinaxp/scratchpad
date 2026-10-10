import { escapeHtml } from './utils.js';

const cloneRegexGlobal = (regex) => {
    const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
    return new RegExp(regex.source, flags);
};

const wrap = (className, text) => `<span class="tok-${className}">${text}</span>`;

// Excludes quotes/brackets so the URL is safe inside href="" and trailing punctuation is dropped.
const URL_PATTERN_CAPTURE = /(https?:\/\/[^\s"'<>`]*[^\s"'<>`.,;:!?)\]}])/;

// Escapes text and wraps URLs in anchors; anchors are inline so the overlay layout stays identical.
const escapeWithLinks = (text) => `${text || ''}`.split(URL_PATTERN_CAPTURE).map((part, index) => {
    const escaped = escapeHtml(part);
    return index % 2 ? `<a class="tok-url" href="${escaped}" target="_blank" rel="noopener noreferrer">${escaped}</a>` : escaped;
}).join('');

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
        const escaped = escapeWithLinks(segment.text);
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

const FENCE_LANGUAGE_ALIASES = {
    py: 'python',
    python: 'python',
    java: 'java',
    yml: 'yaml',
    yaml: 'yaml',
    json: 'json',
    c: 'c',
    h: 'c',
    cpp: 'c',
    'c++': 'c'
};

// Fenced blocks tagged with a known language get that language's rules; others stay plain code.
const highlightFence = (lines, tag) => {
    const rules = rulesByLanguage[FENCE_LANGUAGE_ALIASES[tag]];
    if (!rules) return lines.map((line) => wrap('code', escapeWithLinks(line))).join('\n');
    return applyRulesSafely(lines.join('\n'), rules);
};

const highlightMarkdown = (text) => {
    const lines = text.split('\n');
    let fence = null;
    const out = [];
    const closeFence = () => {
        if (fence.lines.length) out.push(highlightFence(fence.lines, fence.tag));
        fence = null;
    };

    for (const line of lines) {
        const trimmed = line.trim();

        if (!fence && (trimmed.startsWith('```') || trimmed.startsWith('~~~'))) {
            fence = { marker: trimmed.slice(0, 3), tag: trimmed.slice(3).trim().split(/\s+/)[0].toLowerCase(), lines: [] };
            out.push(wrap('code', escapeWithLinks(line)));
            continue;
        }

        if (fence) {
            if (trimmed.startsWith(fence.marker)) {
                closeFence();
                out.push(wrap('code', escapeWithLinks(line)));
            } else {
                fence.lines.push(line);
            }
            continue;
        }

        if (/^\s*#{1,6}\s/.test(line)) {
            out.push(wrap('title', escapeWithLinks(line)));
            continue;
        }

        if (/^\s*>/.test(line)) {
            out.push(wrap('comment', escapeWithLinks(line)));
            continue;
        }

        if (/^\s*(?:[-*+]\s|\d+\.\s|-\s\[[ xX]\]\s)/.test(line)) {
            out.push(wrap('keyword', applyInlineMarkdown(line)));
            continue;
        }

        if (/^\s*(?:---|\*\*\*|___)\s*$/.test(line)) {
            out.push(wrap('keyword', escapeWithLinks(line)));
            continue;
        }

        out.push(applyInlineMarkdown(line));
    }

    if (fence) closeFence();
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

const cRules = [
    [/(\/\*[\s\S]*?\*\/|\/\/.*$)/gm, 'comment'],
    [/(^[ \t]*#[ \t]*[a-z]+.*$)/gm, 'meta'],
    [/("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/g, 'string'],
    [/(\b(?:auto|bool|break|case|char|const|continue|default|do|double|else|enum|extern|false|float|for|goto|if|inline|int|long|NULL|register|return|short|signed|sizeof|static|struct|switch|true|typedef|union|unsigned|void|volatile|while)\b)/g, 'keyword'],
    [/(\b0[xX][0-9a-fA-F]+\b|\b\d+(?:\.\d+)?[uUlLfF]*\b)/g, 'number']
];

const bracketRule =[/[(){}\[\]]/g, 'bracket'];

const rulesByLanguage = {
    python: [...pythonRules, bracketRule],
    java: [...javaRules, bracketRule],
    yaml: [...yamlRules, bracketRule],
    c: [...cRules, bracketRule],
    json: [...jsonRules, bracketRule]
};

export const highlightText = (text, language = 'text') => {
    const source = text || '';
    let html = '';
    const normalizedLanguage = language === 'markdown' ? 'text' : language;

    if (normalizedLanguage === 'text') {
        html = highlightMarkdown(source);
    } else {
        const rules = rulesByLanguage[normalizedLanguage] || rulesByLanguage.python;
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
