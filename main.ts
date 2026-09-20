import {
    Decoration,
    EditorView,
    ViewPlugin,
    WidgetType,
} from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import {
    App,
    Component,
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

interface ViewRect {
    bottom: number;
    height: number;
    left: number;
    right: number;
    top: number;
    width: number;
}

interface ModifierState {
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
}

interface GitHubIssueReference {
    id: string;
    owner: string;
    repo: string;
    shortReference: string;
    type: 'issues' | 'pull';
}

type GitHubIssueState = 'Open' | 'Draft' | 'Merged' | 'Closed';

type GitHubReferenceCopyHandler = (event: MouseEvent | KeyboardEvent) => void;

interface InlinePreviewControlsState {
    container: HTMLElement;
    githubConvertButton: HTMLElement;
    hoverZone?: ViewRect;
    previewButton: HTMLElement;
    target?: LinkInfo;
}

interface PreviewWebviewElement extends HTMLElement {
    getWebContentsId(): number;
    canGoBack(): boolean;
    canGoForward(): boolean;
    executeJavaScript(code: string): Promise<unknown>;
    getURL(): string;
    goBack(): void;
    goForward(): void;
    canGoToOffset(offset: number): boolean;
    goToOffset(offset: number): void;
    loadURL(url: string): Promise<void>;
    setAudioMuted(muted: boolean): void;
}

type PreviewFrameElement = HTMLIFrameElement | PreviewWebviewElement;

interface PreviewFrameController {
    cleanupKeyboard?: () => void;
    muted?: boolean;
    currentUrl: string;
    element: PreviewFrameElement;
    fallbackHistory: string[];
    fallbackHistoryIndex: number;
    isReady: boolean;
    startLoading?: () => void;
}

// Neither pane is useful below this width, so the divider stops there.
const SIDE_PANEL_MIN_WIDTH = 280;

// A cached page keeps a whole renderer process alive, so it is only worth holding for as
// long as the user is plausibly coming back to it.
const PREVIEW_CACHE_LIMIT = 5;
const PREVIEW_CACHE_TTL_MS = 5 * 60 * 1000;

interface CachedPreview {
    url: string;
    doc: Document;
    element: HTMLElement;
    controller: PreviewFrameController;
    dock?: PreviewSidePanel;
    expiry?: number;
    floatingBounds?: { left: number; top: number; width: number; height: number };
    floatingAnchor?: HTMLElement;
    cancelRefresh?: () => void;
}

class PreviewSidePanel {
    private observer: ResizeObserver;
    readonly divider: HTMLElement;
    private stopDrag?: () => void;
    private ratio: number;
    private saveTimer?: number;
    private closing = false;

    constructor(readonly entry: CachedPreview, readonly host: HTMLElement,
        private content: HTMLElement, private plugin: LinkPreviewPlugin) {
        entry.dock = this;
        this.ratio = Number.isFinite(plugin.settings.sidePanelRatio) ? plugin.settings.sidePanelRatio : 0.5;
        host.addClass('url-preview-has-side-panel');
        entry.element.addClass('is-docked');
        entry.element.removeClass('is-cached');
        plugin.setPreviewMuted(entry, false);
        plugin.clearCacheExpiry(entry);
        this.divider = entry.doc.body.createDiv('url-preview-divider');
        this.divider.setAttr('role', 'separator');
        this.divider.setAttr('aria-label', 'Resize note and preview');
        this.divider.setAttr('aria-orientation', 'vertical');
        this.divider.tabIndex = 0;
        this.divider.addEventListener('pointerdown', event => {
            if (event.button !== 0) return;
            event.preventDefault();
            this.stopDrag?.();
            entry.element.addClass('is-divider-resizing');
            this.divider.addClass('is-dragging');
            const shield = entry.doc.body.createDiv('url-preview-divider-shield');
            const move = (e: PointerEvent) => {
                const rect = host.getBoundingClientRect();
                if (rect.width) this.setRatio((e.clientX - rect.left) / rect.width);
            };
            const stop = () => {
                entry.doc.removeEventListener('pointermove', move);
                entry.doc.removeEventListener('pointerup', stop);
                entry.doc.removeEventListener('pointercancel', stop);
                entry.doc.defaultView?.removeEventListener('blur', stop);
                shield.remove();
                entry.element.removeClass('is-divider-resizing');
                this.divider.removeClass('is-dragging');
                this.stopDrag = undefined;
                this.scheduleSave();
            };
            this.stopDrag = stop;
            entry.doc.addEventListener('pointermove', move);
            entry.doc.addEventListener('pointerup', stop);
            entry.doc.addEventListener('pointercancel', stop);
            entry.doc.defaultView?.addEventListener('blur', stop);
        });
        this.divider.addEventListener('keydown', event => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            this.setRatio(this.ratio + (event.key === 'ArrowLeft' ? -0.02 : 0.02));
            this.scheduleSave();
        });
        this.observer = new ResizeObserver(() => this.updateBounds());
        this.observer.observe(host);
        this.observer.observe(content);
        this.updateBounds();
    }

    // Autorepeat on the arrow keys would otherwise write data.json ~30 times a second.
    private scheduleSave() {
        if (this.closing) return;
        const win = this.entry.doc.defaultView ?? window;
        if (this.saveTimer !== undefined) win.clearTimeout(this.saveTimer);
        this.saveTimer = win.setTimeout(() => {
            this.saveTimer = undefined;
            this.plugin.settings.sidePanelRatio = this.ratio;
            void this.plugin.saveSettings();
        }, 300);
    }

    updateBounds() {
        if (!this.host.isConnected || this.host.ownerDocument !== this.entry.doc) { this.close(); return; }
        const width = this.host.getBoundingClientRect().width;
        if (width > 0) {
            const minimum = Math.min(SIDE_PANEL_MIN_WIDTH / width, 0.5);
            const ratio = Math.min(1 - minimum, Math.max(minimum, this.ratio));
            // Keep the stored ratio inside the range the current window allows, so the next
            // arrow key moves the divider instead of being clamped back to where it already is.
            this.ratio = ratio;
            this.host.setCssProps({ '--url-preview-note-width': `${ratio * 100}%` });
            this.divider.setAttr('aria-valuenow', String(Math.round(ratio * 100)));
        }
        this.plugin.positionDockPreview(this.entry, this.host, this.content);
        const rect = this.entry.element.getBoundingClientRect();
        this.divider.toggleClass('is-hidden', this.entry.element.hasClass('is-cached'));
        this.divider.setCssStyles({ left: `${rect.left - 4}px`, top: `${rect.top}px`, height: `${rect.height}px` });
    }

    private setRatio(ratio: number) {
        const width = this.host.getBoundingClientRect().width;
        const minimum = width > 0 ? Math.min(SIDE_PANEL_MIN_WIDTH / width, 0.5) : 0.5;
        this.ratio = Math.min(1 - minimum, Math.max(minimum, ratio));
        this.updateBounds();
    }

    close(trim = true) {
        this.closing = true;
        if (this.saveTimer !== undefined) {
            // Flush rather than drop it: a drag that ended moments ago is a deliberate choice.
            (this.entry.doc.defaultView ?? window).clearTimeout(this.saveTimer);
            this.saveTimer = undefined;
            this.plugin.settings.sidePanelRatio = this.ratio;
            void this.plugin.saveSettings();
        }
        this.stopDrag?.();
        this.observer.disconnect();
        this.divider.remove();
        this.host.removeClass('url-preview-has-side-panel');
        this.host.setCssProps({ '--url-preview-note-width': '' });
        this.plugin.hideDockPreview(this.entry, trim);
    }
}

interface GitHubPullRequestBadgeObserver {
    observer: MutationObserver;
    scheduled: boolean;
    frame?: number;
    win?: Window;
}

interface GitHubHoverCardData {
    description: string | null;
    id: string;
    repoLabel: string;
    shortReference: string;
    state: GitHubIssueState | null;
    title: string;
    type: 'issues' | 'pull';
}

interface GitHubHoverCardState {
    element: HTMLElement;
    hideTimeout?: number;
    hoverZone?: ViewRect;
    key?: string;
    linkInfo?: LinkInfo;
    loadingKey?: string;
    pendingKey?: string;
    point?: ScreenPoint;
    reference?: GitHubIssueReference;
    requestId: number;
    showTimeout?: number;
}


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

interface ElectronSession {
    cookies?: ElectronCookies;
    flushStorageData?: () => Promise<void>;
}

interface ElectronModule {
    session?: {
        defaultSession?: ElectronSession;
    };
}

const MIN_PREVIEW_WIDTH = 200;
const MIN_PREVIEW_HEIGHT = 150;

// A hand-edited or half-typed size must never shrink a preview to nothing.
function sanitizePreviewSize(persisted: number | undefined, configured: number, fallback: number, minimum: number): number {
    // A persisted size below the minimum can only come from a corrupt file, so it is skipped
    // rather than clamped; a configured one is the user's choice and is clamped up.
    if (typeof persisted === 'number' && Number.isFinite(persisted) && persisted >= minimum) return persisted;
    for (const candidate of [configured, fallback]) {
        if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
            return Math.max(candidate, minimum);
        }
    }
    return minimum;
}
const INLINE_CONTROLS_GAP = 4;
const INLINE_CONTROLS_HOVER_PADDING_X = 12;
const INLINE_CONTROLS_HOVER_PADDING_Y = 10;
const INLINE_CONTROLS_SIZE = 20;
const INLINE_CONTROLS_ADORNMENT_SCAN_WIDTH = 120;
const GITHUB_PULL_REQUEST_BADGE_WIDGET_SIDE = 10000;
const GITHUB_HOVER_CARD_DELAY_MS = 250;
const GITHUB_HOVER_CARD_GAP = 12;
// Hovered GitHub references accumulate for the whole session otherwise.
const GITHUB_HOVER_CARD_CACHE_LIMIT = 100;
const GITHUB_HOVER_CARD_HIDE_DELAY_MS = 300;
const GITHUB_HOVER_CARD_MARGIN = 10;
const GITHUB_HOVER_CARD_DESCRIPTION_MAX_LENGTH = 320;
const TOOLBAR_TOOLTIP_OPTIONS = {
    classes: ['url-preview-toolbar-tooltip'],
    delay: 250,
    gap: 6,
    placement: 'bottom' as const,
};
const EDITOR_LINK_SELECTOR = '.external-link, .cm-link, .cm-hmd-external-link, .cm-url, .cm-underline, .url-preview-github-reference, [data-href], [data-url], a[href]';

function shouldCopyFullGitHubReference(event?: MouseEvent | KeyboardEvent): boolean {
    if (!event) return false;
    return Platform.isMacOS ? event.metaKey : event.altKey;
}

function getGitHubReferenceCopyDescription(): string {
    const modifierLabel = Platform.isMacOS ? 'Command' : 'Alt';
    return `Copy #id. Hold ${modifierLabel} to copy owner/repo#id`;
}

function getGitHubRepoInitials(repo: string): string {
    return repo
        .split(/[-_.]+/)
        .filter((part) => part.length > 0)
        .map((part) => part[0] ?? '')
        .join('')
        .toLowerCase();
}

interface GitHubHoverCardDisplayTitle {
    full: string;
    prefix: string;
    rest: string;
}

function formatGitHubHoverCardTitle(repo: string, id: string, title: string): GitHubHoverCardDisplayTitle {
    const initials = getGitHubRepoInitials(repo);
    const rest = `#${id} ${title}`;
    return {
        full: initials ? `${initials}${rest}` : rest,
        prefix: initials,
        rest,
    };
}

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
    constructor(
        private readonly githubId: string,
        private readonly githubReference: string,
        private readonly copyGitHubReference: GitHubReferenceCopyHandler
    ) {
        super();
    }

    eq(other: GitHubPullRequestBadgeWidget): boolean {
        return this.githubId === other.githubId && this.githubReference === other.githubReference;
    }

    toDOM(view: EditorView): HTMLElement {
        const badge = view.dom.ownerDocument.createElement('span');
        badge.addClass('url-preview-github-pr-badge');
        badge.textContent = `#${this.githubId}`;
        badge.setAttr('aria-description', getGitHubReferenceCopyDescription());
        badge.setAttr('role', 'button');
        badge.setAttr('tabindex', '0');
        badge.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.copyGitHubReference(event);
        });
        badge.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;

            event.preventDefault();
            event.stopPropagation();
            this.copyGitHubReference(event);
        });
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
    showInlinePreviewButton: boolean;
    showInlineExternalLinkIcon: boolean;
    showGitHubHoverCard: boolean;
    showLoadingIndicators: boolean;
    allowResize: boolean;
    persistResize: boolean;
    domainZoomLevels: Record<string, number>;
    sidePanelRatio: number;
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
    showInlinePreviewButton: false,
    showInlineExternalLinkIcon: true,
    showGitHubHoverCard: true,
    showLoadingIndicators: false,
    allowResize: true,
    persistResize: false,
    domainZoomLevels: {},
    sidePanelRatio: 0.5,
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
    private githubHoverCards = new Map<Document, GitHubHoverCardState>();
    private githubHoverCardDataCache = new Map<string, GitHubHoverCardData | Promise<GitHubHoverCardData>>();
    private documentScopes = new Map<Document, Component>();
    private previewCache = new Map<HTMLElement, CachedPreview>();
    private lastPreviewChromeSignature: string | undefined;
    previewRequest = 0;
    private unloaded = false;
    private editorLinkCache = new WeakMap<EditorView, { doc: unknown; links: ParsedMarkdownLink[] }>();

    async onload() {
        await this.loadSettings();
        this.registerEvent(this.app.workspace.on('layout-change', () => {
            for (const entry of this.previewCache.values()) entry.dock?.updateBounds();
        }));
        await this.removeLegacyPreviewCache();
        
        // Defer setup until layout is ready
        this.app.workspace.onLayoutReady(() => {
            // onLayoutReady is a workspace queue, not a component registration, so it can
            // still fire for a plugin that was disabled before the layout settled.
            if (this.unloaded) return;
            this.registerGlobalHandler();
        });

        this.registerEvent(
            this.app.workspace.on('editor-menu', (menu, editor) => {
                this.addLinkContextMenuItems(menu, editor);
            })
        );
        this.registerEvent(
            this.app.workspace.on('url-menu', (menu, url) => {
                this.addLinkContextMenuItemsForUrl(menu, url);
            })
        );
        this.registerEditorExtension(this.createGitHubPullRequestBadgeExtension());

        // Modifier+click and the inline button both need a mouse. This is the only way to
        // reach a preview from the keyboard, or at all on a touch device.
        this.addCommand({
            id: 'preview-link-at-cursor',
            name: 'Preview link at cursor',
            editorCheckCallback: (checking, editor, ctx) => {
                const content = editor.getValue();
                const link = this.getEditorLinkAtCursor(editor, content, null);
                if (!link) return false;
                const view = ctx instanceof MarkdownView ? EditorView.findFromDOM(ctx.contentEl) : null;
                if (view && this.isRangeInsideCode(view, link.start, link.end)) return false;
                if (checking) return true;

                if (!view) return false;
                // Anchor on the link itself: the whole note as hover element would position the
                // popup in the corner and make every click in the note count as a click inside it.
                const at = view.domAtPos(link.start);
                const node = at.node.nodeType === Node.ELEMENT_NODE ? at.node : at.node.parentElement;
                const anchor = node instanceof HTMLElement ? node : view.contentDOM;
                this.openPreviewForLink({
                    editorView: view,
                    element: anchor,
                    hoverElement: anchor,
                    markdownLink: link,
                    sourceKey: this.getMarkdownLinkSourceKey(link),
                    url: link.url,
                });
                return true;
            },
        });

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
                    if (
                        !update.docChanged &&
                        !update.geometryChanged &&
                        !update.viewportChanged &&
                        syntaxTree(update.startState) === syntaxTree(update.state) &&
                        this.version === version
                    ) return;

                    this.version = version;
                    this.decorations = buildDecorations(update.view);
                }
            },
            {
                decorations: (value) => value.decorations,
            }
        );
    }

    // A URL written inside code is documentation, not a link: it gets no badge and no preview.
    private isRangeInsideCode(view: EditorView, from: number, to: number): boolean {
        let insideCode = false;
        syntaxTree(view.state).iterate({
            from,
            to: Math.max(from + 1, to),
            enter: (node) => {
                if (insideCode) return false;
                if (/(^|[-_])(inline-code|codeblock|comment)/i.test(node.name)) {
                    insideCode = true;
                    return false;
                }
            },
        });
        return insideCode;
    }

    // Decorations rebuild on every scroll tick, so re-parsing the whole note each time is the
    // single most expensive thing this plugin does on a long note. The document is immutable,
    // so its identity is a safe cache key.
    private parseEditorLinksForDocument(view: EditorView): ParsedMarkdownLink[] {
        const doc = view.state.doc;
        const cached = this.editorLinkCache.get(view);
        if (cached?.doc === doc) return cached.links;
        const links = this.parseEditorLinks(doc.toString());
        this.editorLinkCache.set(view, { doc, links });
        return links;
    }

    private buildGitHubPullRequestBadgeDecorations(view: EditorView): DecorationSet {
        const visible = view.visibleRanges;
        const links = this.parseEditorLinksForDocument(view)
            .filter((link) => visible.some((range) => link.start <= range.to && link.end >= range.from))
            .filter((link) => !this.isRangeInsideCode(view, link.start, link.end));

        return Decoration.set(
            links.flatMap((link) => {
                const linkDecorations = this.shouldMarkBareGitHubLink(link)
                    ? [Decoration.mark({ class: 'url-preview-github-reference' }).range(link.start, link.end)]
                    : [];
                const githubReference = this.getGitHubIssueReference(link.url);
                if (!this.settings.showGitHubPullRequestIds || !githubReference) return linkDecorations;

                const badgePosition = link.end;

                if (this.linkTextContainsGitHubId(link.text, githubReference.id)) {
                    return linkDecorations;
                }

                return [
                    ...linkDecorations,
                    Decoration.widget({
                        side: GITHUB_PULL_REQUEST_BADGE_WIDGET_SIDE,
                        widget: new GitHubPullRequestBadgeWidget(
                            githubReference.id,
                            githubReference.shortReference,
                            (event) => {
                                void this.copyGitHubReference(githubReference, event);
                            }
                        ),
                    }).range(badgePosition),
                ];
            }),
            true
        );
    }

    private registerGlobalHandler() {
        // Per-document handlers live on their own child component: `registerDomEvent` only
        // unbinds at plugin unload, which would retain every closed popout's document.
        const handleWindow = (doc: Document) => {
            if (this.handledDocuments.has(doc)) return;
            this.handledDocuments.add(doc);
            this.applyDisplaySettings(doc);

            const scope = new Component();
            this.addChild(scope);
            this.documentScopes.set(doc, scope);

            scope.registerDomEvent(doc, 'mouseover', (e: MouseEvent) => {
                this.lastMouseX = e.clientX;
                this.lastMouseY = e.clientY;
            });
            scope.registerDomEvent(doc, 'contextmenu', (e: MouseEvent) => this.captureEditorContextMenuLink(e));
            scope.registerDomEvent(doc, 'click', (e: MouseEvent) => {
                if (this.isClickInsideGitHubHoverCard(doc, e)) return;

                this.hideGitHubHoverCard(doc);
                this.handleLinkClick(e);
            }, { capture: true });
            scope.registerDomEvent(doc, 'mousemove', (e: MouseEvent) => {
                const dx = Math.abs(e.clientX - this.lastMouseX);
                const dy = Math.abs(e.clientY - this.lastMouseY);
                const didMouseMove = dx > 0 || dy > 0;
                this.lastMouseX = e.clientX;
                this.lastMouseY = e.clientY;
                if (didMouseMove) {
                    this.updateInlinePreviewButton(e);
                    this.updateGitHubHoverCardFromEvent(e);
                }
            });
            scope.registerDomEvent(doc, 'keydown', (e: KeyboardEvent) => {
                if (this.isSourceModeToggleEvent(e)) {
                    this.hideEditorHoverUi(doc);
                    const win = doc.defaultView ?? window;
                    win.setTimeout(() => this.hideEditorHoverUi(doc), 0);
                }
                if (e.key === 'Escape' && this.activePreview) {
                    this.cleanupActivePreview();
                } else if (e.key === 'Escape') {
                    // A docked panel is not the active preview, so it needs its own exit.
                    for (const entry of [...this.previewCache.values()]) {
                        if (entry.doc === doc && entry.dock) entry.dock.close();
                    }
                }
                if (e.key === 'Escape') {
                    this.hideGitHubHoverCard(doc);
                    return;
                }
            });
            const win = doc.defaultView;
            if (win) {
                scope.registerDomEvent(win, 'blur', () => {
                    this.hideGitHubHoverCard(doc);
                });
            }
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
            this.app.workspace.on('editor-change', () => this.hideAllEditorHoverUi())
        );
        this.registerEvent(
            this.app.workspace.on('layout-change', () => this.hideAllEditorHoverUi())
        );
        this.registerEvent(
            this.app.workspace.on('window-close', (workspaceWindow) => {
                if (this.activePreview?.doc === workspaceWindow.doc) {
                    this.cleanupActivePreview();
                }
                this.removeInlinePreviewControls(workspaceWindow.doc);
                this.removeGitHubHoverCard(workspaceWindow.doc);
                for (const entry of this.previewCache.values()) {
                    if (entry.doc === workspaceWindow.doc) this.disposeCachedPreview(entry);
                }
                this.unregisterGitHubPullRequestBadges(workspaceWindow.doc);
                const scope = this.documentScopes.get(workspaceWindow.doc);
                if (scope) {
                    this.removeChild(scope);
                    this.documentScopes.delete(workspaceWindow.doc);
                }
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
        // A frame already queued would put every badge back after teardown.
        if (observerState.frame !== undefined) observerState.win?.cancelAnimationFrame(observerState.frame);
        this.githubPullRequestBadgeObservers.delete(doc);
        doc.querySelectorAll('.url-preview-github-pr-badge').forEach((badge) => badge.remove());
        doc.body.removeClass('url-preview-hide-github-pr-badges');
    }

    private scheduleGitHubPullRequestBadgeUpdate(doc: Document) {
        const observerState = this.githubPullRequestBadgeObservers.get(doc);
        if (!observerState || observerState.scheduled) return;

        observerState.scheduled = true;
        const win = doc.defaultView ?? window;
        observerState.win = win;
        observerState.frame = win.requestAnimationFrame(() => {
            observerState.scheduled = false;
            observerState.frame = undefined;
            if (!this.githubPullRequestBadgeObservers.has(doc)) return;
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
            // Kanban cards render their own number line; badges there only crowd the card.
            if (link.closest('.hover-popup, .url-preview-inline-controls, .cm-editor, .kanban-plugin')) {
                this.removeGitHubPullRequestBadge(link);
                continue;
            }

            const githubReference = this.getGitHubIssueReference(link.href);
            if (!githubReference) {
                this.removeGitHubPullRequestBadge(link);
                continue;
            }

            if (link.getAttribute('aria-label') === githubReference.shortReference) {
                link.removeAttribute('aria-label');
            }
            if (this.linkTextContainsGitHubId(link.textContent ?? '', githubReference.id)) {
                this.removeGitHubPullRequestBadge(link);
                continue;
            }

            this.upsertGitHubPullRequestBadge(link, githubReference);
        }

        // A badge belongs directly after its link; anything else is an orphan left by other DOM edits.
        doc.querySelectorAll('.url-preview-github-pr-badge').forEach((badge) => {
            // Editor badges are CodeMirror widgets owned by the editor extension, never orphans.
            if (badge.closest('.cm-editor')) return;
            const previous = badge.previousElementSibling;
            if (!(previous instanceof HTMLAnchorElement) || !this.getGitHubIssueReference(previous.href)) {
                badge.remove();
            }
        });
    }

    private upsertGitHubPullRequestBadge(link: HTMLAnchorElement, githubReference: GitHubIssueReference) {
        link.querySelectorAll('.url-preview-github-pr-badge').forEach((badge) => badge.remove());

        const nextElement = link.nextElementSibling;
        const existingBadge = nextElement?.classList.contains('url-preview-github-pr-badge') ? nextElement : null;
        if (existingBadge instanceof HTMLElement) {
            // Rewriting an unchanged badge still counts as a childList mutation, which wakes the
            // observer that scheduled this pass and spins the updater at frame rate forever.
            if (existingBadge.getAttribute('data-github-reference') !== githubReference.shortReference) {
                this.configureGitHubPullRequestBadge(existingBadge, githubReference);
            }
            return;
        }

        const badge = link.ownerDocument.createElement('span');
        badge.addClass('url-preview-github-pr-badge');
        this.configureGitHubPullRequestBadge(badge, githubReference);
        link.parentElement?.insertBefore(badge, link.nextSibling);
    }

    private configureGitHubPullRequestBadge(badge: HTMLElement, githubReference: GitHubIssueReference) {
        const text = `#${githubReference.id}`;
        if (badge.textContent !== text) badge.textContent = text;
        badge.removeAttribute('aria-label');
        badge.setAttr('aria-description', getGitHubReferenceCopyDescription());
        badge.setAttr('data-github-id', githubReference.id);
        badge.setAttr('data-github-reference', githubReference.shortReference);
        badge.setAttr('role', 'button');
        badge.setAttr('tabindex', '0');

        if (badge.getAttribute('data-url-preview-copy-enabled') === 'true') return;

        badge.setAttr('data-url-preview-copy-enabled', 'true');
        badge.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();

            const reference = this.getGitHubReferenceFromBadge(badge);
            if (reference) {
                void this.copyGitHubReference(reference, event);
            }
        });
        badge.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;

            event.preventDefault();
            event.stopPropagation();

            const reference = this.getGitHubReferenceFromBadge(badge);
            if (reference) {
                void this.copyGitHubReference(reference, event);
            }
        });
    }

    private getGitHubReferenceFromBadge(
        badge: HTMLElement
    ): Pick<GitHubIssueReference, 'id' | 'shortReference'> | null {
        const id = badge.getAttribute('data-github-id');
        const shortReference = badge.getAttribute('data-github-reference');
        if (!id || !shortReference) return null;

        return { id, shortReference };
    }

    private removeGitHubPullRequestBadge(link: HTMLAnchorElement) {
        link.querySelectorAll('.url-preview-github-pr-badge').forEach((badge) => badge.remove());
        const nextElement = link.nextElementSibling;
        if (nextElement?.classList.contains('url-preview-github-pr-badge')) {
            nextElement.remove();
        }
    }

    private linkTextContainsGitHubId(text: string, id: string): boolean {
        return new RegExp(`#${id}(?!\\d)`).test(text);
    }

    private getGitHubIssueReference(url: string): GitHubIssueReference | null {
        try {
            const parsedUrl = new URL(url);
            if (parsedUrl.hostname !== 'github.com') return null;

            const [owner, repo, type, id] = parsedUrl.pathname.split('/').filter(Boolean);
            if (!owner || !repo || !id) return null;
            if (type !== 'pull' && type !== 'issues') return null;
            if (!/^\d+$/.test(id)) return null;

            return {
                id,
                owner,
                repo,
                shortReference: `${owner}/${repo}#${id}`,
                type,
            };
        } catch {
            return null;
        }
    }

    private async copyGitHubReference(
        githubReference: Pick<GitHubIssueReference, 'id' | 'shortReference'>,
        event?: MouseEvent | KeyboardEvent
    ) {
        const text = shouldCopyFullGitHubReference(event)
            ? githubReference.shortReference
            : `#${githubReference.id}`;
        await this.copyTextToClipboard(text, text);
    }

    private async copyTextToClipboard(text: string, label: string) {
        try {
            await navigator.clipboard.writeText(text);
            new Notice(`Copied ${label}`);
        } catch {
            new Notice(`Could not copy ${label}`);
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

        if (this.isSourceModeMarkdownTarget(target)) {
            this.hideInlinePreviewControls(doc);
            return;
        }

        if (this.activePreview?.element.contains(target)) {
            this.hideInlinePreviewControls(doc);
            return;
        }

        const linkInfo = this.findLinkElement(target, null, point) ??
            this.findInlinePreviewLineLinkElement(target, point);
        if (!linkInfo) {
            this.hideInlinePreviewControls(doc);
            return;
        }

        this.showInlinePreviewControls(doc, linkInfo, point);
    }

    private updateGitHubHoverCardFromEvent(event: MouseEvent) {
        const target = event.target;
        if (!(target instanceof Element)) return;

        this.updateGitHubHoverCardAtPoint(
            target.ownerDocument,
            { x: event.clientX, y: event.clientY },
            this.getModifierState(event)
        );
    }

    private isClickInsideGitHubHoverCard(doc: Document, event: MouseEvent): boolean {
        const state = this.githubHoverCards.get(doc);
        const target = event.target;
        const win = doc.defaultView ?? window;
        return Boolean(state && target instanceof win.Node && state.element.contains(target));
    }

    private updateGitHubHoverCardAtPoint(doc: Document, point: ScreenPoint, modifiers: ModifierState) {
        if (!this.settings.showGitHubHoverCard) {
            this.hideGitHubHoverCard(doc);
            return;
        }

        const target = doc.elementFromPoint(point.x, point.y);
        const state = this.githubHoverCards.get(doc);

        if (state?.linkInfo && this.isSourceModeMarkdownTarget(state.linkInfo.element)) {
            this.hideGitHubHoverCard(doc);
            return;
        }

        if (!(target instanceof Element)) {
            this.scheduleGitHubHoverCardHide(doc);
            return;
        }

        if (this.isSourceModeMarkdownTarget(target)) {
            this.hideGitHubHoverCard(doc);
            return;
        }

        if (this.activePreview?.doc === doc || this.activePreview?.element.contains(target)) {
            this.hideGitHubHoverCard(doc);
            return;
        }

        if (state?.element.contains(target) || (state && this.isPointInGitHubHoverCardHoverZone(state, point))) {
            this.clearGitHubHoverCardHideTimer(state);
            return;
        }

        if (!this.areConfiguredModifiersPressed(modifiers)) {
            this.scheduleGitHubHoverCardHide(doc);
            return;
        }

        const linkInfo = this.findLinkElement(target, null, point);
        if (!linkInfo) {
            this.scheduleGitHubHoverCardHide(doc);
            return;
        }

        if (this.isSourceModeMarkdownTarget(linkInfo.element)) {
            this.hideGitHubHoverCard(doc);
            return;
        }

        const reference = this.getGitHubIssueReference(linkInfo.url);
        if (!reference) {
            this.scheduleGitHubHoverCardHide(doc);
            return;
        }

        this.scheduleGitHubHoverCard(doc, linkInfo, reference, point);
    }

    private scheduleGitHubHoverCard(
        doc: Document,
        linkInfo: LinkInfo,
        reference: GitHubIssueReference,
        point: ScreenPoint
    ) {
        const state = this.getGitHubHoverCard(doc);
        const key = this.getGitHubHoverCardKey(linkInfo, reference);
        this.clearGitHubHoverCardHideTimer(state);

        if (state.key === key || state.pendingKey === key) {
            state.linkInfo = linkInfo;
            state.hoverZone = this.getInlinePreviewLineHoverRect(linkInfo) ?? undefined;
            state.reference = reference;
            if (!state.element.classList.contains('is-visible')) {
                state.point = point;
            }
            return;
        }

        this.clearGitHubHoverCardTimer(state);
        state.key = undefined;
        state.pendingKey = key;
        state.hoverZone = this.getInlinePreviewLineHoverRect(linkInfo) ?? undefined;
        state.linkInfo = linkInfo;
        state.point = point;
        state.reference = reference;
        this.stopGitHubHoverCardLoading(state);
        state.element.removeClass('is-visible');

        const win = doc.defaultView ?? window;
        state.showTimeout = win.setTimeout(() => {
            if (state.pendingKey !== key || !state.linkInfo || !state.reference || !state.point) return;

            state.key = key;
            state.pendingKey = undefined;
            const cachedData = this.getCachedGitHubHoverCardData(state.linkInfo.url);
            if (cachedData) {
                this.renderGitHubHoverCard(state.element, cachedData);
            } else {
                this.renderGitHubHoverCard(
                    state.element,
                    this.createGitHubHoverCardFallbackData(state.linkInfo, state.reference),
                    { showDescriptionSkeleton: true }
                );
                this.startGitHubHoverCardLoading(state, key);
                void this.loadGitHubHoverCardData(state, state.linkInfo, state.reference, key);
            }
            this.positionGitHubHoverCard(state.element, state.point);
            state.element.addClass('is-visible');
        }, GITHUB_HOVER_CARD_DELAY_MS);
    }

    private getGitHubHoverCard(doc: Document): GitHubHoverCardState {
        const existingState = this.githubHoverCards.get(doc);
        if (existingState) return existingState;

        const element = doc.createElement('div');
        element.addClass('url-preview-github-hover-card');
        doc.body.appendChild(element);

        const state = { element, requestId: 0 };
        this.githubHoverCards.set(doc, state);
        return state;
    }

    private hideGitHubHoverCard(doc: Document) {
        const state = this.githubHoverCards.get(doc);
        if (!state) return;

        this.clearGitHubHoverCardTimer(state);
        this.clearGitHubHoverCardHideTimer(state);
        state.key = undefined;
        state.pendingKey = undefined;
        state.hoverZone = undefined;
        state.linkInfo = undefined;
        state.point = undefined;
        state.reference = undefined;
        this.stopGitHubHoverCardLoading(state);
        state.element.removeClass('is-visible');
    }

    private removeGitHubHoverCard(doc: Document) {
        const state = this.githubHoverCards.get(doc);
        if (!state) return;

        this.clearGitHubHoverCardTimer(state);
        this.clearGitHubHoverCardHideTimer(state);
        this.stopGitHubHoverCardLoading(state);
        state.element.remove();
        this.githubHoverCards.delete(doc);
    }

    private clearGitHubHoverCardTimer(state: GitHubHoverCardState) {
        if (!state.showTimeout) return;

        const win = state.element.ownerDocument.defaultView ?? window;
        win.clearTimeout(state.showTimeout);
        state.showTimeout = undefined;
    }

    private scheduleGitHubHoverCardHide(doc: Document) {
        const state = this.githubHoverCards.get(doc);
        if (!state) return;

        this.clearGitHubHoverCardHideTimer(state);
        const win = state.element.ownerDocument.defaultView ?? window;
        state.hideTimeout = win.setTimeout(() => {
            this.hideGitHubHoverCard(doc);
        }, GITHUB_HOVER_CARD_HIDE_DELAY_MS);
    }

    private clearGitHubHoverCardHideTimer(state: GitHubHoverCardState) {
        if (!state.hideTimeout) return;

        const win = state.element.ownerDocument.defaultView ?? window;
        win.clearTimeout(state.hideTimeout);
        state.hideTimeout = undefined;
    }

    private isPointInGitHubHoverCardHoverZone(state: GitHubHoverCardState, point: ScreenPoint): boolean {
        if (!state.linkInfo && !state.hoverZone) return false;

        const hoverZone = state.hoverZone ?? (
            state.linkInfo ? this.getInlinePreviewLineHoverRect(state.linkInfo) : null
        );
        if (!hoverZone) return false;

        return point.x >= hoverZone.left &&
            point.x <= hoverZone.right &&
            point.y >= hoverZone.top &&
            point.y <= hoverZone.bottom;
    }

    private getGitHubHoverCardKey(linkInfo: LinkInfo, reference: GitHubIssueReference): string {
        return `${linkInfo.url}:${reference.shortReference}`;
    }

    private startGitHubHoverCardLoading(state: GitHubHoverCardState, key: string) {
        state.loadingKey = key;
    }

    private finishGitHubHoverCardLoading(state: GitHubHoverCardState, key: string) {
        if (state.loadingKey !== key) return;

        this.stopGitHubHoverCardLoading(state);
    }

    private stopGitHubHoverCardLoading(state: GitHubHoverCardState) {
        state.loadingKey = undefined;
    }

    private async loadGitHubHoverCardData(
        state: GitHubHoverCardState,
        linkInfo: LinkInfo,
        reference: GitHubIssueReference,
        key: string
    ) {
        const requestId = state.requestId + 1;
        state.requestId = requestId;

        const data = await this.getGitHubHoverCardData(linkInfo, reference);
        if (state.requestId !== requestId || state.key !== key || !state.linkInfo || !state.point) return;

        this.finishGitHubHoverCardLoading(state, key);
        this.renderGitHubHoverCard(state.element, data);
        this.positionGitHubHoverCard(state.element, state.point);
    }

    private renderGitHubHoverCard(
        card: HTMLElement,
        data: GitHubHoverCardData,
        options: { showDescriptionSkeleton?: boolean } = {}
    ) {
        card.empty();

        const header = card.createDiv('url-preview-github-hover-card-header');
        const referenceLabel = `${data.repoLabel}#${data.id}`;
        const referenceAction = header.createSpan('url-preview-github-hover-card-reference-action');
        referenceAction.setAttr('role', 'button');
        referenceAction.setAttr('tabindex', '0');
        referenceAction.createSpan({ cls: 'url-preview-github-hover-card-repo', text: referenceLabel });
        const copyIcon = referenceAction.createSpan('url-preview-github-hover-card-copy-icon');
        setIcon(copyIcon, 'clipboard');
        referenceAction.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            void this.copyGitHubReference(
                { id: data.id, shortReference: data.shortReference },
                event
            );
        });
        referenceAction.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;

            event.preventDefault();
            event.stopPropagation();
            void this.copyGitHubReference(
                { id: data.id, shortReference: data.shortReference },
                event
            );
        });

        const titleRow = card.createDiv('url-preview-github-hover-card-title-row');
        const stateClass = data.state ? ` is-${data.state.toLowerCase()}` : '';
        const icon = titleRow.createSpan(`url-preview-github-hover-card-icon${stateClass}`);
        setIcon(icon, data.type === 'pull' ? 'git-pull-request' : 'circle-dot');
        const titleAction = titleRow.createSpan('url-preview-github-hover-card-title-action');
        titleAction.setAttr('role', 'button');
        titleAction.setAttr('tabindex', '0');
        const displayTitle = this.formatGitHubHoverCardDisplayTitle(data);
        const titleEl = titleAction.createSpan('url-preview-github-hover-card-title');
        if (displayTitle.prefix) {
            titleEl.createSpan({
                cls: 'url-preview-github-hover-card-title-prefix',
                text: displayTitle.prefix,
            });
        }
        titleEl.createSpan({
            cls: 'url-preview-github-hover-card-title-text',
            text: displayTitle.rest,
        });
        const titleCopyIcon = titleAction.createSpan('url-preview-github-hover-card-copy-icon');
        setIcon(titleCopyIcon, 'clipboard');
        titleAction.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            void this.copyTextToClipboard(displayTitle.full, 'title');
        });
        titleAction.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;

            event.preventDefault();
            event.stopPropagation();
            void this.copyTextToClipboard(displayTitle.full, 'title');
        });

        if (data.description) {
            const descriptionShell = card.createDiv('url-preview-github-hover-card-description-shell');
            descriptionShell.createDiv({ cls: 'url-preview-github-hover-card-description', text: data.description });
        } else if (options.showDescriptionSkeleton) {
            const descriptionShell = card.createDiv(
                'url-preview-github-hover-card-description-shell is-skeleton'
            );
            const skeleton = descriptionShell.createDiv({
                cls: 'url-preview-github-hover-card-description-skeleton',
                text: 'mmmmmmmmm mmmmmmmm mmmmmmmmm mmmmmmm mmmmmmmmmm mmmmmmmm mmmmmmm mmmmmmmmm mmmmmmmm mmmmmmm mmmmmmmmm mmmmmm mmmmmmmm mmmmmmmmmm mmmmmmmm mmmmmmm mmmmmmmmm mmmmmmmmmm mmmmmmm mmmmmmmm mmmmmmmmm mmmmmmmm mmmmmmm mmmmmmmmm mmmmmmmm mmmmmmmmmm',
            });
            skeleton.setAttr('aria-hidden', 'true');
        }
    }

    private positionGitHubHoverCard(card: HTMLElement, point: ScreenPoint) {
        const win = card.ownerDocument.defaultView ?? window;
        const cardRect = this.measureGitHubHoverCard(card);
        const cardWidth = cardRect.width || Math.min(420, win.innerWidth - GITHUB_HOVER_CARD_MARGIN * 2);
        const cardHeight = cardRect.height || 160;
        const maxLeft = Math.max(GITHUB_HOVER_CARD_MARGIN, win.innerWidth - cardWidth - GITHUB_HOVER_CARD_MARGIN);
        const left = Math.max(
            GITHUB_HOVER_CARD_MARGIN,
            Math.min(point.x - cardWidth / 2, maxLeft)
        );
        const canFitBelow = point.y + GITHUB_HOVER_CARD_GAP + cardHeight + GITHUB_HOVER_CARD_MARGIN <= win.innerHeight;
        const canFitAbove = point.y - GITHUB_HOVER_CARD_GAP - cardHeight >= GITHUB_HOVER_CARD_MARGIN;
        const showAbove = !canFitBelow && canFitAbove;
        const unclampedTop = showAbove
            ? point.y - cardHeight - GITHUB_HOVER_CARD_GAP
            : point.y + GITHUB_HOVER_CARD_GAP;
        const maxTop = win.innerHeight - cardHeight - GITHUB_HOVER_CARD_MARGIN;
        const top = Math.max(GITHUB_HOVER_CARD_MARGIN, Math.min(unclampedTop, maxTop));

        card.setCssStyles({
            left: `${left}px`,
            top: `${top}px`,
        });
    }

    private measureGitHubHoverCard(card: HTMLElement): DOMRect {
        const wasMeasuring = card.classList.contains('is-measuring');
        card.addClass('is-measuring');
        const rect = card.getBoundingClientRect();
        if (!wasMeasuring) {
            card.removeClass('is-measuring');
        }

        return rect;
    }

    private createGitHubHoverCardFallbackData(
        linkInfo: LinkInfo,
        reference: GitHubIssueReference
    ): GitHubHoverCardData {
        return {
            description: null,
            id: reference.id,
            repoLabel: `${reference.owner}/${reference.repo}`,
            shortReference: reference.shortReference,
            state: null,
            title: this.getGitHubHoverCardLinkTitle(linkInfo, reference) ??
                `${reference.type === 'pull' ? 'Pull request' : 'Issue'} #${reference.id}`,
            type: reference.type,
        };
    }

private formatGitHubHoverCardDisplayTitle(data: GitHubHoverCardData): GitHubHoverCardDisplayTitle {
        const repo = data.repoLabel.split('/').pop() ?? data.repoLabel;
        return formatGitHubHoverCardTitle(repo, data.id, data.title);
    }

    private async getGitHubHoverCardData(
        linkInfo: LinkInfo,
        reference: GitHubIssueReference
    ): Promise<GitHubHoverCardData> {
        const cached = this.githubHoverCardDataCache.get(linkInfo.url);
        if (cached) return cached;

        const promise = this.fetchGitHubHoverCardData(linkInfo, reference)
            .then((data) => {
                this.githubHoverCardDataCache.set(linkInfo.url, data);
                this.trimGitHubHoverCardCache();
                return data;
            })
            .catch(() => {
                // Drop the entry instead of caching the placeholder: a single offline or
                // rate-limited hover would otherwise stand in for the real title all session.
                this.githubHoverCardDataCache.delete(linkInfo.url);
                return this.createGitHubHoverCardFallbackData(linkInfo, reference);
            });

        this.githubHoverCardDataCache.set(linkInfo.url, promise);
        return promise;
    }

    private trimGitHubHoverCardCache() {
        for (const url of this.githubHoverCardDataCache.keys()) {
            if (this.githubHoverCardDataCache.size <= GITHUB_HOVER_CARD_CACHE_LIMIT) break;
            this.githubHoverCardDataCache.delete(url);
        }
    }

    private getCachedGitHubHoverCardData(url: string): GitHubHoverCardData | null {
        const cached = this.githubHoverCardDataCache.get(url);
        if (!cached || 'then' in cached) return null;

        return cached;
    }

    private async fetchGitHubHoverCardData(
        linkInfo: LinkInfo,
        reference: GitHubIssueReference
    ): Promise<GitHubHoverCardData> {
        const fallbackData = this.createGitHubHoverCardFallbackData(linkInfo, reference);
        const html = await this.fetchPageHtml(linkInfo.url);
        const parsedDocument = new DOMParser().parseFromString(html, 'text/html');
        const title = this.extractGitHubPageTitle(parsedDocument, linkInfo.url) ?? fallbackData.title;

        return {
            ...fallbackData,
            description: this.extractGitHubHoverCardDescription(parsedDocument, title),
            state: this.extractGitHubHoverCardState(parsedDocument),
            title,
        };
    }

    private getGitHubHoverCardLinkTitle(
        linkInfo: LinkInfo,
        reference: GitHubIssueReference
    ): string | null {
        const text = this.cleanPageTitle(linkInfo.markdownLink?.text ?? linkInfo.element.textContent);
        if (!text || this.normalizeUrl(text)) return null;
        if (text === reference.shortReference) return null;

        const withoutTrailingId = this.cleanPageTitle(text.replace(new RegExp(`\\s*#${reference.id}\\s*$`), ''));
        return withoutTrailingId && withoutTrailingId !== reference.shortReference ? withoutTrailingId : null;
    }

    private extractGitHubHoverCardDescription(doc: Document, title: string): string | null {
        const commentText = this.cleanPageTitle(doc.querySelector('.comment-body')?.textContent);
        const metaText = this.getFirstMetaContent(doc, [
            'meta[property="og:description"]',
            'meta[name="description"]',
        ]);
        const description = commentText ?? metaText;
        if (!description || description === title || /github is where/i.test(description)) return null;

        return this.truncateText(description, GITHUB_HOVER_CARD_DESCRIPTION_MAX_LENGTH);
    }

    private extractGitHubHoverCardState(doc: Document): GitHubIssueState | null {
        const header = doc.querySelector('[data-component="PH_Title"]')?.closest('header') ??
            doc.querySelector('.gh-header');
        const stateElement = header?.querySelector(
            '[data-status], .State, [data-testid="issue-state"], [data-testid="issue-state-badge"], [data-testid="pr-state-badge"]'
        );
        if (stateElement) {
            const state = this.extractGitHubStateFromElement(stateElement);
            if (state) return state;
        }

        const legacyHeaderState = doc.querySelector('.gh-header-meta .State');
        if (!legacyHeaderState) return null;

        return this.extractGitHubStateFromElement(legacyHeaderState);
    }

    private extractGitHubStateFromElement(element: Element): GitHubIssueState | null {
        const status = element.getAttribute('data-status') ?? '';
        const className = typeof element.className === 'string' ? element.className : '';
        const text = this.cleanPageTitle(element.textContent) ?? '';
        const title = element.getAttribute('title') ?? '';

        return this.normalizeGitHubIssueState(`${status} ${className} ${title} ${text}`);
    }

    private normalizeGitHubIssueState(value: string): GitHubIssueState | null {
        const normalized = value.toLowerCase();
        if (normalized.includes('draft')) return 'Draft';
        if (normalized.includes('merged')) return 'Merged';
        if (normalized.includes('closed')) return 'Closed';
        if (normalized.includes('open')) return 'Open';
        return null;
    }

    private truncateText(text: string, maxLength: number): string {
        if (text.length <= maxLength) return text;

        const truncated = text.slice(0, maxLength - 1).trimEnd();
        return `${truncated}...`;
    }

    private showInlinePreviewControls(doc: Document, linkInfo: LinkInfo, point: ScreenPoint) {
        const state = this.getInlinePreviewControls(doc);
        const iconPosition = this.getInlinePreviewControlsPosition(linkInfo, point, state.container);
        if (!iconPosition) {
            this.hideInlinePreviewControls(doc);
            return;
        }

        state.container.setCssStyles({
            left: `${iconPosition.left}px`,
            top: `${iconPosition.top}px`,
        });
        state.container.addClass('is-visible');
        state.container.toggleAttribute('inert', false);
        state.hoverZone = this.getInlinePreviewLineHoverRect(linkInfo) ?? undefined;
        state.target = linkInfo;

        const canConvertGitHubUrl = this.canInlineConvertGitHubUrl(linkInfo);
        if (canConvertGitHubUrl) {
            state.githubConvertButton.removeClass('is-hidden');
        } else {
            state.githubConvertButton.addClass('is-hidden');
        }
        if (this.settings.showInlinePreviewButton) {
            state.previewButton.removeClass('is-hidden');
        } else {
            state.previewButton.addClass('is-hidden');
        }
        if (!canConvertGitHubUrl && !this.settings.showInlinePreviewButton) {
            this.hideInlinePreviewControls(doc);
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

        const previewButton = container.createEl('button', {
            cls: `url-preview-inline-button${this.settings.showInlinePreviewButton ? '' : ' is-hidden'}`,
        });
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
        linkInfo: LinkInfo,
        point: ScreenPoint,
        controlsEl: HTMLElement
    ): { left: number; top: number } | null {
        const rect = this.getInlinePreviewAnchorRect(linkInfo, point);
        if (!rect) return null;

        const adornmentRight = this.getExternalLinkAdornmentRight(linkInfo.element, rect, controlsEl);
        return {
            left: adornmentRight + INLINE_CONTROLS_GAP,
            top: rect.top + (rect.height - INLINE_CONTROLS_SIZE) / 2,
        };
    }

    private getInlinePreviewAnchorRect(linkInfo: LinkInfo, point: ScreenPoint): ViewRect | null {
        const editorLinkEndRect = this.getEditorLinkEndRect(linkInfo);
        if (editorLinkEndRect) return editorLinkEndRect;

        return this.getClientRectForPoint(linkInfo.element, point);
    }

    private getEditorLinkEndRect(linkInfo: LinkInfo): ViewRect | null {
        if (!linkInfo.editorView || !linkInfo.markdownLink) return null;

        const contentLength = linkInfo.editorView.state.doc.length;
        const linkEnd = Math.min(contentLength, Math.max(0, linkInfo.markdownLink.end));
        const coords = linkInfo.editorView.coordsAtPos(linkEnd, 1) ??
            linkInfo.editorView.coordsAtPos(Math.max(0, linkEnd - 1), 1);
        if (!coords) return null;

        return this.toViewRect(coords);
    }

    private toViewRect(rect: { bottom: number; left: number; right: number; top: number }): ViewRect {
        const left = Math.min(rect.left, rect.right);
        const right = Math.max(rect.left, rect.right);
        const top = Math.min(rect.top, rect.bottom);
        const bottom = Math.max(rect.top, rect.bottom);

        return {
            bottom,
            height: Math.max(1, bottom - top),
            left,
            right,
            top,
            width: Math.max(1, right - left),
        };
    }

    private getExternalLinkAdornmentRight(element: HTMLElement, rect: ViewRect, controlsEl: HTMLElement): number {
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
        linkRect: ViewRect
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

        if (state.hoverZone &&
            point.x >= state.hoverZone.left &&
            point.x <= state.hoverZone.right &&
            point.y >= state.hoverZone.top &&
            point.y <= state.hoverZone.bottom) {
            return true;
        }

        const linkRect = this.getInlinePreviewAnchorRect(state.target, point);
        const controlsRect = state.container.getBoundingClientRect();
        if (!linkRect || controlsRect.width === 0 || controlsRect.height === 0) return false;

        const top = Math.min(linkRect.top, controlsRect.top) - INLINE_CONTROLS_HOVER_PADDING_Y;
        const bottom = Math.max(linkRect.bottom, controlsRect.bottom) + INLINE_CONTROLS_HOVER_PADDING_Y;
        const left = Math.min(linkRect.right, controlsRect.left) - INLINE_CONTROLS_HOVER_PADDING_X;
        const right = controlsRect.right + INLINE_CONTROLS_HOVER_PADDING_X;

        return point.x >= left && point.x <= right && point.y >= top && point.y <= bottom;
    }

    private getInlinePreviewLineHoverRect(linkInfo: LinkInfo): ViewRect | null {
        const lineElement = this.getInlinePreviewLineElement(linkInfo.element);
        const doc = linkInfo.element.ownerDocument;
        const win = doc.defaultView ?? window;
        const lineRect = lineElement ? this.toViewRect(lineElement.getBoundingClientRect()) : null;
        const linkRects = Array.from(linkInfo.element.getClientRects()).map((rect) => this.toViewRect(rect));
        const rects = [
            ...(lineRect ? [lineRect] : []),
            ...linkRects,
        ].filter((rect) => rect.width > 0 && rect.height > 0);
        if (rects.length === 0) return null;

        const top = Math.max(0, Math.min(...rects.map((rect) => rect.top)) - INLINE_CONTROLS_HOVER_PADDING_Y);
        const bottom = Math.min(
            win.innerHeight,
            Math.max(...rects.map((rect) => rect.bottom)) + INLINE_CONTROLS_HOVER_PADDING_Y
        );

        return {
            bottom,
            height: Math.max(1, bottom - top),
            left: 0,
            right: win.innerWidth,
            top,
            width: win.innerWidth,
        };
    }

    private findInlinePreviewLineLinkElement(target: Element, point: ScreenPoint): LinkInfo | null {
        if (!(target instanceof HTMLElement)) return null;

        const lineElement = this.getInlinePreviewLineElement(target);
        if (!lineElement) return null;

        let nearestLinkInfo: LinkInfo | null = null;
        let nearestDistance = Number.POSITIVE_INFINITY;
        const linkElements = Array.from(lineElement.querySelectorAll(EDITOR_LINK_SELECTOR));

        for (const linkElement of linkElements) {
            if (!(linkElement instanceof HTMLElement)) continue;

            const linkRect = this.getInlinePreviewLineLinkRect(linkElement, point);
            if (!linkRect) continue;

            const candidatePoint = {
                x: linkRect.left + linkRect.width / 2,
                y: linkRect.top + linkRect.height / 2,
            };
            const linkInfo = this.findLinkElement(linkElement, null, candidatePoint);
            if (!linkInfo) continue;

            const distance = point.x < linkRect.left
                ? linkRect.left - point.x
                : Math.max(0, point.x - linkRect.right);
            if (distance >= nearestDistance) continue;

            nearestDistance = distance;
            nearestLinkInfo = linkInfo;
        }

        return nearestLinkInfo;
    }

    private getInlinePreviewLineLinkRect(element: HTMLElement, point: ScreenPoint): ViewRect | null {
        const rects = Array.from(element.getClientRects())
            .map((rect) => this.toViewRect(rect))
            .filter((rect) =>
                rect.width > 0 &&
                rect.height > 0 &&
                point.y >= rect.top - INLINE_CONTROLS_HOVER_PADDING_Y &&
                point.y <= rect.bottom + INLINE_CONTROLS_HOVER_PADDING_Y
            );

        if (rects.length === 0) return null;

        return rects.reduce((nearest, rect) => {
            const nearestDistance = this.getHorizontalDistanceToRect(point, nearest);
            const distance = this.getHorizontalDistanceToRect(point, rect);
            return distance < nearestDistance ? rect : nearest;
        });
    }

    private getHorizontalDistanceToRect(point: ScreenPoint, rect: ViewRect): number {
        if (point.x < rect.left) return rect.left - point.x;
        if (point.x > rect.right) return point.x - rect.right;
        return 0;
    }

    private isSourceModeMarkdownTarget(element: Element): boolean {
        const sourceView = element.closest('.markdown-source-view');
        return sourceView instanceof HTMLElement && !sourceView.classList.contains('is-live-preview');
    }

    private getInlinePreviewLineElement(element: HTMLElement): HTMLElement | null {
        const lineElement = element.closest('.cm-line, li, p, h1, h2, h3, h4, h5, h6, td, th, blockquote');
        return lineElement instanceof HTMLElement ? lineElement : null;
    }

    private canInlineConvertGitHubUrl(linkInfo: LinkInfo): boolean {
        return Boolean(
            linkInfo.editorView &&
            linkInfo.markdownLink &&
            this.isGitHubUrl(linkInfo.url) &&
            this.isBareMarkdownUrl(linkInfo.markdownLink)
        );
    }

    private shouldMarkBareGitHubLink(link: ParsedMarkdownLink): boolean {
        return this.isBareMarkdownUrl(link) &&
            this.isGitHubUrl(link.url) &&
            !/^https?:\/\//i.test(link.text);
    }

    private getClientRectForPoint(element: HTMLElement, point: ScreenPoint): ViewRect | null {
        const rects = Array.from(element.getClientRects());
        if (rects.length === 0) return null;

        const rect = rects.find((rect) =>
            point.y >= rect.top &&
            point.y <= rect.bottom &&
            point.x >= rect.left &&
            point.x <= rect.right
        ) ?? rects.find((rect) =>
            point.y >= rect.top &&
            point.y <= rect.bottom
        ) ?? rects[rects.length - 1];

        return this.toViewRect(rect);
    }

    private hideInlinePreviewControls(doc: Document) {
        const state = this.inlinePreviewControls.get(doc);
        if (!state) return;

        state.container.removeClass('is-visible');
        state.container.toggleAttribute('inert', true);
        state.hoverZone = undefined;
        state.target = undefined;
    }

    private removeInlinePreviewControls(doc: Document) {
        const state = this.inlinePreviewControls.get(doc);
        if (!state) return;

        state.container.remove();
        this.inlinePreviewControls.delete(doc);
    }

    private hideEditorHoverUi(doc: Document) {
        this.hideInlinePreviewControls(doc);
        this.hideGitHubHoverCard(doc);
    }

    private hideAllEditorHoverUi() {
        for (const doc of this.handledDocuments) {
            this.hideEditorHoverUi(doc);
        }
    }

    private isSourceModeToggleEvent(event: KeyboardEvent): boolean {
        const isSlash = event.key === '/' || event.code === 'Slash';
        if (!isSlash) return false;

        return Platform.isMacOS ? event.metaKey : event.ctrlKey;
    }

    private addLinkContextMenuItemsForUrl(menu: Menu, url: string) {
        const activeMarkdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!activeMarkdownView) return;

        this.addLinkContextMenuItems(menu, activeMarkdownView.editor, url, true);
    }

    private addLinkContextMenuItems(
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
        const githubReference = this.getGitHubIssueReference(link.url);
        const isGitHubUrl = this.isGitHubUrl(link.url);

        menu.addItem((item) => {
            item
                .setTitle(this.isBareMarkdownUrl(link) ? 'Convert URL to Markdown link' : 'Use page title as link text')
                .setIcon(isGitHubUrl ? 'github' : 'link')
                .onClick(() => {
                    void this.convertEditorLinkToMarkdown(editor, link);
                });
        });

        if (!githubReference) return;

        menu.addItem((item) => {
            item
                .setTitle('Add repo name prefix')
                .setIcon('tag')
                .onClick(() => {
                    this.addRepoNamePrefixToEditorLink(editor, link, githubReference);
                });
        });

        menu.addItem((item) => {
            item
                .setTitle('Copy PR ID')
                .setIcon('hash')
                .onClick(() => {
                    void this.copyGitHubReference(githubReference);
                });
        });

        menu.addItem((item) => {
            item
                .setTitle('Copy agent session title')
                .setIcon('clipboard')
                .onClick(() => {
                    void this.copyAgentSessionTitle(link.url, githubReference);
                });
        });
    }

    private addRepoNamePrefixToEditorLink(
        editor: Editor,
        originalLink: ParsedMarkdownLink,
        githubReference: GitHubIssueReference
    ) {
        const link = this.resolveCurrentEditorLink(editor, originalLink);
        if (!link) {
            new Notice('Could not find the link anymore.');
            return;
        }

        const prefix = `${githubReference.repo}: `;
        const content = editor.getValue();
        if (this.hasRepoNamePrefixBefore(content, link.start, githubReference.repo)) {
            new Notice(`Already has ${githubReference.repo} prefix.`);
            return;
        }

        editor.replaceRange(
            prefix,
            editor.offsetToPos(link.start),
            editor.offsetToPos(link.start),
            'url-preview-repo-prefix'
        );
        editor.setCursor(editor.offsetToPos(link.start + prefix.length + (link.end - link.start)));
        new Notice(`Added ${githubReference.repo} prefix.`);
    }

    private hasRepoNamePrefixBefore(content: string, linkStart: number, repo: string): boolean {
        const before = content.slice(0, linkStart);
        const candidates = [`${repo} `, `${repo}: `, `${repo}:`];

        return candidates.some((prefix) => {
            if (!before.toLowerCase().endsWith(prefix.toLowerCase())) return false;
            if (before.length === prefix.length) return true;

            const charBefore = before[before.length - prefix.length - 1] ?? '';
            return charBefore === ' ' ||
                charBefore === '\t' ||
                charBefore === '\n' ||
                charBefore === '\r' ||
                charBefore === '(' ||
                charBefore === '[' ||
                charBefore === '{';
        });
    }

    private async copyAgentSessionTitle(url: string, githubReference: GitHubIssueReference) {
        const cached = this.getCachedGitHubHoverCardData(url);
        let title = cached?.title ?? null;

        if (!title) {
            const notice = new Notice('Fetching page title...', 0);
            title = await this.fetchPageTitleForNotice(url, notice);
            if (!title) return;
            notice.hide();
        }

        const displayTitle = formatGitHubHoverCardTitle(githubReference.repo, githubReference.id, title);
        await this.copyTextToClipboard(displayTitle.full, displayTitle.full);
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

        // Other plugins listen on this document too; only this link's default is ours to cancel.
        event.preventDefault();
        event.stopPropagation();
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
        const request = ++this.previewRequest;
        const doc = link.ownerDocument;
        // Only a visible panel that owns this link reuses itself; otherwise the click would
        // retarget a panel the user cannot see, or one parked over a different note.
        const sidePanel = [...this.previewCache.values()].find(entry =>
            entry.doc === doc && entry.dock && !entry.element.hasClass('is-cached') &&
            entry.dock.host.contains(link));
        if (sidePanel) {
            void this.showPreviewInSidePanel(request, sidePanel, link, url, hoverElement, sourceKey);
            return;
        }
        this.showFloatingPreview(link, url, hoverElement, sourceKey);
    }

    private async showPreviewInSidePanel(request: number, panel: CachedPreview, link: HTMLElement, url: string,
        hoverElement: HTMLElement, sourceKey?: string) {
        if (this.getPreviewFrameUrl(panel.controller) !== url) {
            let dirty = false;
            try {
                dirty = (await this.readPreviewState(panel)).dirty;
            } catch {
                // A page that cannot report its state has nothing to lose.
            }
            // Reading the panel's state is a round trip to the guest, so a second click can
            // land while this one is still waiting. The newest click owns the preview.
            if (request !== this.previewRequest) return;
            if (!panel.dock || !panel.element.isConnected) {
                this.showFloatingPreview(link, url, hoverElement, sourceKey);
                return;
            }
            if (dirty) {
                new Notice('Side panel has unsaved input, opening a floating preview instead');
                this.showFloatingPreview(link, url, hoverElement, sourceKey);
                return;
            }
            this.navigatePreviewFrame(panel.controller, url);
            panel.url = url;
        }
        panel.dock?.updateBounds();
    }

    private showFloatingPreview(link: HTMLElement, url: string, hoverElement: HTMLElement, sourceKey?: string) {
        const doc = link.ownerDocument;
        const cached = [...this.previewCache.values()].find(entry =>
            entry.doc === doc && entry.url === url && entry.element.isConnected && !entry.dock);
        const entry = cached ?? this.createCachedPreview(link, url);
        this.activateCachedPreview(entry, link, hoverElement, sourceKey);
        if (cached) void this.refreshCachedPreview(entry);
        this.trimPreviewCache();
    }

    private createCachedPreview(link: HTMLElement, url: string): CachedPreview {
        const doc = link.ownerDocument;
        const rect = link.getBoundingClientRect();
        const previewEl = this.createPreviewElement(rect, doc);
        const frameController = this.createPreviewFrame(doc, url);
        const entry: CachedPreview = { url, doc, element: previewEl, controller: frameController };

        if (this.shouldShowToolbar()) {
            this.createButtons(previewEl, frameController);
        }

        previewEl.setAttr('data-preview-url', url);

        const wrapper = previewEl.createDiv('preview-iframe-wrapper');
        wrapper.addClass('preview-scaled-viewport');
        wrapper.appendChild(frameController.element);
        const loading = wrapper.createDiv('preview-loading');
        loading.addClass('loading-spinner');
        loading.setAttr('aria-label', 'Loading preview');
        loading.setAttr('role', 'status');
        const pageLoading = wrapper.createDiv('preview-page-loading');
        pageLoading.setAttr('role', 'status');
        pageLoading.setAttr('aria-label', 'Loading page');
        this.bindPreviewFrame(previewEl, frameController, loading);

        // Add preview hover handlers
        previewEl.addEventListener('mouseenter', () => {
            if (this.cleanupTimeout) {
                window.clearTimeout(this.cleanupTimeout);
                this.cleanupTimeout = undefined;
            }
        });

        previewEl.addEventListener('mouseleave', () => {
            if (!entry.dock && !this.settings.stickyPopup) {
                this.startCleanupTimer();
            }
        });

        if (this.settings.allowResize) this.createResizeHandles(previewEl);
        doc.body.appendChild(previewEl);
        this.applyPreviewViewportProps(previewEl, url);
        this.navigatePreviewFrame(frameController, url);
        return entry;
    }

    private activateCachedPreview(entry: CachedPreview, link: HTMLElement, hoverElement: HTMLElement, sourceKey?: string,
        bounds?: { left: number; top: number; width: number; height: number }) {
        const { element: previewEl, doc } = entry;
        // Register first: cleanupActivePreview sweeps popups that are not in the cache,
        // and a freshly created entry is in the document before it is in the map.
        this.previewCache.delete(previewEl);
        this.previewCache.set(previewEl, entry);
        if (this.activePreview && this.activePreview.element !== previewEl) {
            this.cleanupActivePreview();
        }
        previewEl.removeClass('is-cached', 'is-refreshing', 'is-docked');
        this.setPreviewMuted(entry, false);
        this.clearCacheExpiry(entry);
        const win = doc.defaultView ?? window;
        // A refreshed page already has its final viewport and restored scroll.
        // Resizing it again here can trigger the website's scroll anchoring.
        if (!bounds) {
            this.applyPreviewBounds(previewEl, this.calculatePreviewBounds(link.getBoundingClientRect(), {
                width: win.innerWidth, height: win.innerHeight,
            }));
        }

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
            // The opening click is already being dispatched; attach after it finishes.
        }
        const clickTimer = win.setTimeout(() => {
            if (clickOutsideHandler && this.activePreview?.element === previewEl) {
                doc.addEventListener('click', clickOutsideHandler);
            }
        }, 0);
        const cleanupWithClickHandler = () => {
            win.clearTimeout(clickTimer);
            if (clickOutsideHandler) {
                doc.removeEventListener('click', clickOutsideHandler);
            }
            entry.cancelRefresh?.();
            entry.url = this.getPreviewFrameUrl(entry.controller);
            previewEl.addClass('is-cached');
            this.setPreviewMuted(entry, true);
            this.scheduleCacheExpiry(entry);
            void this.flushPreviewSessionStorage();
            this.activePreview = undefined;
        };
        this.activePreview = { element: previewEl, cleanup: cleanupWithClickHandler, doc, link: hoverElement, sourceKey };
    }

    private scheduleCacheExpiry(entry: CachedPreview) {
        this.clearCacheExpiry(entry);
        const win = entry.doc.defaultView ?? window;
        entry.expiry = win.setTimeout(() => {
            entry.expiry = undefined;
            if (entry.dock || entry.element === this.activePreview?.element) return;
            this.disposeCachedPreview(entry);
        }, PREVIEW_CACHE_TTL_MS);
    }

    clearCacheExpiry(entry: CachedPreview) {
        if (entry.expiry === undefined) return;
        (entry.doc.defaultView ?? window).clearTimeout(entry.expiry);
        entry.expiry = undefined;
    }

    // A cached preview stays attached and keeps playing; silence it while it is out of sight.
    setPreviewMuted(entry: CachedPreview, muted: boolean) {
        const frame = entry.controller.element;
        if (!this.isPreviewWebview(frame)) return;
        // A guest that has not reached dom-ready rejects this, so remember the intent
        // and let the dom-ready handler apply it once the page can make a sound.
        entry.controller.muted = muted;
        try {
            frame.setAudioMuted(muted);
        } catch {
            // Applied on dom-ready instead.
        }
    }

    private disposeCachedPreview(entry: CachedPreview) {
        // Remove first so closing the panel cannot evict this entry recursively.
        this.previewCache.delete(entry.element);
        if (this.activePreview?.element === entry.element) {
            this.cleanupActivePreview();
        } else if (entry.element.hasClass('is-resizing')) {
            this.activeResizeCleanup?.();
            this.activeResizeCleanup = undefined;
        }
        entry.dock?.close();
        entry.cancelRefresh?.();
        entry.controller.cleanupKeyboard?.();
        entry.element.remove();
        // Last: closing the dock goes through hideDockPreview, which re-arms the timer.
        this.clearCacheExpiry(entry);
        this.previewCache.delete(entry.element);
    }

    private trimPreviewCache() {
        for (const entry of this.previewCache.values()) {
            if (this.previewCache.size <= PREVIEW_CACHE_LIMIT) break;
            if (entry.dock || entry.element === this.activePreview?.element) continue;
            this.disposeCachedPreview(entry);
        }
    }

    private executeInPreview(frame: PreviewFrameElement, code: string): Promise<unknown> {
        if (!this.isPreviewWebview(frame)) return Promise.reject(new Error('Desktop preview required'));
        try {
            const remote = this.getRequireFunction()?.('@electron/remote') as {
                webContents?: { fromId(id: number): { mainFrame: { executeJavaScript(code: string): Promise<unknown> } } | undefined };
            } | undefined;
            const mainFrame = remote?.webContents?.fromId(frame.getWebContentsId())?.mainFrame;
            if (mainFrame) return mainFrame.executeJavaScript(code);
        } catch {
            // Hosts without Electron remote fall back to the webview's own bridge.
        }
        try {
            return frame.executeJavaScript(code);
        } catch (error) {
            return Promise.reject(error instanceof Error ? error : new Error(String(error)));
        }
    }

    private async readPreviewState(entry: CachedPreview): Promise<{ x: number; y: number; dirty: boolean }> {
        const result = await this.executeInPreview(entry.controller.element, `JSON.stringify({
            x: scrollX, y: scrollY,
            dirty: !!window.__urlPreviewEdited || !!document.activeElement?.matches('input, textarea, [contenteditable="true"], [role="textbox"]')
        })`);
        if (typeof result !== 'string') throw new Error('Preview state unavailable');
        return JSON.parse(result) as { x: number; y: number; dirty: boolean };
    }

    private async refreshCachedPreview(entry: CachedPreview) {
        if (!this.isPreviewWebview(entry.controller.element)) return;
        const active = this.activePreview;
        if (active?.element !== entry.element) return;
        try {
            if ((await this.readPreviewState(entry)).dirty || this.activePreview !== active) return;
        } catch { return; }
        const url = this.getPreviewFrameUrl(entry.controller);
        const fresh = this.createCachedPreview(active.link, url);
        fresh.url = entry.url;
        fresh.element.addClass('is-refreshing');
        // It is loading the same page behind the live one; two copies must not both be heard.
        this.setPreviewMuted(fresh, true);
        const bounds = entry.element.getBoundingClientRect();
        this.applyPreviewBounds(fresh.element, { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height });
        this.applyPreviewViewportProps(fresh.element, url);
        let cancelled = false;
        const win = entry.doc.defaultView ?? window;
        const onFailLoad = (event: Event) => {
            if ('isMainFrame' in event && event.isMainFrame === false) return;
            if ('errorCode' in event && event.errorCode === -3) return;
            cancel();
        };
        const onNavigate = (event: Event) => {
            if ('httpResponseCode' in event && typeof event.httpResponseCode === 'number' && event.httpResponseCode >= 400) cancel();
        };
        // Keeping these removable matters: on the success path `fresh` becomes the live entry,
        // so a listener left behind would pin the replaced preview and its document forever.
        const detachRefreshListeners = () => {
            fresh.controller.element.removeEventListener('did-fail-load', onFailLoad);
            fresh.controller.element.removeEventListener('did-navigate', onNavigate);
        };
        const cancel = () => {
            if (cancelled) return;
            cancelled = true;
            win.clearTimeout(timeout);
            observer.disconnect();
            detachRefreshListeners();
            this.disposeCachedPreview(fresh);
            entry.cancelRefresh = undefined;
        };
        const observer = new MutationObserver(() => {
            const loader = fresh.element.querySelector('.preview-loading');
            if (loader?.classList.contains('is-error')) cancel();
            else if (loader?.classList.contains('is-hidden') && !fresh.element.classList.contains('is-page-loading')) void replace();
        });
        let replacing = false;
        const replace = async () => {
            if (cancelled || replacing) return;
            replacing = true;
            try {
                const state = await this.readPreviewState(entry);
                if (cancelled || state.dirty || this.activePreview !== active ||
                    this.getPreviewFrameUrl(entry.controller) !== url) { cancel(); return; }
                await this.executeInPreview(fresh.controller.element, `new Promise(resolve => {
                    history.scrollRestoration = 'manual';
                    const anchorStyle = document.createElement('style');
                    anchorStyle.textContent = 'html, body { overflow-anchor: none !important; scroll-behavior: auto !important; }';
                    document.head.appendChild(anchorStyle);
                    setTimeout(() => anchorStyle.remove(), 2000);
                    const restore = () => {
                        scrollTo({ left: ${Number(state.x)}, top: ${Number(state.y)}, behavior: 'instant' });
                        resolve();
                    };
                    const timeout = setTimeout(restore, 200);
                    requestAnimationFrame(() => requestAnimationFrame(() => {
                        clearTimeout(timeout);
                        restore();
                    }));
                })`);
                const restored = await this.readPreviewState(fresh);
                if (Math.abs(restored.x - state.x) > 2 || Math.abs(restored.y - state.y) > 2) { cancel(); return; }
                const latest = await this.readPreviewState(entry);
                if (cancelled || latest.dirty || this.activePreview !== active ||
                    latest.x !== state.x || latest.y !== state.y || this.getPreviewFrameUrl(entry.controller) !== url) { cancel(); return; }
                observer.disconnect();
                win.clearTimeout(timeout);
                detachRefreshListeners();
                cancelled = true;
                entry.cancelRefresh = undefined;
                this.cleanupActivePreview();
                this.disposeCachedPreview(entry);
                this.activateCachedPreview(fresh, active.link, active.link, active.sourceKey,
                    { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height });
            } catch { cancel(); }
        };
        const timeout = win.setTimeout(cancel, 30000);
        entry.cancelRefresh = cancel;
        fresh.controller.element.addEventListener('did-fail-load', onFailLoad);
        fresh.controller.element.addEventListener('did-navigate', onNavigate);
        observer.observe(fresh.element, { subtree: true, attributes: true, attributeFilter: ['class'] });
    }

    hideDockPreview(entry: CachedPreview, trim = true) {
        // Anything still waiting on this panel asked for the panel, not a popup.
        this.previewRequest++;
        entry.url = this.getPreviewFrameUrl(entry.controller);
        entry.dock = undefined;
        entry.element.removeClass('is-docked');
        entry.element.addClass('is-cached');
        this.setPreviewMuted(entry, true);
        this.scheduleCacheExpiry(entry);
        this.updateDockButton(entry.element, false);
        if (trim) this.trimPreviewCache();
    }

    positionDockPreview(entry: CachedPreview, host: HTMLElement, content: HTMLElement) {
        const rect = host.getBoundingClientRect();
        const page = content.getBoundingClientRect();
        const hidden = rect.width === 0 || page.height === 0;
        if (entry.element.hasClass('is-cached') !== hidden) {
            entry.element.toggleClass('is-cached', hidden);
            this.setPreviewMuted(entry, hidden);
        }
        this.applyPreviewBounds(entry.element, { left: page.right, top: page.top, width: Math.max(0, rect.right - page.right), height: page.height });
        this.applyPreviewViewportProps(entry.element, entry.controller.currentUrl);
    }

    private dockPreview(container: HTMLElement) {
        const entry = this.previewCache.get(container);
        if (entry?.dock) {
            const anchor = entry.floatingAnchor?.isConnected ? entry.floatingAnchor : entry.dock.host;
            entry.dock.close(false);
            this.cleanupActivePreview();
            // Restore the geometry the preview had before it was docked, not the panel's.
            if (entry.floatingBounds) this.applyPreviewBounds(entry.element, entry.floatingBounds);
            this.activateCachedPreview(entry, anchor, anchor, undefined, entry.floatingBounds);
            return;
        }
        const note = this.app.workspace.getMostRecentLeaf();
        const host = note?.view.containerEl;
        const content = host?.querySelector<HTMLElement>(':scope > .view-content');
        if (!entry || !host || !content || host.ownerDocument !== entry.doc) return;
        for (const other of this.previewCache.values()) {
            if (other.doc === entry.doc) other.dock?.close();
        }
        const rect = container.getBoundingClientRect();
        entry.floatingBounds = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
        entry.floatingAnchor = this.activePreview?.link;
        this.cleanupActivePreview();
        new PreviewSidePanel(entry, host, content, this);
        this.updateDockButton(container, true);
    }

    private updateDockButton(container: HTMLElement, docked: boolean) {
        const button = container.querySelector<HTMLElement>('.preview-dock-button');
        if (!button) return;
        setIcon(button, docked ? 'panels-top-left' : 'log-out');
        this.setToolbarTooltip(button, docked ? 'Return to floating preview' : 'Open in right-side panel');
    }

    private createPreviewFrame(doc: Document, url: string): PreviewFrameController {
        if (Platform.isDesktopApp) {
            const candidate = doc.createElement('webview');
            if (this.isPreviewWebview(candidate)) {
                candidate.addClass('preview-frame');
                return {
                    currentUrl: url,
                    element: candidate,
                    fallbackHistory: [],
                    fallbackHistoryIndex: -1,
                    isReady: false,
                };
            }
        }

        const iframe = doc.createElement('iframe');
        iframe.addClass('preview-frame');
        return {
            currentUrl: url,
            element: iframe,
            fallbackHistory: [],
            fallbackHistoryIndex: -1,
            isReady: true,
        };
    }

    private isPreviewWebview(element: HTMLElement): element is PreviewWebviewElement {
        return element.tagName.toLowerCase() === 'webview' &&
            'loadURL' in element &&
            typeof element.loadURL === 'function';
    }

    private bindPreviewFrame(
        previewEl: HTMLElement,
        controller: PreviewFrameController,
        loading: HTMLElement
    ) {
        let loadSequence = 0;
        let failedSequence = -1;
        let revealingSequence = -1;
        let hasRevealedInitialPage = false;
        const frame = controller.element;
        const startLoading = () => {
            previewEl.addClass('is-page-loading');
            if (hasRevealedInitialPage) return;

            loadSequence++;
            failedSequence = -1;
            loading.textContent = '';
            loading.removeClass('is-error');
            loading.removeClass('is-hidden');
        };
        const revealContent = () => {
            if (hasRevealedInitialPage) return;
            const sequence = loadSequence;
            if (failedSequence === sequence || revealingSequence === sequence) return;
            revealingSequence = sequence;

            void this.revealLoadedPreviewFrame(
                frame,
                loading,
                () => sequence === loadSequence && failedSequence !== sequence
            ).then((didReveal) => {
                if (!didReveal || !frame.isConnected) return;

                hasRevealedInitialPage = true;
            });
        };
        const finishLoading = () => {
            previewEl.removeClass('is-page-loading');
            revealContent();
            void this.flushPreviewSessionStorage();
        };
        const failLoading = (event: Event) => {
            if ('isMainFrame' in event && event.isMainFrame === false) return;
            if ('errorCode' in event && event.errorCode === -3) return;
            previewEl.removeClass('is-page-loading');
            if (hasRevealedInitialPage) return;

            failedSequence = loadSequence;
            loading.textContent = 'Failed to load preview';
            loading.addClass('is-error');
            loading.removeClass('is-hidden');
        };
        const updateNavigation = (event?: Event) => {
            const eventUrl = event ? this.getPreviewNavigationEventUrl(event) : null;
            const currentUrl = eventUrl ?? this.getPreviewFrameUrl(controller);
            if (currentUrl) {
                controller.currentUrl = currentUrl;
                previewEl.setAttr('data-preview-url', currentUrl);
            }
            this.updatePreviewNavigationControls(previewEl, controller);
            this.applyPreviewViewportProps(previewEl, controller.currentUrl);
        };
        controller.startLoading = startLoading;

        if (this.isPreviewWebview(frame)) {
            frame.addEventListener('dom-ready', () => {
                controller.isReady = true;
                if (controller.muted !== undefined) {
                    try {
                        frame.setAudioMuted(controller.muted);
                    } catch {
                        // Nothing to mute on a guest that never attached.
                    }
                }
                void this.executeInPreview(frame, `
                    window.__urlPreviewEdited = false;
                    document.addEventListener('input', () => { window.__urlPreviewEdited = true; }, true);
                `).catch(() => undefined);
                this.bindPreviewEscape(previewEl, controller);
                updateNavigation();
                revealContent();
            });
            frame.addEventListener('did-start-loading', startLoading);
            frame.addEventListener('did-stop-loading', finishLoading);
            frame.addEventListener('did-fail-load', failLoading);
            frame.addEventListener('did-navigate', updateNavigation);
            frame.addEventListener('did-navigate-in-page', updateNavigation);
        } else {
            frame.addEventListener('load', () => {
                if (loading.classList.contains('is-hidden')) {
                    startLoading();
                }
                updateNavigation();
                finishLoading();
            });
            frame.addEventListener('error', failLoading);
        }

        startLoading();
    }

    private bindPreviewEscape(previewEl: HTMLElement, controller: PreviewFrameController) {
        const frame = controller.element;
        if (!this.isPreviewWebview(frame) || controller.cleanupKeyboard) return;
        const requireFn = this.getRequireFunction();
        if (!requireFn) return;
        type Input = { type: string; key: string; isAutoRepeat: boolean; alt: boolean; control: boolean; meta: boolean; shift: boolean };
        type Listener = (event: unknown, input: Input) => void;
        type Contents = { on(event: string, listener: Listener): void; removeListener(event: string, listener: Listener): void; isDestroyed(): boolean };
        try {
            const remote = requireFn('@electron/remote') as { webContents: { fromId(id: number): Contents | undefined } };
            const contents = remote.webContents.fromId(frame.getWebContentsId());
            if (!contents) return;
            let lastEscape = 0;
            const listener: Listener = (_event, input) => {
                if (input.type !== 'keyDown' || input.isAutoRepeat) return;
                if (input.key !== 'Escape' || input.alt || input.control || input.meta || input.shift) {
                    lastEscape = 0;
                    return;
                }
                const now = Date.now();
                if (lastEscape && now - lastEscape <= 500 && this.activePreview?.element === previewEl) {
                    this.cleanupActivePreview();
                } else {
                    lastEscape = now;
                }
            };
            contents.on('before-input-event', listener);
            controller.cleanupKeyboard = () => {
                try {
                    if (!contents.isDestroyed()) contents.removeListener('before-input-event', listener);
                } catch {
                    // The remote reference dies with its window; nothing is left to detach.
                }
            };
        } catch {
            // Embedded keyboard access is only available in desktop hosts exposing Electron remote.
        }
    }

    private async revealLoadedPreviewFrame(
        frame: PreviewFrameElement,
        loading: HTMLElement,
        isCurrentLoad: () => boolean
    ): Promise<boolean> {
        await this.waitForPreviewFramePaint(frame);
        if (!isCurrentLoad() || !frame.isConnected) return false;

        loading.addClass('is-hidden');
        return true;
    }

    private async waitForPreviewFramePaint(frame: PreviewFrameElement) {
        if (this.isPreviewWebview(frame)) {
            try {
                // The webview helper defers execution until load completes. Execute on
                // the main frame directly so slow subresources do not delay the reveal.
                const requireFn = this.getRequireFunction();
                const remote = requireFn?.('@electron/remote') as {
                    webContents?: { fromId(id: number): { mainFrame: { executeJavaScript(code: string): Promise<unknown> } } | undefined };
                } | undefined;
                const mainFrame = remote?.webContents?.fromId(frame.getWebContentsId())?.mainFrame;
                const execute = mainFrame
                    ? (code: string) => mainFrame.executeJavaScript(code)
                    : (code: string) => frame.executeJavaScript(code);
                await execute(
                    `new Promise((resolve) => {
                        if (performance.getEntriesByName('first-contentful-paint').length) {
                            resolve();
                            return;
                        }
                        const observer = new PerformanceObserver((list) => {
                            if (list.getEntries().some(entry => entry.name === 'first-contentful-paint')) done();
                        });
                        // Some embedded documents expose no paint entries. Wait for
                        // rendered text or media, then let the guest paint it.
                        let painting = false;
                        const checkContent = () => {
                            if (painting || !document.body) return;
                            const media = Array.from(document.querySelectorAll('img, svg, canvas, video'))
                                .some(element => {
                                    const rect = element.getBoundingClientRect();
                                    return rect.width > 0 && rect.height > 0 &&
                                        (!(element instanceof HTMLImageElement) || element.naturalWidth > 0);
                                });
                            if (!document.body.innerText.trim() && !media) return;
                            painting = true;
                            requestAnimationFrame(() => requestAnimationFrame(done));
                        };
                        const done = () => {
                            observer.disconnect();
                            window.removeEventListener('load', done);
                            clearInterval(contentCheck);
                            resolve();
                        };
                        const contentCheck = setInterval(checkContent, 100);
                        // Completed blank documents need no artificial waiting period.
                        window.addEventListener('load', done, { once: true });
                        observer.observe({ type: 'paint', buffered: true });
                        if (document.readyState === 'complete') {
                            done();
                            return;
                        }
                        checkContent();
                    })`
                );
                return;
            } catch {
                // Navigation may replace the document while waiting for its paint timing.
            }
        }
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

        // Keyboard focus counts as being in the preview; the pointer is not the only way in.
        const active = this.activePreview.doc.activeElement;
        if (active && this.activePreview.element.contains(active)) return true;

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
        return this.areConfiguredModifiersPressed(this.getModifierState(event));
    }

    private areConfiguredModifiersPressed(modifiers: ModifierState): boolean {
        const keys = this.settings.modifierKeys;
        if (keys.meta && !modifiers.metaKey) return false;
        if (keys.ctrl && !modifiers.ctrlKey) return false;
        if (keys.alt && !modifiers.altKey) return false;
        if (keys.shift && !modifiers.shiftKey) return false;
        return keys.meta || keys.ctrl || keys.alt || keys.shift;
    }

    private getModifierState(event: MouseEvent | KeyboardEvent): ModifierState {
        return {
            altKey: event.altKey,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            shiftKey: event.shiftKey,
        };
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
            // Merge over the defaults and keep only known keys, so a key added in a later
            // version gets its default and a stale one is not written back on every save.
            const stored = loaded.modifierKeys as Partial<ModifierKeyConfig>;
            modifierKeys = {
                meta: stored.meta ?? DEFAULT_MODIFIER_KEYS.meta,
                ctrl: stored.ctrl ?? DEFAULT_MODIFIER_KEYS.ctrl,
                alt: stored.alt ?? DEFAULT_MODIFIER_KEYS.alt,
                shift: stored.shift ?? DEFAULT_MODIFIER_KEYS.shift,
            };
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
            maxPreviewWidth: sanitizePreviewSize(undefined, loaded?.maxPreviewWidth as number,
                DEFAULT_SETTINGS.maxPreviewWidth, MIN_PREVIEW_WIDTH),
            maxPreviewHeight: sanitizePreviewSize(undefined, loaded?.maxPreviewHeight as number,
                DEFAULT_SETTINGS.maxPreviewHeight, MIN_PREVIEW_HEIGHT),
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
        this.lastPreviewChromeSignature = this.previewChromeSignature();
    }

    async saveSettings() {
        await this.saveData(this.settings);
        if (this.unloaded) return;
        // Toolbar buttons and resize handles are built once per preview, so a cached page
        // would keep the old chrome until it aged out. Drop the idle ones instead.
        const chrome = this.previewChromeSignature();
        if (this.lastPreviewChromeSignature !== undefined && this.lastPreviewChromeSignature !== chrome) {
            for (const entry of [...this.previewCache.values()]) {
                if (entry.dock || entry.element === this.activePreview?.element) continue;
                this.disposeCachedPreview(entry);
            }
        }
        this.lastPreviewChromeSignature = chrome;
        for (const doc of this.handledDocuments) this.applyDisplaySettings(doc);
    }

    private previewChromeSignature(): string {
        const { showOpenInBrowser, showCloseButton, allowResize } = this.settings;
        return `${showOpenInBrowser}|${showCloseButton}|${allowResize}`;
    }

    private applyDisplaySettings(doc: Document) {
        if (!this.settings.showGitHubHoverCard) this.hideGitHubHoverCard(doc);
        doc.body.addClass('url-preview-inline-links');
        doc.body.toggleClass('url-preview-hide-external-link-icon', !this.settings.showInlineExternalLinkIcon);
        doc.body.toggleClass('url-preview-hide-loading-indicators', !this.settings.showLoadingIndicators);
    }

    onunload() {
        this.unloaded = true;
        for (const doc of this.handledDocuments) {
            doc.body.removeClass('url-preview-inline-links', 'url-preview-hide-external-link-icon');
            doc.body.removeClass('url-preview-hide-loading-indicators');
        }
        this.cleanupActivePreview();
        // One preview that fails to tear down must not abort the rest of the unload.
        for (const entry of [...this.previewCache.values()]) {
            try {
                this.disposeCachedPreview(entry);
            } catch {
                entry.cancelRefresh?.();
                entry.controller.cleanupKeyboard?.();
                this.clearCacheExpiry(entry);
                entry.element.remove();
            }
        }
        for (const doc of this.inlinePreviewControls.keys()) {
            this.removeInlinePreviewControls(doc);
        }
        for (const doc of this.githubHoverCards.keys()) {
            this.removeGitHubHoverCard(doc);
        }
        for (const doc of this.githubPullRequestBadgeObservers.keys()) {
            this.unregisterGitHubPullRequestBadges(doc);
        }
    }

    private navigatePreviewFrame(controller: PreviewFrameController, url: string, addToHistory = true) {
        const frame = controller.element;
        controller.currentUrl = url;
        controller.startLoading?.();

        if (this.isPreviewWebview(frame)) {
            if (!frame.isConnected || !controller.isReady) {
                frame.setAttr('src', url);
                return;
            }

            try {
                void frame.loadURL(url).catch(() => undefined);
            } catch {
                frame.setAttr('src', url);
            }
            return;
        }

        if (addToHistory) {
            controller.fallbackHistory = controller.fallbackHistory.slice(0, controller.fallbackHistoryIndex + 1);
            controller.fallbackHistory.push(url);
            controller.fallbackHistoryIndex = controller.fallbackHistory.length - 1;
        }
        frame.setAttr('src', url);
    }

    private getPreviewFrameUrl(controller: PreviewFrameController): string {
        const frame = controller.element;
        if (this.isPreviewWebview(frame)) {
            try {
                return frame.getURL() || controller.currentUrl;
            } catch {
                return controller.currentUrl;
            }
        }

        return controller.currentUrl;
    }

    private getPreviewNavigationEventUrl(event: Event): string | null {
        if ('url' in event && typeof event.url === 'string') return event.url;
        if ('validatedURL' in event && typeof event.validatedURL === 'string') return event.validatedURL;
        return null;
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
            doc.querySelectorAll<HTMLElement>('.hover-popup:not(.is-refreshing)').forEach(el => {
                if (!this.previewCache.has(el)) el.remove();
            });
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
        this.setPreviewSizeData(el, bounds.width, bounds.height);
        
        return el;
    }

    private isGitHubUrl(url: string): boolean {
        try {
            const hostname = new URL(url).hostname.toLowerCase();
            return hostname === 'github.com' || hostname === 'www.github.com';
        } catch {
            return false;
        }
    }


    private getRequireFunction(): ((moduleName: string) => unknown) | null {
        const windowRequire = (window as Window & RequireHost).require;
        if (typeof windowRequire === 'function') return windowRequire;

        const globalRequire = (globalThis as RequireHost).require;
        if (typeof globalRequire === 'function') return globalRequire;

        return null;
    }

    private getElectronSession(): ElectronSession | null {
        if (!Platform.isDesktopApp) return null;

        const requireFn = this.getRequireFunction();
        if (!requireFn) return null;

        try {
            const electron = requireFn('electron') as ElectronModule;
            return electron.session?.defaultSession ?? null;
        } catch {
            return null;
        }
    }


    private async flushPreviewSessionStorage() {
        const electronSession = this.getElectronSession();
        if (!electronSession?.flushStorageData) return;

        try {
            await electronSession.flushStorageData();
        } catch {
            // Session persistence is best-effort on Electron versions without this support.
        }
    }

    private getElectronCookies(): ElectronCookies | null {
        return this.getElectronSession()?.cookies ?? null;
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

    private createButtons(container: HTMLElement, frameController: PreviewFrameController) {
        const buttons = container.createDiv('preview-buttons');
        const win = container.ownerDocument.defaultView ?? window;
        this.createNavigationControls(buttons, container, frameController);

        if (this.settings.allowResize) {
            this.createSizeControls(buttons, container);
        }

        this.createZoomControls(buttons, container, () => this.getPreviewFrameUrl(frameController));


        if (this.settings.allowResize) {
            let restoreBounds: { left: number, top: number, width: number, height: number } | null = null;
            const resizeBtn = buttons.createEl('button', { cls: 'clickable-icon preview-expand-button' });
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

        const dockButton = buttons.createEl('button', { cls: 'clickable-icon preview-dock-button' });
        setIcon(dockButton, 'log-out');
        this.setToolbarTooltip(dockButton, 'Open in right-side panel');
        dockButton.addEventListener('click', event => {
            event.stopPropagation();
            this.dockPreview(container);
        });

        if (this.settings.showOpenInBrowser) {
            const openBtn = buttons.createEl('button', { cls: 'clickable-icon' });
            setIcon(openBtn, 'external-link');
            this.setToolbarTooltip(openBtn, 'Open in external browser');
            openBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                win.open(this.getPreviewFrameUrl(frameController));
            });
        }

        if (this.settings.showCloseButton) {
            const closeBtn = buttons.createEl('button', { cls: 'clickable-icon' });
            setIcon(closeBtn, 'x');
            this.setToolbarTooltip(closeBtn, 'Close preview');
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const entry = this.previewCache.get(container);
                if (entry?.dock) entry.dock.close();
                else this.cleanupActivePreview();
            });
        }
    }

    private createNavigationControls(
        buttons: HTMLElement,
        previewEl: HTMLElement,
        controller: PreviewFrameController
    ) {
        const navigation = buttons.createDiv('preview-navigation');
        const backButton = navigation.createEl('button', {
            cls: 'clickable-icon preview-navigation-back',
        });
        setIcon(backButton, 'arrow-left');
        this.setToolbarTooltip(backButton, 'Back');

        const forwardButton = navigation.createEl('button', {
            cls: 'clickable-icon preview-navigation-forward',
        });
        setIcon(forwardButton, 'arrow-right');
        this.setToolbarTooltip(forwardButton, 'Forward');

        const addressInput = navigation.createEl('input', { cls: 'preview-address-input' });
        addressInput.setAttr('type', 'text');
        addressInput.setAttr('aria-label', 'Preview address');
        addressInput.setAttr('autocomplete', 'off');
        addressInput.setAttr('autocapitalize', 'off');
        addressInput.setAttr('spellcheck', 'false');
        addressInput.value = controller.currentUrl;

        const updateControls = () => this.updatePreviewNavigationControls(previewEl, controller);
        const frame = controller.element;
        if (this.isPreviewWebview(frame)) {
            frame.addEventListener('did-navigate', updateControls);
            frame.addEventListener('did-navigate-in-page', updateControls);
            frame.addEventListener('did-finish-load', updateControls);
        } else {
            frame.addEventListener('load', updateControls);
        }

        backButton.addEventListener('click', (event) => {
            event.stopPropagation();
            this.goBackInPreview(controller);
            updateControls();
        });
        forwardButton.addEventListener('click', (event) => {
            event.stopPropagation();
            this.goForwardInPreview(controller);
            updateControls();
        });
        addressInput.addEventListener('click', (event) => event.stopPropagation());
        addressInput.addEventListener('keydown', (event) => {
            event.stopPropagation();
            if (event.key === 'Escape') {
                addressInput.value = this.getPreviewFrameUrl(controller);
                addressInput.blur();
                return;
            }
            if (event.key !== 'Enter') return;

            const url = this.normalizeNavigationUrl(addressInput.value);
            if (!url) {
                new Notice('Enter a valid web address.');
                return;
            }

            this.navigatePreviewFrame(controller, url);
            previewEl.setAttr('data-preview-url', url);
            addressInput.value = url;
            addressInput.blur();
            updateControls();
        });

        updateControls();
    }

    private updatePreviewNavigationControls(previewEl: HTMLElement, controller: PreviewFrameController) {
        const addressInput = previewEl.querySelector('.preview-address-input');
        if (addressInput instanceof HTMLInputElement && addressInput.ownerDocument.activeElement !== addressInput) {
            addressInput.value = this.getPreviewFrameUrl(controller);
        }

        const backButton = previewEl.querySelector('.preview-navigation-back');
        if (backButton instanceof HTMLButtonElement) {
            backButton.disabled = !this.canGoBackInPreview(controller);
        }
        const forwardButton = previewEl.querySelector('.preview-navigation-forward');
        if (forwardButton instanceof HTMLButtonElement) {
            forwardButton.disabled = !this.canGoForwardInPreview(controller);
        }
    }

    private canGoBackInPreview(controller: PreviewFrameController): boolean {
        const frame = controller.element;
        if (this.isPreviewWebview(frame)) {
            try {
                return frame.canGoToOffset(-1);
            } catch {
                return false;
            }
        }
        return controller.fallbackHistoryIndex > 0;
    }

    private canGoForwardInPreview(controller: PreviewFrameController): boolean {
        const frame = controller.element;
        if (this.isPreviewWebview(frame)) {
            try {
                return frame.canGoToOffset(1);
            } catch {
                return false;
            }
        }
        return controller.fallbackHistoryIndex >= 0 &&
            controller.fallbackHistoryIndex < controller.fallbackHistory.length - 1;
    }

    private goBackInPreview(controller: PreviewFrameController) {
        const frame = controller.element;
        if (this.isPreviewWebview(frame)) {
            if (this.canGoBackInPreview(controller)) frame.goToOffset(-1);
            return;
        }
        if (!this.canGoBackInPreview(controller)) return;

        controller.fallbackHistoryIndex--;
        const url = controller.fallbackHistory[controller.fallbackHistoryIndex];
        if (url) this.navigatePreviewFrame(controller, url, false);
    }

    private goForwardInPreview(controller: PreviewFrameController) {
        const frame = controller.element;
        if (this.isPreviewWebview(frame)) {
            if (this.canGoForwardInPreview(controller)) frame.goToOffset(1);
            return;
        }
        if (!this.canGoForwardInPreview(controller)) return;

        controller.fallbackHistoryIndex++;
        const url = controller.fallbackHistory[controller.fallbackHistoryIndex];
        if (url) this.navigatePreviewFrame(controller, url, false);
    }

    private normalizeNavigationUrl(candidate: string): string | null {
        const normalized = this.normalizeUrl(candidate);
        if (normalized) return normalized;

        const trimmed = candidate.trim();
        if (!/^(?:localhost|(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})(?::\d+)?(?:\/\S*)?$/.test(trimmed)) {
            return null;
        }
        return this.normalizeUrl(`https://${trimmed}`);
    }


    private createSizeControls(buttons: HTMLElement, previewEl: HTMLElement) {
        const sizeControls = buttons.createDiv('preview-size-controls');
        const sizeInput = sizeControls.createEl('input', { cls: 'preview-size-input' });
        sizeInput.setAttr('type', 'text');
        sizeInput.setAttr('aria-label', 'Preview window size');
        sizeInput.setAttr('spellcheck', 'false');

        const pinBtn = sizeControls.createEl('button', { cls: 'clickable-icon preview-size-pin-button' });

        const updateSizeInput = () => {
            sizeInput.value = this.formatPreviewSize(previewEl);
        };
        const updatePinButton = () => {
            const isPinned = this.settings.persistResize;
            setIcon(pinBtn, isPinned ? 'pin' : 'pin-off');
            this.setToolbarTooltip(pinBtn, isPinned ? 'Forget preview size' : 'Remember preview size');
            if (isPinned) {
                pinBtn.addClass('is-active');
            } else {
                pinBtn.removeClass('is-active');
            }
        };
        const applyInputSize = () => {
            const size = this.parsePreviewSize(sizeInput.value);
            if (!size) {
                updateSizeInput();
                return;
            }

            this.resizePreviewTo(previewEl, size.width, size.height);
            this.updatePreviewSizeControls(previewEl, true);
            if (this.settings.persistResize) {
                void this.persistPreviewSize(previewEl);
            }
        };

        updateSizeInput();
        updatePinButton();

        sizeInput.addEventListener('click', (event) => event.stopPropagation());
        sizeInput.addEventListener('change', applyInputSize);
        sizeInput.addEventListener('keydown', (event) => {
            event.stopPropagation();
            if (event.key === 'Enter') {
                applyInputSize();
                sizeInput.blur();
            }
            if (event.key === 'Escape') {
                updateSizeInput();
                sizeInput.blur();
            }
        });

        pinBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            void (async () => {
                if (this.settings.persistResize) {
                    this.settings.persistResize = false;
                    this.settings.persistedWidth = undefined;
                    this.settings.persistedHeight = undefined;
                    await this.saveSettings();
                    updatePinButton();
                    return;
                }

                this.settings.persistResize = true;
                await this.persistPreviewSize(previewEl);
                updatePinButton();
            })();
        });
    }

    private createZoomControls(buttons: HTMLElement, previewEl: HTMLElement, getUrl: () => string) {
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
            zoomInput.value = String(this.getDomainZoomPercent(getUrl()));
        };
        const applyZoom = async (value: number) => {
            const url = getUrl();
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
            void applyZoom(this.getDomainZoomPercent(getUrl()) - 10);
        });

        const zoomInBtn = zoomControls.createEl('button', { cls: 'clickable-icon preview-zoom-button' });
        setIcon(zoomInBtn, 'plus');
        this.setToolbarTooltip(zoomInBtn, 'Zoom in');
        zoomInBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            void applyZoom(this.getDomainZoomPercent(getUrl()) + 10);
        });

        const resetZoomBtn = zoomControls.createEl('button', { cls: 'clickable-icon preview-zoom-button' });
        setIcon(resetZoomBtn, 'rotate-ccw');
        this.setToolbarTooltip(resetZoomBtn, 'Reset zoom');
        resetZoomBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            void (async () => {
                const url = getUrl();
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
        this.setPreviewSizeData(previewEl, bounds.width, bounds.height);
        this.updatePreviewSizeControls(previewEl);
        this.applyPreviewViewportProps(previewEl);
    }

    private setPreviewSizeData(previewEl: HTMLElement, width: number, height: number) {
        previewEl.setAttr('data-preview-width', String(Math.round(width)));
        previewEl.setAttr('data-preview-height', String(Math.round(height)));
    }

    private getPreviewSize(previewEl: HTMLElement): { width: number, height: number } {
        const rect = previewEl.getBoundingClientRect();
        const dataWidth = Number(previewEl.getAttribute('data-preview-width'));
        const dataHeight = Number(previewEl.getAttribute('data-preview-height'));
        const width = rect.width > 0 ? rect.width : dataWidth;
        const height = rect.height > 0 ? rect.height : dataHeight;

        return {
            width: Math.round(Number.isFinite(width) && width > 0
                ? width
                : sanitizePreviewSize(undefined, this.settings.maxPreviewWidth, DEFAULT_SETTINGS.maxPreviewWidth, MIN_PREVIEW_WIDTH)),
            height: Math.round(Number.isFinite(height) && height > 0
                ? height
                : sanitizePreviewSize(undefined, this.settings.maxPreviewHeight, DEFAULT_SETTINGS.maxPreviewHeight, MIN_PREVIEW_HEIGHT)),
        };
    }

    private formatPreviewSize(previewEl: HTMLElement): string {
        const { width, height } = this.getPreviewSize(previewEl);
        return `${width}x${height}`;
    }

    private parsePreviewSize(value: string): { width: number, height: number } | null {
        const match = value.match(/^\s*(\d+)\s*[x\u00d7,]\s*(\d+)\s*$/i);
        if (!match) return null;

        const width = Number(match[1]);
        const height = Number(match[2]);
        if (!Number.isFinite(width) || !Number.isFinite(height)) return null;

        return { width, height };
    }

    private updatePreviewSizeControls(previewEl: HTMLElement, force = false) {
        const input = previewEl.querySelector('.preview-size-input');
        if (!(input instanceof HTMLInputElement)) return;
        if (!force && input.ownerDocument.activeElement === input) return;

        input.value = this.formatPreviewSize(previewEl);
    }

    private resizePreviewTo(previewEl: HTMLElement, width: number, height: number) {
        const doc = previewEl.ownerDocument;
        const win = doc.defaultView ?? window;
        const margin = 5;
        const maxWidth = Math.max(MIN_PREVIEW_WIDTH, win.innerWidth - margin * 2);
        const maxHeight = Math.max(MIN_PREVIEW_HEIGHT, win.innerHeight - margin * 2);
        const targetWidth = Math.min(maxWidth, Math.max(MIN_PREVIEW_WIDTH, Math.round(width)));
        const targetHeight = Math.min(maxHeight, Math.max(MIN_PREVIEW_HEIGHT, Math.round(height)));
        const rect = previewEl.getBoundingClientRect();
        const currentLeft = rect.width > 0 ? rect.left : margin;
        const currentTop = rect.height > 0 ? rect.top : margin;
        const left = Math.max(margin, Math.min(currentLeft, win.innerWidth - targetWidth - margin));
        const top = Math.max(margin, Math.min(currentTop, win.innerHeight - targetHeight - margin));

        this.applyPreviewBounds(previewEl, {
            left,
            top,
            width: targetWidth,
            height: targetHeight,
        });
    }

    private async persistPreviewSize(previewEl: HTMLElement) {
        const { width, height } = this.getPreviewSize(previewEl);
        this.settings.persistedWidth = width;
        this.settings.persistedHeight = height;
        await this.saveSettings();
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

            // Clamp to viewport. Dragging a west or north edge past the window edge must
            // stop the pane growing, not push its opposite edge outwards.
            if (newLeft < margin) {
                if (direction.includes('w')) newWidth -= margin - newLeft;
                newLeft = margin;
            }
            if (newTop < margin) {
                if (direction.includes('n')) newHeight -= margin - newTop;
                newTop = margin;
            }
            if (newLeft + newWidth > win.innerWidth - margin) {
                newWidth = win.innerWidth - margin - newLeft;
            }
            if (newTop + newHeight > win.innerHeight - margin) {
                newHeight = win.innerHeight - margin - newTop;
            }
            newWidth = Math.max(MIN_PREVIEW_WIDTH, newWidth);
            newHeight = Math.max(MIN_PREVIEW_HEIGHT, newHeight);

            previewEl.setCssStyles({
                left: `${newLeft}px`,
                top: `${newTop}px`,
                width: `${newWidth}px`,
                height: `${newHeight}px`,
            });
            this.setPreviewSizeData(previewEl, newWidth, newHeight);
            this.updatePreviewSizeControls(previewEl);
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
                void this.persistPreviewSize(previewEl);
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
        const usePersisted = this.settings.allowResize && this.settings.persistResize;
        const targetWidth = sanitizePreviewSize(
            usePersisted ? this.settings.persistedWidth : undefined,
            this.settings.maxPreviewWidth, DEFAULT_SETTINGS.maxPreviewWidth, MIN_PREVIEW_WIDTH);
        const targetHeight = sanitizePreviewSize(
            usePersisted ? this.settings.persistedHeight : undefined,
            this.settings.maxPreviewHeight, DEFAULT_SETTINGS.maxPreviewHeight, MIN_PREVIEW_HEIGHT);
        const maxWidth = Math.min(targetWidth, Math.max(MIN_PREVIEW_WIDTH, windowSize.width - margin * 2));
        const maxHeight = Math.min(targetHeight, Math.max(MIN_PREVIEW_HEIGHT, windowSize.height - margin * 2));
        
        // Determine if we should show above or below
        const spaceBelow = windowSize.height - rect.bottom - margin;
        const spaceAbove = rect.top - margin;
        const showAbove = spaceBelow < maxHeight && spaceAbove > spaceBelow;

        // Calculate vertical position
        let top = showAbove ? 
            Math.max(margin, rect.top - maxHeight - margin) : 
            Math.min(rect.bottom + margin, windowSize.height - maxHeight - margin);
        top = Math.max(margin, top);

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
            if (this.isRangeInsideCode(editorView, pointLink.start, pointLink.end)) return null;
            return {
                editorView,
                element: linkTarget,
                hoverElement: linkTarget,
                markdownLink: pointLink,
                sourceKey: this.getMarkdownLinkSourceKey(pointLink),
                url: pointLink.url,
            };
        }

        // Matching by display text would let [[Design]] resolve to a same-titled external link.
        // Live Preview wraps a wikilink's text in .cm-underline inside .cm-hmd-internal-link,
        // which carries neither data-href nor .internal-link, so both shapes are checked.
        if (linkTarget.hasAttribute('data-href') ||
            linkTarget.closest('.internal-link, .cm-hmd-internal-link, .cm-hmd-barelink, .cm-link-alias')) return null;

        const textLink = this.getMarkdownLinkByDisplayText(content, linkTarget);
        if (textLink && !this.isRangeInsideCode(editorView, textLink.start, textLink.end)) {
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

        for (const link of this.parseMarkdownLinks(content)) {
            if (link.text.trim() === displayText) {
                return link;
            }
        }

        // A substring match used to be accepted here, which let a wikilink such as [[Design]]
        // resolve to an unrelated [Design docs](…) elsewhere in the note.
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
        const occupiedRanges = [...excludedRanges];
        // ')' stays in the match so that Wikipedia-style URLs keep their closing paren;
        // trimBareUrlPunctuation drops the ones that are sentence punctuation.
        const urlRegex = /(?:https?:\/\/|(?:www\.)?github\.com\/)[^\s<>"']+/gi;
        let match: RegExpExecArray | null;

        while ((match = urlRegex.exec(content)) !== null) {
            const start = match.index;
            const text = this.trimBareUrlPunctuation(match[0]);
            const end = start + text.length;
            if (excludedRanges.some((range) => start >= range.start && end <= range.end)) continue;

            const url = this.normalizeUrl(text);
            if (!url) continue;

            links.push(this.createBareMarkdownUrlLink(start, end, text, url));
            occupiedRanges.push({ start, end });
        }

        const githubReferenceRegex = /(^|[\s([{:;,])([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+#\d+)\b/gm;
        while ((match = githubReferenceRegex.exec(content)) !== null) {
            const prefix = match[1] ?? '';
            const text = match[2];
            if (!text) continue;

            const start = match.index + prefix.length;
            const end = start + text.length;
            if (occupiedRanges.some((range) => start >= range.start && end <= range.end)) continue;

            const url = this.normalizeUrl(text);
            if (!url) continue;

            links.push(this.createBareMarkdownUrlLink(start, end, text, url));
            occupiedRanges.push({ start, end });
        }

        return links.sort((a, b) => a.start - b.start);
    }

    private trimBareUrlPunctuation(candidate: string): string {
        let trimmed = candidate.replace(/[.,;:!?\]}]+$/g, '');

        // Keep parens that the URL itself opened, drop the ones that close surrounding prose.
        while (trimmed.endsWith(')')) {
            let depth = 0;
            for (const char of trimmed) {
                if (char === '(') depth++;
                else if (char === ')') depth--;
            }
            if (depth >= 0) break;
            trimmed = trimmed.slice(0, -1).replace(/[.,;:!?\]}]+$/g, '');
        }

        return trimmed;
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
        // A preview whose element is gone can never come back; clearing it here keeps
        // the link clickable instead of silently matching a preview that no longer exists.
        if (!this.activePreview.element.isConnected) {
            this.cleanupActivePreview();
            return false;
        }
        if (this.activePreview.link !== linkInfo.hoverElement) return false;

        if (this.activePreview.sourceKey || linkInfo.sourceKey) {
            return this.activePreview.sourceKey === linkInfo.sourceKey;
        }

        return true;
    }

    private extractUrlFromElement(element: HTMLElement): string | null {
        // Anchors carry a resolved href, so internal links surface as app:// URLs.
        // Normalizing here keeps Obsidian's own links out of the preview.
        if (element instanceof HTMLAnchorElement) {
            return this.normalizeUrl(element.href);
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
            // An error page has a title of its own; using it would write "Page not found" into the note.
            if (response.status >= 400) throw new Error(`Title request failed with status ${response.status}`);
            return response.text;
        } catch (error) {
            if (!headers.Cookie) throw error instanceof Error ? error : new Error('Title request failed');

            const response = await requestUrl({ url, headers: this.getTitleRequestBaseHeaders(), throw: false });
            if (response.status >= 400) throw new Error(`Title request failed with status ${response.status}`);
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
        const githubReference = trimmed.match(
            /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_.-]+)#(\d+)$/
        );
        const normalizedCandidate = githubReference
            ? `https://github.com/${githubReference[1]}/${githubReference[2]}/issues/${githubReference[3]}`
            : /^(?:www\.)?github\.com(?:\/|$)/i.test(trimmed)
                ? `https://${trimmed}`
                : trimmed;
        if (!/^https?:\/\//i.test(normalizedCandidate)) return null;

        try {
            const url = new URL(normalizedCandidate);
            if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
            if (url.hostname.toLowerCase() === 'www.github.com') {
                url.hostname = 'github.com';
            }
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
        this.icon = 'eye';
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
            .addClass('url-preview-settings-group-no-margin');

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
            .setHeading('Preview window')
            .addClass('url-preview-settings-group-no-margin');

        behaviorGroup.addSetting(setting => {
            setting
                .setName('Sticky popup')
                .setDesc('Keep the preview open until escape or click outside. Inside a desktop preview page, press escape twice quickly to close.')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.stickyPopup)
                    .onChange(async (value) => {
                        this.plugin.settings.stickyPopup = value;
                        await this.plugin.saveSettings();
                    }));
        });

        const inlineGroup = new SettingGroup(containerEl)
            .setHeading('Inline links')
            .addClass('url-preview-settings-group-no-margin');

        inlineGroup.addSetting(setting => {
            setting
                .setName('Show preview button on link hover')
                .setDesc('Show the eye button beside links while hovering')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.showInlinePreviewButton)
                    .onChange(async (value) => {
                        this.plugin.settings.showInlinePreviewButton = value;
                        await this.plugin.saveSettings();
                    }));
        });

        inlineGroup.addSetting(setting => {
            setting
                .setName('Show external-link icon')
                .setDesc('Show Obsidian’s external-link icon beside link text in notes')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.showInlineExternalLinkIcon)
                    .onChange(async (value) => {
                        this.plugin.settings.showInlineExternalLinkIcon = value;
                        await this.plugin.saveSettings();
                    }));
        });

        inlineGroup.addSetting(setting => {
            setting
                .setName('Show GitHub hover cards')
                .setDesc('Show a summary card when hovering GitHub links with the configured modifier keys')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.showGitHubHoverCard)
                    .onChange(async (value) => {
                        this.plugin.settings.showGitHubHoverCard = value;
                        await this.plugin.saveSettings();
                    }));
        });

        behaviorGroup.addSetting(setting => {
            setting
                .setName('Show open in browser button')
                .setDesc('Show the open in browser button in the preview toolbar')
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
                .setName('Show loading indicators')
                .setDesc('Show an initial loading overlay and a small circular indicator during subsequent navigation')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.showLoadingIndicators)
                    .onChange(async (value) => {
                        this.plugin.settings.showLoadingIndicators = value;
                        await this.plugin.saveSettings();
                    }));
        });

        inlineGroup.addSetting(setting => {
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
            .addClass('url-preview-settings-group-no-margin')
            .addSetting(setting => {
                setting
                    .setName('Maximum height')
                    .setDesc('Maximum height of preview window (in px)')
                    .addText(text => text
                        .setPlaceholder('300')
                        .setValue(String(this.plugin.settings.maxPreviewHeight))
                        .onChange(async (value) => {
                            const height = Number(value);
                            if (!value.trim() || !Number.isFinite(height)) return;
                            const clamped = Math.max(MIN_PREVIEW_HEIGHT, Math.round(height));
                            if (String(clamped) !== value) text.setValue(String(clamped));
                            this.plugin.settings.maxPreviewHeight = clamped;
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
                            const width = Number(value);
                            if (!value.trim() || !Number.isFinite(width)) return;
                            const clamped = Math.max(MIN_PREVIEW_WIDTH, Math.round(width));
                            if (String(clamped) !== value) text.setValue(String(clamped));
                            this.plugin.settings.maxPreviewWidth = clamped;
                            this.plugin.settings.persistedWidth = undefined;
                            this.plugin.settings.persistedHeight = undefined;
                            await this.plugin.saveSettings();
                        }));
            });

        const isResizeEnabled = this.plugin.settings.allowResize;

        const resizeGroup = new SettingGroup(containerEl)
            .setHeading('Resize')
            .addClass('url-preview-settings-group-no-margin');

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
                setting.settingEl.addClass('url-preview-setting-disabled');
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
