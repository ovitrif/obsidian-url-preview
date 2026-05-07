import {
    Decoration,
    EditorView,
    ViewPlugin,
    WidgetType,
} from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import {
    App,
    Editor,
    MarkdownView,
    Menu,
    Notice,
    Platform,
    Plugin,
    PluginSettingTab,
    SettingGroup,
    normalizePath,
    requestUrl,
    setIcon,
    setTooltip,
} from 'obsidian';

type ModifierKeyType = 'meta' | 'ctrl' | 'alt' | 'shift';
type ResizeDirection = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';

interface ScreenPoint {
    x: number;
    y: number;
}

interface LinkInfo {
    editorView?: EditorView;
    element: HTMLElement;
    hoverElement: HTMLElement;
    markdownLink?: ParsedMarkdownLink;
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

interface EditorContextLink {
    link: ParsedMarkdownLink;
    rawText: string;
    timestamp: number;
}

interface TextRange {
    end: number;
    start: number;
}

interface InlinePreviewControlsState {
    container: HTMLElement;
    githubConvertButton: HTMLElement;
    previewButton: HTMLElement;
    target?: LinkInfo;
}

interface GitHubPullRequestBadgeObserver {
    observer: MutationObserver;
    scheduled: boolean;
}

type GitHubAuthState = 'signed-in' | 'signed-out' | 'unknown';

interface RequireHost {
    require?: (moduleName: string) => unknown;
}

interface ElectronCookie {
    name: string;
    value: string;
}

interface ElectronCookies {
    get(filter: { url?: string; name?: string }): Promise<ElectronCookie[]>;
}

interface ElectronModule {
    session?: {
        defaultSession?: {
            cookies?: ElectronCookies;
        };
    };
}

const MIN_PREVIEW_WIDTH = 200;
const MIN_PREVIEW_HEIGHT = 150;
const INLINE_CONTROLS_GAP = 4;
const INLINE_CONTROLS_SIZE = 16;
const INLINE_CONTROLS_ADORNMENT_SCAN_WIDTH = 120;
const GITHUB_PULL_REQUEST_BADGE_WIDGET_SIDE = 10000;
const MIN_PREVIEW_LOADING_MS = 750;
const POST_LOAD_SPINNER_MS = 350;
const TOOLBAR_TOOLTIP_OPTIONS = {
    classes: ['url-preview-toolbar-tooltip'],
    delay: 250,
    gap: 6,
    placement: 'bottom' as const,
};
const EDITOR_LINK_SELECTOR = '.external-link, .cm-link, .cm-hmd-external-link, .cm-url, .cm-underline, [data-href], [data-url], a[href]';

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

class GitHubPullRequestBadgeWidget extends WidgetType {
    constructor(private readonly pullRequestId: string) {
        super();
    }

    eq(other: GitHubPullRequestBadgeWidget): boolean {
        return this.pullRequestId === other.pullRequestId;
    }

    toDOM(view: EditorView): HTMLElement {
        const badge = view.dom.ownerDocument.createElement('span');
        badge.addClass('url-preview-github-pr-badge');
        badge.textContent = `#${this.pullRequestId}`;
        badge.setAttr('aria-label', `Pull request #${this.pullRequestId}`);
        return badge;
    }

    ignoreEvent(): boolean {
        return true;
    }
}

interface ModifierKeyConfig {
    meta: boolean;
    ctrl: boolean;
    alt: boolean;
    shift: boolean;
}

interface LinkPreviewSettings {
    maxPreviewHeight: number;
    maxPreviewWidth: number;
    modifierKeys: ModifierKeyConfig;
    stickyPopup: boolean;
    showOpenInBrowser: boolean;
    showCloseButton: boolean;
    showGitHubPullRequestIds: boolean;
    allowResize: boolean;
    persistResize: boolean;
    domainZoomLevels: Record<string, number>;
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
    stickyPopup: true,
    showOpenInBrowser: true,
    showCloseButton: true,
    showGitHubPullRequestIds: true,
    allowResize: true,
    persistResize: false,
    domainZoomLevels: {},
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
    private lastMouseX = 0;
    private lastMouseY = 0;
    private activeResizeCleanup?: () => void;
    private handledDocuments = new Set<Document>();
    private convertLinkMenus = new WeakSet<Menu>();
    private lastEditorContextLink?: EditorContextLink;
    private inlinePreviewControls = new Map<Document, InlinePreviewControlsState>();
    private githubPullRequestBadgeObservers = new Map<Document, GitHubPullRequestBadgeObserver>();
    private githubPullRequestBadgeVersion = 0;

    async onload() {
        await this.loadSettings();
        await this.removeLegacyPreviewCache();
        
        // Defer setup until layout is ready
        this.app.workspace.onLayoutReady(() => {
            this.registerGlobalHandler();
        });

        this.registerEvent(
            this.app.workspace.on('editor-menu', (menu, editor) => {
                this.addConvertToMarkdownLinkMenuItem(menu, editor);
            })
        );
        this.registerEvent(
            this.app.workspace.on('url-menu', (menu, url) => {
                this.addConvertToMarkdownLinkMenuItemForUrl(menu, url);
            })
        );
        this.registerEditorExtension(this.createGitHubPullRequestBadgeExtension());
        
        this.addSettingTab(new LinkPreviewSettingTab(this.app, this));
    }

    private createGitHubPullRequestBadgeExtension() {
        const buildDecorations = (view: EditorView) => this.buildGitHubPullRequestBadgeDecorations(view);
        const getBadgeVersion = () => this.githubPullRequestBadgeVersion;

        return ViewPlugin.fromClass(
            class {
                decorations: DecorationSet;
                version: number;

                constructor(view: EditorView) {
                    this.version = getBadgeVersion();
                    this.decorations = buildDecorations(view);
                }

                update(update: ViewUpdate) {
                    const version = getBadgeVersion();
                    if (!update.docChanged && !update.viewportChanged && this.version === version) return;

                    this.version = version;
                    this.decorations = buildDecorations(update.view);
                }
            },
            {
                decorations: (value) => value.decorations,
            }
        );
    }

    private buildGitHubPullRequestBadgeDecorations(view: EditorView): DecorationSet {
        if (!this.settings.showGitHubPullRequestIds) return Decoration.none;

        const links = this.parseEditorLinks(view.state.doc.toString());

        return Decoration.set(
            links.flatMap((link) => {
                const pullRequestId = this.getGitHubPullRequestId(link.url);
                if (!pullRequestId) return [];

                const badgePosition = link.end;
                const label = `Pull request #${pullRequestId}`;
                return [
                    Decoration.mark({
                        attributes: {
                            'aria-label': label,
                            'class': 'url-preview-github-pr-link-tooltip',
                        },
                    }).range(link.textStart, link.textEnd),
                    Decoration.widget({
                        side: GITHUB_PULL_REQUEST_BADGE_WIDGET_SIDE,
                        widget: new GitHubPullRequestBadgeWidget(pullRequestId),
                    }).range(badgePosition),
                ];
            }),
            true
        );
    }

    private registerGlobalHandler() {
        const handleWindow = (doc: Document) => {
            if (this.handledDocuments.has(doc)) return;
            this.handledDocuments.add(doc);

            this.registerDomEvent(doc, 'mouseover', (e: MouseEvent) => {
                this.updateInlinePreviewButton(e);
            });
            this.registerDomEvent(doc, 'contextmenu', (e: MouseEvent) => this.captureEditorContextMenuLink(e));
            this.registerDomEvent(doc, 'click', (e: MouseEvent) => this.handleLinkClick(e), { capture: true });
            this.registerDomEvent(doc, 'mousemove', (e: MouseEvent) => {
                const dx = Math.abs(e.clientX - this.lastMouseX);
                const dy = Math.abs(e.clientY - this.lastMouseY);
                const didMouseMove = dx > 0 || dy > 0;
                this.lastMouseX = e.clientX;
                this.lastMouseY = e.clientY;
                if (didMouseMove) {
                    this.updateInlinePreviewButton(e);
                }
            });
            this.registerDomEvent(doc, 'keydown', (e: KeyboardEvent) => {
                if (e.key === 'Escape' && this.activePreview) {
                    this.cleanupActivePreview();
                }
            });
            this.registerGitHubPullRequestBadges(doc);
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
                this.removeInlinePreviewControls(workspaceWindow.doc);
                this.unregisterGitHubPullRequestBadges(workspaceWindow.doc);
                this.handledDocuments.delete(workspaceWindow.doc);
            })
        );
    }

    private registerGitHubPullRequestBadges(doc: Document) {
        if (this.githubPullRequestBadgeObservers.has(doc)) return;

        this.syncGitHubPullRequestBadgeVisibility(doc);
        const observerState: GitHubPullRequestBadgeObserver = {
            observer: new MutationObserver(() => this.scheduleGitHubPullRequestBadgeUpdate(doc)),
            scheduled: false,
        };
        this.githubPullRequestBadgeObservers.set(doc, observerState);
        observerState.observer.observe(doc.body, { childList: true, subtree: true });
        this.scheduleGitHubPullRequestBadgeUpdate(doc);
    }

    private unregisterGitHubPullRequestBadges(doc: Document) {
        const observerState = this.githubPullRequestBadgeObservers.get(doc);
        if (!observerState) return;

        observerState.observer.disconnect();
        this.githubPullRequestBadgeObservers.delete(doc);
        doc.querySelectorAll('.url-preview-github-pr-badge').forEach((badge) => badge.remove());
        doc.body.removeClass('url-preview-hide-github-pr-badges');
    }

    private scheduleGitHubPullRequestBadgeUpdate(doc: Document) {
        const observerState = this.githubPullRequestBadgeObservers.get(doc);
        if (!observerState || observerState.scheduled) return;

        observerState.scheduled = true;
        const win = doc.defaultView ?? window;
        win.requestAnimationFrame(() => {
            observerState.scheduled = false;
            this.updateGitHubPullRequestBadges(doc);
        });
    }

    private updateGitHubPullRequestBadges(doc: Document) {
        if (!this.settings.showGitHubPullRequestIds) {
            doc.querySelectorAll('.url-preview-github-pr-badge').forEach((badge) => badge.remove());
            return;
        }

        const links = Array.from(doc.querySelectorAll('a[href]'));
        for (const link of links) {
            if (!(link instanceof HTMLAnchorElement)) continue;
            if (link.closest('.hover-popup, .url-preview-inline-controls, .cm-editor')) continue;

            const pullRequestId = this.getGitHubPullRequestId(link.href);
            if (!pullRequestId) {
                this.removeGitHubPullRequestBadge(link);
                continue;
            }

            this.upsertGitHubPullRequestBadge(link, pullRequestId);
        }
    }

    private upsertGitHubPullRequestBadge(link: HTMLAnchorElement, pullRequestId: string) {
        link.querySelectorAll('.url-preview-github-pr-badge').forEach((badge) => badge.remove());

        const nextElement = link.nextElementSibling;
        const existingBadge = nextElement?.classList.contains('url-preview-github-pr-badge') ? nextElement : null;
        if (existingBadge instanceof HTMLElement) {
            if (existingBadge.textContent !== `#${pullRequestId}`) {
                existingBadge.textContent = `#${pullRequestId}`;
                existingBadge.setAttr('aria-label', `Pull request #${pullRequestId}`);
            }
            return;
        }

        const badge = link.ownerDocument.createElement('span');
        badge.addClass('url-preview-github-pr-badge');
        badge.textContent = `#${pullRequestId}`;
        badge.setAttr('aria-label', `Pull request #${pullRequestId}`);
        link.parentElement?.insertBefore(badge, link.nextSibling);
    }

    private removeGitHubPullRequestBadge(link: HTMLAnchorElement) {
        link.querySelectorAll('.url-preview-github-pr-badge').forEach((badge) => badge.remove());
        const nextElement = link.nextElementSibling;
        if (nextElement?.classList.contains('url-preview-github-pr-badge')) {
            nextElement.remove();
        }
    }

    private getGitHubPullRequestId(url: string): string | null {
        try {
            const parsedUrl = new URL(url);
            if (parsedUrl.hostname !== 'github.com') return null;

            const match = parsedUrl.pathname.match(/^\/[^/]+\/[^/]+\/pull\/(\d+)(?:\/|$)/);
            return match?.[1] ?? null;
        } catch {
            return null;
        }
    }

    async setShowGitHubPullRequestIds(value: boolean) {
        this.settings.showGitHubPullRequestIds = value;
        await this.saveSettings();
        this.refreshGitHubPullRequestBadges();
    }

    private refreshGitHubPullRequestBadges() {
        this.githubPullRequestBadgeVersion += 1;
        for (const doc of this.handledDocuments) {
            this.syncGitHubPullRequestBadgeVisibility(doc);
            if (this.settings.showGitHubPullRequestIds) {
                this.scheduleGitHubPullRequestBadgeUpdate(doc);
            } else {
                doc.querySelectorAll('.url-preview-github-pr-badge').forEach((badge) => badge.remove());
            }
            this.requestGitHubPullRequestBadgeDecorationUpdate(doc);
        }
    }

    private syncGitHubPullRequestBadgeVisibility(doc: Document) {
        if (this.settings.showGitHubPullRequestIds) {
            doc.body.removeClass('url-preview-hide-github-pr-badges');
        } else {
            doc.body.addClass('url-preview-hide-github-pr-badges');
        }
    }

    private requestGitHubPullRequestBadgeDecorationUpdate(doc: Document) {
        const views = new Set<EditorView>();
        doc.querySelectorAll('.cm-editor').forEach((editorElement) => {
            if (!(editorElement instanceof HTMLElement)) return;

            const editorView = EditorView.findFromDOM(editorElement);
            if (editorView) {
                views.add(editorView);
            }
        });

        views.forEach((editorView) => editorView.dispatch({}));
    }

    private captureEditorContextMenuLink(event: MouseEvent) {
        const target = event.target;
        if (!(target instanceof HTMLElement)) {
            this.lastEditorContextLink = undefined;
            return;
        }

        const editorElement = target.closest('.cm-editor');
        if (!(editorElement instanceof HTMLElement)) {
            this.lastEditorContextLink = undefined;
            return;
        }

        if (!this.getEditorLinkTargetElement(target)) {
            this.lastEditorContextLink = undefined;
            return;
        }

        const editorView = EditorView.findFromDOM(target) ?? EditorView.findFromDOM(editorElement);
        if (!editorView) {
            this.lastEditorContextLink = undefined;
            return;
        }

        const content = editorView.state.doc.toString();
        const link = this.getMarkdownLinkAtPoint(editorView, content, { x: event.clientX, y: event.clientY });
        if (!link) {
            this.lastEditorContextLink = undefined;
            return;
        }

        this.lastEditorContextLink = {
            link,
            rawText: content.slice(link.start, link.end),
            timestamp: Date.now(),
        };
    }

    private updateInlinePreviewButton(event: MouseEvent) {
        const target = event.target;
        if (!(target instanceof Element)) return;

        const doc = target.ownerDocument;
        const state = this.inlinePreviewControls.get(doc);
        const point = { x: event.clientX, y: event.clientY };
        if (state?.container.contains(target) || (state && this.isPointInInlineControlsHoverZone(state, point))) {
            return;
        }

        if (this.activePreview?.element.contains(target)) {
            this.hideInlinePreviewControls(doc);
            return;
        }

        const linkInfo = this.findLinkElement(target, null, point);
        if (!linkInfo) {
            this.hideInlinePreviewControls(doc);
            return;
        }

        this.showInlinePreviewControls(doc, linkInfo, point);
    }

    private showInlinePreviewControls(doc: Document, linkInfo: LinkInfo, point: ScreenPoint) {
        const state = this.getInlinePreviewControls(doc);
        const iconPosition = this.getInlinePreviewControlsPosition(linkInfo.element, point, state.container);
        if (!iconPosition) {
            this.hideInlinePreviewControls(doc);
            return;
        }

        state.container.setCssStyles({
            left: `${iconPosition.left}px`,
            top: `${iconPosition.top}px`,
        });
        state.container.addClass('is-visible');
        state.target = linkInfo;

        if (this.canInlineConvertGitHubUrl(linkInfo)) {
            state.githubConvertButton.removeClass('is-hidden');
        } else {
            state.githubConvertButton.addClass('is-hidden');
        }
    }

    private getInlinePreviewControls(doc: Document): InlinePreviewControlsState {
        const existingState = this.inlinePreviewControls.get(doc);
        if (existingState) return existingState;

        const container = doc.createElement('span');
        container.addClass('url-preview-inline-controls');

        const githubConvertButton = container.createEl('button', { cls: 'url-preview-inline-button is-hidden' });
        githubConvertButton.setAttr('type', 'button');
        githubConvertButton.setAttr('aria-label', 'Convert to Markdown link');
        setIcon(githubConvertButton, 'github');
        setTooltip(githubConvertButton, 'Convert to Markdown link', TOOLBAR_TOOLTIP_OPTIONS);

        githubConvertButton.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();

            const state = this.inlinePreviewControls.get(doc);
            const targetInfo = state?.target;
            if (!targetInfo?.editorView || !targetInfo.markdownLink) return;

            this.hideInlinePreviewControls(doc);
            void this.convertEditorViewLinkToMarkdown(targetInfo.editorView, targetInfo.markdownLink);
        });

        const previewButton = container.createEl('button', { cls: 'url-preview-inline-button' });
        previewButton.setAttr('type', 'button');
        previewButton.setAttr('aria-label', 'Preview link');
        setIcon(previewButton, 'eye');
        setTooltip(previewButton, 'Preview link', TOOLBAR_TOOLTIP_OPTIONS);

        previewButton.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();

            const state = this.inlinePreviewControls.get(doc);
            if (!state?.target) return;

            const targetInfo = state.target;
            this.hideInlinePreviewControls(doc);
            this.showPreview(
                targetInfo.element,
                targetInfo.url,
                targetInfo.hoverElement,
                targetInfo.sourceKey
            );
        });

        doc.body.appendChild(container);

        const state = { container, githubConvertButton, previewButton };
        this.inlinePreviewControls.set(doc, state);

        return state;
    }

    private getInlinePreviewControlsPosition(
        element: HTMLElement,
        point: ScreenPoint,
        controlsEl: HTMLElement
    ): { left: number; top: number } | null {
        const rect = this.getClientRectForPoint(element, point);
        if (!rect) return null;

        const adornmentRight = this.getExternalLinkAdornmentRight(element, rect, controlsEl);
        return {
            left: adornmentRight + INLINE_CONTROLS_GAP,
            top: rect.top + (rect.height - INLINE_CONTROLS_SIZE) / 2,
        };
    }

    private getExternalLinkAdornmentRight(element: HTMLElement, rect: DOMRect, controlsEl: HTMLElement): number {
        const doc = element.ownerDocument;
        const probeY = rect.top + rect.height / 2;
        let right = rect.right;

        for (let offset = 1; offset <= INLINE_CONTROLS_ADORNMENT_SCAN_WIDTH; offset += 4) {
            const elements = doc.elementsFromPoint(rect.right + offset, probeY);
            const adornment = elements.find((candidate) =>
                this.isExternalLinkAdornmentCandidate(candidate, element, controlsEl, rect)
            );
            if (!adornment) continue;

            const adornmentRect = adornment.getBoundingClientRect();
            right = Math.max(right, adornmentRect.right);
        }

        return right;
    }

    private isExternalLinkAdornmentCandidate(
        candidate: Element,
        linkElement: HTMLElement,
        controlsEl: HTMLElement,
        linkRect: DOMRect
    ): boolean {
        if (candidate === linkElement ||
            linkElement.contains(candidate) ||
            candidate === controlsEl ||
            controlsEl.contains(candidate) ||
            candidate === linkElement.ownerDocument.body) {
            return false;
        }

        const rect = candidate.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        if (rect.left < linkRect.right - 2) return false;
        if (rect.left > linkRect.right + INLINE_CONTROLS_ADORNMENT_SCAN_WIDTH) return false;
        if (candidate.classList.contains('url-preview-github-pr-badge')) {
            return rect.width <= 80;
        }
        if (rect.width > 24 || rect.height > 24) return false;

        return true;
    }

    private isPointInInlineControlsHoverZone(state: InlinePreviewControlsState, point: ScreenPoint): boolean {
        if (!state.target) return false;

        const linkRect = this.getClientRectForPoint(state.target.element, point);
        const controlsRect = state.container.getBoundingClientRect();
        if (!linkRect || controlsRect.width === 0 || controlsRect.height === 0) return false;

        const top = Math.min(linkRect.top, controlsRect.top) - INLINE_CONTROLS_GAP;
        const bottom = Math.max(linkRect.bottom, controlsRect.bottom) + INLINE_CONTROLS_GAP;
        const left = Math.min(linkRect.right, controlsRect.left) - INLINE_CONTROLS_GAP;
        const right = controlsRect.right + INLINE_CONTROLS_GAP;

        return point.x >= left && point.x <= right && point.y >= top && point.y <= bottom;
    }

    private canInlineConvertGitHubUrl(linkInfo: LinkInfo): boolean {
        return Boolean(
            linkInfo.editorView &&
            linkInfo.markdownLink &&
            this.isGitHubUrl(linkInfo.url) &&
            this.isBareMarkdownUrl(linkInfo.markdownLink)
        );
    }

    private getClientRectForPoint(element: HTMLElement, point: ScreenPoint): DOMRect | null {
        const rects = Array.from(element.getClientRects());
        if (rects.length === 0) return null;

        return rects.find((rect) =>
            point.y >= rect.top &&
            point.y <= rect.bottom &&
            point.x >= rect.left &&
            point.x <= rect.right
        ) ?? rects.find((rect) =>
            point.y >= rect.top &&
            point.y <= rect.bottom
        ) ?? rects[rects.length - 1];
    }

    private hideInlinePreviewControls(doc: Document) {
        const state = this.inlinePreviewControls.get(doc);
        if (!state) return;

        state.container.removeClass('is-visible');
        state.target = undefined;
    }

    private removeInlinePreviewControls(doc: Document) {
        const state = this.inlinePreviewControls.get(doc);
        if (!state) return;

        state.container.remove();
        this.inlinePreviewControls.delete(doc);
    }

    private addConvertToMarkdownLinkMenuItemForUrl(menu: Menu, url: string) {
        const activeMarkdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!activeMarkdownView) return;

        this.addConvertToMarkdownLinkMenuItem(menu, activeMarkdownView.editor, url, true);
    }

    private addConvertToMarkdownLinkMenuItem(
        menu: Menu,
        editor: Editor,
        expectedUrl?: string,
        requireRecentContext = false
    ) {
        if (this.convertLinkMenus.has(menu)) return;

        const link = requireRecentContext
            ? this.getRecentEditorContextLink(editor.getValue(), expectedUrl ? this.normalizeUrl(expectedUrl) : null)
            : this.getEditorContextLink(editor, expectedUrl);
        if (!link) return;

        this.convertLinkMenus.add(menu);
        menu.addItem((item) => {
            item
                .setTitle(this.isBareMarkdownUrl(link) ? 'Convert URL to Markdown link' : 'Use page title as link text')
                .setIcon('link')
                .onClick(() => {
                    void this.convertEditorLinkToMarkdown(editor, link);
                });
        });
    }

    private getEditorContextLink(editor: Editor, expectedUrl?: string): ParsedMarkdownLink | null {
        const content = editor.getValue();
        const normalizedExpectedUrl = expectedUrl ? this.normalizeUrl(expectedUrl) : null;
        const recentLink = this.getRecentEditorContextLink(content, normalizedExpectedUrl);
        if (recentLink) return recentLink;

        const selectedLink = this.getSelectedBareUrlLink(editor, normalizedExpectedUrl);
        if (selectedLink) return selectedLink;

        return this.getEditorLinkAtCursor(editor, content, normalizedExpectedUrl);
    }

    private getRecentEditorContextLink(content: string, expectedUrl: string | null): ParsedMarkdownLink | null {
        if (!this.lastEditorContextLink) return null;
        if (Date.now() - this.lastEditorContextLink.timestamp > 2500) return null;

        const { link, rawText } = this.lastEditorContextLink;
        if (!this.linkMatchesExpectedUrl(link, expectedUrl)) return null;
        if (content.slice(link.start, link.end) !== rawText) return null;

        return link;
    }

    private getSelectedBareUrlLink(editor: Editor, expectedUrl: string | null): ParsedMarkdownLink | null {
        if (!editor.somethingSelected()) return null;

        const selection = editor.getSelection();
        const selectedUrlText = selection.trim();
        const url = this.normalizeUrl(selectedUrlText);
        if (!url || !this.urlMatchesExpectedUrl(url, expectedUrl)) return null;

        const selectionStart = editor.posToOffset(editor.getCursor('from'));
        const leadingWhitespaceLength = selection.length - selection.trimStart().length;
        const start = selectionStart + leadingWhitespaceLength;
        const end = start + selectedUrlText.length;

        return this.createBareMarkdownUrlLink(start, end, selectedUrlText, url);
    }

    private getEditorLinkAtCursor(
        editor: Editor,
        content: string,
        expectedUrl: string | null
    ): ParsedMarkdownLink | null {
        const offsets = new Set<number>();
        for (const cursorSide of ['from', 'to', 'head'] as const) {
            const offset = editor.posToOffset(editor.getCursor(cursorSide));
            offsets.add(offset);
            offsets.add(Math.max(0, offset - 1));
            offsets.add(Math.min(content.length, offset + 1));
        }

        const markdownLinks = this.parseMarkdownLinks(content);
        for (const offset of offsets) {
            const link = this.findParsedMarkdownLinkAtOffset(markdownLinks, offset);
            if (link && this.linkMatchesExpectedUrl(link, expectedUrl)) {
                return link;
            }
        }

        for (const offset of offsets) {
            const link = this.getBareMarkdownUrlAtOffset(content, offset);
            if (link && this.linkMatchesExpectedUrl(link, expectedUrl)) {
                return link;
            }
        }

        return null;
    }

    private async convertEditorLinkToMarkdown(editor: Editor, originalLink: ParsedMarkdownLink) {
        let link = this.resolveCurrentEditorLink(editor, originalLink);
        if (!link) {
            new Notice('Could not find the link anymore.');
            return;
        }

        const notice = new Notice('Fetching page title...', 0);
        const title = await this.fetchPageTitleForNotice(link.url, notice);
        if (!title) return;

        link = this.resolveCurrentEditorLink(editor, link);
        if (!link) {
            notice.hide();
            new Notice('The link changed before it could be converted.');
            return;
        }

        const replacement = this.createMarkdownLinkReplacement(title, link.url);
        editor.replaceRange(
            replacement,
            editor.offsetToPos(link.start),
            editor.offsetToPos(link.end),
            'url-preview-convert-link'
        );
        editor.setCursor(editor.offsetToPos(link.start + replacement.length));

        notice.setMessage('Converted URL to Markdown link.');
        window.setTimeout(() => notice.hide(), 1200);
    }

    private async convertEditorViewLinkToMarkdown(editorView: EditorView, originalLink: ParsedMarkdownLink) {
        let link = this.resolveCurrentEditorViewLink(editorView, originalLink);
        if (!link) {
            new Notice('Could not find the link anymore.');
            return;
        }

        const notice = new Notice('Fetching GitHub title...', 0);
        const title = await this.fetchPageTitleForNotice(link.url, notice);
        if (!title) return;

        link = this.resolveCurrentEditorViewLink(editorView, link);
        if (!link) {
            notice.hide();
            new Notice('The link changed before it could be converted.');
            return;
        }

        const replacement = this.createMarkdownLinkReplacement(title, link.url);
        editorView.dispatch({
            changes: { from: link.start, insert: replacement, to: link.end },
            selection: { anchor: link.start + replacement.length },
            scrollIntoView: true,
        });
        editorView.focus();

        notice.setMessage('Converted GitHub URL to Markdown link.');
        window.setTimeout(() => notice.hide(), 1200);
    }

    private async fetchPageTitleForNotice(url: string, notice: Notice): Promise<string | null> {
        try {
            const title = await this.fetchPageTitle(url);
            if (!title) {
                notice.hide();
                new Notice('Could not find a page title for this URL.');
                return null;
            }
            return title;
        } catch {
            notice.hide();
            new Notice('Could not fetch the page title.');
            return null;
        }
    }

    private resolveCurrentEditorLink(editor: Editor, originalLink: ParsedMarkdownLink): ParsedMarkdownLink | null {
        return this.resolveCurrentLinkInContent(editor.getValue(), originalLink);
    }

    private resolveCurrentLinkInContent(content: string, originalLink: ParsedMarkdownLink): ParsedMarkdownLink | null {
        const offsets = [
            originalLink.start,
            Math.min(content.length, originalLink.start + 1),
            Math.max(0, originalLink.end - 1),
        ];
        const markdownLinks = this.parseMarkdownLinks(content);

        for (const offset of offsets) {
            const link = this.findParsedMarkdownLinkAtOffset(markdownLinks, offset);
            if (link?.url === originalLink.url) {
                return link;
            }
        }

        for (const offset of offsets) {
            const link = this.getBareMarkdownUrlAtOffset(content, offset);
            if (link?.url === originalLink.url) {
                return link;
            }
        }

        return null;
    }

    private resolveCurrentEditorViewLink(editorView: EditorView, originalLink: ParsedMarkdownLink): ParsedMarkdownLink | null {
        return this.resolveCurrentLinkInContent(editorView.state.doc.toString(), originalLink);
    }

    private isBareMarkdownUrl(link: ParsedMarkdownLink): boolean {
        return link.start === link.textStart &&
            link.end === link.textEnd &&
            link.start === link.destinationStart &&
            link.end === link.destinationEnd;
    }

    private linkMatchesExpectedUrl(link: ParsedMarkdownLink, expectedUrl: string | null): boolean {
        return this.urlMatchesExpectedUrl(link.url, expectedUrl);
    }

    private urlMatchesExpectedUrl(url: string, expectedUrl: string | null): boolean {
        return !expectedUrl || url === expectedUrl;
    }

    private createMarkdownLinkReplacement(title: string, url: string): string {
        return `[${this.escapeMarkdownLinkText(title)}](${this.formatMarkdownDestination(url)})`;
    }

    private handleLinkClick(event: MouseEvent) {
        if (!this.areClickModifiersPressed(event)) return;

        const target = event.target;
        if (!(target instanceof Element)) return;
        if (this.activePreview?.element.contains(target)) return;

        const linkInfo = this.findLinkElement(target, null, { x: event.clientX, y: event.clientY });
        if (!linkInfo) return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        this.openPreviewForLink(linkInfo);
    }

    private openPreviewForLink(linkInfo: LinkInfo) {
        if (this.isActivePreviewForLink(linkInfo)) {
            if (this.cleanupTimeout) {
                window.clearTimeout(this.cleanupTimeout);
                this.cleanupTimeout = undefined;
            }
            return;
        }

        this.cleanupActivePreview();

        const { element: linkElement, hoverElement, sourceKey, url } = linkInfo;
        this.showPreview(linkElement, url, hoverElement, sourceKey);
    }

    private showPreview(link: HTMLElement, url: string, hoverElement: HTMLElement, sourceKey?: string) {
        this.cleanupActivePreview();
        const doc = link.ownerDocument;
        const rect = link.getBoundingClientRect();
        const previewEl = this.createPreviewElement(rect, doc);

        if (this.shouldShowToolbar()) {
            this.createButtons(previewEl, url);
        }

        previewEl.setAttr('data-preview-url', url);

        const wrapper = previewEl.createDiv('preview-iframe-wrapper');
        wrapper.addClass('preview-scaled-viewport');

        const loading = previewEl.createDiv('preview-loading');
        loading.addClass('loading-spinner');
        const loadingStartedAt = Date.now();

        const cleanup = () => {
            previewEl.remove();
            this.activePreview = undefined;
        };

        const iframe = doc.createElement('iframe');

        iframe.onload = () => {
            this.revealLoadedIframe(iframe, loading, loadingStartedAt);
            if (this.isGitHubUrl(url)) {
                void this.updateGitHubAuthControls(previewEl);
            }
        };

        iframe.onerror = () => {
            loading.textContent = 'Failed to load preview';
        };

        wrapper.appendChild(iframe);

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
        this.applyPreviewViewportProps(previewEl, url);
        this.loadPreviewIframe(iframe, url);
        this.activePreview = { element: previewEl, cleanup: cleanupWithClickHandler, doc, link: hoverElement, sourceKey };
    }

    private revealLoadedIframe(iframe: HTMLIFrameElement, loading: HTMLElement, loadingStartedAt: number) {
        const win = iframe.ownerDocument.defaultView ?? window;
        win.requestAnimationFrame(() => {
            win.requestAnimationFrame(() => {
                iframe.addClass('is-loaded');
                const elapsed = Date.now() - loadingStartedAt;
                const remainingMinimum = Math.max(0, MIN_PREVIEW_LOADING_MS - elapsed);
                win.setTimeout(() => {
                    loading.remove();
                }, Math.max(remainingMinimum, POST_LOAD_SPINNER_MS));
            });
        });
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
        if (this.cleanupTimeout) {
            window.clearTimeout(this.cleanupTimeout);
            this.cleanupTimeout = undefined;
        }
        // Safety net: remove any orphaned preview popups
        this.removeOrphanedPreviews();
    }

    private areClickModifiersPressed(event: MouseEvent): boolean {
        const keys = this.settings.modifierKeys;
        if (keys.meta && !event.metaKey) return false;
        if (keys.ctrl && !event.ctrlKey) return false;
        if (keys.alt && !event.altKey) return false;
        if (keys.shift && !event.shiftKey) return false;
        return keys.meta || keys.ctrl || keys.alt || keys.shift;
    }

    private hasAnyModifierSelected(keys: ModifierKeyConfig): boolean {
        return keys.meta || keys.ctrl || keys.alt || keys.shift;
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
        if (!this.hasAnyModifierSelected(modifierKeys)) {
            modifierKeys = platformDefaultKeys;
        }

        this.settings = {
            ...DEFAULT_SETTINGS,
            ...loaded,
            domainZoomLevels: { ...loaded?.domainZoomLevels },
            modifierKeys,
        };

        // Clean up legacy field if present
        if ('modifierKey' in this.settings) {
            delete (this.settings as LinkPreviewSettings & LegacyLinkPreviewSettings).modifierKey;
            await this.saveSettings();
        }

        const obsoleteSettingsFields = [
            'cachedPreviewDelay',
            'closeOnModifierRelease',
            'hoverDelay',
            'hideGitHubSignInButton',
            'previewCacheEnabled',
            'previewCacheTtlDays',
            'previewImageCacheEnabled',
            'previewImageCacheTtlDays',
            'requireModifierKey',
            'mouseStillnessDelay',
        ];
        const rawSettings = this.settings as LinkPreviewSettings & Record<string, unknown>;
        let removedObsoleteField = false;
        for (const field of obsoleteSettingsFields) {
            if (field in rawSettings) {
                delete rawSettings[field];
                removedObsoleteField = true;
            }
        }
        if (removedObsoleteField) {
            await this.saveSettings();
        }
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    onunload() {
        this.cleanupActivePreview();
        for (const doc of this.inlinePreviewControls.keys()) {
            this.removeInlinePreviewControls(doc);
        }
        for (const doc of this.githubPullRequestBadgeObservers.keys()) {
            this.unregisterGitHubPullRequestBadges(doc);
        }
    }

    private loadPreviewIframe(iframe: HTMLIFrameElement, url: string) {
        iframe.setAttribute('src', url);
    }

    private async removeLegacyPreviewCache() {
        await this.removeLegacyPreviewCacheFile(this.getLegacyPreviewCachePath());
        try {
            const imageCacheDir = this.getLegacyPreviewImageCacheDir();
            if (await this.app.vault.adapter.exists(imageCacheDir)) {
                await this.app.vault.adapter.rmdir(imageCacheDir, true);
            }
        } catch {
            // Legacy cache cleanup is best-effort.
        }
    }

    private async removeLegacyPreviewCacheFile(path: string) {
        try {
            if (await this.app.vault.adapter.exists(path)) {
                await this.app.vault.adapter.remove(path);
            }
        } catch {
            // Legacy cache cleanup is best-effort.
        }
    }

    private getLegacyPreviewCachePath(): string {
        const pluginDir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
        return normalizePath(`${pluginDir}/preview-cache.json`);
    }

    private getLegacyPreviewImageCacheDir(): string {
        const pluginDir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
        return normalizePath(`${pluginDir}/preview-cache-images`);
    }

    private removeOrphanedPreviews() {
        for (const doc of this.handledDocuments) {
            doc.querySelectorAll('.hover-popup').forEach(el => el.remove());
        }
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

    private isGitHubUrl(url: string): boolean {
        try {
            return new URL(url).hostname === 'github.com';
        } catch {
            return false;
        }
    }

    private getGitHubLoginUrl(returnUrl: string): string {
        try {
            const githubUrl = new URL(returnUrl);
            const returnPath = `${githubUrl.pathname}${githubUrl.search}${githubUrl.hash}`;
            return `https://github.com/login?return_to=${encodeURIComponent(returnPath)}`;
        } catch {
            return 'https://github.com/login';
        }
    }

    private getGitHubLogoutUrl(returnUrl: string): string {
        try {
            const githubUrl = new URL(returnUrl);
            const returnPath = `${githubUrl.pathname}${githubUrl.search}${githubUrl.hash}`;
            return `https://github.com/logout?return_to=${encodeURIComponent(returnPath)}`;
        } catch {
            return 'https://github.com/logout';
        }
    }

    private getRequireFunction(): ((moduleName: string) => unknown) | null {
        const windowRequire = (window as Window & RequireHost).require;
        if (typeof windowRequire === 'function') return windowRequire;

        const globalRequire = (globalThis as RequireHost).require;
        if (typeof globalRequire === 'function') return globalRequire;

        return null;
    }

    private getElectronCookies(): ElectronCookies | null {
        if (!Platform.isDesktopApp) return null;

        const requireFn = this.getRequireFunction();
        if (!requireFn) return null;

        try {
            const electron = requireFn('electron') as ElectronModule;
            return electron.session?.defaultSession?.cookies ?? null;
        } catch {
            return null;
        }
    }

    private async getGitHubAuthState(): Promise<GitHubAuthState> {
        const cookies = this.getElectronCookies();
        if (!cookies) return 'unknown';

        try {
            const githubCookies = await cookies.get({ url: 'https://github.com/' });
            const hasAuthCookie = githubCookies.some((cookie) =>
                cookie.value.length > 0 &&
                (
                    cookie.name === 'dotcom_user' ||
                    cookie.name === 'user_session' ||
                    cookie.name === '__Host-user_session_same_site' ||
                    (cookie.name === 'logged_in' && cookie.value === 'yes')
                )
            );

            return hasAuthCookie ? 'signed-in' : 'signed-out';
        } catch {
            return 'unknown';
        }
    }

    private getPreviewDomain(url: string): string | null {
        try {
            return new URL(url).hostname.toLowerCase();
        } catch {
            return null;
        }
    }

    private getDomainZoomPercent(url: string): number {
        const domain = this.getPreviewDomain(url);
        const savedZoom = domain ? this.settings.domainZoomLevels[domain] : undefined;
        return this.clampZoomPercent(savedZoom ?? this.getDefaultDomainZoomPercent(url));
    }

    private getDefaultDomainZoomPercent(_url: string): number {
        return 100;
    }

    private clampZoomPercent(value: number): number {
        if (!Number.isFinite(value)) return 100;
        return Math.min(200, Math.max(50, Math.round(value)));
    }

    private async setDomainZoomPercent(url: string, value: number) {
        const domain = this.getPreviewDomain(url);
        if (!domain) return;

        this.settings.domainZoomLevels[domain] = this.clampZoomPercent(value);
        await this.saveSettings();
    }

    private async resetDomainZoomPercent(url: string) {
        const domain = this.getPreviewDomain(url);
        if (!domain) return;

        delete this.settings.domainZoomLevels[domain];
        await this.saveSettings();
    }

    private applyPreviewViewportProps(previewEl: HTMLElement, url = previewEl.getAttribute('data-preview-url') ?? '') {
        const previewRect = previewEl.getBoundingClientRect();
        const wrapper = previewEl.querySelector('.preview-iframe-wrapper');
        const viewportRect = wrapper instanceof HTMLElement ? wrapper.getBoundingClientRect() : previewRect;
        const width = Math.max(1, viewportRect.width);
        const height = Math.max(1, viewportRect.height);
        const zoomScale = this.getDomainZoomPercent(url) / 100;
        const frameWidth = Math.max(1, width / zoomScale);
        const scale = width / frameWidth;

        previewEl.setCssProps({
            '--preview-frame-height': `${Math.ceil(height / scale)}px`,
            '--preview-frame-scale': String(scale),
            '--preview-frame-width': `${frameWidth}px`,
        });
    }

    private shouldShowToolbar(): boolean {
        return true;
    }

    private setToolbarTooltip(button: HTMLElement, label: string) {
        button.setAttr('aria-label', label);
        setTooltip(button, label, TOOLBAR_TOOLTIP_OPTIONS);
    }

    private createButtons(container: HTMLElement, url: string) {
        const buttons = container.createDiv('preview-buttons');
        const win = container.ownerDocument.defaultView ?? window;

        this.createZoomControls(buttons, container, url);

        if (this.isGitHubUrl(url)) {
            this.createGitHubAuthButton(buttons, container, url);
        }

        if (this.settings.allowResize) {
            let restoreBounds: { left: number, top: number, width: number, height: number } | null = null;
            const resizeBtn = buttons.createEl('button', { cls: 'clickable-icon' });
            setIcon(resizeBtn, 'maximize-2');
            this.setToolbarTooltip(resizeBtn, 'Expand preview');
            resizeBtn.addEventListener('click', (e) => {
                e.stopPropagation();

                if (restoreBounds) {
                    this.applyPreviewBounds(container, restoreBounds);
                    restoreBounds = null;
                    setIcon(resizeBtn, 'maximize-2');
                    this.setToolbarTooltip(resizeBtn, 'Expand preview');
                    return;
                }

                const rect = container.getBoundingClientRect();
                restoreBounds = {
                    left: rect.left,
                    top: rect.top,
                    width: rect.width,
                    height: rect.height,
                };
                this.applyPreviewBounds(container, this.calculateExpandedPreviewBounds(container.ownerDocument));
                setIcon(resizeBtn, 'minimize-2');
                this.setToolbarTooltip(resizeBtn, 'Restore preview size');
            });
        }

        if (this.settings.showOpenInBrowser) {
            const openBtn = buttons.createEl('button', { cls: 'clickable-icon' });
            setIcon(openBtn, 'external-link');
            this.setToolbarTooltip(openBtn, 'Open in external browser');
            openBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                win.open(url);
            });
        }

        if (this.settings.showCloseButton) {
            const closeBtn = buttons.createEl('button', { cls: 'clickable-icon' });
            setIcon(closeBtn, 'x');
            this.setToolbarTooltip(closeBtn, 'Close preview');
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.cleanupActivePreview();
            });
        }
    }

    private createGitHubAuthButton(buttons: HTMLElement, container: HTMLElement, url: string) {
        const authBtn = buttons.createEl('button', { cls: 'clickable-icon preview-github-auth-button' });
        this.configureGitHubAuthButton(authBtn, 'unknown');
        void this.updateGitHubAuthButton(authBtn);

        authBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            const iframe = container.querySelector('.preview-iframe-wrapper iframe');
            if (!(iframe instanceof HTMLIFrameElement)) return;

            const authState = authBtn.getAttribute('data-github-auth-state');
            iframe.removeClass('is-loaded');
            iframe.setAttribute(
                'src',
                authState === 'signed-in' ? this.getGitHubLogoutUrl(url) : this.getGitHubLoginUrl(url)
            );
        });
    }

    private configureGitHubAuthButton(button: HTMLElement, state: GitHubAuthState) {
        const isSignedIn = state === 'signed-in';
        button.setAttr('data-github-auth-state', isSignedIn ? 'signed-in' : 'signed-out');
        setIcon(button, isSignedIn ? 'log-out' : 'log-in');
        this.setToolbarTooltip(button, isSignedIn ? 'Sign out of GitHub' : 'Sign in to GitHub');
    }

    private async updateGitHubAuthControls(previewEl: HTMLElement) {
        const authButton = previewEl.querySelector('.preview-github-auth-button');
        if (authButton instanceof HTMLElement) {
            await this.updateGitHubAuthButton(authButton);
        }
    }

    private async updateGitHubAuthButton(button: HTMLElement) {
        const authState = await this.getGitHubAuthState();
        if (!button.isConnected) return;

        this.configureGitHubAuthButton(button, authState);
    }

    private createZoomControls(buttons: HTMLElement, previewEl: HTMLElement, url: string) {
        const zoomControls = buttons.createDiv('preview-zoom-controls');
        const zoomInputWrap = zoomControls.createDiv('preview-zoom-input-wrap');
        const zoomInput = zoomInputWrap.createEl('input', { cls: 'preview-zoom-input' });
        const zoomSuffix = zoomInputWrap.createSpan({ cls: 'preview-zoom-suffix', text: '%' });
        zoomSuffix.setAttr('aria-hidden', 'true');
        zoomInput.setAttr('type', 'number');
        zoomInput.setAttr('min', '50');
        zoomInput.setAttr('max', '200');
        zoomInput.setAttr('step', '10');
        zoomInput.setAttr('aria-label', 'Preview zoom percentage');

        const updateZoomInput = () => {
            zoomInput.value = String(this.getDomainZoomPercent(url));
        };
        const applyZoom = async (value: number) => {
            await this.setDomainZoomPercent(url, value);
            updateZoomInput();
            this.applyPreviewViewportProps(previewEl, url);
        };
        const applyInputZoom = () => {
            const value = Number(zoomInput.value);
            if (!isNaN(value)) {
                void applyZoom(value);
            } else {
                updateZoomInput();
            }
        };

        updateZoomInput();
        zoomInputWrap.addEventListener('click', (event) => {
            event.stopPropagation();
            if (event.target !== zoomInput) {
                zoomInput.focus();
            }
        });
        zoomInput.addEventListener('click', (event) => event.stopPropagation());
        zoomInput.addEventListener('change', applyInputZoom);
        zoomInput.addEventListener('keydown', (event) => {
            event.stopPropagation();
            if (event.key === 'Enter') {
                applyInputZoom();
                zoomInput.blur();
            }
        });

        const zoomOutBtn = zoomControls.createEl('button', { cls: 'clickable-icon preview-zoom-button' });
        setIcon(zoomOutBtn, 'minus');
        this.setToolbarTooltip(zoomOutBtn, 'Zoom out');
        zoomOutBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            void applyZoom(this.getDomainZoomPercent(url) - 10);
        });

        const zoomInBtn = zoomControls.createEl('button', { cls: 'clickable-icon preview-zoom-button' });
        setIcon(zoomInBtn, 'plus');
        this.setToolbarTooltip(zoomInBtn, 'Zoom in');
        zoomInBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            void applyZoom(this.getDomainZoomPercent(url) + 10);
        });

        const resetZoomBtn = zoomControls.createEl('button', { cls: 'clickable-icon preview-zoom-button' });
        setIcon(resetZoomBtn, 'rotate-ccw');
        this.setToolbarTooltip(resetZoomBtn, 'Reset zoom');
        resetZoomBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            void (async () => {
                await this.resetDomainZoomPercent(url);
                updateZoomInput();
                this.applyPreviewViewportProps(previewEl, url);
            })();
        });
    }

    private calculateExpandedPreviewBounds(doc: Document): { left: number, top: number, width: number, height: number } {
        const win = doc.defaultView ?? window;
        const margin = 5;

        return {
            left: margin,
            top: margin,
            width: Math.max(MIN_PREVIEW_WIDTH, win.innerWidth - margin * 2),
            height: Math.max(MIN_PREVIEW_HEIGHT, win.innerHeight - margin * 2),
        };
    }

    private applyPreviewBounds(previewEl: HTMLElement, bounds: { left: number, top: number, width: number, height: number }) {
        previewEl.setCssStyles({
            left: `${bounds.left}px`,
            top: `${bounds.top}px`,
            width: `${bounds.width}px`,
            height: `${bounds.height}px`,
        });
        this.applyPreviewViewportProps(previewEl);
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
            this.applyPreviewViewportProps(previewEl);

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

        const linkTarget = this.getEditorLinkTargetElement(target);
        if (!linkTarget) return null;

        const content = editorView.state.doc.toString();
        const pointLink = point ? this.getMarkdownLinkAtPoint(editorView, content, point) : null;

        if (pointLink) {
            return {
                editorView,
                element: linkTarget,
                hoverElement: linkTarget,
                markdownLink: pointLink,
                sourceKey: this.getMarkdownLinkSourceKey(pointLink),
                url: pointLink.url,
            };
        }

        const textLink = this.getMarkdownLinkByDisplayText(content, linkTarget);
        if (textLink) {
            return {
                element: linkTarget,
                hoverElement: linkTarget,
                sourceKey: this.getMarkdownLinkSourceKey(textLink),
                url: textLink.url,
            };
        }

        return null;
    }

    private getEditorLinkTargetElement(element: HTMLElement): HTMLElement | null {
        const linkElement = element.closest(EDITOR_LINK_SELECTOR);
        return linkElement instanceof HTMLElement ? linkElement : null;
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

    private parseEditorLinks(content: string): ParsedMarkdownLink[] {
        const markdownLinks = this.parseMarkdownLinks(content);
        return [
            ...markdownLinks,
            ...this.parseBareMarkdownUrls(content, markdownLinks),
        ];
    }

    private parseBareMarkdownUrls(content: string, excludedRanges: TextRange[] = []): ParsedMarkdownLink[] {
        const links: ParsedMarkdownLink[] = [];
        const urlRegex = /https?:\/\/[^\s<>"')]+/gi;
        let match: RegExpExecArray | null;

        while ((match = urlRegex.exec(content)) !== null) {
            const start = match.index;
            const text = match[0];
            const end = start + text.length;
            if (excludedRanges.some((range) => start >= range.start && end <= range.end)) continue;

            const url = this.normalizeUrl(text);
            if (!url) continue;

            links.push(this.createBareMarkdownUrlLink(start, end, text, url));
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

        return this.createBareMarkdownUrlLink(0, displayText.length, displayText, url);
    }

    private getBareMarkdownUrlAtOffset(content: string, offset: number): ParsedMarkdownLink | null {
        for (const link of this.parseBareMarkdownUrls(content)) {
            const { end, start } = link;
            if (offset < start || offset > end) continue;

            return link;
        }

        return null;
    }

    private createBareMarkdownUrlLink(start: number, end: number, text: string, url: string): ParsedMarkdownLink {
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

    private async fetchPageTitle(url: string): Promise<string | null> {
        const html = await this.fetchPageHtml(url);
        const title = this.extractPageTitle(html, url);
        if (!title || this.isUnusablePageTitle(title, url)) return null;

        return title;
    }

    private async fetchPageHtml(url: string): Promise<string> {
        const headers = await this.getTitleRequestHeaders(url);

        try {
            const response = await requestUrl({ url, headers, throw: false });
            return response.text;
        } catch {
            if (!headers.Cookie) throw new Error('Title request failed');

            const response = await requestUrl({ url, headers: this.getTitleRequestBaseHeaders(), throw: false });
            return response.text;
        }
    }

    private async getTitleRequestHeaders(url: string): Promise<Record<string, string>> {
        const headers = this.getTitleRequestBaseHeaders();
        const cookieHeader = await this.getCookieHeaderForUrl(url);
        if (cookieHeader) {
            headers.Cookie = cookieHeader;
        }
        return headers;
    }

    private getTitleRequestBaseHeaders(): Record<string, string> {
        return {
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        };
    }

    private async getCookieHeaderForUrl(url: string): Promise<string | null> {
        const cookies = this.getElectronCookies();
        if (!cookies) return null;

        try {
            const parsedUrl = new URL(url);
            if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
                return null;
            }

            const matchingCookies = await cookies.get({ url: parsedUrl.href });
            const cookiePairs = matchingCookies
                .filter((cookie) => cookie.name.length > 0 && cookie.value.length > 0)
                .map((cookie) => `${cookie.name}=${cookie.value}`);

            return cookiePairs.length > 0 ? cookiePairs.join('; ') : null;
        } catch {
            return null;
        }
    }

    private extractPageTitle(html: string, url: string): string | null {
        const parsedDocument = new DOMParser().parseFromString(html, 'text/html');
        const githubTitle = this.extractGitHubPageTitle(parsedDocument, url);
        if (githubTitle) return githubTitle;

        return this.getFirstMetaContent(parsedDocument, [
            'meta[property="og:title"]',
            'meta[name="twitter:title"]',
            'meta[name="title"]',
        ]) ?? this.cleanPageTitle(parsedDocument.querySelector('title')?.textContent);
    }

    private extractGitHubPageTitle(doc: Document, url: string): string | null {
        if (!this.isGitHubUrl(url)) return null;

        const issueTitleElement = doc.querySelector('.js-issue-title, [data-testid="issue-title"], bdi.js-issue-title');
        const issueTitle = this.cleanPageTitle(issueTitleElement?.textContent);
        if (issueTitle) return issueTitle;

        const rawTitle = this.getFirstMetaContent(doc, ['meta[property="og:title"]']) ??
            doc.querySelector('title')?.textContent;
        return this.cleanGitHubTitle(rawTitle);
    }

    private cleanGitHubTitle(title: string | null | undefined): string | null {
        const cleanedTitle = this.cleanPageTitle(title);
        if (!cleanedTitle) return null;

        const withoutGitHubSuffix = cleanedTitle.replace(/\s+·\s+GitHub$/i, '');
        const withoutAuthor = withoutGitHubSuffix.replace(
            /\s+by\s+[^·]+(?=\s+·\s+(?:Pull Request|Issue|Discussion)\s+#\d+)/i,
            ''
        );
        const titleMatch = withoutAuthor.match(
            /^(.*?)\s+·\s+(?:Pull Request|Issue|Discussion)\s+#\d+\s+·\s+.+$/i
        );

        return this.cleanPageTitle(titleMatch?.[1] ?? withoutAuthor);
    }

    private getFirstMetaContent(doc: Document, selectors: string[]): string | null {
        for (const selector of selectors) {
            const meta = doc.querySelector(selector);
            if (!(meta instanceof HTMLMetaElement)) continue;

            const title = this.cleanPageTitle(meta.content);
            if (title) return title;
        }

        return null;
    }

    private cleanPageTitle(title: string | null | undefined): string | null {
        const cleanedTitle = title?.replace(/\s+/g, ' ').trim();
        return cleanedTitle ? cleanedTitle : null;
    }

    private isUnusablePageTitle(title: string, url: string): boolean {
        if (!this.isGitHubUrl(url)) return false;

        return /^(sign in to github|join github|github)$/i.test(title);
    }

    private escapeMarkdownLinkText(text: string): string {
        return text
            .replace(/\\/g, '\\\\')
            .replace(/\[/g, '\\[')
            .replace(/\]/g, '\\]');
    }

    private formatMarkdownDestination(url: string): string {
        const safeUrl = url.replace(/</g, '%3C').replace(/>/g, '%3E');
        return /[\s()<>]/.test(safeUrl) ? `<${safeUrl}>` : safeUrl;
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

        const modifierKeyNames: { key: keyof ModifierKeyConfig; label: string }[] = [
            { key: 'meta', label: Platform.isMacOS ? 'Command (⌘)' : 'Meta/Win' },
            { key: 'ctrl', label: Platform.isMacOS ? 'Control (⌃)' : 'Ctrl' },
            { key: 'alt', label: Platform.isMacOS ? 'Option (⌥)' : 'Alt' },
            { key: 'shift', label: 'Shift' },
        ];

        const modifierGroup = new SettingGroup(containerEl)
            .setHeading('Preview click modifiers')
            .addClass('settings-group-no-margin');

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
                                if (!this.hasAnyModifierSelected()) {
                                    const defaultKey = Platform.isMacOS ? 'meta' : 'ctrl';
                                    this.plugin.settings.modifierKeys[defaultKey] = true;
                                }
                                await this.plugin.saveSettings();
                                this.display();
                            });
                    });
            });
        }

        const behaviorGroup = new SettingGroup(containerEl)
            .setHeading('Behavior')
            .addClass('settings-group-no-margin');

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

        behaviorGroup.addSetting(setting => {
            setting
                .setName('Show GitHub pull request numbers')
                .setDesc('Show #123 beside GitHub pull request links')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.showGitHubPullRequestIds)
                    .onChange(async (value) => {
                        await this.plugin.setShowGitHubPullRequestIds(value);
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
            meta: Platform.isMacOS ? 'Hold Command while clicking a link' : 'Hold Meta/Windows while clicking a link',
            ctrl: Platform.isMacOS ? 'Hold Control while clicking a link' : 'Hold Ctrl while clicking a link',
            alt: Platform.isMacOS ? 'Hold Option while clicking a link' : 'Hold Alt while clicking a link',
            shift: 'Hold Shift while clicking a link',
        };
        return descriptions[key];
    }
}
