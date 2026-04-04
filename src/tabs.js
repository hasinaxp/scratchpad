export class TabsView {
    constructor({ tabHeaders, addTabButton, onAdd, onSelect, onClose }) {
        this.tabHeaders = tabHeaders;
        this.addTabButton = addTabButton;
        this.onAdd = onAdd;
        this.onSelect = onSelect;
        this.onClose = onClose;

        this.bindEvents();
    }

    bindEvents() {
        this.tabHeaders.addEventListener('click', (event) => {
            const closeButton = event.target.closest('.tab-close');
            if (closeButton) {
                const tabHeader = closeButton.closest('.tab-header');
                if (tabHeader?.dataset.tabId) {
                    this.onClose(tabHeader.dataset.tabId);
                }
                return;
            }

            const tabHeader = event.target.closest('.tab-header');
            if (tabHeader?.dataset.tabId) {
                this.onSelect(tabHeader.dataset.tabId);
            }
        });

        this.addTabButton.addEventListener('click', this.onAdd);

        this.addTabButton.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                this.onAdd();
            }
        });
    }

    render(tabs, activeTabId) {
        this.tabHeaders.querySelectorAll('.tab-header').forEach((node) => node.remove());

        tabs.forEach((tab) => {
            const tabHeader = document.createElement('div');
            tabHeader.className = `tab-header${tab.id === activeTabId ? ' active' : ''}`;
            tabHeader.dataset.tabId = tab.id;
            tabHeader.setAttribute('role', 'tab');
            tabHeader.setAttribute('aria-selected', String(tab.id === activeTabId));
            tabHeader.title = tab.title;

            const title = document.createElement('span');
            title.className = 'tab-title';
            title.textContent = tab.title;

            const close = document.createElement('button');
            close.type = 'button';
            close.className = 'tab-close';
            close.setAttribute('aria-label', `Close ${tab.title}`);
            close.textContent = '×';

            tabHeader.append(title, close);
            this.tabHeaders.insertBefore(tabHeader, this.addTabButton);
        });
    }

    updateActiveTabTitle(title) {
        const activeTitle = this.tabHeaders.querySelector('.tab-header.active .tab-title');
        if (activeTitle) {
            activeTitle.textContent = title;
        }
    }
}
