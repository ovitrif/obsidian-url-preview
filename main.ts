import { EditorView } from '@codemirror/view';
import { App, Plugin, PluginSettingTab, Setting, SettingGroup, Platform, setIcon, setTooltip } from 'obsidian';

type ModifierKeyType = 'meta' | 'ctrl' | 'alt' | 'shift';
type ResizeDirection = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';

interface ScreenPoint {
    x: number;
    y: number;
}

interface LinkInfo {
    element: HTMLElement;
    hoverElement: HTMLElement;
    sourceKey?: string;
    url: string;
}

interface ParsedMarkdownLink {
    destinationEnd: number;
    destinationStart: number;
    end: number;
    start: number;
    text: string;
    textEnd: number;
    textStart: number;
    url: string;
}

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
        doc: Document,
        link: HTMLElement,
        sourceKey?: string
    };
    private hoverTimeout?: number;
    private pendingPreview?: {
        hoverElement: HTMLElement,
        sourceKey?: string
    };
    private lastMouseX = 0;
    private lastMouseY = 0;
    private modifierState: ModifierKeyConfig = { meta: false, ctrl: false, alt: false, shift: false };
    private lastMovementTime = 0;
    private stillnessCheckTimeout?: number;
    private activeResizeCleanup?: () => void;
    private loadingIndicator?: HTMLElement;
    private handledDocuments = new Set<Document>();

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
            if (this.handledDocuments.has(doc)) return;
            this.handledDocuments.add(doc);

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
                if (this.loadingIndicator) {
                    this.loadingIndicator.setCssStyles({
                        left: `${e.clientX + 12}px`,
                        top: `${e.clientY + 12}px`,
                    });
                }
            });
            this.registerDomEvent(doc, 'keydown', (e: KeyboardEvent) => {
                if (e.key === 'Escape' && this.activePreview) {
                    this.cleanupActivePreview();
                }
                // Update modifier state
                this.updateModifierState(e);
                // Handle modifier key press while hovering over link
                if (this.settings.requireModifierKey && this.isModifierKeyEvent(e)) {
                    this.handleModifierKeyDown(doc);
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
        this.app.workspace.iterateAllLeaves((leaf) => {
            handleWindow(leaf.view.containerEl.ownerDocument);
        });

        this.registerEvent(
            this.app.workspace.on('window-open', (workspaceWindow) => handleWindow(workspaceWindow.doc))
        );
        this.registerEvent(
            this.app.workspace.on('window-close', (workspaceWindow) => {
                if (this.activePreview?.doc === workspaceWindow.doc) {
                    this.cleanupActivePreview();
                }
                this.handledDocuments.delete(workspaceWindow.doc);
            })
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

        const relatedTarget = event.relatedTarget instanceof Element ? event.relatedTarget : null;
        const linkInfo = this.findLinkElement(target, relatedTarget, { x: event.clientX, y: event.clientY });
        if (!linkInfo) return;

        const { element: linkElement, hoverElement, sourceKey, url } = linkInfo;
        const targetDoc = hoverElement.ownerDocument;

        if (this.isActivePreviewForLink(linkInfo)) {
            if (this.cleanupTimeout) {
                window.clearTimeout(this.cleanupTimeout);
                this.cleanupTimeout = undefined;
            }
            this.removeLoadingIndicator();
            return;
        }

        if (this.isPendingPreviewForLink(linkInfo)) {
            return;
        }

        // Clear any existing hover timeout
        if (this.hoverTimeout) {
            window.clearTimeout(this.hoverTimeout);
            this.pendingPreview = undefined;
        }

        // Clear any existing stillness check
        if (this.stillnessCheckTimeout) {
            window.clearTimeout(this.stillnessCheckTimeout);
            this.stillnessCheckTimeout = undefined;
        }

        // Clean up any existing preview
        this.cleanupActivePreview();

        // Set timeout for showing preview
        this.showLoadingIndicator(targetDoc);
        this.pendingPreview = { hoverElement, sourceKey };
        this.hoverTimeout = window.setTimeout(() => {
            this.tryShowPreview(linkElement, url, hoverElement, sourceKey);
        }, this.settings.hoverDelay);

        // Add mouse leave listener to target
        const handleMouseLeave = (e: MouseEvent) => {
            // Skip cleanup timer if sticky popup is enabled
            if (this.settings.stickyPopup) {
                hoverElement.removeEventListener('mouseleave', handleMouseLeave);
                return;
            }

            // Check if mouse moved to the preview
            const toElement = e.relatedTarget as HTMLElement | null;
            if (toElement && this.activePreview?.element.contains(toElement)) return;

            // If preview hasn't shown yet, cancel the pending load
            if (!this.activePreview && this.hoverTimeout) {
                window.clearTimeout(this.hoverTimeout);
                this.hoverTimeout = undefined;
                this.pendingPreview = undefined;
                this.removeLoadingIndicator();
            } else {
                this.startCleanupTimer();
            }
            hoverElement.removeEventListener('mouseleave', handleMouseLeave);
        };

        hoverElement.addEventListener('mouseleave', handleMouseLeave);
    }

    private tryShowPreview(linkElement: HTMLElement, url: string, hoverElement: HTMLElement, sourceKey?: string) {
        // If modifiers are required but no longer held, cancel
        if (this.settings.requireModifierKey && !this.areAllModifiersPressed()) {
            this.removeLoadingIndicator();
            this.pendingPreview = undefined;
            return;
        }
        // Check mouse stillness if delay is configured
        if (this.settings.mouseStillnessDelay > 0) {
            const timeSinceMovement = Date.now() - this.lastMovementTime;
            if (timeSinceMovement < this.settings.mouseStillnessDelay) {
                // Mouse hasn't been still long enough, reschedule check
                const remainingTime = this.settings.mouseStillnessDelay - timeSinceMovement;
                this.stillnessCheckTimeout = window.setTimeout(() => {
                    this.tryShowPreview(linkElement, url, hoverElement, sourceKey);
                }, Math.min(remainingTime, 50)); // Poll at most every 50ms
                return;
            }
        }
        this.showPreview(linkElement, url, hoverElement, sourceKey);
    }

    private showPreview(link: HTMLElement, url: string, hoverElement: HTMLElement, sourceKey?: string) {
        this.removeLoadingIndicator();
        this.cleanupActivePreview();
        this.pendingPreview = undefined;
        const doc = link.ownerDocument;
        const rect = link.getBoundingClientRect();
        const previewEl = this.createPreviewElement(rect, doc);

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
        
        const iframe = doc.createElement('iframe');
        iframe.setAttribute('src', url);
        
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
                if (!previewEl.contains(target) && !hoverElement.contains(target)) {
                    this.cleanupActivePreview();
                }
            };
            // Delay adding listener to avoid immediate trigger from the click that might have opened it
            setTimeout(() => {
                doc.addEventListener('click', clickOutsideHandler!);
            }, 0);
        }

        // Update cleanup to remove click handler
        const originalCleanup = cleanup;
        const cleanupWithClickHandler = () => {
            if (clickOutsideHandler) {
                doc.removeEventListener('click', clickOutsideHandler);
            }
            originalCleanup();
        };

        if (this.settings.allowResize) {
            this.createResizeHandles(previewEl);
        }

        doc.body.appendChild(previewEl);
        this.activePreview = { element: previewEl, cleanup: cleanupWithClickHandler, doc, link: hoverElement, sourceKey };
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
        this.removeLoadingIndicator();
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
            this.pendingPreview = undefined;
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
        this.removeOrphanedPreviews();
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

    private handleModifierKeyDown(doc: Document) {
        // If already showing a preview, do nothing
        if (this.activePreview) return;

        // Check if ALL required modifiers are now pressed
        if (!this.areAllModifiersPressed()) return;

        // Skip if mouse hasn't moved recently — user is likely typing/editing
        if (Date.now() - this.lastMovementTime > 1500) return;

        // Find element under cursor
        const elementUnderCursor = doc.elementFromPoint(this.lastMouseX, this.lastMouseY);
        if (!elementUnderCursor) return;

        const linkInfo = this.findLinkElement(elementUnderCursor, null, { x: this.lastMouseX, y: this.lastMouseY });
        if (linkInfo) {
            // Clear any existing timeout and show preview after delay
            if (this.hoverTimeout) {
                window.clearTimeout(this.hoverTimeout);
                this.pendingPreview = undefined;
            }
            this.showLoadingIndicator(linkInfo.hoverElement.ownerDocument);
            this.pendingPreview = {
                hoverElement: linkInfo.hoverElement,
                sourceKey: linkInfo.sourceKey,
            };
            this.hoverTimeout = window.setTimeout(() => {
                this.tryShowPreview(linkInfo.element, linkInfo.url, linkInfo.hoverElement, linkInfo.sourceKey);
            }, this.settings.hoverDelay);
        }
    }

    private handleModifierKeyUp() {
        if (this.settings.requireModifierKey && !this.areAllModifiersPressed()) {
            // Always cancel pending preview when modifiers released
            if (this.hoverTimeout) {
                window.clearTimeout(this.hoverTimeout);
                this.hoverTimeout = undefined;
                this.pendingPreview = undefined;
            }
            if (this.stillnessCheckTimeout) {
                window.clearTimeout(this.stillnessCheckTimeout);
                this.stillnessCheckTimeout = undefined;
                this.pendingPreview = undefined;
            }
            this.removeLoadingIndicator();

            // Only close visible preview if setting is enabled
            if (this.settings.closeOnModifierRelease && !this.settings.stickyPopup) {
                this.cleanupActivePreview();
            }
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

    private removeOrphanedPreviews() {
        for (const doc of this.handledDocuments) {
            doc.querySelectorAll('.hover-popup').forEach(el => el.remove());
        }
    }

    private showLoadingIndicator(doc: Document) {
        this.removeLoadingIndicator();
        const el = doc.createElement('div');
        el.addClass('preview-loading-cursor');
        el.setCssStyles({
            left: `${this.lastMouseX + 12}px`,
            top: `${this.lastMouseY + 12}px`,
        });
        doc.body.appendChild(el);
        this.loadingIndicator = el;
    }

    private removeLoadingIndicator() {
        this.loadingIndicator?.remove();
        this.loadingIndicator = undefined;
    }

    private createPreviewElement(rect: DOMRect, doc: Document): HTMLElement {
        const el = doc.createElement('div');
        el.addClass('hover-popup');
        const win = doc.defaultView ?? window;
        
        const windowSize = {
            width: win.innerWidth,
            height: win.innerHeight
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
        const win = container.ownerDocument.defaultView ?? window;

        if (this.settings.showOpenInBrowser) {
            const openBtn = buttons.createEl('button', { cls: 'clickable-icon' });
            setIcon(openBtn, 'external-link');
            setTooltip(openBtn, 'Open in external browser');
            openBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                win.open(url);
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
        const doc = previewEl.ownerDocument;
        const win = doc.defaultView ?? window;

        const startX = e.clientX;
        const startY = e.clientY;
        const initialRect = previewEl.getBoundingClientRect();

        const indicator = doc.createElement('div');
        indicator.addClass('resize-size-indicator');
        indicator.textContent = `${Math.round(initialRect.width)}\u00d7${Math.round(initialRect.height)}`;
        indicator.setCssStyles({
            left: `${e.clientX + 12}px`,
            top: `${e.clientY + 12}px`,
        });
        doc.body.appendChild(indicator);

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
            if (newLeft + newWidth > win.innerWidth - margin) {
                newWidth = win.innerWidth - margin - newLeft;
            }
            if (newTop + newHeight > win.innerHeight - margin) {
                newHeight = win.innerHeight - margin - newTop;
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
            doc.removeEventListener('mousemove', onMouseMove);
            doc.removeEventListener('mouseup', onMouseUp);
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
            doc.removeEventListener('mousemove', onMouseMove);
            doc.removeEventListener('mouseup', onMouseUp);
            indicator.remove();
        };

        doc.addEventListener('mousemove', onMouseMove);
        doc.addEventListener('mouseup', onMouseUp);
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

    private findLinkElement(target: Element, relatedTarget: Element | null, point?: ScreenPoint): LinkInfo | null {
        const editorLinkInfo = this.getEditorLinkInfo(target, point);
        if (editorLinkInfo) {
            return editorLinkInfo;
        }

        const LINK_SELECTOR = 'a.external-link, a[href^="http"], span.external-link, .cm-hmd-external-link, .cm-link .cm-underline, .cm-url, [data-href], [data-url]';

        let el: Element | null = target;
        const body = target.ownerDocument.body;
        while (el && el !== body) {
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

            const url = this.extractUrlFromElement(el);

            if (url) {
                return { element: el, hoverElement: el, url };
            }

            el = el.parentElement;
        }

        return null;
    }

    private getEditorLinkInfo(target: Element, point?: ScreenPoint): LinkInfo | null {
        if (!(target instanceof HTMLElement)) return null;

        const editorElement = target.closest('.cm-editor');
        if (!(editorElement instanceof HTMLElement)) return null;

        const editorView = EditorView.findFromDOM(target) ?? EditorView.findFromDOM(editorElement);
        if (!editorView) return null;

        const content = editorView.state.doc.toString();
        const hoverElement = this.getEditorHoverElement(target, editorElement);
        const pointLink = point ? this.getMarkdownLinkAtPoint(editorView, content, point) : null;

        if (pointLink) {
            return {
                element: target,
                hoverElement,
                sourceKey: this.getMarkdownLinkSourceKey(pointLink),
                url: pointLink.url,
            };
        }

        if (!this.isEditorLinkLikeElement(target)) {
            return null;
        }

        const textLink = this.getMarkdownLinkByDisplayText(content, target);
        if (textLink) {
            return {
                element: target,
                hoverElement,
                sourceKey: this.getMarkdownLinkSourceKey(textLink),
                url: textLink.url,
            };
        }

        return null;
    }

    private getEditorHoverElement(target: HTMLElement, editorElement: HTMLElement): HTMLElement {
        const lineElement = target.closest('.cm-line');
        if (lineElement instanceof HTMLElement) {
            return lineElement;
        }
        return editorElement;
    }

    private isEditorLinkLikeElement(element: HTMLElement): boolean {
        return Boolean(element.closest('.cm-link, .cm-hmd-external-link, .cm-url, .cm-underline, [data-href], [data-url], a[href]'));
    }

    private getMarkdownLinkAtPoint(editorView: EditorView, content: string, point: ScreenPoint): ParsedMarkdownLink | null {
        const offset = editorView.posAtCoords(point);
        if (offset === null) return null;

        const nearbyOffsets = [
            offset,
            Math.max(0, offset - 1),
            Math.min(content.length, offset + 1),
        ];
        const links = this.parseMarkdownLinks(content);

        for (const nearbyOffset of nearbyOffsets) {
            const link = this.findParsedMarkdownLinkAtOffset(links, nearbyOffset);
            if (link) return link;
        }

        for (const nearbyOffset of nearbyOffsets) {
            const link = this.getBareMarkdownUrlAtOffset(content, nearbyOffset);
            if (link) return link;
        }

        return null;
    }

    private getMarkdownLinkByDisplayText(content: string, element: HTMLElement): ParsedMarkdownLink | null {
        const displayText = element.textContent?.trim();
        if (!displayText) return null;

        let substringMatch: ParsedMarkdownLink | null = null;

        for (const link of this.parseMarkdownLinks(content)) {
            const linkText = link.text.trim();

            // Exact match — return immediately
            if (linkText === displayText) {
                return link;
            }

            // Substring match — remember first one, but keep looking for exact
            if (!substringMatch &&
                (linkText.includes(displayText) || displayText.includes(linkText))) {
                substringMatch = link;
            }
        }

        // No exact match found — use substring match if any
        if (substringMatch) {
            return substringMatch;
        }

        return this.getBareMarkdownUrl(displayText);
    }

    private findParsedMarkdownLinkAtOffset(links: ParsedMarkdownLink[], offset: number): ParsedMarkdownLink | null {
        for (const link of links) {
            if (offset >= link.start && offset <= link.end) {
                return link;
            }
        }

        return null;
    }

    private parseMarkdownLinks(content: string): ParsedMarkdownLink[] {
        const links: ParsedMarkdownLink[] = [];
        let index = 0;

        while (index < content.length) {
            const start = content.indexOf('[', index);
            if (start === -1) break;

            if (start > 0 && content[start - 1] === '!') {
                index = start + 1;
                continue;
            }

            const textEnd = this.findClosingBracket(content, start);
            if (textEnd === -1 || content[textEnd + 1] !== '(') {
                index = start + 1;
                continue;
            }

            const destinationStart = textEnd + 2;
            const destinationEnd = this.findClosingParen(content, destinationStart);
            if (destinationEnd === -1) {
                index = start + 1;
                continue;
            }

            const url = this.extractMarkdownDestination(content.slice(destinationStart, destinationEnd));
            if (url) {
                links.push({
                    destinationEnd,
                    destinationStart,
                    end: destinationEnd + 1,
                    start,
                    text: content.slice(start + 1, textEnd),
                    textEnd,
                    textStart: start + 1,
                    url,
                });
            }

            index = destinationEnd + 1;
        }

        return links;
    }

    private findClosingBracket(content: string, start: number): number {
        let depth = 0;

        for (let index = start; index < content.length; index++) {
            const char = content[index];

            if (char === '\\') {
                index++;
                continue;
            }

            if (char === '[') {
                depth++;
            } else if (char === ']') {
                depth--;
                if (depth === 0) {
                    return index;
                }
            }
        }

        return -1;
    }

    private findClosingParen(content: string, start: number): number {
        let depth = 0;

        for (let index = start; index < content.length; index++) {
            const char = content[index];

            if (char === '\\') {
                index++;
                continue;
            }

            if (char === '(') {
                depth++;
            } else if (char === ')') {
                if (depth === 0) {
                    return index;
                }
                depth--;
            }
        }

        return -1;
    }

    private extractMarkdownDestination(destination: string): string | null {
        const trimmed = destination.trim();
        if (!trimmed) return null;

        if (trimmed.startsWith('<')) {
            const end = trimmed.indexOf('>');
            if (end !== -1) {
                return this.normalizeUrl(trimmed.slice(1, end));
            }
        }

        return this.normalizeUrl(trimmed.split(/\s+/)[0]);
    }

    private getBareMarkdownUrl(displayText: string): ParsedMarkdownLink | null {
        const url = this.normalizeUrl(displayText);
        if (!url) return null;

        return {
            destinationEnd: displayText.length,
            destinationStart: 0,
            end: displayText.length,
            start: 0,
            text: displayText,
            textEnd: displayText.length,
            textStart: 0,
            url,
        };
    }

    private getBareMarkdownUrlAtOffset(content: string, offset: number): ParsedMarkdownLink | null {
        const urlRegex = /https?:\/\/[^\s<>"')]+/gi;
        let match;

        while ((match = urlRegex.exec(content)) !== null) {
            const start = match.index;
            const text = match[0];
            const end = start + text.length;
            if (offset < start || offset > end) continue;

            const url = this.normalizeUrl(text);
            if (!url) return null;

            return {
                destinationEnd: end,
                destinationStart: start,
                end,
                start,
                text,
                textEnd: end,
                textStart: start,
                url,
            };
        }

        return null;
    }

    private getMarkdownLinkSourceKey(link: ParsedMarkdownLink): string {
        return `${link.start}:${link.end}:${link.url}`;
    }

    private isActivePreviewForLink(linkInfo: LinkInfo): boolean {
        if (!this.activePreview) return false;
        if (this.activePreview.link !== linkInfo.hoverElement) return false;

        if (this.activePreview.sourceKey || linkInfo.sourceKey) {
            return this.activePreview.sourceKey === linkInfo.sourceKey;
        }

        return true;
    }

    private isPendingPreviewForLink(linkInfo: LinkInfo): boolean {
        if (!this.pendingPreview) return false;
        if (this.pendingPreview.hoverElement !== linkInfo.hoverElement) return false;

        if (this.pendingPreview.sourceKey || linkInfo.sourceKey) {
            return this.pendingPreview.sourceKey === linkInfo.sourceKey;
        }

        return true;
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
        const body = element.ownerDocument.body;
        while (ancestor && ancestor !== body) {
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

        const hasPersistedSize = this.plugin.settings.persistedWidth != null
            && this.plugin.settings.persistedHeight != null;
        const persistDesc = hasPersistedSize
            ? `Remember resized dimensions for future previews (current: ${this.plugin.settings.persistedWidth}\u00d7${this.plugin.settings.persistedHeight})`
            : 'Remember resized dimensions for future previews';

        resizeGroup.addSetting(setting => {
            setting
                .setName('Persist resize')
                .setDesc(persistDesc)
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
                            this.display();
                        });
                    toggle.setDisabled(!isResizeEnabled);
                });
            if (hasPersistedSize && isResizeEnabled) {
                setting.addButton(button => button
                    .setButtonText('Reset')
                    .onClick(async () => {
                        this.plugin.settings.persistedWidth = undefined;
                        this.plugin.settings.persistedHeight = undefined;
                        await this.plugin.saveSettings();
                        this.display();
                    }));
            }
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
