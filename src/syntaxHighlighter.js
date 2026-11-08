// Tokens are { text, kind, url, bold }: kind is a colour name (null = plain text), url marks a link,
// bold marks markdown emphasis.
const cloneRegexGlobal = (regex) => {
    const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
    return new RegExp(regex.source, flags);
};

// Excludes quotes/brackets so trailing punctuation is not part of the link.
const URL_PATTERN_CAPTURE = /(https?:\/\/[^\s"'<>`]*[^\s"'<>`.,;:!?)\]}])/;

const splitLinks = (text, kind = null) => `${text || ''}`.split(URL_PATTERN_CAPTURE)
    .map((part, index) => ({ text: part, kind, url: index % 2 === 1 }))
    .filter((token) => token.text);

// The outer kind fills in where inner tokens have none, like a nested span would.
const wrap = (kind, tokens) => tokens.map((token) => (token.kind ? token : { ...token, kind }));

const NEWLINE = { text: '\n', kind: null, url: false };
const EMPHASIS = new Set(['strong', 'em']);
const joinLines = (chunks) => chunks.flatMap((tokens, index) => (index ? [NEWLINE, ...tokens] : tokens));

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

    // 'plain' only shields text from later rules; emphasis is a weight, not a colour, so both leave
    // kind empty and inherit the colour around them (e.g. a list item's).
    return segments.flatMap((segment) => {
        if (segment.className === 'plain') return splitLinks(segment.text);
        if (EMPHASIS.has(segment.className)) return splitLinks(segment.text).map((token) => ({ ...token, bold: true }));
        return splitLinks(segment.text, segment.className);
    });
};

const applyInlineMarkdown = (line) => {
    const rules = [
        [/(`[^`\n]+`)/g, 'code'],
        [/\*\*[^*\n]+\*\*/g, 'strong'],
        [/(?<![*\w])\*[^*\s](?:[^*\n]*[^*\s])?\*(?![*\w])/g, 'em'],
        // Contractions (haven't, I've, it's) must not open a single-quoted string.
        [/\p{L}['’](?:t|s|re|ve|ll|d|m)\b/giu, 'plain'],
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
    if (!rules) return joinLines(lines.map((line) => splitLinks(line, 'code')));
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
            out.push(splitLinks(line, 'code'));
            continue;
        }

        if (fence) {
            if (trimmed.startsWith(fence.marker)) {
                closeFence();
                out.push(splitLinks(line, 'code'));
            } else {
                fence.lines.push(line);
            }
            continue;
        }

        if (/^\s*#{1,6}\s/.test(line)) {
            out.push(splitLinks(line, 'title'));
            continue;
        }

        if (/^\s*>/.test(line)) {
            out.push(splitLinks(line, 'comment'));
            continue;
        }

        if (/^\s*(?:[-*+]\s|\d+\.\s|-\s\[[ xX]\]\s)/.test(line)) {
            out.push(wrap('keyword', applyInlineMarkdown(line)));
            continue;
        }

        if (/^\s*(?:---|\*\*\*|___)\s*$/.test(line)) {
            out.push(splitLinks(line, 'keyword'));
            continue;
        }

        out.push(applyInlineMarkdown(line));
    }

    if (fence) closeFence();
    return joinLines(out);
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

// Escaped JSON strings: \"...\" where an inner escape is \\ followed by one escaped token.
const ESCAPED_JSON_STRING = String.raw`\\"(?:[^\\"]|\\[^\\"]|\\\\(?:\\.|[^\\]))*\\"`;
const escapedJsonRules = [
    [new RegExp(`(${ESCAPED_JSON_STRING}\\s*:)`, 'g'), 'keyword'],
    [new RegExp(`(${ESCAPED_JSON_STRING})`, 'g'), 'string'],
    ...jsonRules
];
// Only documents that contain escaped objects/arrays use them, so normal "say \"hi\"" strings stay intact.
const looksEscapedJson = (source) => /[{[]\s*\\"/.test(source);

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

export const highlightTokens = (text, language = 'text') => {
    const source = text || '';
    if (language === 'text' || language === 'markdown') return highlightMarkdown(source);

    const rules = language === 'json' && looksEscapedJson(source)
        ? [...escapedJsonRules, bracketRule]
        : (rulesByLanguage[language] || rulesByLanguage.python);
    return applyRulesSafely(source, rules);
};
