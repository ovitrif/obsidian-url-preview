import { App, Plugin, PluginSettingTab, Setting, MarkdownView } from 'obsidian';

interface LinkPreviewSettings {
    maxPreviewHeight: number;
    maxPreviewWidth: number;
    hoverDelay: number;
}

const DEFAULT_SETTINGS: Readonly<LinkPreviewSettings> = {
    maxPreviewHeight: 400,
    maxPreviewWidth: 600,
    hoverDelay: 500,
};

export default class LinkPreviewPlugin extends Plugin {
    settings: LinkPreviewSettings;
    private activePreview?: {
        element: HTMLElement,
        cleanup: () => void,
        link: HTMLElement
    };
    private hoverTimeout?: number;
    private lastMouseX = 0;
    private lastMouseY = 0;

    async onload() {
        await this.loadSettings();
        
        // Defer setup until layout is ready
        this.app.workspace.onLayoutReady(() => {
            this.registerGlobalHandler();
        });
        
        this.addSettingTab(new LinkPreviewSettingTab(this.app, this));
    }

    private registerGlobalHandler() {
        const handleWindow = (doc: Document) => {
            this.registerDomEvent(doc, 'mouseover', this.handleLinkHover.bind(this));
            this.registerDomEvent(doc, 'mousemove', (e: MouseEvent) => {
                this.lastMouseX = e.clientX;
                this.lastMouseY = e.clientY;
            });
        };

        handleWindow(document);
        this.registerEvent(
            this.app.workspace.on('window-open', ({win}) => handleWindow(win.document))
        );
    }

    private handleLinkHover(event: MouseEvent) {
        const target = event.target as Element | null;
        if (!(target instanceof Element)) return;

        // Skip if event is from inside the active preview (prevents flickering)
        if (this.activePreview?.element.contains(target)) {
            return;
        }

        const linkInfo = this.findLinkElement(target, event.relatedTarget as Element | null);
        if (!linkInfo) return;

        const { element: linkElement, url } = linkInfo;

        // Clear any existing hover timeout
        if (this.hoverTimeout) {
            window.clearTimeout(this.hoverTimeout);
        }

        // If hovering the same link that has an active preview, clear any pending cleanup
        if (this.activePreview?.link === linkElement) {
            if (this.cleanupTimeout) {
                window.clearTimeout(this.cleanupTimeout);
                this.cleanupTimeout = undefined;
            }
            return;
        }

        // Clean up any existing preview
        this.cleanupActivePreview();

        // Set timeout for showing preview
        this.hoverTimeout = window.setTimeout(() => {
            this.showPreview(linkElement, url);
        }, this.settings.hoverDelay);

        // Add mouse leave listener to target
        const handleMouseLeave = (e: MouseEvent) => {
            // Check if mouse moved to the preview
            const toElement = e.relatedTarget as HTMLElement | null;
            if (toElement && this.activePreview?.element.contains(toElement)) return;

            this.startCleanupTimer();
            linkElement.removeEventListener('mouseleave', handleMouseLeave);
        };

        linkElement.addEventListener('mouseleave', handleMouseLeave);
    }

    private showPreview(link: HTMLElement, url: string) {
        const rect = link.getBoundingClientRect();
        const previewEl = this.createPreviewElement(rect);

        const wrapper = previewEl.createDiv('preview-iframe-wrapper');

        // GitHub-specific: add class to enable header cropping
        if (url.includes('github.com')) {
            wrapper.addClass('github-preview');
        }

        const loading = previewEl.createDiv('preview-loading');
        loading.addClass('loading-spinner');
        
        const iframe = createEl('iframe', {
            attr: {
                src: url
            }
        });
        
        wrapper.appendChild(iframe);

        const cleanup = () => {
            previewEl.remove();
            this.activePreview = undefined;
        };

        iframe.onload = () => {
            // Small delay to let page render before showing
            setTimeout(() => {
                iframe.style.visibility = 'visible';
                loading.remove();  // Remove entirely to stop infinite animation
            }, 50);
        };

        iframe.onerror = () => {
            loading.textContent = 'Failed to load preview';
        };

        // Add preview hover handlers
        previewEl.addEventListener('mouseenter', () => {
            if (this.cleanupTimeout) {
                window.clearTimeout(this.cleanupTimeout);
                this.cleanupTimeout = undefined;
            }
        });

        previewEl.addEventListener('mouseleave', () => {
            this.startCleanupTimer();
        });

        document.body.appendChild(previewEl);
        this.activePreview = { element: previewEl, cleanup, link };
    }

    private cleanupTimeout?: number;

    private startCleanupTimer() {
        if (this.cleanupTimeout) {
            window.clearTimeout(this.cleanupTimeout);
        }
        this.cleanupTimeout = window.setTimeout(() => {
            // Before cleanup, verify mouse isn't over preview OR the original link
            if (this.activePreview && this.isMouseOverPreviewOrLink()) {
                this.cleanupTimeout = undefined;
                return;
            }
            this.cleanupActivePreview();
            this.cleanupTimeout = undefined;
        }, 300);
    }

    private isMouseOverPreviewOrLink(): boolean {
        if (!this.activePreview) return false;

        // Check preview bounds
        const previewRect = this.activePreview.element.getBoundingClientRect();
        if (this.lastMouseX >= previewRect.left &&
            this.lastMouseX <= previewRect.right &&
            this.lastMouseY >= previewRect.top &&
            this.lastMouseY <= previewRect.bottom) {
            return true;
        }

        // Check original link bounds
        const linkRect = this.activePreview.link.getBoundingClientRect();
        if (this.lastMouseX >= linkRect.left &&
            this.lastMouseX <= linkRect.right &&
            this.lastMouseY >= linkRect.top &&
            this.lastMouseY <= linkRect.bottom) {
            return true;
        }

        return false;
    }

    private cleanupActivePreview() {
        if (this.activePreview) {
            this.activePreview.cleanup();
            this.activePreview = undefined;
        }
        if (this.hoverTimeout) {
            window.clearTimeout(this.hoverTimeout);
            this.hoverTimeout = undefined;
        }
        if (this.cleanupTimeout) {
            window.clearTimeout(this.cleanupTimeout);
            this.cleanupTimeout = undefined;
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    onunload() {
        this.cleanupActivePreview();
    }

    private createPreviewElement(rect: DOMRect): HTMLElement {
        const el = createEl('div', { cls: 'hover-popup' });
        
        const windowSize = {
            width: window.innerWidth,
            height: window.innerHeight
        };
        
        const bounds = this.calculatePreviewBounds(rect, windowSize);
        
        // Set positioning directly - remove CSS variables approach
        el.style.cssText = `
            left: ${bounds.left}px;
            top: ${bounds.top}px;
            width: ${bounds.width}px;
            height: ${bounds.height}px;
        `;
        
        return el;
    }

    private calculatePreviewBounds(rect: DOMRect, windowSize: { width: number, height: number }): {
        left: number,
        top: number,
        width: number,
        height: number,
        showAbove: boolean
    } {
        const margin = 5; // Margin from edges
        const maxWidth = Math.min(this.settings.maxPreviewWidth, windowSize.width - margin * 2);
        const maxHeight = Math.min(this.settings.maxPreviewHeight, windowSize.height - margin * 2);
        
        // Determine if we should show above or below
        const spaceBelow = windowSize.height - rect.bottom - margin;
        const spaceAbove = rect.top - margin;
        const showAbove = spaceBelow < maxHeight && spaceAbove > spaceBelow;

        // Calculate vertical position
        let top = showAbove ? 
            Math.max(margin, rect.top - maxHeight - margin) : 
            Math.min(rect.bottom + margin, windowSize.height - maxHeight - margin);

        // Calculate horizontal position
        let left = rect.left;
        if (left + maxWidth > windowSize.width - margin) {
            left = windowSize.width - maxWidth - margin;
        }
        left = Math.max(margin, left);

        return {
            left,
            top,
            width: maxWidth,
            height: maxHeight,
            showAbove
        };
    }

    private findLinkElement(target: Element, relatedTarget: Element | null): { element: HTMLElement, url: string } | null {
        const LINK_SELECTOR = 'a.external-link, a[href^="http"], span.external-link, .cm-hmd-external-link, .cm-link .cm-underline, .cm-url, [data-href], [data-url]';

        let el: Element | null = target;
        while (el && el !== document.body) {
            if (!(el instanceof HTMLElement)) {
                el = el.parentElement;
                continue;
            }

            if (!el.matches(LINK_SELECTOR)) {
                el = el.parentElement;
                continue;
            }

            if (relatedTarget && el.contains(relatedTarget)) {
                return null;
            }

            let url: string | null = null;

            // In editor mode, use document search FIRST (DOM doesn't have URLs)
            if (el.closest('.cm-editor')) {
                url = this.getUrlFromEditorByText(el);
            }

            // Fallback to DOM extraction (works in Reader mode)
            if (!url) {
                url = this.extractUrlFromElement(el);
            }

            if (url) {
                return { element: el, url };
            }

            el = el.parentElement;
        }

        return null;
    }

    private getUrlFromEditorByText(element: HTMLElement): string | null {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.editor) return null;

        // Get the display text from the hovered element
        const displayText = element.textContent?.trim();
        if (!displayText) return null;

        // Get the full document content
        const content = view.editor.getValue();

        // Find all markdown links in the document: [text](url)
        const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
        let match;

        while ((match = linkRegex.exec(content)) !== null) {
            const linkText = match[1];
            const url = match[2];

            // Check if the display text matches or contains/is contained in the link text
            if (linkText === displayText ||
                linkText.includes(displayText) ||
                displayText.includes(linkText)) {
                return url;
            }
        }

        // Also try to find bare URLs if the displayText looks like a URL
        if (displayText.startsWith('http')) {
            return this.normalizeUrl(displayText);
        }

        return null;
    }

    private extractUrlFromElement(element: HTMLElement): string | null {
        // For anchor elements, use href directly
        if (element instanceof HTMLAnchorElement) {
            return element.href;
        }

        // Check element's own attributes
        const attributes = ['data-href', 'data-url', 'href', 'aria-label', 'title'];
        for (const attr of attributes) {
            const value = element.getAttribute(attr);
            const url = value ? this.normalizeUrl(value) : null;
            if (url) return url;
        }

        // For CodeMirror elements, look for ancestor anchor or external-link
        let ancestor: HTMLElement | null = element;
        while (ancestor && ancestor !== document.body) {
            if (ancestor instanceof HTMLAnchorElement && ancestor.href) {
                return this.normalizeUrl(ancestor.href);
            }
            // Check for Obsidian's external-link class which wraps the anchor
            if (ancestor.classList.contains('external-link') || ancestor.classList.contains('cm-link')) {
                const anchor = ancestor.querySelector('a[href]') as HTMLAnchorElement | null;
                if (anchor?.href) {
                    return this.normalizeUrl(anchor.href);
                }
            }
            ancestor = ancestor.parentElement;
        }

        // Fallback to text content (for bare URLs in editor)
        const text = element.textContent?.trim();
        return text ? this.normalizeUrl(text) : null;
    }

    private normalizeUrl(candidate: string): string | null {
        const trimmed = candidate.trim();
        if (!/^https?:\/\//i.test(trimmed)) {
            return null;
        }
        try {
            const url = new URL(trimmed);
            return url.href;
        } catch (e) {
            return null;
        }
    }
}

class LinkPreviewSettingTab extends PluginSettingTab {
    plugin: LinkPreviewPlugin;

    constructor(app: App, plugin: LinkPreviewPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const {containerEl} = this;

        containerEl.empty();

        new Setting(containerEl)
            .setName('Hover delay')
            .setDesc('Delay before showing preview (in ms)')
            .addText(text => text
                .setPlaceholder('500')
                .setValue(String(this.plugin.settings.hoverDelay))
                .onChange(async (value) => {
                    const numValue = Number(value);
                    if (!isNaN(numValue) && numValue >= 0) {
                        this.plugin.settings.hoverDelay = numValue;
                        await this.plugin.saveSettings();
                    }
                }));

        new Setting(containerEl)
            .setName('Maximum height')
            .setDesc('Maximum height of preview window (in px)')
            .addText(text => text
                .setPlaceholder('300')
                .setValue(String(this.plugin.settings.maxPreviewHeight))
                .onChange(async (value) => {
                    this.plugin.settings.maxPreviewHeight = Number(value);
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Maximum width')
            .setDesc('Maximum width of preview window (in px)')
            .addText(text => text
                .setPlaceholder('400')
                .setValue(String(this.plugin.settings.maxPreviewWidth))
                .onChange(async (value) => {
                    this.plugin.settings.maxPreviewWidth = Number(value);
                    await this.plugin.saveSettings();
                }));
    }
}
