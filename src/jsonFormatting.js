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

        const endIndex = findBalancedJsonEnd(content, i);
        if (endIndex === -1) {
            i += 1;
            continue;
        }

        const candidate = content.slice(i, endIndex + 1);
        if (formatChunk(candidate, 'minified') === null) {
            i += 1;
            continue;
        }

        chunks.push({ start: i, end: endIndex + 1, text: candidate });
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

        const formatted = formatChunk(chunk.text, targetMode);
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
