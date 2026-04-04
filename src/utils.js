export const TAB_INDENT = '    ';

export const countLines = (text) => {
    if (!text || text.length === 0) return 1;

    let count = 1;
    for (let i = 0; i < text.length; i += 1) {
        if (text[i] === '\n') count += 1;
    }
    return count;
};

export const deriveTabTitle = (content, fallbackNumber = 1) => {
    const line = (content || '').split('\n').find((part) => part.trim().length > 0) || '';
    const compact = line.replace(/\s+/g, ' ').trim();
    if (!compact) return `Tab ${fallbackNumber}`;

    const maxLength = 26;
    return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}...` : compact;
};

export const createTabId = () => `tab-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
