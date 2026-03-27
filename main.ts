import { App, Plugin, PluginSettingTab, Setting, SettingGroup, MarkdownView, Platform, setIcon, setTooltip } from 'obsidian';

type ModifierKeyType = 'meta' | 'ctrl' | 'alt' | 'shift';
type ResizeDirection = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';

const MIN_PREVIEW_WIDTH = 200;
const MIN_PREVIEW_HEIGHT = 150;

const RESIZE_HANDLES: { direction: ResizeDirection; cls: string }[] = [
    { direction: 'n', cls: 'resize-handle-n' },
    { direction: 's', cls: 'resize-handle-s' },
    { direction: 'w', cls: 'resize-handle-w' },
    { direction: 'e', cls: 'resize-handle-e' },
    { direction: 'nw', cls: 'resize-handle-nw' },
    { direction: 'ne', cls: 'resize-handle-ne' },
    { direction: 'sw', cls: 'resize-handle-sw' },
    { direction: 'se', cls: 'resize-handle-se' },
];

interface ModifierKeyConfig {
    meta: boolean;
    ctrl: boolean;
    alt: boolean;
    shift: boolean;
}

interface LinkPreviewSettings {
    maxPreviewHeight: number;
    maxPreviewWidth: number;
    hoverDelay: number;
    requireModifierKey: boolean;
    modifierKeys: ModifierKeyConfig;
    closeOnModifierRelease: boolean;
    mouseStillnessDelay: number;
    stickyPopup: boolean;
    showOpenInBrowser: boolean;
    showCloseButton: boolean;
    allowResize: boolean;
    persistResize: boolean;
    persistedWidth?: number;
    persistedHeight?: number;
}

// Legacy settings interface for migration
interface LegacyLinkPreviewSettings {
    modifierKey?: ModifierKeyType;
}

const DEFAULT_MODIFIER_KEYS: ModifierKeyConfig = {
    meta: false,
    ctrl: false,
    alt: false,
    shift: false,
};

const DEFAULT_SETTINGS: Readonly<Omit<LinkPreviewSettings, 'modifierKeys' | 'persistedWidth' | 'persistedHeight'>> = {
    maxPreviewHeight: 960,
    maxPreviewWidth: 720,
    hoverDelay: 500,
    requireModifierKey: true,
    closeOnModifierRelease: true,
    mouseStillnessDelay: 0,
    stickyPopup: false,
    showOpenInBrowser: true,
    showCloseButton: true,
    allowResize: true,
    persistResize: false,
    // modifierKeys default is set dynamically in loadSettings() based on platform
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
    private modifierState: ModifierKeyConfig = { meta: false, ctrl: false, alt: false, shift: false };
    private lastMovementTime = 0;
    private stillnessCheckTimeout?: number;
    private activeResizeCleanup?: () => void;

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
            this.registerDomEvent(doc, 'mouseover', (e: MouseEvent) => this.handleLinkHover(e));
            this.registerDomEvent(doc, 'mousemove', (e: MouseEvent) => {
                // Track mouse stillness - only update time if mouse moved significantly (>2px)
                const dx = Math.abs(e.clientX - this.lastMouseX);
                const dy = Math.abs(e.clientY - this.lastMouseY);
                if (dx > 2 || dy > 2) {
                    this.lastMovementTime = Date.now();
                }
                this.lastMouseX = e.clientX;
                this.lastMouseY = e.clientY;
            });
            this.registerDomEvent(doc, 'keydown', (e: KeyboardEvent) => {
                if (e.key === 'Escape' && this.activePreview) {
                    this.cleanupActivePreview();
                }
                // Update modifier state
                this.updateModifierState(e);
                // Handle modifier key press while hovering over link
                if (this.settings.requireModifierKey && this.isModifierKeyEvent(e)) {
                    this.handleModifierKeyDown();
                }
            });
            this.registerDomEvent(doc, 'keyup', (e: KeyboardEvent) => {
                // Update modifier state
                this.updateModifierState(e);
                // Close preview when any required modifier key is released
                if (this.settings.requireModifierKey && this.isModifierKeyEvent(e)) {
                    this.handleModifierKeyUp();
                }
            });
            // Reset modifier state on window blur
            this.registerDomEvent(doc.defaultView ?? window, 'blur', () => {
                this.modifierState = { meta: false, ctrl: false, alt: false, shift: false };
            });
        };

        handleWindow(document);
        this.registerEvent(
            this.app.workspace.on('window-open', ({win}) => handleWindow(win.document))
        );
    }

    private updateModifierState(e: KeyboardEvent) {
        this.modifierState.meta = e.metaKey;
        this.modifierState.ctrl = e.ctrlKey;
        this.modifierState.alt = e.altKey;
        this.modifierState.shift = e.shiftKey;
    }

    private handleLinkHover(event: MouseEvent) {
        const target = event.target as Element | null;
        if (!(target instanceof Element)) return;

        // Skip if event is from inside the active preview (prevents flickering)
        if (this.activePreview?.element.contains(target)) {
            return;
        }

        // Check for modifier key requirement
        if (this.settings.requireModifierKey && !this.isModifierKeyPressed(event)) {
            return;
        }

        const linkInfo = this.findLinkElement(target, event.relatedTarget as Element | null);
        if (!linkInfo) return;

        const { element: linkElement, url } = linkInfo;

        // Clear any existing hover timeout
        if (this.hoverTimeout) {
            window.clearTimeout(this.hoverTimeout);
        }

        // Clear any existing stillness check
        if (this.stillnessCheckTimeout) {
            window.clearTimeout(this.stillnessCheckTimeout);
            this.stillnessCheckTimeout = undefined;
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
            this.tryShowPreview(linkElement, url);
        }, this.settings.hoverDelay);

        // Add mouse leave listener to target
        const handleMouseLeave = (e: MouseEvent) => {
            // Skip cleanup timer if sticky popup is enabled
            if (this.settings.stickyPopup) {
                linkElement.removeEventListener('mouseleave', handleMouseLeave);
                return;
            }

            // Check if mouse moved to the preview
            const toElement = e.relatedTarget as HTMLElement | null;
            if (toElement && this.activePreview?.element.contains(toElement)) return;

            this.startCleanupTimer();
            linkElement.removeEventListener('mouseleave', handleMouseLeave);
        };

        linkElement.addEventListener('mouseleave', handleMouseLeave);
    }

    private tryShowPreview(linkElement: HTMLElement, url: string) {
        // Check mouse stillness if delay is configured
        if (this.settings.mouseStillnessDelay > 0) {
            const timeSinceMovement = Date.now() - this.lastMovementTime;
            if (timeSinceMovement < this.settings.mouseStillnessDelay) {
                // Mouse hasn't been still long enough, reschedule check
                const remainingTime = this.settings.mouseStillnessDelay - timeSinceMovement;
                this.stillnessCheckTimeout = window.setTimeout(() => {
                    this.tryShowPreview(linkElement, url);
                }, Math.min(remainingTime, 50)); // Poll at most every 50ms
                return;
            }
        }
        this.showPreview(linkElement, url);
    }

    private showPreview(link: HTMLElement, url: string) {
        this.cleanupActivePreview();
        const rect = link.getBoundingClientRect();
        const previewEl = this.createPreviewElement(rect);

        if (this.settings.showOpenInBrowser || this.settings.showCloseButton) {
            this.createButtons(previewEl, url);
        }

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
                iframe.addClass('is-loaded');
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
            if (!this.settings.stickyPopup) {
                this.startCleanupTimer();
            }
        });

        // Add click-outside handler for sticky popup mode
        let clickOutsideHandler: ((e: MouseEvent) => void) | undefined;
        if (this.settings.stickyPopup) {
            clickOutsideHandler = (e: MouseEvent) => {
                const target = e.target as Element;
                if (!previewEl.contains(target) && !link.contains(target)) {
                    this.cleanupActivePreview();
                }
            };
            // Delay adding listener to avoid immediate trigger from the click that might have opened it
            setTimeout(() => {
                document.addEventListener('click', clickOutsideHandler!);
            }, 0);
        }

        // Update cleanup to remove click handler
        const originalCleanup = cleanup;
        const cleanupWithClickHandler = () => {
            if (clickOutsideHandler) {
                document.removeEventListener('click', clickOutsideHandler);
            }
            originalCleanup();
        };

        if (this.settings.allowResize) {
            this.createResizeHandles(previewEl);
        }

        document.body.appendChild(previewEl);
        this.activePreview = { element: previewEl, cleanup: cleanupWithClickHandler, link };
    }

    private cleanupTimeout?: number;

    private startCleanupTimer() {
        if (this.activeResizeCleanup) return;
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
        if (this.activeResizeCleanup) {
            this.activeResizeCleanup();
            this.activeResizeCleanup = undefined;
        }
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
        if (this.stillnessCheckTimeout) {
            window.clearTimeout(this.stillnessCheckTimeout);
            this.stillnessCheckTimeout = undefined;
        }
        // Safety net: remove any orphaned preview popups
        document.querySelectorAll('.hover-popup').forEach(el => el.remove());
    }

    private isModifierKeyPressed(event: MouseEvent): boolean {
        const keys = this.settings.modifierKeys;
        // Check if ALL required modifiers are pressed
        if (keys.meta && !event.metaKey) return false;
        if (keys.ctrl && !event.ctrlKey) return false;
        if (keys.alt && !event.altKey) return false;
        if (keys.shift && !event.shiftKey) return false;
        // At least one modifier must be required
        return keys.meta || keys.ctrl || keys.alt || keys.shift;
    }

    private isModifierKeyEvent(event: KeyboardEvent): boolean {
        const keys = this.settings.modifierKeys;
        // Return true if any required modifier key is pressed or released
        if (keys.meta && event.key === 'Meta') return true;
        if (keys.ctrl && event.key === 'Control') return true;
        if (keys.alt && event.key === 'Alt') return true;
        if (keys.shift && event.key === 'Shift') return true;
        return false;
    }

    private areAllModifiersPressed(): boolean {
        const keys = this.settings.modifierKeys;
        // Check if ALL required modifiers are currently pressed (using tracked state)
        if (keys.meta && !this.modifierState.meta) return false;
        if (keys.ctrl && !this.modifierState.ctrl) return false;
        if (keys.alt && !this.modifierState.alt) return false;
        if (keys.shift && !this.modifierState.shift) return false;
        // At least one modifier must be required
        return keys.meta || keys.ctrl || keys.alt || keys.shift;
    }

    private handleModifierKeyDown() {
        // If already showing a preview, do nothing
        if (this.activePreview) return;

        // Check if ALL required modifiers are now pressed
        if (!this.areAllModifiersPressed()) return;

        // Find element under cursor
        const elementUnderCursor = document.elementFromPoint(this.lastMouseX, this.lastMouseY);
        if (!elementUnderCursor) return;

        const linkInfo = this.findLinkElement(elementUnderCursor, null);
        if (linkInfo) {
            // Clear any existing timeout and show preview after delay
            if (this.hoverTimeout) {
                window.clearTimeout(this.hoverTimeout);
            }
            this.hoverTimeout = window.setTimeout(() => {
                this.tryShowPreview(linkInfo.element, linkInfo.url);
            }, this.settings.hoverDelay);
        }
    }

    private handleModifierKeyUp() {
        // Close preview when any required modifier key is released (unless sticky popup is enabled)
        if (this.settings.closeOnModifierRelease && !this.settings.stickyPopup && !this.areAllModifiersPressed()) {
            this.cleanupActivePreview();
        }
    }

    async loadSettings() {
        const loaded = (await this.loadData()) as (Partial<LinkPreviewSettings> & LegacyLinkPreviewSettings) | null;

        // Create platform-aware default modifier keys
        const platformDefaultKeys: ModifierKeyConfig = {
            ...DEFAULT_MODIFIER_KEYS,
            [Platform.isMacOS ? 'meta' : 'ctrl']: true,
        };

        let modifierKeys: ModifierKeyConfig;

        if (loaded?.modifierKeys) {
            // New format exists, use it
            modifierKeys = loaded.modifierKeys;
        } else if (loaded?.modifierKey) {
            // Migrate from old single key format
            modifierKeys = { ...DEFAULT_MODIFIER_KEYS, [loaded.modifierKey]: true };
        } else {
            // Fresh install, use platform default
            modifierKeys = platformDefaultKeys;
        }

        this.settings = {
            ...DEFAULT_SETTINGS,
            ...loaded,
            modifierKeys,
        };

        // Clean up legacy field if present
        if ('modifierKey' in this.settings) {
            delete (this.settings as LinkPreviewSettings & LegacyLinkPreviewSettings).modifierKey;
            await this.saveSettings();
        }
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
        
        el.setCssStyles({
            left: `${bounds.left}px`,
            top: `${bounds.top}px`,
            width: `${bounds.width}px`,
            height: `${bounds.height}px`,
        });
        
        return el;
    }

    private createButtons(container: HTMLElement, url: string) {
        const buttons = container.createDiv('preview-buttons');

        if (this.settings.showOpenInBrowser) {
            const openBtn = buttons.createEl('button', { cls: 'clickable-icon' });
            setIcon(openBtn, 'external-link');
            setTooltip(openBtn, 'Open in external browser');
            openBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                window.open(url);
            });
        }

        if (this.settings.showCloseButton) {
            const closeBtn = buttons.createEl('button', { cls: 'clickable-icon' });
            setIcon(closeBtn, 'x');
            setTooltip(closeBtn, 'Close preview');
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.cleanupActivePreview();
            });
        }
    }

    private createResizeHandles(previewEl: HTMLElement) {
        for (const { direction, cls } of RESIZE_HANDLES) {
            const handle = previewEl.createDiv(`resize-handle ${cls}`);
            handle.addEventListener('mousedown', (e) => this.startResize(e, previewEl, direction));
        }
    }

    private startResize(e: MouseEvent, previewEl: HTMLElement, direction: ResizeDirection) {
        e.preventDefault();
        e.stopPropagation();

        previewEl.addClass('is-resizing');

        const startX = e.clientX;
        const startY = e.clientY;
        const initialRect = previewEl.getBoundingClientRect();

        const indicator = createEl('div', { cls: 'resize-size-indicator' });
        indicator.textContent = `${Math.round(initialRect.width)}\u00d7${Math.round(initialRect.height)}`;
        indicator.setCssStyles({
            left: `${e.clientX + 12}px`,
            top: `${e.clientY + 12}px`,
        });
        document.body.appendChild(indicator);

        const margin = 5;

        const onMouseMove = (moveEvent: MouseEvent) => {
            const dx = moveEvent.clientX - startX;
            const dy = moveEvent.clientY - startY;

            let newLeft = initialRect.left;
            let newTop = initialRect.top;
            let newWidth = initialRect.width;
            let newHeight = initialRect.height;

            if (direction.includes('e')) newWidth += dx;
            if (direction.includes('w')) { newWidth -= dx; newLeft += dx; }
            if (direction.includes('s')) newHeight += dy;
            if (direction.includes('n')) { newHeight -= dy; newTop += dy; }

            // Enforce minimum size
            if (newWidth < MIN_PREVIEW_WIDTH) {
                if (direction.includes('w')) newLeft = initialRect.right - MIN_PREVIEW_WIDTH;
                newWidth = MIN_PREVIEW_WIDTH;
            }
            if (newHeight < MIN_PREVIEW_HEIGHT) {
                if (direction.includes('n')) newTop = initialRect.bottom - MIN_PREVIEW_HEIGHT;
                newHeight = MIN_PREVIEW_HEIGHT;
            }

            // Clamp to viewport
            newLeft = Math.max(margin, newLeft);
            newTop = Math.max(margin, newTop);
            if (newLeft + newWidth > window.innerWidth - margin) {
                newWidth = window.innerWidth - margin - newLeft;
            }
            if (newTop + newHeight > window.innerHeight - margin) {
                newHeight = window.innerHeight - margin - newTop;
            }

            previewEl.setCssStyles({
                left: `${newLeft}px`,
                top: `${newTop}px`,
                width: `${newWidth}px`,
                height: `${newHeight}px`,
            });

            indicator.textContent = `${Math.round(newWidth)}\u00d7${Math.round(newHeight)}`;
            indicator.setCssStyles({
                left: `${moveEvent.clientX + 12}px`,
                top: `${moveEvent.clientY + 12}px`,
            });
        };

        const onMouseUp = () => {
            previewEl.removeClass('is-resizing');
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            indicator.remove();
            this.activeResizeCleanup = undefined;

            if (this.settings.persistResize) {
                const finalRect = previewEl.getBoundingClientRect();
                this.settings.persistedWidth = Math.round(finalRect.width);
                this.settings.persistedHeight = Math.round(finalRect.height);
                void this.saveSettings();
            }
        };

        this.activeResizeCleanup = () => {
            previewEl.removeClass('is-resizing');
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            indicator.remove();
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    }

    private calculatePreviewBounds(rect: DOMRect, windowSize: { width: number, height: number }): {
        left: number,
        top: number,
        width: number,
        height: number,
        showAbove: boolean
    } {
        const margin = 5; // Margin from edges
        const targetWidth = (this.settings.persistResize && this.settings.persistedWidth)
            ? this.settings.persistedWidth : this.settings.maxPreviewWidth;
        const targetHeight = (this.settings.persistResize && this.settings.persistedHeight)
            ? this.settings.persistedHeight : this.settings.maxPreviewHeight;
        const maxWidth = Math.min(targetWidth, windowSize.width - margin * 2);
        const maxHeight = Math.min(targetHeight, windowSize.height - margin * 2);
        
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

        const displayText = element.textContent?.trim();
        if (!displayText) return null;

        const content = view.editor.getValue();
        const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
        let match;
        let substringMatch: string | null = null;

        while ((match = linkRegex.exec(content)) !== null) {
            const linkText = match[1];
            const url = match[2];

            // Exact match — return immediately
            if (linkText === displayText) {
                return url;
            }

            // Substring match — remember first one, but keep looking for exact
            if (!substringMatch &&
                (linkText.includes(displayText) || displayText.includes(linkText))) {
                substringMatch = url;
            }
        }

        // No exact match found — use substring match if any
        if (substringMatch) {
            return substringMatch;
        }

        // Bare URL fallback
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
                const anchor = ancestor.querySelector('a[href]');
                if (anchor instanceof HTMLAnchorElement && anchor.href) {
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
        } catch {
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

        const isModifierKeyEnabled = this.plugin.settings.requireModifierKey;

        new Setting(containerEl)
            .setName('Require modifier key')
            .setDesc('Only show preview when holding a modifier key while hovering')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.requireModifierKey)
                .onChange(async (value) => {
                    this.plugin.settings.requireModifierKey = value;
                    await this.plugin.saveSettings();
                    // Refresh display to update disabled/opacity states
                    this.display();
                }));

        // Modifier key toggles
        const modifierKeyNames: { key: keyof ModifierKeyConfig; label: string }[] = [
            { key: 'meta', label: Platform.isMacOS ? 'Command (⌘)' : 'Meta/Win' },
            { key: 'ctrl', label: Platform.isMacOS ? 'Control (⌃)' : 'Ctrl' },
            { key: 'alt', label: Platform.isMacOS ? 'Option (⌥)' : 'Alt' },
            { key: 'shift', label: 'Shift' },
        ];

        const modifierGroup = new SettingGroup(containerEl)
            .setHeading('Modifier keys')
            .addClass('settings-group-no-margin');

        if (!isModifierKeyEnabled) {
            modifierGroup.addClass('setting-disabled');
        }

        for (const { key, label } of modifierKeyNames) {
            modifierGroup.addSetting(setting => {
                setting
                    .setName(label)
                    .setDesc(this.getModifierKeyDescription(key))
                    .addToggle(toggle => {
                        toggle
                            .setValue(this.plugin.settings.modifierKeys[key])
                            .onChange(async (value) => {
                                this.plugin.settings.modifierKeys[key] = value;
                                // Ensure at least one modifier is selected when requireModifierKey is enabled
                                if (this.plugin.settings.requireModifierKey && !this.hasAnyModifierSelected()) {
                                    // Reset to platform default
                                    const defaultKey = Platform.isMacOS ? 'meta' : 'ctrl';
                                    this.plugin.settings.modifierKeys[defaultKey] = true;
                                }
                                await this.plugin.saveSettings();
                                this.display();
                            });
                        toggle.setDisabled(!isModifierKeyEnabled);
                    });
            });
        }

        const behaviorGroup = new SettingGroup(containerEl)
            .setHeading('Behavior')
            .addClass('settings-group-no-margin');

        behaviorGroup.addSetting(setting => {
            setting
                .setName('Close on key release')
                .setDesc('Close preview when modifier key is released')
                .addToggle(toggle => {
                    toggle
                        .setValue(this.plugin.settings.closeOnModifierRelease)
                        .onChange(async (value) => {
                            this.plugin.settings.closeOnModifierRelease = value;
                            await this.plugin.saveSettings();
                        });
                    toggle.setDisabled(!isModifierKeyEnabled);
                });
            if (!isModifierKeyEnabled) {
                setting.settingEl.addClass('setting-disabled');
            }
        });

        behaviorGroup.addSetting(setting => {
            setting
                .setName('Sticky popup')
                .setDesc('Keep popup open until escape or click outside (instead of closing when mouse leaves)')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.stickyPopup)
                    .onChange(async (value) => {
                        this.plugin.settings.stickyPopup = value;
                        await this.plugin.saveSettings();
                    }));
        });

        behaviorGroup.addSetting(setting => {
            setting
                .setName('Show open in browser button')
                .setDesc('Show a button to open the URL in the default browser')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.showOpenInBrowser)
                    .onChange(async (value) => {
                        this.plugin.settings.showOpenInBrowser = value;
                        await this.plugin.saveSettings();
                    }));
        });

        behaviorGroup.addSetting(setting => {
            setting
                .setName('Show close button')
                .setDesc('Show a button to close the preview popup')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.showCloseButton)
                    .onChange(async (value) => {
                        this.plugin.settings.showCloseButton = value;
                        await this.plugin.saveSettings();
                    }));
        });

        new SettingGroup(containerEl)
            .setHeading('Mouse settings')
            .addClass('settings-group-no-margin')
            .addSetting(setting => {
                setting
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
            })
            .addSetting(setting => {
                setting
                    .setName('Mouse stillness delay')
                    .setDesc('Time in ms the mouse must be stationary before showing preview (0 = disabled)')
                    .addText(text => text
                        .setPlaceholder('0')
                        .setValue(String(this.plugin.settings.mouseStillnessDelay))
                        .onChange(async (value) => {
                            const numValue = Number(value);
                            if (!isNaN(numValue) && numValue >= 0) {
                                this.plugin.settings.mouseStillnessDelay = numValue;
                                await this.plugin.saveSettings();
                            }
                        }));
            });

        new SettingGroup(containerEl)
            .setHeading('Preview size')
            .addClass('settings-group-no-margin')
            .addSetting(setting => {
                setting
                    .setName('Maximum height')
                    .setDesc('Maximum height of preview window (in px)')
                    .addText(text => text
                        .setPlaceholder('300')
                        .setValue(String(this.plugin.settings.maxPreviewHeight))
                        .onChange(async (value) => {
                            this.plugin.settings.maxPreviewHeight = Number(value);
                            this.plugin.settings.persistedWidth = undefined;
                            this.plugin.settings.persistedHeight = undefined;
                            await this.plugin.saveSettings();
                        }));
            })
            .addSetting(setting => {
                setting
                    .setName('Maximum width')
                    .setDesc('Maximum width of preview window (in px)')
                    .addText(text => text
                        .setPlaceholder('400')
                        .setValue(String(this.plugin.settings.maxPreviewWidth))
                        .onChange(async (value) => {
                            this.plugin.settings.maxPreviewWidth = Number(value);
                            this.plugin.settings.persistedWidth = undefined;
                            this.plugin.settings.persistedHeight = undefined;
                            await this.plugin.saveSettings();
                        }));
            });

        const isResizeEnabled = this.plugin.settings.allowResize;

        const resizeGroup = new SettingGroup(containerEl)
            .setHeading('Resize')
            .addClass('settings-group-no-margin');

        resizeGroup.addSetting(setting => {
            setting
                .setName('Allow resize')
                .setDesc('Drag the edges or corners of the preview to resize it')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.allowResize)
                    .onChange(async (value) => {
                        this.plugin.settings.allowResize = value;
                        await this.plugin.saveSettings();
                        this.display();
                    }));
        });

        resizeGroup.addSetting(setting => {
            setting
                .setName('Persist resize')
                .setDesc('Remember resized dimensions for future previews')
                .addToggle(toggle => {
                    toggle
                        .setValue(this.plugin.settings.persistResize)
                        .onChange(async (value) => {
                            this.plugin.settings.persistResize = value;
                            if (!value) {
                                this.plugin.settings.persistedWidth = undefined;
                                this.plugin.settings.persistedHeight = undefined;
                            }
                            await this.plugin.saveSettings();
                        });
                    toggle.setDisabled(!isResizeEnabled);
                });
            if (!isResizeEnabled) {
                setting.settingEl.addClass('setting-disabled');
            }
        });
    }

    private hasAnyModifierSelected(): boolean {
        const keys = this.plugin.settings.modifierKeys;
        return keys.meta || keys.ctrl || keys.alt || keys.shift;
    }

    private getModifierKeyDescription(key: keyof ModifierKeyConfig): string {
        const descriptions: Record<keyof ModifierKeyConfig, string> = {
            meta: Platform.isMacOS ? 'Require Command key' : 'Require Meta/Windows key',
            ctrl: Platform.isMacOS ? 'Require Control key' : 'Require Ctrl key',
            alt: Platform.isMacOS ? 'Require Option key' : 'Require Alt key',
            shift: 'Require Shift key',
        };
        return descriptions[key];
    }
}
