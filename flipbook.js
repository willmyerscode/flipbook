/**
 * Flipbook Plugin for Squarespace List Sections
 * Transforms list section images into an interactive 3D flipbook
 * Copyright Will-Myers.com
 **/

class WMFlipbook {
  static pluginName = 'flipbook';

  static defaultSettings = {
    showProgressBar: true,
    showPageNumbers: true,
    turnDuration: 0.8,
    singlePageOnMobile: false,
    singlePageMobileMaxWidth: 767,
    startOnSpread: false,
    sectionDescription: false,
    sectionDescriptionTag: 'p'
  };

  static allowedSectionDescriptionTags = new Set([
    'p',
    'span',
    'div',
    'h1',
    'h2',
    'h3',
    'h4'
  ]);

  static emitEvent(type, detail = {}, elem = document) {
    elem.dispatchEvent(new CustomEvent(`wm-${this.pluginName}${type}`, { detail, bubbles: true }));
  }

  constructor(el, settings = {}) {
    this.el = el;
    this.settings = { ...WMFlipbook.defaultSettings, ...settings };
    this.data = null;
    this.sectionTitle = null;
    this.sectionButton = null;
    this.options = null;
    this.styles = null;
    this.originalContainer = null;
    this.pluginName = this.constructor.pluginName;
    this.isBackend = window.top !== window.self;
    this.isSectionTitleEnabled = true;
    this.isSectionButtonEnabled = false;
    this.hiddenElements = [];
    this.builtTitleEl = null;
    this.nativeSectionTitleTypography = null;
    this.sectionButtonEl = null;
    this.pendingSectionButton = null;
    this.sectionButtonRestore = null;
    this.sectionButtonAlignment = null;
    this.sectionButtonSize = null;
    this.spaceAboveSectionButton = null;
    this.listLayout = null;
    this.pages = [];
    this.spreadIndex = 0;
    this.spreadCount = 0;
    this.isAnimating = false;
    this.isDragging = false;
    this.pluginContent = null;
    this.bookEl = null;
    this.pagesLayerEl = null;
    this.stageEl = null;
    this.leftPageEl = null;
    this.rightPageEl = null;
    this.flipperEl = null;
    this.dragZoneEl = null;
    this.progressFillEl = null;
    this.pageNumbersEl = null;
    this.prevBtn = null;
    this.nextBtn = null;
    this.boundHandlers = {};
    this.mobileMediaQuery = null;
    this.imagePreloads = new Map();
    this.init();
  }

  init() {
    WMFlipbook.emitEvent(':beforeInit', { el: this.el }, this.el);
    this.addDataAttribute();
    this.extractData();
    if (!this.pages.length) {
      console.warn(`[${this.pluginName}] No pages found`);
      return;
    }
    this.removeOrHideOriginalListSectionContent();
    this.buildLayout();
    this.setupLayoutModeListener();
    this.syncSinglePageAttribute();
    this.bindEvents();
    this.goToSpread(0, { animate: false });
    this.scheduleAdjacentPreload();
    WMFlipbook.emitEvent(':afterInit', { el: this.el, pages: this.pages.length }, this.el);
  }

  addDataAttribute() {
    this.el.setAttribute('data-wm-plugin', this.pluginName);
    if (this.settings.showProgressBar) {
      this.el.setAttribute('data-wm-show-progress', '');
    }
    if (this.settings.showPageNumbers) {
      this.el.setAttribute('data-wm-show-page-numbers', '');
    }
  }

  getTurnDurationCss() {
    const { turnDuration } = this.settings;
    if (turnDuration == null) return '0.8s';
    return typeof turnDuration === 'number' ? `${turnDuration}s` : String(turnDuration);
  }

  getTurnEasingCss() {
    const direction = this.flipperEl?.dataset.direction;
    const prop = direction === 'backward'
      ? '--flipbook-turn-easing-backward'
      : '--flipbook-turn-easing';
    const fallback = direction === 'backward'
      ? 'cubic-bezier(0.25, 0.1, 0.25, 1)'
      : 'cubic-bezier(0.45, 0.05, 0.25, 1)';
    const val = getComputedStyle(this.el).getPropertyValue(prop).trim();
    return val || fallback;
  }

  static parseImageDimensions(source) {
    if (source == null || source === '') return null;
    const value = String(source).trim();
    const match = value.match(/^(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)/i);
    if (!match) return null;
    const width = parseFloat(match[1]);
    const height = parseFloat(match[2]);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return null;
    }
    return { width, height };
  }

  static getImageAspectRatioCss(image, domDimensions) {
    const fromImage =
      WMFlipbook.parseImageDimensions(image?.originalSize) ||
      WMFlipbook.parseImageDimensions(image?.systemDataVariants?.split(',')[0]);
    const fromDom = WMFlipbook.parseImageDimensions(domDimensions);
    const dims = fromImage || fromDom;
    if (!dims) return null;
    return `${dims.width} / ${dims.height}`;
  }

  extractData() {
    const container = this.el.querySelector('.user-items-list-item-container');
    if (!container || !container.dataset.currentContext) {
      console.error(`[${this.pluginName}] No data-current-context found`);
      return;
    }

    const contextData = JSON.parse(container.dataset.currentContext);
    this.originalContainer = container;
    this.data = contextData.userItems || [];
    this.options = contextData.options || {};
    this.styles = contextData.styles || {};
    this.sectionTitle = contextData.sectionTitle || null;
    this.sectionTitleAlignment = contextData.sectionTitleAlignment || null;
    this.sectionButton = contextData.sectionButton || null;
    this.sectionButtonAlignment = contextData.sectionButtonAlignment || null;
    this.sectionButtonSize = contextData.sectionButtonSize || null;
    this.spaceAboveSectionButton = contextData.spaceAboveSectionButton || null;
    this.isSectionTitleEnabled = contextData.isSectionTitleEnabled !== false;
    this.isSectionButtonEnabled = !!contextData.isSectionButtonEnabled;
    this.listLayout = WMFlipbook.normalizeListLayout(
      contextData.layout || this.detectListLayoutFromDom()
    );
    this.syncListLayoutAttribute();

    const domAlts = this.extractDomAlts();
    const domDimensions = this.extractDomImageDimensions();

    this.pages = this.data
      .filter((item) => item.image && item.image.assetUrl)
      .map((item, index) => ({
        src: item.image.assetUrl,
        alt: domAlts[index] || item.image.title || item.title || '',
        focalX: item.image.mediaFocalPoint?.x ?? 0.5,
        focalY: item.image.mediaFocalPoint?.y ?? 0.5,
        aspectRatio: WMFlipbook.getImageAspectRatioCss(item.image, domDimensions[index])
      }));

    this.spreadCount = this.getSpreadCount(this.pages.length);
  }

  extractDomAlts() {
    if (!this.originalContainer) return [];
    const imgs = this.originalContainer.querySelectorAll(
      '.user-items-list-carousel__slide img, .list-item img, .user-items-list-simple__item img'
    );
    return Array.from(imgs).map((img) => img.getAttribute('alt') || '');
  }

  extractDomImageDimensions() {
    if (!this.originalContainer) return [];
    const imgs = this.originalContainer.querySelectorAll(
      '.user-items-list-carousel__slide img, .list-item img, .user-items-list-simple__item img'
    );
    return Array.from(imgs).map((img) => img.getAttribute('data-image-dimensions') || '');
  }

  static normalizeListLayout(layout) {
    const value = String(layout || 'carousel').toLowerCase();
    if (value.includes('banner')) return 'banner-slideshow';
    if (value.includes('simple')) return 'simple';
    return 'carousel';
  }

  detectListLayoutFromDom() {
    const container = this.originalContainer;
    if (!container) return 'carousel';
    const classList = container.classList;
    if (classList.contains('user-items-list-banner-slideshow')) return 'banner-slideshow';
    if (classList.contains('user-items-list-simple')) return 'simple';
    return 'carousel';
  }

  syncListLayoutAttribute() {
    if (this.listLayout) {
      this.el.setAttribute('data-wm-list-layout', this.listLayout);
    }
  }

  static getSectionButtonStyle(link) {
    if (link?.classList.contains('sqs-button-element--primary')) return 'primary';
    return 'secondary';
  }

  getMobileLayoutMaxWidth() {
    return this.settings.singlePageMobileMaxWidth ?? 767;
  }

  isMobileLayout() {
    return window.matchMedia(`(max-width: ${this.getMobileLayoutMaxWidth()}px)`).matches;
  }

  isSinglePageMode() {
    if (!this.settings.singlePageOnMobile) return false;
    return this.isMobileLayout();
  }

  isMobileSpreadMode() {
    return this.isMobileLayout() && !this.isSinglePageMode();
  }

  setupLayoutModeListener() {
    const maxWidth = this.getMobileLayoutMaxWidth();
    this.mobileMediaQuery = window.matchMedia(`(max-width: ${maxWidth}px)`);
    this.boundHandlers.layoutChange = () => this.handleLayoutChange();
    this.mobileMediaQuery.addEventListener('change', this.boundHandlers.layoutChange);
  }

  syncSinglePageAttribute() {
    this.el.toggleAttribute('data-wm-single-page', this.isSinglePageMode());
  }

  spreadIndexToPageIndex(spreadIndex, singlePage = this.isSinglePageMode()) {
    if (singlePage) return spreadIndex;
    if (this.settings.startOnSpread) return spreadIndex * 2;
    if (spreadIndex <= 0) return 0;
    return 1 + (spreadIndex - 1) * 2;
  }

  pageIndexToSpreadIndex(pageIndex, singlePage = this.isSinglePageMode()) {
    if (singlePage) return pageIndex;
    if (this.settings.startOnSpread) return Math.floor(pageIndex / 2);
    if (pageIndex <= 0) return 0;
    return 1 + Math.floor((pageIndex - 1) / 2);
  }

  handleLayoutChange() {
    if (!this.bookEl || this.isAnimating) return;

    const wasSingle = this.el.hasAttribute('data-wm-single-page');
    const pageIndex = this.spreadIndexToPageIndex(this.spreadIndex, wasSingle);
    this.spreadCount = this.getSpreadCount(this.pages.length);
    const nextSpread = this.pageIndexToSpreadIndex(pageIndex, this.isSinglePageMode());
    this.spreadIndex = Math.max(0, Math.min(nextSpread, this.spreadCount - 1));
    this.syncSinglePageAttribute();
    this.updateSpreadDisplay();
  }

  getSpreadCount(pageCount) {
    if (pageCount <= 0) return 0;
    if (this.isSinglePageMode()) return pageCount;
    if (pageCount === 1) return 1;
    if (this.settings.startOnSpread) return Math.ceil(pageCount / 2);
    return 1 + Math.ceil((pageCount - 1) / 2);
  }

  getSpreadInfo(spreadIndex) {
    const pageCount = this.pages.length;
    if (this.isSinglePageMode()) {
      const right = Math.max(0, Math.min(spreadIndex, pageCount - 1));
      return { isCover: true, left: null, right };
    }
    if (this.settings.startOnSpread) {
      const left = Math.max(0, Math.min(spreadIndex * 2, pageCount - 1));
      const right = left + 1 < pageCount ? left + 1 : null;
      return { isCover: false, left, right };
    }
    if (spreadIndex <= 0) {
      return { isCover: true, left: null, right: 0 };
    }
    const left = 1 + (spreadIndex - 1) * 2;
    const right = left + 1 < pageCount ? left + 1 : null;
    return { isCover: false, left, right };
  }

  hideElement(el) {
    if (!el) return;
    this.hiddenElements.push({ el, display: el.style.display });
    el.style.display = 'none';
  }

  removeOrHideOriginalListSectionContent() {
    const userItemsList = this.el.querySelector('.user-items-list');
    if (!userItemsList) return;

    const container = userItemsList.querySelector('.user-items-list-item-container');
    this.reserveNativeSectionButton(userItemsList);
    this.hideElement(container);

    const nativeTitle = userItemsList.querySelector('.list-section-title');
    if (nativeTitle && !this.isSectionTitleEnabled) {
      this.hideElement(nativeTitle);
    }
  }

  decodeHtml(html) {
    const txt = document.createElement('textarea');
    txt.innerHTML = html;
    return txt.value;
  }

  static sectionDescriptionTagMappings = {
    p1: { tag: 'p', className: 'sqsrte-large' },
    p3: { tag: 'p', className: 'sqsrte-small' }
  };

  static resolveSectionDescriptionTag(tag) {
    const normalized = String(tag || 'p')
      .trim()
      .toLowerCase();
    const mapped = WMFlipbook.sectionDescriptionTagMappings[normalized];
    if (mapped) return mapped;
    return {
      tag: WMFlipbook.allowedSectionDescriptionTags.has(normalized) ? normalized : 'p',
      className: null
    };
  }

  static sectionTitleBlockSelector = 'p, h1, h2, h3, h4, h5, h6';

  getSectionTitleBlocks(root) {
    if (!root) return [];
    const blocks = [...root.querySelectorAll(WMFlipbook.sectionTitleBlockSelector)];
    if (blocks.length <= 1) return blocks;

    const groups = new Map();
    blocks.forEach((block) => {
      const parent = block.parentElement;
      if (!groups.has(parent)) groups.set(parent, []);
      groups.get(parent).push(block);
    });

    let bestGroup = [blocks[0]];
    groups.forEach((group) => {
      if (group.length > bestGroup.length) bestGroup = group;
    });
    return bestGroup.length > 1 ? bestGroup : blocks.slice(0, 1);
  }

  extractTextLinesFromElement(element) {
    const lines = [''];

    const appendText = (text) => {
      const parts = text.replace(/\r\n/g, '\n').split('\n');
      lines[lines.length - 1] += parts[0];
      for (let i = 1; i < parts.length; i += 1) {
        lines.push(parts[i]);
      }
    };

    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        appendText(node.textContent);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.tagName === 'BR') {
        lines.push('');
        return;
      }
      node.childNodes.forEach(walk);
    };

    walk(element);
    return lines.map((line) => line.trim());
  }

  partsFromTitleLines(lines) {
    const trimmed = lines.map((line) => line.trim());
    while (trimmed.length && !trimmed[0]) trimmed.shift();
    while (trimmed.length && !trimmed[trimmed.length - 1]) trimmed.pop();
    if (!trimmed.length) return { title: '', description: '' };
    return {
      title: trimmed[0],
      description: trimmed.slice(1).join('\n').trim()
    };
  }

  parseSectionTitleFromRoot(root) {
    const blocks = this.getSectionTitleBlocks(root);
    if (blocks.length > 1) {
      return {
        title: blocks[0].textContent.trim(),
        description: blocks
          .slice(1)
          .map((block) => block.textContent.trim())
          .filter(Boolean)
          .join('\n')
      };
    }

    const source = blocks[0] || root;
    return this.partsFromTitleLines(this.extractTextLinesFromElement(source));
  }

  parseSectionTitleParts(html) {
    const native = this.getNativeSectionTitle();
    if (native) {
      const fromNative = this.parseSectionTitleFromRoot(native);
      if (fromNative.title || fromNative.description) return fromNative;
    }

    if (!html) return { title: '', description: '' };
    const root = document.createElement('div');
    root.innerHTML = this.decodeHtml(html);
    return this.parseSectionTitleFromRoot(root);
  }

  getNativeSectionTitle() {
    return this.el.querySelector('.user-items-list .list-section-title');
  }

  shouldRebuildSectionTitle() {
    return (
      this.isSectionTitleEnabled &&
      !!this.sectionTitle &&
      !!this.settings.sectionDescription
    );
  }

  getSectionTitleAlignment() {
    const nativeTitle = this.getNativeSectionTitle();
    return (
      nativeTitle?.dataset.sectionTitleAlignment ||
      this.sectionTitleAlignment ||
      'left'
    );
  }

  applySectionTitleAlignment(titleEl) {
    const alignment = this.getSectionTitleAlignment();
    if (alignment) {
      titleEl.setAttribute('data-section-title-alignment', alignment);
    }
  }

  captureNativeSectionTitleTypography() {
    const native = this.getNativeSectionTitle();
    if (!native) {
      this.nativeSectionTitleTypography = null;
      return;
    }

    const blocks = this.getSectionTitleBlocks(native);
    const line =
      blocks[0] || native.querySelector(WMFlipbook.sectionTitleBlockSelector);
    if (!line) {
      this.nativeSectionTitleTypography = null;
      return;
    }

    const styles = getComputedStyle(line);
    this.nativeSectionTitleTypography = {
      fontFamily: styles.fontFamily,
      fontSize: styles.fontSize,
      fontWeight: styles.fontWeight,
      lineHeight: styles.lineHeight,
      letterSpacing: styles.letterSpacing,
      textTransform: styles.textTransform,
      color: styles.color
    };
  }

  applySectionTitleTypography(titleEl) {
    const typo = this.nativeSectionTitleTypography;
    if (!typo || !titleEl) return;
    titleEl.style.fontFamily = typo.fontFamily;
    titleEl.style.fontSize = typo.fontSize;
    titleEl.style.fontWeight = typo.fontWeight;
    titleEl.style.lineHeight = typo.lineHeight;
    titleEl.style.letterSpacing = typo.letterSpacing;
    titleEl.style.textTransform = typo.textTransform;
    titleEl.style.color = typo.color;
  }

  appendSectionTitle(userItemsList) {
    const { title, description } = this.parseSectionTitleParts(this.sectionTitle);
    if ((!title && !description) || !userItemsList) return;

    const titleWrapper = document.createElement('div');
    titleWrapper.className = 'wm-flipbook-section-title';
    if (this.el.id) titleWrapper.id = this.el.id;
    this.applySectionTitleAlignment(titleWrapper);

    const spaceBelow = userItemsList.getAttribute('data-space-below-section-title-value');
    const spaceBelowUnit = userItemsList.getAttribute('data-space-below-section-title-unit');
    if (spaceBelow && spaceBelowUnit) {
      titleWrapper.style.paddingBottom = `${spaceBelow}${spaceBelowUnit}`;
    }

    if (title) {
      const titleEl = document.createElement('p');
      titleEl.className = 'wm-flipbook-section-title__title';
      titleEl.textContent = title;
      this.applySectionTitleTypography(titleEl);
      titleWrapper.appendChild(titleEl);
    }

    if (description) {
      const { tag, className } = WMFlipbook.resolveSectionDescriptionTag(
        this.settings.sectionDescriptionTag
      );
      const descriptionEl = document.createElement(tag);
      descriptionEl.className = 'wm-flipbook-section-title__description';
      if (className) descriptionEl.classList.add(className);
      descriptionEl.style.whiteSpace = 'pre-wrap';
      descriptionEl.textContent = description;
      titleWrapper.appendChild(descriptionEl);
    }

    userItemsList.insertBefore(titleWrapper, userItemsList.firstChild);
    this.builtTitleEl = titleWrapper;
  }

  findNativeSectionButton(userItemsList) {
    if (!userItemsList) return null;
    return (
      this.pendingSectionButton ||
      userItemsList.querySelector('.list-section-button-container')
    );
  }

  getSectionButtonText(userItemsList) {
    const fromContext = this.sectionButton?.buttonText?.trim();
    if (fromContext) return fromContext;
    const link = this.findNativeSectionButton(userItemsList)?.querySelector('a');
    return link?.textContent?.trim() || '';
  }

  isSectionButtonActive(userItemsList) {
    return this.isSectionButtonEnabled && !!this.getSectionButtonText(userItemsList);
  }

  reserveNativeSectionButton(userItemsList) {
    const nativeButton = userItemsList?.querySelector('.list-section-button-container');
    if (nativeButton) this.pendingSectionButton = nativeButton;
  }

  mountSectionButtonParent(userItemsList) {
    return userItemsList;
  }

  getNativeSectionButtonLinkClassName(userItemsList) {
    const link = this.findNativeSectionButton(userItemsList)?.querySelector('a');
    return link?.className || this.getSectionButtonLinkClassName();
  }

  applySectionButtonLink(link, userItemsList) {
    if (!link) return;
    const text = this.getSectionButtonText(userItemsList);
    if (!text) return;
    link.textContent = text;
    if (this.sectionButton?.buttonLink) {
      link.href = this.sectionButton.buttonLink;
    } else if (!link.getAttribute('href')) {
      link.href = '#';
    }
    if (this.sectionButton?.buttonNewWindow) {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    } else {
      link.removeAttribute('target');
      link.removeAttribute('rel');
    }
  }

  applySectionButtonContainerAttrs(container) {
    if (!container) return;
    if (this.sectionButtonAlignment) {
      container.setAttribute('data-section-button-alignment', this.sectionButtonAlignment);
    }
    if (this.sectionButtonSize) {
      container.setAttribute('data-button-size', this.sectionButtonSize);
    }
    const link = container.querySelector('a');
    container.setAttribute(
      'data-wm-section-button-style',
      WMFlipbook.getSectionButtonStyle(link)
    );
    container.setAttribute('data-animation-role', 'button');
  }

  applySectionButtonSpacing(container) {
    if (!container) return;
    const space = this.spaceAboveSectionButton;
    if (space?.value != null && space?.unit && !container.style.marginTop) {
      container.style.marginTop = `${space.value}${space.unit}`;
    }
  }

  getSectionButtonLinkClassName() {
    const size = this.sectionButtonSize || 'medium';
    const sizeClass = size && size !== 'medium' ? ` sqs-block-button-element--${size}` : '';
    return `list-section-button sqs-block-button-element${sizeClass} sqs-button-element--secondary`;
  }

  mountSectionButton(userItemsList) {
    if (!this.isSectionButtonActive(userItemsList)) return;

    const mountParent = this.mountSectionButtonParent(userItemsList);
    if (!mountParent) return;

    const nativeButton = this.findNativeSectionButton(userItemsList);
    if (nativeButton) {
      this.sectionButtonRestore = {
        parent: nativeButton.parentElement,
        next: nativeButton.nextSibling
      };
      this.sectionButtonEl = nativeButton;
      nativeButton.style.removeProperty('display');
      nativeButton.style.removeProperty('opacity');
      nativeButton.style.removeProperty('visibility');
      this.applySectionButtonLink(nativeButton.querySelector('a'), userItemsList);
      this.applySectionButtonContainerAttrs(nativeButton);
      this.applySectionButtonSpacing(nativeButton);
      mountParent.appendChild(nativeButton);
      this.pendingSectionButton = null;
      return;
    }

    const buttonWrapper = document.createElement('div');
    buttonWrapper.className = 'list-section-button-container';
    this.applySectionButtonContainerAttrs(buttonWrapper);

    this.applySectionButtonSpacing(buttonWrapper);

    const buttonLink = document.createElement('a');
    buttonLink.className = this.getNativeSectionButtonLinkClassName(userItemsList);
    this.applySectionButtonLink(buttonLink, userItemsList);
    buttonWrapper.appendChild(buttonLink);
    this.sectionButtonEl = buttonWrapper;
    mountParent.appendChild(buttonWrapper);
  }

  restoreSectionButton() {
    if (!this.sectionButtonEl || !this.sectionButtonRestore) return;
    const { parent, next } = this.sectionButtonRestore;
    if (next && next.parentNode === parent) {
      parent.insertBefore(this.sectionButtonEl, next);
    } else {
      parent.appendChild(this.sectionButtonEl);
    }
    this.sectionButtonEl = null;
    this.sectionButtonRestore = null;
    this.pendingSectionButton = null;
  }

  getPageImageUrl(page) {
    return `${page.src}?format=1500w`;
  }

  preloadPageByIndex(pageIndex) {
    if (pageIndex == null || pageIndex < 0 || pageIndex >= this.pages.length) {
      return Promise.resolve(null);
    }
    if (this.imagePreloads.has(pageIndex)) {
      return this.imagePreloads.get(pageIndex);
    }

    const page = this.pages[pageIndex];
    const promise = new Promise((resolve) => {
      const img = new Image();
      const finish = () => resolve(img);
      img.addEventListener('load', finish, { once: true });
      img.addEventListener('error', finish, { once: true });
      img.src = this.getPageImageUrl(page);
      if (img.complete) finish();
    });

    this.imagePreloads.set(pageIndex, promise);
    return promise;
  }

  preloadPageIndices(indices) {
    const unique = [...new Set(indices.filter((index) => index != null && index >= 0))];
    return Promise.all(unique.map((index) => this.preloadPageByIndex(index)));
  }

  getSpreadPageIndices(spreadIndex) {
    const info = this.getSpreadInfo(spreadIndex);
    const indices = [];
    if (info.left != null) indices.push(info.left);
    if (info.right != null) indices.push(info.right);
    return indices;
  }

  getTurnPageIndices(fromSpread, toSpread, direction) {
    const fromInfo = this.getSpreadInfo(fromSpread);
    const toInfo = this.getSpreadInfo(toSpread);
    const indices = new Set([
      ...this.getSpreadPageIndices(fromSpread),
      ...this.getSpreadPageIndices(toSpread)
    ]);

    if (direction === 'forward') {
      const faces = this.getForwardFlipFaces(fromInfo, toInfo);
      if (faces.front != null) indices.add(faces.front);
      if (faces.back != null) indices.add(faces.back);
      const underIndex = this.getRightUnderlayIndex(fromInfo, toInfo);
      if (underIndex != null) indices.add(underIndex);
      if (fromInfo.left != null) indices.add(fromInfo.left);
    } else {
      const faces = this.getBackwardFlipFaces(fromInfo, toInfo);
      if (faces.front != null) indices.add(faces.front);
      if (faces.back != null) indices.add(faces.back);
      const underIndex = this.getLeftUnderlayIndex(fromInfo, toInfo);
      if (underIndex != null) indices.add(underIndex);
      if (fromInfo.right != null) indices.add(fromInfo.right);
    }

    return [...indices];
  }

  scheduleAdjacentPreload() {
    const indices = new Set(this.getSpreadPageIndices(this.spreadIndex));

    if (this.spreadIndex > 0) {
      this.getSpreadPageIndices(this.spreadIndex - 1).forEach((index) => indices.add(index));
      this.getTurnPageIndices(this.spreadIndex, this.spreadIndex - 1, 'backward')
        .forEach((index) => indices.add(index));
    }

    if (this.spreadIndex < this.spreadCount - 1) {
      this.getSpreadPageIndices(this.spreadIndex + 1).forEach((index) => indices.add(index));
      this.getTurnPageIndices(this.spreadIndex, this.spreadIndex + 1, 'forward')
        .forEach((index) => indices.add(index));
    }

    this.preloadPageIndices([...indices]);
  }

  buildPageImage(page, className, { pageIndex = null, eager = false } = {}) {
    const el = document.createElement('div');
    el.className = className;
    const innerEl = document.createElement('div');
    innerEl.className = 'wm-flipbook-page__inner';
    const img = document.createElement('img');
    img.src = this.getPageImageUrl(page);
    img.alt = page.alt;
    img.loading = eager ? 'eager' : 'lazy';
    img.draggable = false;
    img.style.objectPosition = `${page.focalX * 100}% ${page.focalY * 100}%`;

    const markReady = () => img.classList.add('is-ready');
    if (img.complete && img.naturalWidth > 0) {
      markReady();
    } else {
      img.addEventListener('load', markReady, { once: true });
      img.addEventListener('error', markReady, { once: true });
    }

    if (pageIndex != null) {
      this.preloadPageByIndex(pageIndex);
    }

    innerEl.appendChild(img);
    el.appendChild(innerEl);
    const shade = document.createElement('div');
    shade.className = 'wm-flipbook-page__shade';
    el.appendChild(shade);
    return el;
  }


  buildArrowButton(direction) {
    const isPrev = direction === 'prev';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `wm-flipbook-arrow wm-flipbook-arrow--${direction}`;
    btn.setAttribute('aria-label', isPrev ? 'Previous page' : 'Next page');
    btn.innerHTML = `
      <div class="wm-flipbook-arrow-bg"></div>
      <svg viewBox="0 0 44 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        ${isPrev
          ? '<path d="M9.90649 16.96L2.1221 9.17556L9.9065 1.39116"></path><path d="M42.8633 9.18125L3.37868 9.18125"></path>'
          : '<path d="M34.1477 1.39111L41.9321 9.17551L34.1477 16.9599"></path><path d="M1.19088 9.16982H40.6755"></path>'}
      </svg>`;
    return btn;
  }

  buildLayout() {
    const userItemsList = this.el.querySelector('.user-items-list');
    if (!userItemsList || !userItemsList.parentElement) return;

    this.pluginContent = document.createElement('div');
    this.pluginContent.className = 'wm-plugin-content wm-flipbook-content';

    const rebuildSectionTitle = this.shouldRebuildSectionTitle();
    if (rebuildSectionTitle) {
      this.captureNativeSectionTitleTypography();
    }
    const nativeTitle = this.getNativeSectionTitle();
    if (nativeTitle && rebuildSectionTitle) {
      this.hideElement(nativeTitle);
    }
    if (rebuildSectionTitle) {
      this.appendSectionTitle(userItemsList);
    }

    const viewport = document.createElement('div');
    viewport.className = 'wm-flipbook-viewport';
    this.viewportEl = viewport;

    this.prevBtn = this.buildArrowButton('prev');
    this.nextBtn = this.buildArrowButton('next');

    const bookWrap = document.createElement('div');
    bookWrap.className = 'wm-flipbook-book-wrap';
    this.bookWrapEl = bookWrap;

    this.stageEl = document.createElement('div');
    this.stageEl.className = 'wm-flipbook-stage';
    this.stageEl.setAttribute('tabindex', '0');
    this.stageEl.setAttribute('role', 'region');
    this.stageEl.setAttribute('aria-label', 'Flipbook');

    this.bookEl = document.createElement('div');
    this.bookEl.className = 'wm-flipbook-book';

    const spineEl = document.createElement('div');
    spineEl.className = 'wm-flipbook-spine';

    const pagesLayer = document.createElement('div');
    pagesLayer.className = 'wm-flipbook-pages';
    this.pagesLayerEl = pagesLayer;

    this.leftPageEl = document.createElement('div');
    this.leftPageEl.className = 'wm-flipbook-page wm-flipbook-page--left';

    this.rightPageEl = document.createElement('div');
    this.rightPageEl.className = 'wm-flipbook-page wm-flipbook-page--right';

    const flipper = document.createElement('div');
    flipper.className = 'wm-flipbook-flipper';
    this.flipperEl = flipper;

    const flipperFront = document.createElement('div');
    flipperFront.className = 'wm-flipbook-flipper__face wm-flipbook-flipper__face--front';
    const flipperBack = document.createElement('div');
    flipperBack.className = 'wm-flipbook-flipper__face wm-flipbook-flipper__face--back';

    flipper.appendChild(flipperFront);
    flipper.appendChild(flipperBack);
    pagesLayer.appendChild(this.leftPageEl);
    pagesLayer.appendChild(this.rightPageEl);
    pagesLayer.appendChild(flipper);

    this.bookEl.appendChild(spineEl);
    this.bookEl.appendChild(pagesLayer);
    this.stageEl.appendChild(this.bookEl);
    bookWrap.appendChild(this.stageEl);

    const dragZone = document.createElement('div');
    dragZone.className = 'wm-flipbook-drag-zone';
    dragZone.setAttribute('aria-hidden', 'true');
    bookWrap.appendChild(dragZone);
    this.dragZoneEl = dragZone;

    viewport.appendChild(this.prevBtn);
    viewport.appendChild(bookWrap);
    viewport.appendChild(this.nextBtn);

    this.pluginContent.appendChild(viewport);

    if (this.settings.showProgressBar) {
      const progress = document.createElement('div');
      progress.className = 'wm-flipbook-progress';
      progress.setAttribute('role', 'progressbar');
      progress.setAttribute('aria-valuemin', '0');
      progress.setAttribute('aria-valuemax', '100');
      const track = document.createElement('div');
      track.className = 'wm-flipbook-progress__track';
      this.progressFillEl = document.createElement('div');
      this.progressFillEl.className = 'wm-flipbook-progress__fill';
      track.appendChild(this.progressFillEl);
      progress.appendChild(track);
      this.pluginContent.appendChild(progress);
    }

    if (this.settings.showPageNumbers) {
      this.pageNumbersEl = document.createElement('p');
      this.pageNumbersEl.className = 'wm-flipbook-page-numbers';
      this.pluginContent.appendChild(this.pageNumbersEl);
    }

    this.mountSectionButton(userItemsList);

    const listContainer = userItemsList.querySelector('.user-items-list-item-container');
    if (listContainer) {
      listContainer.insertAdjacentElement('afterend', this.pluginContent);
    } else {
      userItemsList.appendChild(this.pluginContent);
    }
  }

  applyPageAspectRatio(container, pageIndex) {
    const ratio = pageIndex != null ? this.pages[pageIndex]?.aspectRatio : null;
    if (ratio) {
      container.style.aspectRatio = ratio;
    } else {
      container.style.removeProperty('aspect-ratio');
    }
  }

  renderPageContent(container, pageIndex, side) {
    container.innerHTML = '';
    if (pageIndex == null || !this.pages[pageIndex]) {
      container.classList.add('wm-flipbook-page--blank');
      container.setAttribute('data-blank', '');
      this.applyPageAspectRatio(container, null);
      return;
    }
    container.classList.remove('wm-flipbook-page--blank');
    container.removeAttribute('data-blank');
    this.applyPageAspectRatio(container, pageIndex);
    container.appendChild(this.buildPageImage(this.pages[pageIndex], 'wm-flipbook-page__surface', {
      pageIndex,
      eager: true
    }));
    container.dataset.pageIndex = String(pageIndex);
    container.dataset.side = side;
  }

  renderFlipper(frontIndex, backIndex) {
    const frontFace = this.flipperEl.querySelector('.wm-flipbook-flipper__face--front');
    const backFace = this.flipperEl.querySelector('.wm-flipbook-flipper__face--back');
    frontFace.innerHTML = '';
    backFace.innerHTML = '';
    if (frontIndex != null && this.pages[frontIndex]) {
      frontFace.appendChild(this.buildPageImage(this.pages[frontIndex], 'wm-flipbook-page__surface', {
        pageIndex: frontIndex,
        eager: true
      }));
    }
    if (backIndex != null && this.pages[backIndex]) {
      backFace.appendChild(this.buildPageImage(this.pages[backIndex], 'wm-flipbook-page__surface', {
        pageIndex: backIndex,
        eager: true
      }));
    }
  }

  getTurningPageIndex(fromInfo) {
    return fromInfo.isCover ? fromInfo.right : fromInfo.right;
  }

  getFlipperBackIndex(fromInfo) {
    const turningIndex = this.getTurningPageIndex(fromInfo);
    if (turningIndex == null) return null;
    const backIndex = turningIndex + 1;
    return backIndex < this.pages.length ? backIndex : null;
  }

  getRightUnderlayIndex(fromInfo, toInfo) {
    if (toInfo?.right != null) return toInfo.right;
    const turningIndex = this.getTurningPageIndex(fromInfo);
    if (turningIndex == null) return null;
    const underIndex = turningIndex + 2;
    return underIndex < this.pages.length ? underIndex : null;
  }

  getLeftUnderlayIndex(fromInfo, toInfo) {
    if (toInfo?.isCover) return null;
    if (toInfo?.left != null) return toInfo.left;
    const turningIndex = fromInfo.isCover ? fromInfo.right : fromInfo.left;
    if (turningIndex == null) return null;
    const underIndex = turningIndex - 2;
    return underIndex >= 0 ? underIndex : null;
  }

  getForwardFlipFaces(fromInfo, toInfo) {
    const front = this.getTurningPageIndex(fromInfo);
    const back = this.getFlipperBackIndex(fromInfo);
    return { front, back };
  }

  getBackwardFlipFaces(fromInfo, toInfo) {
    const front = fromInfo.isCover ? fromInfo.right : fromInfo.left;
    const back = toInfo.isCover ? toInfo.right : (toInfo.right ?? toInfo.left);
    return { front, back };
  }

  applyTurnCoverLayout(direction, fromInfo) {
    if (direction === 'forward' && fromInfo?.isCover && this.spreadIndex === 0 && !this.isSinglePageMode()) {
      this.bookEl.dataset.cover = 'false';
    }
  }

  renderTurnUnderlayPages(direction, toInfo, fromInfo) {
    if (direction === 'forward') {
      const underIndex = this.getRightUnderlayIndex(fromInfo, toInfo);
      if (toInfo.isCover) {
        this.renderPageContent(this.leftPageEl, null, 'left');
        this.renderPageContent(this.rightPageEl, underIndex, 'right');
        return;
      }
      this.renderPageContent(this.leftPageEl, fromInfo.left, 'left');
      this.renderPageContent(this.rightPageEl, underIndex, 'right');
      return;
    }

    const leftUnderIndex = this.getLeftUnderlayIndex(fromInfo, toInfo);
    if (toInfo.isCover) {
      this.renderPageContent(this.leftPageEl, leftUnderIndex, 'left');
      this.renderPageContent(this.rightPageEl, fromInfo.right, 'right');
      return;
    }

    this.renderPageContent(this.leftPageEl, leftUnderIndex, 'left');
    this.renderPageContent(this.rightPageEl, fromInfo.right, 'right');
  }

  clearTurnLayoutHeight() {
    if (this.pagesLayerEl) this.pagesLayerEl.style.minHeight = '';
    if (this.stageEl) this.stageEl.style.minHeight = '';
    if (this.bookWrapEl) this.bookWrapEl.style.minHeight = '';
    if (this.viewportEl) this.viewportEl.style.minHeight = '';
    if (this.flipperEl) {
      this.flipperEl.style.height = '';
      this.flipperEl.style.top = '';
    }
  }

  applyTurnLayoutForMeasure(direction, toInfo, fromInfo) {
    this.applyTurnCoverLayout(direction, fromInfo);
    this.renderTurnUnderlayPages(direction, toInfo, fromInfo);
  }

  restoreSpreadLayoutAfterMeasure(savedCover, savedIndex) {
    if (this.bookEl) this.bookEl.dataset.cover = savedCover;
    this.goToSpread(savedIndex, { animate: false });
  }

  measureTurnLayoutHeight(direction, toInfo, fromInfo) {
    const book = this.bookEl;
    const pages = this.pagesLayerEl;
    if (!book || !pages) return 0;

    const savedCover = book.dataset.cover;
    const savedIndex = this.spreadIndex;
    this.applyTurnLayoutForMeasure(direction, toInfo, fromInfo);
    const height = pages.offsetHeight;
    this.restoreSpreadLayoutAfterMeasure(savedCover, savedIndex);
    return height;
  }

  measureViewportHeightForTurn(direction, toInfo, fromInfo) {
    if (!this.viewportEl) return 0;

    const savedCover = this.bookEl?.dataset.cover;
    const savedIndex = this.spreadIndex;
    this.applyTurnLayoutForMeasure(direction, toInfo, fromInfo);
    const height = this.viewportEl.offsetHeight;
    this.restoreSpreadLayoutAfterMeasure(savedCover, savedIndex);
    return height;
  }

  getFlipperAnchorPageEl(direction, fromInfo) {
    if (direction === 'backward') {
      return fromInfo?.isCover ? this.rightPageEl : this.leftPageEl;
    }
    return this.rightPageEl;
  }

  positionFlipperToPage(direction, fromInfo) {
    if (!this.isMobileSpreadMode()) {
      this.flipperEl.style.height = '';
      this.flipperEl.style.top = '';
      return;
    }

    const pageEl = this.getFlipperAnchorPageEl(direction, fromInfo);
    if (!pageEl) return;

    this.flipperEl.style.height = `${pageEl.offsetHeight}px`;
    this.flipperEl.style.top = `${pageEl.offsetTop}px`;
  }

  lockTurnLayoutHeight(direction, toInfo, fromInfo) {
    if (!this.isMobileSpreadMode()) {
      const pages = this.pagesLayerEl;
      if (!pages) return;

      const heightBefore = pages.offsetHeight;
      const heightTarget = this.measureTurnLayoutHeight(direction, toInfo, fromInfo);
      const lockedHeight = Math.max(heightBefore, heightTarget);

      if (lockedHeight > 0) {
        pages.style.minHeight = `${lockedHeight}px`;
      }

      if (this.stageEl) {
        const stageHeight = this.stageEl.offsetHeight;
        if (stageHeight > 0) {
          this.stageEl.style.minHeight = `${stageHeight}px`;
        }
      }

      if (this.viewportEl) {
        const viewportBefore = this.viewportEl.offsetHeight;
        const viewportTarget = this.measureViewportHeightForTurn(direction, toInfo, fromInfo);
        const lockedViewport = Math.max(viewportBefore, viewportTarget);
        if (lockedViewport > 0) {
          this.viewportEl.style.minHeight = `${lockedViewport}px`;
        }
      }

      if (this.bookWrapEl) {
        const wrapBefore = this.bookWrapEl.offsetHeight;
        const savedCover = this.bookEl?.dataset.cover;
        const savedIndex = this.spreadIndex;
        this.applyTurnLayoutForMeasure(direction, toInfo, fromInfo);
        const wrapTarget = this.bookWrapEl.offsetHeight;
        this.restoreSpreadLayoutAfterMeasure(savedCover, savedIndex);
        const lockedWrap = Math.max(wrapBefore, wrapTarget);
        if (lockedWrap > 0) {
          this.bookWrapEl.style.minHeight = `${lockedWrap}px`;
        }
      }
      return;
    }

    if (!this.viewportEl) return;

    const heightBefore = this.viewportEl.offsetHeight;
    const heightTarget = this.measureViewportHeightForTurn(direction, toInfo, fromInfo);
    const lockedHeight = Math.max(heightBefore, heightTarget);

    if (lockedHeight > 0) {
      this.viewportEl.style.minHeight = `${lockedHeight}px`;
    }
  }

  prepareTurnUnderlay(direction, toInfo, fromInfo) {
    this.applyTurnCoverLayout(direction, fromInfo);
    this.renderTurnUnderlayPages(direction, toInfo, fromInfo);
  }

  setFlipperFaceRadius(direction, fromInfo, toInfo) {
    if (!this.flipperEl) return;

    if (this.isSinglePageMode()) {
      this.flipperEl.dataset.flipFront = 'single';
      this.flipperEl.dataset.flipBack = 'single';
      return;
    }

    let frontVisible;
    let backVisible;

    if (direction === 'forward') {
      frontVisible = fromInfo?.isCover ? 'single' : 'spread-right';
      backVisible = 'spread-left';
    } else {
      frontVisible = 'spread-left';
      backVisible = toInfo?.isCover ? 'single' : 'spread-right';
    }

    this.flipperEl.dataset.flipFront = frontVisible;
    this.flipperEl.dataset.flipBack = backVisible;
  }

  setFlipperPose(angle, origin) {
    this.flipperEl.dataset.origin = origin;
    this.flipperEl.style.transformOrigin = origin === 'left' ? 'left center' : 'right center';
    this.flipperEl.style.transform = `rotateY(${angle}deg)`;
  }

  runFlipTransition(startAngle, endAngle, origin) {
    this.setFlipperPose(startAngle, origin);
    this.flipperEl.style.transition = 'none';
    this.flipperEl.classList.remove('is-flipping', 'is-dragging');

    void this.flipperEl.offsetWidth;

    this.flipperEl.classList.add('is-flipping');
    this.flipperEl.style.transition = `transform ${this.getTurnDurationCss()} ${this.getTurnEasingCss()}`;

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this.flipperEl.style.transform = `rotateY(${endAngle}deg)`;
      });
    });
  }

  completeDragTurn(targetSpread, direction, currentAngle) {
    if (this.isAnimating) return;

    this.isAnimating = true;

    const endAngle = direction === 'forward' ? -180 : 180;
    const flipOrigin = direction === 'forward' ? 'left' : 'right';
    const startFraction = direction === 'forward'
      ? Math.min(1, Math.abs(currentAngle) / 180)
      : Math.min(1, Math.max(0, currentAngle) / 180);

    const surfaces = [
      ...this.flipperEl.querySelectorAll('.wm-flipbook-page__surface'),
      this.leftPageEl?.querySelector(':scope > .wm-flipbook-page__surface'),
      this.rightPageEl?.querySelector(':scope > .wm-flipbook-page__surface')
    ].filter(Boolean);

    Promise.all(surfaces.map((surface) => this.preloadPageImage(surface)))
      .then(() => {
        this.animateProgressToSpread(targetSpread, {
          fromSpread: this.spreadIndex,
          startFraction,
          direction
        });
        this.runFlipTransition(currentAngle, endAngle, flipOrigin);

        const duration = this.getTurnDurationMs();
        let completed = false;

        const onEnd = (evt) => {
          if (completed) return;
          if (evt && evt.propertyName && evt.propertyName !== 'transform') return;
          completed = true;

          this.flipperEl.removeEventListener('transitionend', onEnd);
          this.spreadIndex = targetSpread;
          this.flipperEl.classList.remove('is-flipping', 'is-dragging');
          this.flipperEl.style.transform = '';
          this.flipperEl.style.transformOrigin = '';
          this.flipperEl.style.transition = '';
          this.bookEl.classList.remove('is-turning', 'is-drag-active');
          delete this.bookEl.dataset.turn;
          this.clearTurnLayoutHeight();
          this.isAnimating = false;
          this.updateSpreadDisplay();
          WMFlipbook.emitEvent(':pageTurn', {
            spreadIndex: this.spreadIndex,
            direction,
            el: this.el
          }, this.el);
        };

        this.flipperEl.addEventListener('transitionend', onEnd);
        setTimeout(() => onEnd(), duration + 80);
      })
      .catch(() => {
        this.isAnimating = false;
        this.goToSpread(targetSpread, { animate: false, direction });
      });
  }

  updateSpreadDisplay() {
    this.syncSinglePageAttribute();
    const info = this.getSpreadInfo(this.spreadIndex);
    this.bookEl.dataset.cover = info.isCover ? 'true' : 'false';
    this.bookEl.dataset.spread = String(this.spreadIndex);

    if (info.isCover) {
      this.renderPageContent(this.leftPageEl, null, 'left');
      this.renderPageContent(this.rightPageEl, info.right, 'right');
    } else {
      this.renderPageContent(this.leftPageEl, info.left, 'left');
      this.renderPageContent(this.rightPageEl, info.right, 'right');
    }

    this.updateProgress();
    this.updatePageNumbers();
    this.updateArrowStates();
    this.updateDragZone();
    this.scheduleAdjacentPreload();
  }

  getProgressPageIndex(spreadIndex) {
    const info = this.getSpreadInfo(spreadIndex);
    if (info.right != null) return info.right;
    if (info.left != null) return info.left;
    return 0;
  }

  getProgressPercent(spreadIndex, turnFraction = 0, direction = 'forward') {
    const pageCount = this.pages.length;
    if (pageCount <= 1) return 100;
    const max = pageCount - 1;
    const current = this.getProgressPageIndex(spreadIndex);
    if (turnFraction <= 0) return (current / max) * 100;

    const offset = direction === 'forward' ? 1 : -1;
    const targetSpread = Math.max(0, Math.min(this.spreadCount - 1, spreadIndex + offset));
    const target = this.getProgressPageIndex(targetSpread);
    const effective = Math.max(0, Math.min(max, current + (target - current) * turnFraction));
    return (effective / max) * 100;
  }

  updateProgress({ spreadIndex = this.spreadIndex, turnFraction = 0, direction = 'forward', animate = true } = {}) {
    if (!this.progressFillEl) return;
    const progress = this.getProgressPercent(spreadIndex, turnFraction, direction);
    this.progressFillEl.style.width = `${progress}%`;
    this.progressFillEl.style.transition = animate
      ? `width ${this.getTurnDurationCss()} ${this.getTurnEasingCss()}`
      : 'none';
    const progressBar = this.progressFillEl.closest('[role="progressbar"]');
    if (progressBar) {
      progressBar.setAttribute('aria-valuenow', String(Math.round(progress)));
    }
  }

  syncProgressToFlipAngle(angle, direction) {
    const fraction = Math.min(1, Math.max(0, Math.abs(angle) / 180));
    this.updateProgress({
      spreadIndex: this.spreadIndex,
      turnFraction: fraction,
      direction,
      animate: false
    });
  }

  animateProgressToSpread(targetSpread, { fromSpread, startFraction = 0, direction = 'forward' } = {}) {
    const from = fromSpread ?? this.spreadIndex;
    this.updateProgress({ spreadIndex: from, turnFraction: startFraction, direction, animate: false });
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this.updateProgress({ spreadIndex: targetSpread, turnFraction: 0, direction, animate: true });
      });
    });
  }

  updatePageNumbers() {
    if (!this.pageNumbersEl) return;
    const info = this.getSpreadInfo(this.spreadIndex);

    if (info.isCover || this.isSinglePageMode()) {
      this.pageNumbersEl.textContent = String((info.right ?? 0) + 1);
      return;
    }

    const leftNum = (info.left ?? 0) + 1;
    const rightNum = info.right != null ? info.right + 1 : null;
    if (rightNum != null && rightNum !== leftNum) {
      this.pageNumbersEl.textContent = `${leftNum} - ${rightNum}`;
    } else {
      this.pageNumbersEl.textContent = String(leftNum);
    }
  }

  updateArrowStates() {
    const atStart = this.spreadIndex <= 0;
    const atEnd = this.spreadIndex >= this.spreadCount - 1;
    if (this.prevBtn) {
      this.prevBtn.classList.toggle('wm-flipbook-arrow--disabled', atStart);
      this.prevBtn.disabled = atStart;
    }
    if (this.nextBtn) {
      this.nextBtn.classList.toggle('wm-flipbook-arrow--disabled', atEnd);
      this.nextBtn.disabled = atEnd;
    }
  }

  updateDragZone() {
    if (!this.dragZoneEl) return;
    const atStart = this.spreadIndex <= 0;
    const atEnd = this.spreadIndex >= this.spreadCount - 1;
    if (!atStart && !atEnd) {
      this.dragZoneEl.dataset.edge = 'both';
    } else if (atStart) {
      this.dragZoneEl.dataset.edge = 'right';
    } else if (atEnd) {
      this.dragZoneEl.dataset.edge = 'left';
    }
  }

  resetFlipperState() {
    this.flipperEl.classList.remove('is-flipping', 'is-dragging');
    this.flipperEl.style.transform = '';
    this.flipperEl.style.transition = '';
    this.flipperEl.style.transformOrigin = '';
    this.flipperEl.dataset.direction = '';
    delete this.flipperEl.dataset.flipFront;
    delete this.flipperEl.dataset.flipBack;
    this.bookEl?.classList.remove('is-turning', 'is-drag-active');
    if (this.bookEl) delete this.bookEl.dataset.turn;
    this.clearTurnLayoutHeight();
    this.isAnimating = false;
  }

  goToSpread(index, { animate = false, direction = 'forward' } = {}) {
    const target = Math.max(0, Math.min(index, this.spreadCount - 1));
    const useFlipAnimation = animate && !this.isSinglePageMode();

    if (!useFlipAnimation) {
      const from = this.spreadIndex;
      const actualDirection = direction || (target > from ? 'forward' : 'backward');
      const changed = target !== from;

      if (changed && animate && this.isSinglePageMode()) {
        return this.animatePageFade(target, actualDirection);
      }

      this.spreadIndex = target;
      this.resetFlipperState();
      this.updateProgress();
      this.updateSpreadDisplay();

      if (changed) {
        WMFlipbook.emitEvent(':pageTurn', {
          spreadIndex: this.spreadIndex,
          direction: actualDirection,
          el: this.el
        }, this.el);
      }

      return Promise.resolve();
    }

    return this.animateTurn(target, direction);
  }

  getFadeDurationMs() {
    const root = getComputedStyle(this.el);
    const val = root.getPropertyValue('--flipbook-fade-duration').trim();
    if (!val) return 400;
    if (val.endsWith('ms')) return parseFloat(val);
    if (val.endsWith('s')) return parseFloat(val) * 1000;
    return 400;
  }

  waitForOpacityTransition(el, durationMs) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (e) => {
        if (done) return;
        if (e && e.target !== el) return;
        if (e && e.propertyName && e.propertyName !== 'opacity') return;
        done = true;
        el.removeEventListener('transitionend', finish);
        resolve();
      };
      el.addEventListener('transitionend', finish);
      setTimeout(finish, durationMs + 80);
    });
  }

  preloadPageImage(surface) {
    const img = surface?.querySelector('img');
    if (!img) return Promise.resolve();
    if (img.complete && img.naturalWidth > 0) {
      if (typeof img.decode === 'function') {
        return img.decode().catch(() => {});
      }
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const onReady = () => {
        if (typeof img.decode === 'function') {
          img.decode().catch(() => {}).finally(resolve);
          return;
        }
        resolve();
      };
      img.addEventListener('load', onReady, { once: true });
      img.addEventListener('error', onReady, { once: true });
    });
  }

  finishPageCrossfade(pageEl, outgoing, incoming, targetSpread) {
    outgoing?.remove();
    incoming?.classList.remove('wm-flipbook-page__surface--incoming');
    pageEl.classList.remove('is-crossfading', 'is-crossfade-active');
    this.spreadIndex = targetSpread;
    const info = this.getSpreadInfo(targetSpread);
    this.bookEl.dataset.cover = info.isCover ? 'true' : 'false';
    this.bookEl.dataset.spread = String(targetSpread);
    if (info.right != null) {
      pageEl.dataset.pageIndex = String(info.right);
      pageEl.dataset.side = 'right';
    }
    this.updatePageNumbers();
    this.updateArrowStates();
    this.updateDragZone();
    this.scheduleAdjacentPreload();
  }

  animatePageFade(targetSpread, direction) {
    if (this.isAnimating) return Promise.resolve();

    const from = this.spreadIndex;
    const actualDirection = direction || (targetSpread > from ? 'forward' : 'backward');
    const pageEl = this.rightPageEl;
    const outgoing = pageEl?.querySelector(':scope > .wm-flipbook-page__surface:not(.wm-flipbook-page__surface--incoming)');
    const pageIndex = this.getSpreadInfo(targetSpread).right;

    if (!outgoing || pageIndex == null || targetSpread === from) {
      return this.goToSpread(targetSpread, { animate: false, direction: actualDirection });
    }

    this.isAnimating = true;
    this.bookEl.classList.add('is-fading');
    this.resetFlipperState();
    this.animateProgressToSpread(targetSpread, { fromSpread: from, direction: actualDirection });

    const duration = this.getFadeDurationMs();

    return this.preloadPageByIndex(pageIndex)
      .then(() => {
        const incoming = this.buildPageImage(
          this.pages[pageIndex],
          'wm-flipbook-page__surface wm-flipbook-page__surface--incoming',
          { pageIndex, eager: true }
        );

        this.applyPageAspectRatio(pageEl, pageIndex);
        pageEl.classList.add('is-crossfading');
        pageEl.appendChild(incoming);

        return this.preloadPageImage(incoming).then(() => incoming);
      })
      .then((incoming) => {
        void incoming.offsetWidth;
        pageEl.classList.add('is-crossfade-active');
        return this.waitForOpacityTransition(incoming, duration).then(() => incoming);
      })
      .then((incoming) => {
        this.finishPageCrossfade(pageEl, outgoing, incoming, targetSpread);
        this.bookEl.classList.remove('is-fading');
        this.isAnimating = false;
        WMFlipbook.emitEvent(':pageTurn', {
          spreadIndex: this.spreadIndex,
          direction: actualDirection,
          el: this.el
        }, this.el);
      })
      .catch(() => {
        const incoming = pageEl.querySelector(':scope > .wm-flipbook-page__surface--incoming');
        this.finishPageCrossfade(pageEl, outgoing, incoming, targetSpread);
        this.bookEl.classList.remove('is-fading');
        this.isAnimating = false;
        return this.goToSpread(targetSpread, { animate: false, direction: actualDirection });
      });
  }

  animateTurn(targetSpread, direction) {
    if (this.isAnimating) return Promise.resolve();

    const from = this.spreadIndex;
    const actualDirection = direction || (targetSpread > from ? 'forward' : 'backward');
    const fromInfo = this.getSpreadInfo(from);
    const toInfo = this.getSpreadInfo(targetSpread);
    const turnIndices = this.getTurnPageIndices(from, targetSpread, actualDirection);

    this.isAnimating = true;

    return this.preloadPageIndices(turnIndices)
      .then(() => {
        this.bookEl.classList.add('is-turning');
        this.bookEl.dataset.turn = actualDirection;
        this.flipperEl.dataset.direction = actualDirection;

        if (!this.isSinglePageMode()) {
          this.lockTurnLayoutHeight(actualDirection, toInfo, fromInfo);
        }

        this.prepareTurnUnderlay(actualDirection, toInfo, fromInfo);
        this.positionFlipperToPage(actualDirection, fromInfo);
        this.setFlipperFaceRadius(actualDirection, fromInfo, toInfo);

        let flipOrigin = 'left';
        let startAngle = 0;
        let endAngle = -180;
        let faces;

        if (actualDirection === 'forward') {
          faces = this.getForwardFlipFaces(fromInfo, toInfo);
          const currentMatch = this.flipperEl.style.transform.match(/rotateY\((-?\d+\.?\d*)deg\)/);
          if (currentMatch) {
            const parsed = parseFloat(currentMatch[1]);
            if (parsed < 0 && parsed > -180) startAngle = parsed;
          }
        } else {
          flipOrigin = 'right';
          startAngle = 0;
          endAngle = 180;
          faces = this.getBackwardFlipFaces(fromInfo, toInfo);

          const currentMatch = this.flipperEl.style.transform.match(/rotateY\((-?\d+\.?\d*)deg\)/);
          if (currentMatch) {
            const parsed = parseFloat(currentMatch[1]);
            if (parsed > 0 && parsed < 180) startAngle = parsed;
          }
        }

        this.renderFlipper(faces.front, faces.back);

        const surfaces = [
          ...this.flipperEl.querySelectorAll('.wm-flipbook-page__surface'),
          this.leftPageEl?.querySelector(':scope > .wm-flipbook-page__surface'),
          this.rightPageEl?.querySelector(':scope > .wm-flipbook-page__surface')
        ].filter(Boolean);

        return Promise.all(surfaces.map((surface) => this.preloadPageImage(surface))).then(() => {
          const startFraction = actualDirection === 'forward'
            ? Math.min(1, Math.abs(startAngle) / 180)
            : Math.min(1, Math.max(0, startAngle) / 180);
          this.animateProgressToSpread(targetSpread, { fromSpread: from, startFraction, direction: actualDirection });
          this.runFlipTransition(startAngle, endAngle, flipOrigin);

          return new Promise((resolve) => {
            const duration = this.getTurnDurationMs();
            let completed = false;

            const onEnd = (e) => {
              if (completed) return;
              if (e && e.propertyName && e.propertyName !== 'transform') return;
              completed = true;

              this.flipperEl.removeEventListener('transitionend', onEnd);
              this.spreadIndex = targetSpread;
              this.flipperEl.classList.remove('is-flipping', 'is-dragging');
              this.flipperEl.style.transform = '';
              this.flipperEl.style.transformOrigin = '';
              this.flipperEl.style.transition = '';
              this.bookEl.classList.remove('is-turning');
              delete this.bookEl.dataset.turn;
              this.clearTurnLayoutHeight();
              this.isAnimating = false;
              this.updateSpreadDisplay();
              WMFlipbook.emitEvent(':pageTurn', {
                spreadIndex: this.spreadIndex,
                direction: actualDirection,
                el: this.el
              }, this.el);
              resolve();
            };

            this.flipperEl.addEventListener('transitionend', onEnd);
            setTimeout(() => onEnd(), duration + 80);
          });
        });
      })
      .catch(() => {
        this.isAnimating = false;
        this.resetFlipperState();
        return this.goToSpread(targetSpread, { animate: false, direction: actualDirection });
      });
  }

  getTurnDurationMs() {
    const val = this.getTurnDurationCss();
    if (!val) return 800;
    if (val.endsWith('ms')) return parseFloat(val);
    if (val.endsWith('s')) return parseFloat(val) * 1000;
    return 800;
  }

  next() {
    if (this.isAnimating || this.spreadIndex >= this.spreadCount - 1) return;
    this.goToSpread(this.spreadIndex + 1, { animate: true, direction: 'forward' });
  }

  prev() {
    if (this.isAnimating || this.spreadIndex <= 0) return;
    this.goToSpread(this.spreadIndex - 1, { animate: true, direction: 'backward' });
  }

  bindEvents() {
    this.boundHandlers.prev = () => this.prev();
    this.boundHandlers.next = () => this.next();
    this.boundHandlers.keydown = (e) => this.handleKeydown(e);
    this.boundHandlers.dragStart = (e) => this.handleDragStart(e);
    this.boundHandlers.dragMove = (e) => this.handleDragMove(e);
    this.boundHandlers.dragEnd = (e) => this.handleDragEnd(e);

    this.prevBtn?.addEventListener('click', this.boundHandlers.prev);
    this.nextBtn?.addEventListener('click', this.boundHandlers.next);
    this.stageEl?.addEventListener('keydown', this.boundHandlers.keydown);

    const dragTarget = this.dragZoneEl || this.bookEl;
    dragTarget.addEventListener('pointerdown', this.boundHandlers.dragStart);
    window.addEventListener('pointermove', this.boundHandlers.dragMove);
    window.addEventListener('pointerup', this.boundHandlers.dragEnd);
    window.addEventListener('pointercancel', this.boundHandlers.dragEnd);
  }

  handleKeydown(e) {
    if (e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      this.next();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      this.prev();
    }
  }

  handleDragStart(e) {
    if (this.isAnimating || this.isSinglePageMode()) return;
    const edge = this.getDragEdgeFromEvent(e);
    if (!edge) return;

    e.preventDefault();
    this.isDragging = true;
    this.dragEdge = edge;
    this.dragStartX = e.clientX;
    this.dragPointerId = e.pointerId;
    this.dragZoneEl?.setPointerCapture?.(e.pointerId);

    const fromInfo = this.getSpreadInfo(this.spreadIndex);
    this.bookEl.classList.add('is-turning', 'is-drag-active');

    if (edge === 'right') {
      const nextInfo = this.getSpreadInfo(this.spreadIndex + 1);
      this.bookEl.dataset.turn = 'forward';
      this.flipperEl.dataset.direction = 'forward';
      if (!this.isSinglePageMode()) {
        this.lockTurnLayoutHeight('forward', nextInfo, fromInfo);
      }
      this.prepareTurnUnderlay('forward', nextInfo, fromInfo);
      this.positionFlipperToPage('forward', fromInfo);
      const faces = this.getForwardFlipFaces(fromInfo, nextInfo);
      this.renderFlipper(faces.front, faces.back);
      this.setFlipperFaceRadius('forward', fromInfo, nextInfo);
      this.setFlipperPose(0, 'left');
    } else {
      if (this.spreadIndex <= 0) return;
      const prevInfo = this.getSpreadInfo(this.spreadIndex - 1);
      this.bookEl.dataset.turn = 'backward';
      this.flipperEl.dataset.direction = 'backward';
      if (!this.isSinglePageMode()) {
        this.lockTurnLayoutHeight('backward', prevInfo, fromInfo);
      }
      this.prepareTurnUnderlay('backward', prevInfo, fromInfo);
      this.positionFlipperToPage('backward', fromInfo);
      const faces = this.getBackwardFlipFaces(fromInfo, prevInfo);
      this.renderFlipper(faces.front, faces.back);
      this.setFlipperFaceRadius('backward', fromInfo, prevInfo);
      this.setFlipperPose(0, 'right');
    }

    this.flipperEl.classList.add('is-dragging');
    this.flipperEl.classList.remove('is-flipping');
  }

  getDragPagesRect() {
    const pagesEl = this.bookEl?.querySelector('.wm-flipbook-pages');
    return (pagesEl || this.bookEl).getBoundingClientRect();
  }

  getDragEdgeFromEvent(e) {
    const rect = this.getDragPagesRect();
    const x = e.clientX - rect.left;
    const threshold = rect.width * 0.12;
    const atStart = this.spreadIndex <= 0;
    const atEnd = this.spreadIndex >= this.spreadCount - 1;
    const edgeMode = this.dragZoneEl?.dataset.edge;

    if (!atEnd && edgeMode !== 'left' && x > rect.width - threshold) return 'right';
    if (!atStart && edgeMode !== 'right' && x < threshold) return 'left';
    return null;
  }

  handleDragMove(e) {
    if (!this.isDragging || e.pointerId !== this.dragPointerId) return;

    const rect = this.getDragPagesRect();
    const delta = e.clientX - this.dragStartX;
    const maxDrag = rect.width * 0.85;
    const clamped = Math.max(-maxDrag, Math.min(maxDrag, delta));
    const progress = clamped / maxDrag;

    if (this.dragEdge === 'right') {
      const angle = Math.max(-179, Math.min(0, progress * 180));
      this.setFlipperPose(angle, 'left');
      this.syncProgressToFlipAngle(angle, 'forward');
    } else {
      const angle = Math.min(179, Math.max(0, progress * 180));
      this.setFlipperPose(angle, 'right');
      this.syncProgressToFlipAngle(angle, 'backward');
    }
  }

  handleDragEnd(e) {
    if (!this.isDragging || (e.pointerId != null && e.pointerId !== this.dragPointerId)) return;

    this.isDragging = false;
    this.bookEl.classList.remove('is-drag-active');
    this.dragZoneEl?.releasePointerCapture?.(this.dragPointerId);

    const transform = this.flipperEl.style.transform;
    const match = transform.match(/rotateY\((-?\d+\.?\d*)deg\)/);
    const angle = match ? parseFloat(match[1]) : 0;

    const commitForward = this.dragEdge === 'right' && angle <= -90;
    const commitBackward = this.dragEdge === 'left' && angle >= 90;

    if (commitForward && this.spreadIndex < this.spreadCount - 1) {
      this.completeDragTurn(this.spreadIndex + 1, 'forward', angle);
    } else if (commitBackward && this.spreadIndex > 0) {
      this.completeDragTurn(this.spreadIndex - 1, 'backward', angle);
    } else {
      const snapAngle = 0;
      const snapOrigin = this.dragEdge === 'right' ? 'left' : 'right';
      const snapDirection = this.dragEdge === 'right' ? 'forward' : 'backward';
      const snapFraction = Math.min(1, Math.abs(angle) / 180);
      this.animateProgressToSpread(this.spreadIndex, {
        fromSpread: this.spreadIndex,
        startFraction: snapFraction,
        direction: snapDirection
      });
      this.runFlipTransition(angle, snapAngle, snapOrigin);

      let snapCompleted = false;
      const onSnapBack = (evt) => {
        if (snapCompleted) return;
        if (evt && evt.propertyName && evt.propertyName !== 'transform') return;
        snapCompleted = true;
        this.flipperEl.removeEventListener('transitionend', onSnapBack);
        this.flipperEl.classList.remove('is-flipping', 'is-dragging');
        this.flipperEl.style.transform = '';
        this.flipperEl.style.transformOrigin = '';
        this.flipperEl.style.transition = '';
        this.bookEl.classList.remove('is-turning', 'is-drag-active');
        delete this.bookEl.dataset.turn;
        this.clearTurnLayoutHeight();
        this.updateSpreadDisplay();
      };
      this.flipperEl.addEventListener('transitionend', onSnapBack);
      setTimeout(() => onSnapBack(), this.getTurnDurationMs() + 80);
    }
  }

  destroy() {
    this.prevBtn?.removeEventListener('click', this.boundHandlers.prev);
    this.nextBtn?.removeEventListener('click', this.boundHandlers.next);
    this.stageEl?.removeEventListener('keydown', this.boundHandlers.keydown);

    const dragTarget = this.dragZoneEl || this.bookEl;
    dragTarget?.removeEventListener('pointerdown', this.boundHandlers.dragStart);
    window.removeEventListener('pointermove', this.boundHandlers.dragMove);
    window.removeEventListener('pointerup', this.boundHandlers.dragEnd);
    window.removeEventListener('pointercancel', this.boundHandlers.dragEnd);

    this.restoreSectionButton();
    if (this.sectionButtonEl && !this.sectionButtonRestore) {
      this.sectionButtonEl.remove();
    }
    this.pluginContent?.remove();
    this.builtTitleEl?.remove();

    this.hiddenElements.forEach(({ el, display }) => {
      el.style.display = display;
    });
    this.hiddenElements = [];
    this.builtTitleEl = null;

    this.mobileMediaQuery?.removeEventListener('change', this.boundHandlers.layoutChange);
    this.mobileMediaQuery = null;
    this.imagePreloads.clear();

    this.el.removeAttribute('data-wm-plugin');
    this.el.removeAttribute('data-wm-list-layout');
    this.el.removeAttribute('data-wm-show-progress');
    this.el.removeAttribute('data-wm-show-page-numbers');
    this.el.removeAttribute('data-wm-single-page');

    WMFlipbook.emitEvent(':destroy', { el: this.el }, this.el);
  }
}

(function initFlipbook() {
  const pluginName = 'flipbook';
  const instances = [];

  function createInstances() {
    document.querySelectorAll(`[id^="${pluginName}"]`).forEach((section) => {
      if (section.dataset.wmPlugin === pluginName) return;
      const sectionId = section.id;
      const settings = window.wmFlipbookSettings?.[sectionId] || {};
      instances.push(new WMFlipbook(section, settings));
    });
  }

  createInstances();

  if (window.top !== window.self) {
    const destroyObserver = new MutationObserver(() => {
      if (document.body.classList.contains('sqs-edit-mode-active')) {
        instances.forEach((instance) => {
          if (instance && typeof instance.destroy === 'function') {
            instance.destroy();
          }
        });
        instances.length = 0;
        destroyObserver.disconnect();
      }
    });

    destroyObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['class']
    });

    const reinitObserver = new MutationObserver(() => {
      if (!document.body.classList.contains('sqs-edit-mode-active') && instances.length === 0) {
        setTimeout(createInstances, 100);
      }
    });

    reinitObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['class']
    });
  }

  window.WMFlipbook = WMFlipbook;
  window.wmFlipbookInstances = instances;
})();

