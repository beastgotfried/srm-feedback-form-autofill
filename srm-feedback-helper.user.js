// ==UserScript==
// @name         SRM Academia Course Feedback Helper
// @namespace    https://github.com/beastgotfried/srm-feedback-form-autofill
// @version      0.3.0
// @author       beastgotfried+codex
// @description  Fill Course Feedback rating dropdowns and comments for review without targeting submission controls.
// @homepageURL  https://github.com/beastgotfried/srm-feedback-form-autofill
// @supportURL   https://github.com/beastgotfried/srm-feedback-form-autofill/issues
// @updateURL    https://raw.githubusercontent.com/beastgotfried/srm-feedback-form-autofill/main/srm-feedback-helper.user.js
// @downloadURL  https://raw.githubusercontent.com/beastgotfried/srm-feedback-form-autofill/main/srm-feedback-helper.user.js
// @match        https://academia.srmist.edu.in/*
// @run-at       document-idle
// @noframes
// @grant        GM_setClipboard
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '0.3.0';
  const HOST_ID = 'srm-feedback-helper-host';
  const TARGET_ROUTE = /course[\s_-]*feedback/i;
  const COMMENT_HINT = /(comment|feedback|remark|suggest|observation|response)/i;
  const COURSE_RATING_LABELS = ['Average', 'Excellent', 'Good', 'Poor', 'Very Good'];
  const COURSE_RATING_KEYS = new Set(COURSE_RATING_LABELS.map(normalizeLabel));
  const MIN_OPTIONS = 2;
  const MAX_OPTIONS = 10;
  const RESCAN_DELAY_MS = 240;

  const state = {
    analysis: null,
    lastRun: { ratings: [], textFields: [] },
    refreshTimer: null,
    observedRoots: new WeakSet(),
    observers: [],
    host: null,
    ui: null,
  };

  function isElement(value) {
    return Boolean(value && value.nodeType === Node.ELEMENT_NODE && value.ownerDocument);
  }

  function isShadowRoot(value) {
    return Boolean(value && value.nodeType === Node.DOCUMENT_FRAGMENT_NODE && value.host);
  }

  function normalizeText(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeLabel(value) {
    return normalizeText(value)
      .toLocaleLowerCase('en')
      .replace(/[“”"'`]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  }

  function shortText(value, maxLength = 72) {
    const text = normalizeText(value);
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
  }

  function routeMatches() {
    let route = `${location.pathname} ${location.hash}`;
    try {
      route = decodeURIComponent(route);
    } catch {
      // Keep the undecoded route if the URL contains malformed escapes.
    }
    return TARGET_ROUTE.test(route);
  }

  function isVisibleElement(element) {
    if (!isElement(element) || !element.isConnected) return false;
    if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;

    const view = element.ownerDocument.defaultView;
    const style = view?.getComputedStyle(element);
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;

    return Array.from(element.getClientRects()).some(
      (rect) => rect.width > 0 && rect.height > 0,
    );
  }

  function escapeSelector(value) {
    if (globalThis.CSS?.escape) return CSS.escape(value);
    return String(value).replace(/([ #;?%&,.+*~\':"!^$[\]()=>|/@])/g, '\\$1');
  }

  function labelsFor(input, root) {
    const labels = Array.from(input.labels || []);
    if (labels.length) return labels;

    if (input.id) {
      const label = root.querySelector(`label[for="${escapeSelector(input.id)}"]`);
      if (label) return [label];
    }

    const wrappingLabel = input.closest('label');
    return wrappingLabel ? [wrappingLabel] : [];
  }

  function textFromLabelledBy(element) {
    const ids = normalizeText(element.getAttribute('aria-labelledby')).split(' ').filter(Boolean);
    if (!ids.length) return '';

    return ids
      .map((id) => element.ownerDocument.getElementById(id)?.textContent || '')
      .map(normalizeText)
      .filter(Boolean)
      .join(' ');
  }

  function tableHeaderFor(element) {
    const cell = element.closest('td, th');
    const row = cell?.parentElement;
    const table = cell?.closest('table');
    if (!cell || !row || !table) return '';

    const cells = Array.from(row.children).filter((child) => /^(TD|TH)$/.test(child.tagName));
    const columnIndex = cells.indexOf(cell);
    if (columnIndex < 0) return '';

    const headerRows = Array.from(table.querySelectorAll('thead tr'));
    const fallbackRows = headerRows.length
      ? []
      : Array.from(table.querySelectorAll('tr'))
        .filter((candidate) => candidate.querySelector('th'))
        .slice(0, 2);

    for (const headerRow of [...headerRows].reverse().concat(fallbackRows)) {
      const headers = Array.from(headerRow.children).filter((child) => /^(TD|TH)$/.test(child.tagName));
      const header = headers[columnIndex];
      const text = shortText(header?.textContent, 48);
      if (text && header !== cell) return text;
    }

    return '';
  }

  function technicalValue(value) {
    const text = normalizeText(value);
    if (!text || text === 'on') return true;
    if (text.length > 40) return true;
    if (/^[a-f\d-]{20,}$/i.test(text)) return true;
    if (/^[\w-]*\d{6,}[\w-]*$/.test(text)) return true;
    return false;
  }

  function describeOption(element, root, fallbackIndex) {
    const labelledBy = shortText(textFromLabelledBy(element), 48);
    if (labelledBy) return { label: labelledBy, source: 'aria' };

    const ariaLabel = shortText(element.getAttribute('aria-label'), 48);
    if (ariaLabel) return { label: ariaLabel, source: 'aria' };

    if (element.matches('input[type="radio"]')) {
      const label = labelsFor(element, root)
        .map((item) => shortText(item.textContent, 48))
        .find(Boolean);
      if (label) return { label, source: 'label' };
    }

    const ownText = shortText(element.textContent, 48);
    if (ownText) return { label: ownText, source: 'text' };

    const header = tableHeaderFor(element);
    if (header) return { label: header, source: 'header' };

    const title = shortText(element.getAttribute('title'), 48);
    if (title) return { label: title, source: 'title' };

    if (element.matches('input[type="radio"]') && !technicalValue(element.value)) {
      return { label: shortText(element.value, 48), source: 'value' };
    }

    return { label: `Choice ${fallbackIndex + 1}`, source: 'fallback' };
  }

  function clickTargetFor(element, root) {
    if (element.matches('input[type="radio"]')) {
      const visibleLabel = labelsFor(element, root).find(isVisibleElement);
      if (visibleLabel) return visibleLabel;
    }
    return element;
  }

  function isUsableControl(element, root) {
    if (!isElement(element) || !element.isConnected) return false;
    if (element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true') return false;
    if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    if (element.closest('nav, header, [role="navigation"], #signinPage')) return false;

    const ancestry = Array.from(element.closest('form, fieldset, [role="radiogroup"], tr')?.classList || [])
      .concat(element.closest('form, fieldset, [role="radiogroup"], tr')?.id || '')
      .join(' ');
    if (/(?:^|[-_\s])(login|signin|captcha|password|otp|mfa)(?:$|[-_\s])/i.test(ancestry)) {
      return false;
    }

    return isVisibleElement(element) || isVisibleElement(clickTargetFor(element, root));
  }

  function isFeedbackTextField(element) {
    if (!isElement(element) || !element.isConnected) return false;
    if (element.disabled || element.readOnly) return false;
    if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    if (element.closest('nav, header, [role="navigation"], #signinPage')) return false;
    if (!isVisibleElement(element)) return false;

    const identity = [
      element.id,
      element.getAttribute('name'),
      element.getAttribute('class'),
      element.getAttribute('placeholder'),
      element.getAttribute('aria-label'),
      element.getAttribute('autocomplete'),
      textFromLabelledBy(element),
      ...Array.from(element.labels || []).map((label) => label.textContent),
      tableHeaderFor(element),
    ].filter(Boolean).join(' ');

    if (/(login|signin|captcha|password|otp|mfa|email|mobile|search|filter)/i.test(identity)) {
      return false;
    }
    if (/(feedback[\s_-]*(?:number|no\b)|academic[\s_-]*year|course[\s_-]*code)/i.test(identity)) {
      return false;
    }

    return element.matches('textarea, input[type="text"], input:not([type])')
      && COMMENT_HINT.test(identity);
  }

  function isSafeAriaRadio(element) {
    if (!isElement(element)) return false;
    if (element.tagName === 'BUTTON') return element.type === 'button';
    return ['DIV', 'SPAN', 'LI'].includes(element.tagName);
  }

  function elementPosition(option) {
    const target = option.clickTarget;
    const rect = isVisibleElement(target) ? target.getBoundingClientRect() : null;
    return rect ? { x: rect.left, y: rect.top, visible: true } : { x: 0, y: 0, visible: false };
  }

  function sortOptions(options) {
    return options
      .map((option, domIndex) => ({ ...option, domIndex, position: elementPosition(option) }))
      .sort((left, right) => {
        if (left.position.visible && right.position.visible) {
          const sameLine = Math.abs(left.position.y - right.position.y) < 12;
          if (sameLine && left.position.x !== right.position.x) {
            return left.position.x - right.position.x;
          }
        }
        return left.domIndex - right.domIndex;
      })
      .map((option) => {
        const { domIndex: _domIndex, position: _position, ...rest } = option;
        return rest;
      });
  }

  function optionIsSelected(option) {
    if (option.kind === 'native') return Boolean(option.element.checked);
    if (option.kind === 'select') return Boolean(option.nativeOption.selected);
    return option.element.getAttribute('aria-checked') === 'true';
  }

  function selectedIndex(group) {
    return group.options.findIndex(optionIsSelected);
  }

  function collectContexts() {
    const contexts = [];
    const inaccessibleFrames = [];
    const seenRoots = new WeakSet();

    function visit(root, ownerDocument, path) {
      if (!root || seenRoots.has(root)) return;
      if (isShadowRoot(root) && root.host?.id === HOST_ID) return;

      seenRoots.add(root);
      contexts.push({ root, ownerDocument, path });

      for (const element of root.querySelectorAll('*')) {
        if (element.shadowRoot) {
          visit(element.shadowRoot, ownerDocument, `${path} > shadow(${element.localName})`);
        }
      }

      for (const [index, frame] of Array.from(root.querySelectorAll('iframe, frame')).entries()) {
        try {
          const childDocument = frame.contentDocument;
          if (childDocument?.documentElement) {
            visit(childDocument, childDocument, `${path} > frame[${index}]`);
          } else {
            inaccessibleFrames.push(`${path} > frame[${index}] (not loaded)`);
          }
        } catch {
          inaccessibleFrames.push(`${path} > frame[${index}] (cross-origin)`);
        }
      }
    }

    visit(document, document, 'top');
    return { contexts, inaccessibleFrames };
  }

  function nativeGroupsFrom(context, contextIndex) {
    const grouped = new Map();
    const anonymousContainers = new WeakMap();
    let anonymousCounter = 0;

    function anonymousKey(input) {
      const container = input.closest('fieldset, [role="radiogroup"], tr, .question, .feedback-question');
      if (!container) return null;
      if (!anonymousContainers.has(container)) {
        anonymousContainers.set(container, `anonymous-${anonymousCounter++}`);
      }
      return anonymousContainers.get(container);
    }

    for (const input of context.root.querySelectorAll('input[type="radio"]')) {
      if (!isUsableControl(input, context.root)) continue;

      const name = normalizeText(input.name);
      const fallbackKey = name ? null : anonymousKey(input);
      if (!name && !fallbackKey) continue;

      const formMarker = input.form
        ? normalizeText(input.form.id || input.form.getAttribute('name') || 'form')
        : 'no-form';
      const key = `${contextIndex}:${formMarker}:${name || fallbackKey}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(input);
    }

    return Array.from(grouped, ([key, elements]) => {
      const options = sortOptions(
        elements.map((element, index) => ({
          ...describeOption(element, context.root, index),
          element,
          clickTarget: clickTargetFor(element, context.root),
          kind: 'native',
        })),
      );

      return {
        key,
        kind: 'native',
        path: context.path,
        root: context.root,
        options,
      };
    });
  }

  function ariaGroupsFrom(context, contextIndex) {
    const grouped = new Map();

    for (const radio of context.root.querySelectorAll('[role="radio"]')) {
      if (radio.matches('input[type="radio"]') || !isUsableControl(radio, context.root)) continue;
      if (!isSafeAriaRadio(radio)) continue;
      const container = radio.closest('[role="radiogroup"]');
      if (!container) continue;
      if (!grouped.has(container)) grouped.set(container, []);
      grouped.get(container).push(radio);
    }

    return Array.from(grouped, ([container, elements], groupIndex) => {
      const options = sortOptions(
        elements.map((element, index) => ({
          ...describeOption(element, context.root, index),
          element,
          clickTarget: element,
          kind: 'aria',
        })),
      );

      return {
        key: `${contextIndex}:aria:${groupIndex}`,
        kind: 'aria',
        path: context.path,
        root: context.root,
        container,
        options,
      };
    });
  }

  function textFieldsFrom(context) {
    return Array.from(
      context.root.querySelectorAll('textarea, input[type="text"], input:not([type])'),
    ).filter(isFeedbackTextField);
  }

  function select2ContainerFor(select, root) {
    const siblings = [select.previousElementSibling, select.nextElementSibling];
    const sibling = siblings.find((element) => element?.matches?.('.select2-container'));
    if (sibling) return sibling;

    if (select.id) {
      const legacy = root.querySelector(`#s2id_${escapeSelector(select.id)}`);
      if (legacy?.matches('.select2-container')) return legacy;
    }

    return null;
  }

  function placeholderOption(option) {
    const label = normalizeText(option.label || option.textContent);
    return option.disabled
      || option.hidden
      || option.value === ''
      || /^(?:-+\s*)?(?:select|please select|choose(?: an)? answer)(?:\s*-+)?$/i.test(label);
  }

  function isUsableRatingSelect(select, root) {
    if (!isElement(select) || !select.isConnected || select.disabled || select.multiple) return false;
    if (select.parentElement?.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    if (select.closest('nav, header, [role="navigation"], #signinPage')) return false;

    const widget = select2ContainerFor(select, root);
    if (!isVisibleElement(select) && !isVisibleElement(widget)) return false;

    const options = Array.from(select.options).filter((option) => !placeholderOption(option));
    const optionKeys = new Set(options.map((option) => normalizeLabel(option.label || option.textContent)));
    return COURSE_RATING_LABELS.every((label) => optionKeys.has(normalizeLabel(label)))
      && Array.from(optionKeys).every((key) => COURSE_RATING_KEYS.has(key));
  }

  function selectGroupsFrom(context, contextIndex) {
    const groups = [];

    for (const [selectIndex, select] of Array.from(context.root.querySelectorAll('select')).entries()) {
      if (!isUsableRatingSelect(select, context.root)) continue;

      const options = Array.from(select.options)
        .filter((nativeOption) => !placeholderOption(nativeOption))
        .map((nativeOption) => ({
          kind: 'select',
          element: select,
          nativeOption,
          label: normalizeText(nativeOption.label || nativeOption.textContent),
          source: 'option',
        }));

      groups.push({
        key: `${contextIndex}:select:${selectIndex}`,
        kind: 'select',
        path: context.path,
        root: context.root,
        element: select,
        widget: select2ContainerFor(select, context.root),
        options,
      });
    }

    return groups;
  }

  function semanticSignature(group) {
    if (group.options.some((option) => option.source === 'fallback')) return null;
    const labels = group.options.map((option) => normalizeLabel(option.label));
    if (labels.some((label) => !label) || new Set(labels).size < 2) return null;
    return labels.join('|');
  }

  function buildClusters(candidateGroups) {
    const baseGroups = new Map();

    for (const group of candidateGroups) {
      const optionCount = group.options.length;
      if (optionCount < MIN_OPTIONS || optionCount > MAX_OPTIONS) continue;
      const key = `${group.kind}:${optionCount}`;
      if (!baseGroups.has(key)) baseGroups.set(key, []);
      baseGroups.get(key).push(group);
    }

    const clusters = [];

    for (const [baseKey, groups] of baseGroups) {
      const bySignature = new Map();
      for (const group of groups) {
        const signature = semanticSignature(group);
        const key = signature || '__unknown__';
        if (!bySignature.has(key)) bySignature.set(key, []);
        bySignature.get(key).push(group);
      }

      const repeatedSemanticSets = Array.from(bySignature.entries()).filter(
        ([signature, matchingGroups]) => signature !== '__unknown__' && matchingGroups.length >= 2,
      );

      if (repeatedSemanticSets.length) {
        for (const [signature, matchingGroups] of repeatedSemanticSets) {
          clusters.push({
            key: `${baseKey}:${signature}`,
            kind: matchingGroups[0].kind,
            optionCount: matchingGroups[0].options.length,
            groups: matchingGroups,
            signature,
          });
        }

        const unknownGroups = bySignature.get('__unknown__') || [];
        if (unknownGroups.length >= 2) {
          clusters.push({
            key: `${baseKey}:unknown`,
            kind: unknownGroups[0].kind,
            optionCount: unknownGroups[0].options.length,
            groups: unknownGroups,
            signature: null,
          });
        }
      } else {
        const unknownGroups = bySignature.get('__unknown__') || [];
        if (unknownGroups.length < 2) continue;
        clusters.push({
          key: `${baseKey}:fallback`,
          kind: unknownGroups[0].kind,
          optionCount: unknownGroups[0].options.length,
          groups: unknownGroups,
          signature: null,
        });
      }
    }

    return clusters.sort((left, right) => {
      if (right.groups.length !== left.groups.length) return right.groups.length - left.groups.length;
      return right.optionCount - left.optionCount;
    });
  }

  function analyzePage() {
    const { contexts, inaccessibleFrames } = collectContexts();
    const nativeGroups = [];
    const ariaGroups = [];
    const selectGroups = [];
    const commentFields = [];
    let visibleButtonCount = 0;
    let visibleTextareaCount = 0;
    let nativeSelectCount = 0;
    let select2WidgetCount = 0;

    contexts.forEach((context, index) => {
      nativeGroups.push(...nativeGroupsFrom(context, index));
      ariaGroups.push(...ariaGroupsFrom(context, index));
      selectGroups.push(...selectGroupsFrom(context, index));
      commentFields.push(...textFieldsFrom(context));
      visibleButtonCount += Array.from(
        context.root.querySelectorAll('button, [role="button"]'),
      ).filter(isVisibleElement).length;
      visibleTextareaCount += Array.from(
        context.root.querySelectorAll('textarea'),
      ).filter(isVisibleElement).length;
      nativeSelectCount += context.root.querySelectorAll('select').length;
      select2WidgetCount += context.root.querySelectorAll('.select2-container').length;
    });

    const candidateGroups = [...nativeGroups, ...ariaGroups, ...selectGroups];
    const clusters = buildClusters(candidateGroups);
    const eligibleGroups = new Set(clusters.flatMap((cluster) => cluster.groups));

    return {
      contexts,
      inaccessibleFrames,
      candidateGroups,
      clusters,
      skippedGroupCount: candidateGroups.filter((group) => !eligibleGroups.has(group)).length,
      nativeGroupCount: nativeGroups.length,
      ariaGroupCount: ariaGroups.length,
      selectGroupCount: selectGroups.length,
      select2BackedGroupCount: selectGroups.filter((group) => group.widget).length,
      commentFields,
      visibleButtonCount,
      visibleTextareaCount,
      nativeSelectCount,
      select2WidgetCount,
    };
  }

  function representativeLabels(cluster) {
    const representative = cluster.groups[0];
    return representative.options.map((option, index) => {
      const fallback = index === 0
        ? 'Leftmost choice'
        : index === representative.options.length - 1
          ? 'Rightmost choice'
          : `Choice ${index + 1}`;
      return option.source === 'fallback' ? fallback : option.label;
    });
  }

  function clusterLabel(cluster) {
    const type = cluster.kind === 'native'
      ? 'radio'
      : cluster.kind === 'select'
        ? 'course rating dropdown'
        : 'accessible radio';
    const unit = cluster.kind === 'select' ? 'rating fields' : 'questions';
    return `${cluster.groups.length} ${unit} · ${cluster.optionCount} choices · ${type}`;
  }

  function optionElement(label, value) {
    const option = document.createElement('option');
    option.textContent = label;
    option.value = value;
    return option;
  }

  function createPanel() {
    if (state.host?.isConnected) return;

    const host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('data-srm-feedback-helper', '');
    const shadow = host.attachShadow({ mode: 'open' });

    shadow.innerHTML = `
      <style>
        :host {
          all: initial;
          position: fixed;
          right: 16px;
          bottom: 16px;
          z-index: 2147483647;
          color: #20252b;
          font: 14px/1.35 Lato, sans-serif;
        }
        *, *::before, *::after { box-sizing: border-box; }
        button, select, input { font: inherit; }
        .panel {
          width: min(328px, calc(100vw - 24px));
          overflow: hidden;
          background: #ffffff;
          border: 1px solid #cbd2d8;
          border-left: 3px solid #3399ff;
          border-radius: 7px;
          box-shadow: 0 2px 8px rgba(24, 33, 42, 0.16);
        }
        .bar {
          min-height: 44px;
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 8px 10px 8px 12px;
          border-bottom: 1px solid #e1e5e8;
        }
        .bar strong { flex: 1; font-size: 14px; font-weight: 700; }
        .count { color: #57636d; font-size: 12px; white-space: nowrap; }
        .icon-button {
          width: 28px;
          height: 28px;
          padding: 0;
          color: #4a555f;
          background: transparent;
          border: 1px solid transparent;
          border-radius: 5px;
          cursor: pointer;
        }
        .icon-button:hover { background: #f1f3f5; border-color: #d8dde1; }
        .icon-button:focus-visible, button:focus-visible, select:focus-visible, input:focus-visible, textarea:focus-visible {
          outline: 2px solid #2679b5;
          outline-offset: 2px;
        }
        .body { display: grid; gap: 12px; padding: 12px; }
        .body[hidden] { display: none; }
        .field { display: grid; gap: 5px; }
        .field > span { color: #4b5660; font-size: 12px; font-weight: 700; }
        select {
          width: 100%;
          min-height: 36px;
          padding: 6px 30px 6px 9px;
          color: #20252b;
          background: #ffffff;
          border: 1px solid #b9c2c9;
          border-radius: 6px;
        }
        textarea {
          width: 100%;
          min-height: 66px;
          resize: vertical;
          padding: 8px 9px;
          color: #20252b;
          background: #ffffff;
          border: 1px solid #b9c2c9;
          border-radius: 6px;
        }
        select:disabled { color: #7a858e; background: #f2f4f5; }
        .check {
          display: flex;
          align-items: flex-start;
          gap: 8px;
          color: #3d4851;
          font-size: 12px;
          cursor: pointer;
        }
        .check input { width: 15px; height: 15px; margin: 1px 0 0; accent-color: #2679b5; }
        .actions { display: grid; grid-template-columns: 1fr auto; gap: 8px; }
        .button {
          min-height: 36px;
          padding: 7px 11px;
          border: 1px solid #adb7bf;
          border-radius: 6px;
          cursor: pointer;
        }
        .button.primary { color: #ffffff; background: #246f9f; border-color: #246f9f; font-weight: 700; }
        .button.secondary { color: #313a42; background: #ffffff; }
        .button:hover:not(:disabled) { filter: brightness(0.96); }
        .button:disabled { color: #8a949c; background: #eef0f2; border-color: #d7dce0; cursor: not-allowed; }
        .minor-actions { display: flex; gap: 12px; }
        .text-button {
          padding: 0;
          color: #315f7c;
          background: transparent;
          border: 0;
          cursor: pointer;
          font-size: 12px;
          text-decoration: underline;
          text-underline-offset: 2px;
        }
        .text-button:disabled { color: #929ba2; cursor: not-allowed; }
        .status {
          min-height: 35px;
          padding: 8px 9px;
          color: #46515a;
          background: #f4f6f7;
          border: 1px solid #e0e4e7;
          border-radius: 5px;
          font-size: 12px;
        }
        .status[data-tone="success"] { color: #215f3b; background: #f0f7f3; border-color: #c8dfd0; }
        .status[data-tone="warning"] { color: #7a4a12; background: #fff8ec; border-color: #ead5ae; }
        .note { margin: 0; color: #66717a; font-size: 11px; }
        @media (max-width: 520px) {
          :host { right: 12px; bottom: 12px; }
        }
        @media (prefers-reduced-motion: reduce) {
          *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; }
        }
      </style>
      <section class="panel" role="region" aria-label="SRM feedback helper">
        <div class="bar">
          <strong>Feedback helper</strong>
          <span class="count" id="count">Scanning…</span>
          <button class="icon-button" id="collapse" type="button" aria-label="Collapse helper" aria-expanded="true">−</button>
        </div>
        <div class="body" id="body">
          <label class="field">
            <span>Question set</span>
            <select id="cluster" aria-label="Question set"></select>
          </label>
          <label class="field">
            <span>Answer</span>
            <select id="answer" aria-label="Answer choice"></select>
          </label>
          <label class="field">
            <span>Comment text, repeated <span id="comment-count"></span></span>
            <textarea id="comment" rows="3" placeholder="Type once; repeated into blank comment boxes">Good</textarea>
          </label>
          <label class="check">
            <input id="overwrite" type="checkbox">
            <span>Replace rating answers already selected</span>
          </label>
          <div class="actions">
            <button class="button primary" id="fill" type="button" disabled>Fill form</button>
            <button class="button secondary" id="rescan" type="button">Rescan</button>
          </div>
          <div class="minor-actions">
            <button class="text-button" id="undo" type="button" disabled>Undo last fill</button>
            <button class="text-button" id="diagnostics" type="button">Copy diagnostics</button>
          </div>
          <div class="status" id="status" role="status" aria-live="polite">Waiting for the feedback form.</div>
          <p class="note">Submission and navigation controls are not targeted. The portal may still autosave field changes.</p>
        </div>
      </section>
    `;

    document.documentElement.append(host);

    const ui = {
      shadow,
      body: shadow.getElementById('body'),
      collapse: shadow.getElementById('collapse'),
      count: shadow.getElementById('count'),
      cluster: shadow.getElementById('cluster'),
      answer: shadow.getElementById('answer'),
      comment: shadow.getElementById('comment'),
      commentCount: shadow.getElementById('comment-count'),
      overwrite: shadow.getElementById('overwrite'),
      fill: shadow.getElementById('fill'),
      rescan: shadow.getElementById('rescan'),
      undo: shadow.getElementById('undo'),
      diagnostics: shadow.getElementById('diagnostics'),
      status: shadow.getElementById('status'),
    };

    ui.collapse.addEventListener('click', () => {
      const shouldExpand = ui.body.hidden;
      ui.body.hidden = !shouldExpand;
      ui.collapse.textContent = shouldExpand ? '−' : '+';
      ui.collapse.setAttribute('aria-expanded', String(shouldExpand));
      ui.collapse.setAttribute('aria-label', shouldExpand ? 'Collapse helper' : 'Expand helper');
    });
    ui.cluster.addEventListener('change', () => populateAnswers());
    ui.answer.addEventListener('change', updateFillAvailability);
    ui.comment.addEventListener('input', updateFillAvailability);
    ui.fill.addEventListener('click', () => void fillSelectedCluster());
    ui.rescan.addEventListener('click', () => refreshAnalysis({ announce: true }));
    ui.undo.addEventListener('click', () => void undoLastFill());
    ui.diagnostics.addEventListener('click', () => void copyDiagnostics());

    state.host = host;
    state.ui = ui;
  }

  function setStatus(message, tone = 'neutral') {
    if (!state.ui) return;
    state.ui.status.textContent = message;
    state.ui.status.dataset.tone = tone;
  }

  function populateClusters(previousClusterKey = '') {
    const { ui, analysis } = state;
    if (!ui || !analysis) return;

    ui.cluster.replaceChildren();
    if (!analysis.clusters.length) {
      ui.cluster.append(optionElement('No repeated rating sets found', ''));
      ui.cluster.disabled = true;
      populateAnswers();
      return;
    }

    analysis.clusters.forEach((cluster) => {
      ui.cluster.append(optionElement(clusterLabel(cluster), cluster.key));
    });
    ui.cluster.disabled = analysis.clusters.length === 1;
    if (analysis.clusters.some((cluster) => cluster.key === previousClusterKey)) {
      ui.cluster.value = previousClusterKey;
    }
    populateAnswers();
  }

  function populateAnswers(previousAnswer = '') {
    const { ui, analysis } = state;
    if (!ui || !analysis) return;

    ui.answer.replaceChildren(optionElement('Choose an answer…', ''));
    const cluster = analysis.clusters.find((item) => item.key === ui.cluster.value);
    if (!cluster) {
      ui.answer.disabled = true;
      updateFillAvailability();
      return;
    }

    representativeLabels(cluster).forEach((label, index) => {
      ui.answer.append(optionElement(`${index + 1} — ${label}`, String(index)));
    });
    ui.answer.disabled = false;
    if (previousAnswer !== '' && Array.from(ui.answer.options).some((option) => option.value === previousAnswer)) {
      ui.answer.value = previousAnswer;
    } else {
      const goodIndex = representativeLabels(cluster).findIndex(
        (label) => normalizeLabel(label) === normalizeLabel('Good'),
      );
      if (goodIndex >= 0) ui.answer.value = String(goodIndex);
    }
    updateFillAvailability();
  }

  function updateFillAvailability() {
    if (!state.ui) return;
    const hasCluster = Boolean(state.ui.cluster.value);
    const hasAnswer = state.ui.answer.value !== '';
    const hasComment = Boolean(
      normalizeText(state.ui.comment.value) && state.analysis?.commentFields?.length,
    );
    state.ui.fill.disabled = !(hasCluster && hasAnswer) && !hasComment;
  }

  function observeContexts(contexts) {
    for (const context of contexts) {
      if (state.observedRoots.has(context.root)) continue;
      state.observedRoots.add(context.root);

      const Observer = context.ownerDocument.defaultView?.MutationObserver || MutationObserver;
      const observer = new Observer(() => scheduleRefresh());
      observer.observe(context.root, { childList: true, subtree: true });
      state.observers.push(observer);

      for (const frame of context.root.querySelectorAll('iframe, frame')) {
        frame.addEventListener('load', scheduleRefresh, { passive: true });
      }
    }
  }

  function refreshAnalysis({ announce = false } = {}) {
    const previousClusterKey = state.ui?.cluster.value || '';
    const previousAnswer = state.ui?.answer.value || '';
    const analysis = analyzePage();
    state.analysis = analysis;

    if (!routeMatches()) {
      if (state.host) state.host.hidden = true;
      observeContexts(analysis.contexts);
      return;
    }

    createPanel();
    state.host.hidden = false;
    populateClusters(previousClusterKey);
    if (previousAnswer) populateAnswers(previousAnswer);
    observeContexts(analysis.contexts);

    const questionCount = analysis.clusters.reduce((total, cluster) => total + cluster.groups.length, 0);
    const commentCount = analysis.commentFields.length;
    state.ui.count.textContent = [
      questionCount ? `${questionCount} rating` : '',
      commentCount ? `${commentCount} text` : '',
    ].filter(Boolean).join(' · ') || 'No matches';
    state.ui.commentCount.textContent = commentCount ? `(${commentCount} found)` : '(none found)';
    updateFillAvailability();

    if (!analysis.clusters.length) {
      const frameNote = analysis.inaccessibleFrames.length
        ? ` ${analysis.inaccessibleFrames.length} frame(s) could not be inspected.`
        : '';
      const commentNote = commentCount
        ? ` ${commentCount} blank or existing comment box(es) are available.`
        : '';
      setStatus(`No repeated rating controls found.${commentNote}${frameNote}`, 'warning');
    } else if (announce) {
      setStatus(`Found ${questionCount} rating controls. Confirm the selected answer, then fill.`, 'success');
    } else if (/^(Waiting|No repeated rating controls)/.test(state.ui.status.textContent)) {
      setStatus('Good is selected for ratings and comments. Review the choices, then fill.');
    }
  }

  function scheduleRefresh() {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(() => refreshAnalysis(), RESCAN_DELAY_MS);
  }

  function resolveOption(group, requestedIndex, requestedLabel, allowPositionalFallback) {
    const normalizedRequestedLabel = normalizeLabel(requestedLabel);
    if (normalizedRequestedLabel) {
      const semanticMatch = group.options.find(
        (option) => option.source !== 'fallback' && normalizeLabel(option.label) === normalizedRequestedLabel,
      );
      if (semanticMatch) return semanticMatch;
    }
    return allowPositionalFallback ? group.options[requestedIndex] || null : null;
  }

  function setSelectIndex(select, index) {
    if (!isUsableRatingSelect(select, select.getRootNode())) return false;
    const view = select.ownerDocument.defaultView;
    const descriptor = Object.getOwnPropertyDescriptor(
      view.HTMLSelectElement.prototype,
      'selectedIndex',
    );
    if (descriptor?.set) descriptor.set.call(select, index);
    else select.selectedIndex = index;
    select.dispatchEvent(new view.Event('input', { bubbles: true }));
    select.dispatchEvent(new view.Event('change', { bubbles: true }));
    return select.selectedIndex === index;
  }

  async function activateOption(option) {
    if (option?.kind === 'select') {
      return setSelectIndex(option.element, option.nativeOption.index);
    }
    if (!option?.element?.isConnected || !isUsableControl(option.element, option.element.getRootNode())) {
      return false;
    }
    option.clickTarget.click();
    return optionIsSelected(option);
  }

  function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  async function fillSelectedCluster() {
    const { ui } = state;
    if (!ui || ui.fill.disabled) return;

    const hasRatingChoice = Boolean(ui.cluster.value) && ui.answer.value !== '';
    const requestedIndex = hasRatingChoice ? Number(ui.answer.value) : -1;
    const requestedLabel = ui.answer.selectedOptions[0]?.textContent?.replace(/^\d+\s+—\s+/, '') || '';
    const commentText = ui.comment.value.trim();
    const overwrite = ui.overwrite.checked;
    const selectedClusterKey = hasRatingChoice ? ui.cluster.value : '';

    ui.fill.disabled = true;
    setStatus('Filling visible questions…');

    // Re-read the live page immediately before clicking anything.
    const freshAnalysis = analyzePage();
    state.analysis = freshAnalysis;
    const cluster = hasRatingChoice
      ? freshAnalysis.clusters.find((item) => item.key === selectedClusterKey)
      : null;

    if (hasRatingChoice && !cluster) {
      setStatus('The form changed before filling. Rescan and choose the answer again.', 'warning');
      refreshAnalysis();
      return;
    }

    const ratingSnapshots = [];
    const textSnapshots = [];
    const report = {
      ratingsFilled: 0,
      ratingsPreserved: 0,
      ratingsFailed: 0,
      ratingsUnavailable: 0,
      textFilled: 0,
      textPreserved: 0,
      textFailed: 0,
    };

    for (const group of cluster?.groups || []) {
      const beforeIndex = selectedIndex(group);
      if (beforeIndex >= 0 && !overwrite) {
        report.ratingsPreserved += 1;
        continue;
      }

      const target = resolveOption(group, requestedIndex, requestedLabel, !cluster.signature);
      if (!target) {
        report.ratingsUnavailable += 1;
        continue;
      }

      if (beforeIndex === group.options.indexOf(target)) {
        report.ratingsPreserved += 1;
        continue;
      }

      const snapshot = {
        group,
        beforeIndex,
        beforeNativeIndex: group.kind === 'select' ? group.element.selectedIndex : null,
        selectedOption: target,
      };

      if (await activateOption(target)) {
        ratingSnapshots.push(snapshot);
        report.ratingsFilled += 1;
      } else {
        report.ratingsFailed += 1;
      }

      await wait(12);
    }

    if (commentText) {
      for (const field of freshAnalysis.commentFields) {
        const beforeValue = field.value;
        if (normalizeText(beforeValue)) {
          report.textPreserved += 1;
          continue;
        }

        if (setTextFieldValue(field, commentText)) {
          textSnapshots.push({ field, beforeValue, insertedValue: commentText });
          report.textFilled += 1;
        } else {
          report.textFailed += 1;
        }
        await wait(12);
      }
    }

    state.lastRun = { ratings: ratingSnapshots, textFields: textSnapshots };
    ui.undo.disabled = ratingSnapshots.length + textSnapshots.length === 0;
    const parts = [];
    if (hasRatingChoice) parts.push(`${report.ratingsFilled} ratings filled`);
    if (commentText) parts.push(`${report.textFilled} comments filled`);
    const preserved = report.ratingsPreserved + report.textPreserved;
    const failed = report.ratingsFailed + report.textFailed;
    if (preserved) parts.push(`kept ${preserved} existing`);
    if (report.ratingsUnavailable) parts.push(`${report.ratingsUnavailable} lacked that choice`);
    if (failed) parts.push(`${failed} did not respond`);
    refreshAnalysis();
    setStatus(`${parts.join('; ')}. No submit control was clicked.`, failed ? 'warning' : 'success');
  }

  function clearNativeRadio(option) {
    const input = option.element;
    const view = input.ownerDocument.defaultView;
    const descriptor = Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, 'checked');
    descriptor?.set?.call(input, false);
    input.dispatchEvent(new view.Event('input', { bubbles: true }));
    input.dispatchEvent(new view.Event('change', { bubbles: true }));
    return !input.checked;
  }

  function setTextFieldValue(field, value) {
    if (!field.isConnected || !isFeedbackTextField(field)) return false;
    const view = field.ownerDocument.defaultView;
    const prototype = field.matches('textarea')
      ? view.HTMLTextAreaElement.prototype
      : view.HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    descriptor?.set?.call(field, value);
    field.dispatchEvent(new view.Event('input', { bubbles: true }));
    field.dispatchEvent(new view.Event('change', { bubbles: true }));
    return field.value === value;
  }

  async function undoLastFill() {
    const runCount = (state.lastRun.ratings?.length || 0) + (state.lastRun.textFields?.length || 0);
    if (!state.ui || !runCount) return;
    state.ui.undo.disabled = true;
    setStatus('Restoring answers changed by the last fill…');

    let restored = 0;
    let skipped = 0;
    let failed = 0;

    for (const snapshot of [...state.lastRun.ratings].reverse()) {
      const { group, beforeIndex, beforeNativeIndex, selectedOption } = snapshot;
      if (!selectedOption.element.isConnected || !optionIsSelected(selectedOption)) {
        skipped += 1;
        continue;
      }

      if (group.kind === 'select') {
        if (setSelectIndex(group.element, beforeNativeIndex)) restored += 1;
        else failed += 1;
      } else if (beforeIndex >= 0) {
        const original = group.options[beforeIndex];
        if (original && await activateOption(original)) restored += 1;
        else failed += 1;
      } else if (selectedOption.kind === 'native') {
        if (clearNativeRadio(selectedOption)) restored += 1;
        else failed += 1;
      } else {
        // ARIA radio widgets often do not support a safe "no answer" state.
        skipped += 1;
      }

      await wait(12);
    }

    for (const snapshot of [...state.lastRun.textFields].reverse()) {
      const { field, beforeValue, insertedValue } = snapshot;
      if (!field.isConnected || field.value !== insertedValue) {
        skipped += 1;
        continue;
      }
      if (setTextFieldValue(field, beforeValue)) restored += 1;
      else failed += 1;
      await wait(12);
    }

    state.lastRun = { ratings: [], textFields: [] };
    const parts = [`Restored ${restored}`];
    if (skipped) parts.push(`skipped ${skipped} changed or custom controls`);
    if (failed) parts.push(`${failed} could not be restored`);
    refreshAnalysis();
    setStatus(`${parts.join('; ')}. No submit control was clicked.`, failed || skipped ? 'warning' : 'success');
  }

  function safePageLocation() {
    return `${location.origin}/${routeMatches() ? '#Course_Feedback' : '#other-route'}`;
  }

  function diagnosticReport() {
    const analysis = state.analysis || analyzePage();
    return {
      helper: 'SRM Academia Course Feedback Helper',
      version: VERSION,
      page: safePageLocation(),
      routeMatched: routeMatches(),
      capturedAt: new Date().toISOString(),
      scanned: {
        documentsAndOpenShadowRoots: analysis.contexts.length,
        inaccessibleFrames: analysis.inaccessibleFrames.length,
      },
      controls: {
        nativeRadioGroups: analysis.nativeGroupCount,
        ariaRadioGroups: analysis.ariaGroupCount,
        ratingSelectGroups: analysis.selectGroupCount,
        select2BackedRatingGroups: analysis.select2BackedGroupCount,
        feedbackTextFields: analysis.commentFields.length,
        visibleTextareas: analysis.visibleTextareaCount,
        visibleButtons: analysis.visibleButtonCount,
        nativeSelects: analysis.nativeSelectCount,
        select2Widgets: analysis.select2WidgetCount,
        skippedOrOneOffGroups: analysis.skippedGroupCount,
      },
      repeatedSets: analysis.clusters.map((cluster) => ({
        type: cluster.kind,
        questionCount: cluster.groups.length,
        optionCount: cluster.optionCount,
        labels: representativeLabels(cluster),
        labelsAreSemantic: Boolean(cluster.signature),
      })),
      inaccessibleFrameNotes: analysis.inaccessibleFrames,
      privacy: 'No cookies, browser storage, or credentials are included. Derived option labels may contain form text or identifiers; inspect and redact the report before sharing.',
    };
  }

  async function copyDiagnostics() {
    const text = JSON.stringify(diagnosticReport(), null, 2);
    try {
      if (typeof GM_setClipboard === 'function') {
        GM_setClipboard(text, 'text');
      } else {
        await navigator.clipboard.writeText(text);
      }
      console.info('[SRM Feedback Helper] Diagnostics', JSON.parse(text));
      setStatus('Diagnostics copied. Review the visible option labels before sharing.', 'success');
    } catch (error) {
      console.info('[SRM Feedback Helper] Diagnostics', JSON.parse(text));
      setStatus('Clipboard access failed. Diagnostics were printed in the browser console.', 'warning');
      console.error(error);
    }
  }

  window.addEventListener('hashchange', scheduleRefresh, { passive: true });
  window.addEventListener('popstate', scheduleRefresh, { passive: true });

  refreshAnalysis();
})();
