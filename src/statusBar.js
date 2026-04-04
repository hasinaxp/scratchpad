import { countLines } from './utils.js';

export class StatusBarManager {
    constructor({ statusPosition, statusLines, statusChars, getText, getSelectionOffsets, getTotalLines }) {
        this.statusPosition = statusPosition;
        this.statusLines = statusLines;
        this.statusChars = statusChars;
        this.getText = getText;
        this.getSelectionOffsets = getSelectionOffsets;
        this.getTotalLines = getTotalLines;
        this.rafId = 0;
    }

    update() {
        if (!this.statusPosition || !this.statusLines || !this.statusChars) return;

        const text = this.getText();
        const offsets = this.getSelectionOffsets();
        const caret = offsets ? offsets.end : 0;
        const beforeCaret = text.slice(0, caret);
        const line = Math.max(1, countLines(beforeCaret));
        const lineStart = beforeCaret.lastIndexOf('\n') + 1;
        const col = (caret - lineStart) + 1;

        this.statusPosition.textContent = `Ln ${line}, Col ${col}`;
        this.statusLines.textContent = `Lines ${this.getTotalLines()}`;
        this.statusChars.textContent = `Chars ${text.length}`;
    }

    scheduleUpdate() {
        if (this.rafId) return;

        this.rafId = window.requestAnimationFrame(() => {
            this.rafId = 0;
            this.update();
        });
    }
}
