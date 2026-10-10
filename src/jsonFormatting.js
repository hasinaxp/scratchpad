const MAX_CONTENT_LENGTH = 1_000_000;

const isString = (value) => typeof value === 'string';

const findBalancedJsonEnd = (text, startIndex) => {
    const opening = text[startIndex];
    const closing = opening === '{' ? '}' : ']';

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = startIndex; i < text.length; i += 1) {
        const ch = text[i];

        if (inString) {
            if (escaped) {
                escaped = false;
                continue;
            }

            if (ch === '\\') {
                escaped = true;
                continue;
            }

            if (ch === '"') {
                inString = false;
            }
            continue;
        }

        if (ch === '"') {
            inString = true;
            continue;
        }

        if (ch === opening) {
            depth += 1;
            continue;
        }

        if (ch === closing) {
            depth -= 1;
            if (depth === 0) {
                return i;
            }
        }
    }

    return -1;
};

// Escaped JSON (e.g. {\"name\": \"remi\"} copied from logs) is real JSON one string-escape layer down:
// \" acts as a quote and \\X as an escape inside a string.
const findEscapedJsonEnd = (text, startIndex) => {
    const opening = text[startIndex];
    const closing = opening === '{' ? '}' : ']';

    let depth = 0;
    let inString = false;

    for (let i = startIndex; i < text.length; i += 1) {
        const ch = text[i];

        if (ch === '\\') {
            const next = text[i + 1];
            i += 1;
            if (next === '"') {
                inString = !inString;
            } else if (next === '\\' && inString) {
                // The escaped character is itself one token: \" or \\ (two chars) or a plain char.
                i += text[i + 1] === '\\' ? 2 : 1;
            }
            continue;
        }

        // A bare quote cannot appear in escaped JSON.
        if (ch === '"') return -1;
        if (inString) continue;

        if (ch === opening) {
            depth += 1;
        } else if (ch === closing) {
            depth -= 1;
            if (depth === 0) return i;
        }
    }

    return -1;
};

const unescapeJsonLayer = (raw) => {
    try {
        const decoded = JSON.parse(`"${raw}"`);
        return typeof decoded === 'string' ? decoded : null;
    } catch {
        return null;
    }
};

const isValidJson = (text) => {
    try {
        JSON.parse(text);
        return true;
    } catch {
        return false;
    }
};

const formatChunk = (chunk, mode) => {
    try {
        const parsed = JSON.parse(chunk);
        if (mode === 'minified') {
            return JSON.stringify(parsed);
        }
        return JSON.stringify(parsed, null, 2);
    } catch {
        return null;
    }
};

export const extractJsonChunks = (content) => {
    if (!isString(content) || content.length === 0 || content.length > MAX_CONTENT_LENGTH) {
        return [];
    }

    const chunks = [];
    let i = 0;

    while (i < content.length) {
        const ch = content[i];
        const isCandidateStart = ch === '{' || ch === '[';

        if (!isCandidateStart) {
            i += 1;
            continue;
        }

        let endIndex = findBalancedJsonEnd(content, i);
        let json = endIndex === -1 ? null : content.slice(i, endIndex + 1);
        let escaped = false;

        if (json === null || !isValidJson(json)) {
            json = null;
            const escapedEnd = findEscapedJsonEnd(content, i);
            const decoded = escapedEnd === -1 ? null : unescapeJsonLayer(content.slice(i, escapedEnd + 1));
            if (decoded !== null && isValidJson(decoded)) {
                endIndex = escapedEnd;
                json = decoded;
                escaped = true;
            }
        }

        if (json === null) {
            i += 1;
            continue;
        }

        // `text` is the raw source span; `json` is parseable JSON (unescaped for escaped chunks).
        chunks.push({ start: i, end: endIndex + 1, text: content.slice(i, endIndex + 1), json, escaped });
        i = endIndex + 1;
    }

    return chunks;
};

export const formatJsonContent = (content, mode) => {
    if (!isString(content) || content.length === 0) {
        return { output: content || '', changed: false, formattedChunks: 0 };
    }

    if (content.length > MAX_CONTENT_LENGTH) {
        return { output: content, changed: false, formattedChunks: 0 };
    }

    const targetMode = mode === 'minified' ? 'minified' : 'pretty';
    const chunks = extractJsonChunks(content);
    if (chunks.length === 0) {
        return {
            output: content,
            changed: false,
            formattedChunks: 0
        };
    }

    let changed = false;
    let output = '';
    let cursor = 0;

    for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        output += content.slice(cursor, chunk.start);

        // Escaped chunks come out as real JSON, so formatting also unescapes them.
        const formatted = formatChunk(chunk.json, targetMode);
        if (!formatted) {
            output += chunk.text;
        } else {
            output += formatted;
            changed = changed || formatted !== chunk.text;
        }

        cursor = chunk.end;
    }

    output += content.slice(cursor);

    return {
        output,
        changed,
        formattedChunks: chunks.length
    };
};
