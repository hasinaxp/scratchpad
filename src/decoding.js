const MAX_INPUT_LENGTH = 1_000_000;

const isString = (value) => typeof value === 'string';

const isHexChar = (char) => /[0-9a-fA-F]/.test(char);

const decodeUrlEncoded = (selectionText) => {
    if (!isString(selectionText) || selectionText.length === 0) return null;
    if (selectionText.length > MAX_INPUT_LENGTH) return null;
    if (!/%[0-9a-fA-F]{2}/.test(selectionText)) return null;

    let i = 0;
    let decoded = '';
    let changed = false;

    while (i < selectionText.length) {
        const char = selectionText[i];

        if (char === '+') {
            decoded += ' ';
            changed = true;
            i += 1;
            continue;
        }

        const canStartPercentRun = char === '%'
            && i + 2 < selectionText.length
            && isHexChar(selectionText[i + 1])
            && isHexChar(selectionText[i + 2]);

        if (!canStartPercentRun) {
            decoded += char;
            i += 1;
            continue;
        }

        let runEnd = i;
        while (
            runEnd + 2 < selectionText.length
            && selectionText[runEnd] === '%'
            && isHexChar(selectionText[runEnd + 1])
            && isHexChar(selectionText[runEnd + 2])
        ) {
            runEnd += 3;
        }

        const run = selectionText.slice(i, runEnd);
        let consumed = 0;

        while (consumed < run.length) {
            let decodedPart = null;

            for (let end = run.length; end > consumed; end -= 3) {
                const candidate = run.slice(consumed, end);
                try {
                    decodedPart = decodeURIComponent(candidate);
                    consumed = end;
                    break;
                } catch {
                    // Keep searching smaller groups to survive malformed UTF-8 byte runs.
                }
            }

            if (decodedPart !== null) {
                decoded += decodedPart;
                changed = true;
                continue;
            }

            decoded += run.slice(consumed, consumed + 3);
            consumed += 3;
        }

        i = runEnd;
    }

    return changed && decoded !== selectionText ? decoded : null;
};

const decodeUnicodeEscapes = (selectionText) => {
    if (!isString(selectionText) || selectionText.length === 0) return null;
    if (selectionText.length > MAX_INPUT_LENGTH) return null;
    if (!/\\u[0-9a-fA-F]{4}/.test(selectionText)) return null;

    const decoded = selectionText.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => (
        String.fromCharCode(parseInt(hex, 16))
    ));

    return decoded !== selectionText ? decoded : null;
};

const decodeBase64UrlSegment = (segment) => {
    if (!isString(segment) || segment.length === 0) return null;
    if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null;

    const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);

    try {
        const binary = window.atob(padded);
        const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
        return new TextDecoder().decode(bytes);
    } catch {
        return null;
    }
};

const prettyJsonOrRaw = (text) => {
    if (!isString(text) || text.length === 0) return null;
    try {
        return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
        return text;
    }
};

const decodeJwtParts = (selectionText) => {
    const token = isString(selectionText) ? selectionText.trim() : '';
    if (!token || token.length > MAX_INPUT_LENGTH) {
        return { header: null, payload: null };
    }

    const parts = token.split('.');
    if (parts.length < 2 || parts.length > 3) {
        return { header: null, payload: null };
    }

    const header = prettyJsonOrRaw(decodeBase64UrlSegment(parts[0]));
    const payload = prettyJsonOrRaw(decodeBase64UrlSegment(parts[1]));

    return { header, payload };
};

export const getDecodeCandidates = (selectionText) => {
    const url = decodeUrlEncoded(selectionText);
    const unicode = decodeUnicodeEscapes(selectionText);
    const jwt = decodeJwtParts(selectionText);

    return {
        url,
        unicode,
        jwtHeader: jwt.header,
        jwtPayload: jwt.payload,
        hasAny: Boolean(url || unicode || jwt.header || jwt.payload)
    };
};
