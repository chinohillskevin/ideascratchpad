(() => {
  'use strict';

  const STORAGE_KEY = 'drift-pads-v1';
  const GROUPS_KEY = 'drift-groups-v1';
  const LIBRARY_ORDER_KEY = 'drift-library-order-v1';
  const LIBRARY_LAYOUT_KEY = 'drift-library-layout-v1';
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const state = {
    pads: loadPads(),
    groups: loadGroups(),
    libraryOrder: loadLibraryOrder(),
    libraryLayout: loadLibraryLayout(),
    currentPad: null,
    currentGroup: null,
    currentFolderId: null,
    tool: 'pen',
    color: '#415343',
    drawing: false,
    lastPoint: null,
    mergeSource: null,
    isDirty: false,
  };

  const libraryView = $('#library-view');
  const editorView = $('#editor-view');
  const canvasStage = $('#canvas-stage');
  const canvas = $('#drawing-canvas');
  const ctx = canvas.getContext('2d');

  function loadPads() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
    catch { return []; }
  }

  function loadGroups() {
    try { return JSON.parse(localStorage.getItem(GROUPS_KEY)) || []; }
    catch { return []; }
  }

  function loadLibraryOrder() {
    try { return JSON.parse(localStorage.getItem(LIBRARY_ORDER_KEY)) || []; }
    catch { return []; }
  }

  function loadLibraryLayout() {
    try {
      const layout = JSON.parse(localStorage.getItem(LIBRARY_LAYOUT_KEY));
      return layout && typeof layout === 'object' && !Array.isArray(layout) ? layout : {};
    } catch { return {}; }
  }

  function persistPads() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.pads));
  }

  function persistGroups() {
    localStorage.setItem(GROUPS_KEY, JSON.stringify(state.groups));
  }

  function persistLibraryOrder() {
    localStorage.setItem(LIBRARY_ORDER_KEY, JSON.stringify(state.libraryOrder));
  }

  function persistLibraryLayout() {
    localStorage.setItem(LIBRARY_LAYOUT_KEY, JSON.stringify(state.libraryLayout));
  }

  function formatDate(timestamp) {
    return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(new Date(timestamp));
  }

  function makeId() { return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }

  function groupMembers(group) {
    if (Array.isArray(group.pads)) return group.pads;
    return (group.memberIds || []).map((id) => state.pads.find((pad) => pad.id === id)).filter(Boolean);
  }

  function migrateLegacyFolders() {
    let foldersChanged = false;
    let padsChanged = false;
    state.groups.forEach((folder) => {
      if (!Array.isArray(folder.pads)) {
        folder.pads = groupMembers(folder);
        folder.memberIds = folder.pads.map((pad) => pad.id);
        if (folder.noteEdits) Object.entries(folder.noteEdits).forEach(([padId, edit]) => {
          const pad = folder.pads.find((item) => item.id === padId);
          if (pad && edit.text !== undefined) pad.folderNoteText = edit.text;
        });
        foldersChanged = true;
      }
      folder.layout = folder.layout || {};
      const folderIds = new Set(folder.pads.map((pad) => pad.id));
      const remainingPads = state.pads.filter((pad) => !folderIds.has(pad.id));
      if (remainingPads.length !== state.pads.length) {
        state.pads = remainingPads;
        padsChanged = true;
      }
    });
    if (foldersChanged) persistGroups();
    if (padsChanged) persistPads();
  }

  function getFolderNote(folder, pad) {
    const edit = folder.noteEdits?.[pad.id] || {};
    const generic = ['A few lines are starting to find their shape.', 'A blank page, ready for something to begin.'];
    const sourceText = pad.folderNoteText ?? getPadPreview(pad);
    return {
      title: edit.title || pad.name || 'Untitled idea',
      text: edit.text ?? (generic.includes(sourceText) ? '' : sourceText),
    };
  }

  function renderLibrary() {
    const query = $('#search-input').value.trim().toLowerCase();
    const grid = $('#pad-grid');
    const template = $('#pad-card-template');
    const empty = $('#empty-library');
    const noResults = $('#no-results');
    grid.replaceChildren();
    if (!grid.dataset.openWired) {
      grid.addEventListener('click', (event) => {
        const openButton = event.target.closest('.card-open');
        const card = openButton?.closest('.pad-card');
        if (!card) return;
        event.stopPropagation();
        if (card.dataset.itemType === 'group') openGroup(card.dataset.itemId);
        else openPad(card.dataset.itemId);
      });
      grid.dataset.openWired = 'true';
      grid.addEventListener('dragover', (event) => {
        const card = $('.pad-card.is-dragging', grid);
        if (!card) return;
        event.preventDefault();
        const rect = grid.getBoundingClientRect();
        const nextX = Math.max(0, Math.min(event.clientX - rect.left - card.offsetWidth / 2, grid.clientWidth - card.offsetWidth));
        const nextY = Math.max(0, event.clientY - rect.top - card.offsetHeight / 2);
        card.style.left = `${nextX}px`;
        card.style.top = `${nextY}px`;
        state.libraryLayout[card.dataset.itemId] = { x: nextX, y: nextY };
        resizeLibraryWorkspace(grid);
      });
    }
    const totalPadCount = state.pads.length + state.groups.reduce((sum, folder) => sum + groupMembers(folder).length, 0);
    $('#pad-count').textContent = totalPadCount;

    const items = [
      ...state.groups.map((group) => ({ ...group, itemType: 'group' })),
      ...state.pads.map((pad) => ({ ...pad, itemType: 'pad' })),
    ].sort((a, b) => b.updatedAt - a.updatedAt);
    const order = new Map(state.libraryOrder.map((id, index) => [id, index]));
    items.sort((a, b) => {
      const aOrder = order.has(a.id) ? order.get(a.id) : -1;
      const bOrder = order.has(b.id) ? order.get(b.id) : -1;
      if (aOrder === -1 && bOrder === -1) return b.updatedAt - a.updatedAt;
      if (aOrder === -1) return -1;
      if (bOrder === -1) return 1;
      return aOrder - bOrder;
    });
    const visibleItems = items.filter((item) => {
      const members = item.itemType === 'group' ? groupMembers(item) : [];
      const memberText = members.map((pad) => `${pad.name} ${getPadPreview(pad)}`).join(' ');
      return `${item.name} ${item.preview || ''} ${memberText}`.toLowerCase().includes(query);
    });
    if (!items.length) {
      empty.hidden = false;
      noResults.hidden = true;
      return;
    }
    empty.hidden = true;
    noResults.hidden = !query || visibleItems.length > 0;
    visibleItems.forEach((item, index) => {
      const fragment = template.content.cloneNode(true);
      const card = $('.pad-card', fragment);
      const isGroup = item.itemType === 'group';
      const members = isGroup ? groupMembers(item) : [];
      card.classList.toggle('group-card', isGroup);
      card.dataset.itemId = item.id;
      card.dataset.itemType = item.itemType;
      card.draggable = !query;
      $('.card-index', card).textContent = String(index + 1).padStart(2, '0');
      $('.card-title', card).textContent = item.name || (isGroup ? 'Untitled group' : 'Untitled idea');
      const cardPreview = $('.card-preview', card);
      if (isGroup) {
        cardPreview.remove();
      } else {
        cardPreview.textContent = getPadPreview(item);
      }
      if (!isGroup) {
        const thumbnail = buildPadThumbnail(item);
        const thumbnailImage = $('.card-sketch-preview', card);
        if (thumbnail) { thumbnailImage.src = thumbnail; thumbnailImage.hidden = false; }
      } else $('.card-sketch-preview', card).replaceWith(buildFolderThumbnail(item, members));
      $('.card-meta', card).textContent = isGroup
        ? `FOLDER  ·  ${formatDate(item.updatedAt)}  ·  ${members.length} sticky notes`
        : `${formatDate(item.updatedAt)}  ·  ${(item.elements?.length || 0) + (item.strokes?.length || 0)} marks`;
      const actionButtons = $$('[data-card-action]', card);
      if (isGroup) {
        actionButtons[0].textContent = 'Rename folder';
        actionButtons[1].textContent = 'Add scratchpad';
        actionButtons[1].dataset.cardAction = 'add';
      }
      const openCardButton = $('.card-open', card);
      openCardButton.setAttribute('href', `#${isGroup ? 'folder' : 'pad'}/${item.id}`);
      const openCard = (event) => {
        event.stopPropagation();
        openLibraryItem(item.id, item.itemType);
      };
      openCardButton.addEventListener('click', openCard);
      openCardButton.addEventListener('mouseup', openCard);
      $('.card-menu', card).addEventListener('click', (event) => {
        event.stopPropagation();
        $$('.card-actions').forEach((menu) => { menu.hidden = true; });
        $('.card-actions', card).hidden = !$('.card-actions', card).hidden;
      });
      $$('[data-card-action]', card).forEach((button) => button.addEventListener('click', (event) => {
        event.stopPropagation();
        handleCardAction(button.dataset.cardAction, item.id);
      }));
      grid.appendChild(fragment);
      const columns = getLibraryColumnCount(grid);
      const cardGap = 22;
      const cardWidth = (grid.clientWidth - (columns - 1) * cardGap) / columns;
      const defaultPosition = {
        x: (index % columns) * (cardWidth + cardGap),
        y: Math.floor(index / columns) * 268,
      };
      const savedPosition = state.libraryLayout[item.id] || defaultPosition;
      const maxX = Math.max(0, grid.clientWidth - card.offsetWidth);
      card.style.left = `${Math.max(0, Math.min(savedPosition.x, maxX))}px`;
      card.style.top = `${Math.max(0, savedPosition.y)}px`;
      if (!query) {
        card.addEventListener('dragstart', (event) => {
          if (event.target.closest('.card-menu, .card-actions')) {
            event.preventDefault();
            return;
          }
          card.classList.add('is-dragging');
          event.dataTransfer.effectAllowed = 'move';
        });
        card.addEventListener('dragend', () => {
          card.classList.remove('is-dragging');
          persistLibraryLayout();
        });
      }
    });
    resizeLibraryWorkspace(grid);
  }

  function buildFolderThumbnail(folder, members) {
    const thumbnail = document.createElement('div');
    thumbnail.className = 'folder-card-thumbnail';
    if (!members.length) {
      thumbnail.textContent = 'Empty folder';
      return thumbnail;
    }
    members.forEach((pad, index) => {
      const note = getFolderNote(folder, pad);
      const miniNote = document.createElement('div');
      miniNote.className = 'folder-thumb-note';
      miniNote.style.transform = `rotate(${index % 2 ? 1.5 : -1.5}deg)`;
      const drawing = buildPadThumbnail(pad);
      if (drawing) miniNote.style.backgroundImage = `linear-gradient(rgba(245, 207, 104, .76), rgba(245, 207, 104, .76)), url("${drawing}")`;
      const title = document.createElement('strong');
      title.textContent = note.title;
      const text = document.createElement('span');
      text.textContent = note.text || 'No content yet';
      miniNote.append(title, text);
      thumbnail.appendChild(miniNote);
    });
    thumbnail.style.setProperty('--folder-thumb-rows', Math.ceil(members.length / 3));
    return thumbnail;
  }

  function getLibraryColumnCount(grid) {
    if (grid.clientWidth <= 470) return 1;
    if (grid.clientWidth <= 760) return 2;
    return 3;
  }

  function resizeLibraryWorkspace(grid) {
    const cards = $$('.pad-card', grid);
    const height = cards.reduce((max, card) => Math.max(max, card.offsetTop + card.offsetHeight + 30), 0);
    grid.style.minHeight = `${Math.max(500, height)}px`;
  }

  function openLibraryItem(id, itemType) {
    if (itemType === 'group') openGroup(id);
    else openPad(id);
  }

  function openHashItem() {
    const match = window.location.hash.match(/^#(pad|folder)\/(.+)$/);
    if (!match) return;
    if (match[1] === 'folder') openGroup(match[2]);
    else openPad(match[2]);
  }

  function showLibrary() {
    if (window.location.hash) history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    libraryView.hidden = false;
    editorView.hidden = true;
    state.currentPad = null;
    state.currentGroup = null;
    state.currentFolderId = null;
    state.currentFolderId = null;
    state.isDirty = false;
    editorView.classList.remove('group-view');
    renderLibrary();
  }

  function setEditorMode(mode) {
    const isGroup = mode === 'group';
    editorView.classList.toggle('group-view', isGroup);
    $('#editor-kicker').textContent = isGroup ? 'Folder page' : 'Now thinking in';
    $('.shelf-heading span:first-child').textContent = isGroup ? 'Folder paper' : 'Sticky notes';
    $('.shelf-hint').textContent = isGroup
      ? `${state.currentGroup?.memberIds.length || 0} scratchpads inside`
      : 'ideas outside the lines';
    $('#editor-title').disabled = isGroup;
    $('#save-pad-button').hidden = isGroup;
    $('.tool-dock').hidden = isGroup;
    canvas.hidden = isGroup;
    $('#text-layer').hidden = isGroup;
    $('#image-layer').hidden = isGroup;
    $('#sticky-layer').hidden = false;
  }

  function openNameModal() {
    $('#name-modal').hidden = false;
    const input = $('#new-pad-name');
    input.value = '';
    requestAnimationFrame(() => input.focus());
  }

  function closeModals() {
    $('#name-modal').hidden = true;
    $('#confirm-modal').hidden = true;
  }

  function openNewPad() {
    closeModals();
    state.currentPad = {
      id: makeId(),
      name: '',
      preview: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      strokes: [],
      elements: [],
    };
    state.currentGroup = null;
    state.isDirty = false;
    $('#editor-title').value = '';
    editorView.hidden = false;
    libraryView.hidden = true;
    setEditorMode('pad');
    clearCanvas(false);
    renderElements();
    setStatus('Unsaved changes');
  }

  function openPad(id, folderId = null) {
    const folder = folderId ? state.groups.find((item) => item.id === folderId) : null;
    const pad = folder ? groupMembers(folder).find((item) => item.id === id) : state.pads.find((item) => item.id === id);
    if (!pad) return;
    state.currentPad = JSON.parse(JSON.stringify(pad));
    state.currentGroup = null;
    state.currentFolderId = folder?.id || null;
    $('#editor-title').value = state.currentPad.name;
    editorView.hidden = false;
    libraryView.hidden = true;
    setEditorMode('pad');
    clearCanvas(false);
    drawStoredStrokes();
    renderElements();
    setStatus('Saved pad');
  }

  function openGroup(id) {
    const group = state.groups.find((item) => item.id === id);
    if (!group) return;
    state.currentPad = null;
    state.currentGroup = group;
    state.currentFolderId = null;
    state.isDirty = false;
    $('#editor-title').value = group.name || 'Untitled group';
    editorView.hidden = false;
    libraryView.hidden = true;
    setEditorMode('group');
    clearCanvas(false);
    $('#text-layer').replaceChildren();
    $('#image-layer').replaceChildren();
    renderGroupStickyNotes(group);
    setStatus(`${group.memberIds.length} scratchpads in this folder`);
  }

  function saveCurrentPad() {
    if (!state.currentPad) return;
    syncElementTextFromDom();
    state.currentPad.name = $('#editor-title').value.trim();
    state.currentPad.preview = getPreviewText();
    state.currentPad.updatedAt = Date.now();
    state.currentPad.strokes = state.currentPad.strokes || [];
    if (state.currentFolderId) {
      const folder = state.groups.find((item) => item.id === state.currentFolderId);
      const padIndex = folder ? folder.pads.findIndex((pad) => pad.id === state.currentPad.id) : -1;
      if (folder && padIndex >= 0) {
        folder.pads.splice(padIndex, 1, JSON.parse(JSON.stringify(state.currentPad)));
        folder.memberIds = folder.pads.map((pad) => pad.id);
        folder.updatedAt = Date.now();
        persistGroups();
        state.isDirty = false;
        openGroup(folder.id);
      }
      return;
    }
    const existingIndex = state.pads.findIndex((pad) => pad.id === state.currentPad.id);
    if (existingIndex >= 0) state.pads.splice(existingIndex, 1, JSON.parse(JSON.stringify(state.currentPad)));
    else state.pads.unshift(JSON.parse(JSON.stringify(state.currentPad)));
    persistPads();
    state.isDirty = false;
    showLibrary();
  }

  function renderGroupStickyNotes(group) {
    const layer = $('#sticky-layer');
    layer.replaceChildren();
    groupMembers(group).forEach((pad, index) => {
      const folderNote = getFolderNote(group, pad);
      const position = group.layout?.[pad.id] || { x: 18 + (index % 3) * 215, y: 18 + Math.floor(index / 3) * 190 };
      const note = document.createElement('div');
      note.className = 'sticky-note group-sticky';
      note.dataset.padId = pad.id;
      note.style.setProperty('--folder-note-left', `${position.x}px`);
      note.style.setProperty('--folder-note-top', `${position.y}px`);
      note.style.transform = `rotate(${index % 2 ? 1.5 : -1.5}deg)`;
      note.contentEditable = 'false';
      const header = document.createElement('div');
      header.className = 'folder-note-header';
      const title = document.createElement('strong');
      title.className = 'folder-note-title';
      title.textContent = folderNote.title;
      const openButton = document.createElement('button');
      openButton.className = 'folder-note-open';
      openButton.type = 'button';
      openButton.title = 'Open scratchpad';
      openButton.setAttribute('aria-label', `Open ${folderNote.title}`);
      openButton.textContent = '✎';
      openButton.addEventListener('click', (event) => {
        event.stopPropagation();
        openPad(pad.id, group.id);
      });
      const removeButton = document.createElement('button');
      removeButton.className = 'folder-note-remove';
      removeButton.type = 'button';
      removeButton.title = 'Take scratchpad out of folder';
      removeButton.setAttribute('aria-label', `Take ${folderNote.title} out of folder`);
      removeButton.textContent = '×';
      removeButton.addEventListener('click', (event) => {
        event.stopPropagation();
        if (!window.confirm('Take this scratchpad out of the folder? The original pad will stay safe.')) return;
        group.pads = group.pads.filter((member) => member.id !== pad.id);
        group.memberIds = group.pads.map((member) => member.id);
        state.pads.unshift(pad);
        if (group.noteEdits) delete group.noteEdits[pad.id];
        if (group.layout) delete group.layout[pad.id];
        group.updatedAt = Date.now();
        persistGroups();
        persistPads();
        renderGroupStickyNotes(group);
        setStatus(`${group.memberIds.length} scratchpads in this folder`);
      });
      header.append(title, openButton, removeButton);
      note.appendChild(header);
      makeFolderNoteDraggable(note, group, pad);
      const preview = document.createElement('div');
      preview.className = 'folder-note-preview';
      preview.contentEditable = 'true';
      preview.spellcheck = true;
      preview.dataset.placeholder = 'Add a note…';
      preview.textContent = folderNote.text;
      preview.addEventListener('input', () => {
        pad.folderNoteText = preview.textContent;
        pad.preview = preview.textContent;
        group.updatedAt = Date.now();
        persistGroups();
        setStatus('Folder changes saved');
      });
      note.appendChild(preview);
      const thumbnail = buildPadThumbnail(pad);
      if (thumbnail) {
        const image = document.createElement('img');
        image.className = 'folder-note-image';
        image.src = thumbnail;
        image.alt = 'Scratchpad drawing preview';
        note.appendChild(image);
      }
      layer.appendChild(note);
    });
  }

  function makeFolderNoteDraggable(note, folder, pad) {
    let dragging = false;
    const start = (event) => {
      if (dragging) return;
      if (event.target.closest('button')) return;
      const layer = $('#sticky-layer');
      const layerRect = layer.getBoundingClientRect();
      const noteRect = note.getBoundingClientRect();
      const offsetX = event.clientX - noteRect.left;
      const offsetY = event.clientY - noteRect.top;
      const startX = event.clientX;
      const startY = event.clientY;
      const move = (moveEvent) => {
        if (!dragging && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 4) return;
        if (!dragging) {
          dragging = true;
          moveEvent.preventDefault();
        }
        const nextX = Math.max(0, Math.min(moveEvent.clientX - layerRect.left - offsetX, layer.clientWidth - note.offsetWidth));
        const nextY = Math.max(0, Math.min(moveEvent.clientY - layerRect.top - offsetY, layer.clientHeight - note.offsetHeight));
        note.style.setProperty('--folder-note-left', `${nextX}px`);
        note.style.setProperty('--folder-note-top', `${nextY}px`);
        folder.layout = folder.layout || {};
        folder.layout[pad.id] = { x: nextX, y: nextY };
      };
      const end = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('mousemove', move);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
        document.removeEventListener('mouseup', end);
        if (!dragging) return;
        dragging = false;
        folder.updatedAt = Date.now();
        persistGroups();
        setStatus('Folder changes saved');
      };
      if (note.setPointerCapture && event.pointerId !== undefined) note.setPointerCapture(event.pointerId);
      window.addEventListener('pointermove', move);
      window.addEventListener('mousemove', move);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
      document.addEventListener('mouseup', end);
    };
    note.addEventListener('pointerdown', start);
  }

  function getPreviewText() {
    return getPadPreview(state.currentPad);
  }

  function cleanIdeaText(text) {
    return String(text || '').replace(/\s*write it down…/gi, '').trim();
  }

  function getPadPreview(pad) {
    const elements = pad?.elements || [];
    const stickyText = elements
      .filter((element) => element.type === 'sticky')
      .map((element) => cleanIdeaText(element.text))
      .filter(Boolean);
    const writtenText = elements
      .filter((element) => element.type === 'text')
      .map((element) => cleanIdeaText(element.text))
      .filter(Boolean);
    const content = [...stickyText, ...writtenText].join(' ');
    if (content) return content;
    const savedPreview = cleanIdeaText(pad?.preview);
    const genericPreview = ['A few lines are starting to find their shape.', 'A blank page, ready for something to begin.'];
    if (savedPreview && !genericPreview.includes(savedPreview)) return savedPreview;
    return pad?.strokes?.length ? '' : 'A blank page, ready for something to begin.';
  }

  function buildPadThumbnail(pad) {
    const elements = pad?.elements || [];
    const hasStrokes = (pad?.strokes || []).some((stroke) => stroke.points?.length);
    const textElements = elements.filter((element) => element.type === 'text' && cleanIdeaText(element.text));
    if (!hasStrokes && !textElements.length) return '';
    const previewCanvas = document.createElement('canvas');
    previewCanvas.width = 320; previewCanvas.height = 180;
    const previewContext = previewCanvas.getContext('2d');
    previewContext.fillStyle = '#fffefa'; previewContext.fillRect(0, 0, 320, 180);
    previewContext.strokeStyle = 'rgba(214,220,210,.5)'; previewContext.lineWidth = 1;
    for (let x = 0; x <= 320; x += 20) { previewContext.beginPath(); previewContext.moveTo(x, 0); previewContext.lineTo(x, 180); previewContext.stroke(); }
    for (let y = 0; y <= 180; y += 20) { previewContext.beginPath(); previewContext.moveTo(0, y); previewContext.lineTo(320, y); previewContext.stroke(); }
    const scaleX = 320 / 700; const scaleY = 180 / 470;
    (pad.strokes || []).forEach((stroke) => {
      if (!stroke.points?.length) return;
      const isEraser = stroke.tool === 'eraser';
      previewContext.globalCompositeOperation = isEraser ? 'destination-out' : 'source-over';
      previewContext.globalAlpha = stroke.tool === 'highlighter' ? .22 : 1;
      previewContext.strokeStyle = stroke.color || '#415343';
      previewContext.lineWidth = stroke.tool === 'highlighter' ? 10 : 2.5;
      previewContext.lineCap = 'round'; previewContext.lineJoin = 'round';
      previewContext.beginPath();
      stroke.points.forEach((point, index) => { const x = point.x * scaleX; const y = point.y * scaleY; if (index) previewContext.lineTo(x, y); else previewContext.moveTo(x, y); });
      previewContext.stroke();
    });
    previewContext.globalCompositeOperation = 'source-over'; previewContext.globalAlpha = 1;
    textElements.forEach((element) => {
      previewContext.fillStyle = element.color || '#415343';
      previewContext.font = '12px Georgia, serif';
      const lines = cleanIdeaText(element.text).split(/\n/).slice(0, 5);
      lines.forEach((line, index) => previewContext.fillText(line.slice(0, 34), element.x * scaleX, element.y * scaleY + 13 + index * 14));
    });
    return previewCanvas.toDataURL('image/png');
  }

  function syncElementTextFromDom() {
    if (!state.currentPad) return;
    state.currentPad.elements.forEach((element) => {
      if (element.type === 'sticky') {
        const note = $(`.sticky-note[data-id="${element.id}"]`);
        if (note) element.text = note.textContent;
      }
      if (element.type === 'text') {
        const input = $(`.canvas-text[data-id="${element.id}"]`);
        if (input) element.text = input.value;
      }
    });
  }

  function setStatus(text) {
    $('#editor-status').textContent = text;
  }

  function markDirty() {
    state.isDirty = true;
    setStatus('Unsaved changes');
  }

  function resizeCanvas() {
    if (editorView.hidden || !canvasStage) return;
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    const width = canvasStage.clientWidth;
    const height = canvasStage.clientHeight;
    if (!width || !height) return;
    const previous = document.createElement('canvas');
    previous.width = canvas.width; previous.height = canvas.height;
    if (canvas.width && canvas.height) previous.getContext('2d').drawImage(canvas, 0, 0);
    canvas.width = width * ratio; canvas.height = height * ratio;
    canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    if (previous.width && previous.height) ctx.drawImage(previous, 0, 0, previous.width / ratio, previous.height / ratio, 0, 0, width, height);
  }

  function canvasPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function setupDrawing() {
    canvas.addEventListener('pointerdown', (event) => {
      if (state.tool !== 'pen' && state.tool !== 'eraser' && state.tool !== 'highlighter') return;
      state.drawing = true;
      state.lastPoint = canvasPoint(event);
      state.activeStroke = { tool: state.tool, color: state.color, points: [state.lastPoint] };
      state.currentPad.strokes.push(state.activeStroke);
      canvas.setPointerCapture(event.pointerId);
      drawDot(state.lastPoint);
    });
    canvas.addEventListener('pointermove', (event) => {
      if (!state.drawing) return;
      const point = canvasPoint(event);
      drawLine(state.lastPoint, point);
      state.lastPoint = point;
      state.activeStroke?.points.push(point);
    });
    ['pointerup', 'pointercancel'].forEach((type) => canvas.addEventListener(type, () => {
      if (state.drawing) {
        state.drawing = false;
        state.lastPoint = null;
        state.activeStroke = null;
        markDirty();
      }
    }));
    window.addEventListener('resize', resizeCanvas);
  }

  function configureBrush() {
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (state.tool === 'eraser') { ctx.globalCompositeOperation = 'destination-out'; ctx.lineWidth = 24; }
    else if (state.tool === 'highlighter') { ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = .22; ctx.strokeStyle = state.color; ctx.lineWidth = 20; }
    else { ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1; ctx.strokeStyle = state.color; ctx.lineWidth = 3; }
  }

  function drawDot(point) { configureBrush(); ctx.beginPath(); ctx.arc(point.x, point.y, ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fillStyle = ctx.strokeStyle; ctx.fill(); }
  function drawLine(from, to) { configureBrush(); ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke(); }

  function drawStoredStrokes() {
    (state.currentPad.strokes || []).forEach((stroke) => {
      if (!stroke.points?.length) return;
      state.tool = stroke.tool || 'pen';
      state.color = stroke.color || state.color;
      for (let i = 1; i < stroke.points.length; i++) drawLine(stroke.points[i - 1], stroke.points[i]);
    });
    state.tool = 'pen';
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  }

  function clearCanvas(mark = true) {
    resizeCanvas();
    ctx.clearRect(0, 0, canvasStage.clientWidth, canvasStage.clientHeight);
    if (mark && state.currentPad) { state.currentPad.strokes = []; markDirty(); }
  }

  function selectTool(tool) {
    state.tool = tool;
    $$('.tool-button[data-tool]').forEach((button) => button.classList.toggle('active', button.dataset.tool === tool));
    canvas.style.cursor = ['text', 'sticky', 'image'].includes(tool) ? 'copy' : 'crosshair';
    if (tool === 'text') addTextElement();
    if (tool === 'sticky') addStickyElement();
    if (tool === 'image') $('#image-input').click();
  }

  function addTextElement() {
    const element = { id: makeId(), type: 'text', text: '', color: state.color, x: 80 + Math.random() * 100, y: 80 + Math.random() * 80 };
    state.currentPad.elements.push(element); renderElements();
    const input = $(`.canvas-text[data-id="${element.id}"]`);
    input.focus();
  }

  function addStickyElement() {
    const element = { id: makeId(), type: 'sticky', text: '', x: 140 + Math.random() * 160, y: 100 + Math.random() * 130 };
    state.currentPad.elements.push(element); renderElements();
    const note = $(`.sticky-note[data-id="${element.id}"]`);
    note.focus();
    note.addEventListener('input', () => { element.text = note.textContent; markDirty(); });
  }

  function renderElements() {
    $('#text-layer').replaceChildren(); $('#sticky-layer').replaceChildren(); $('#image-layer').replaceChildren();
    (state.currentPad?.elements || []).forEach((element) => {
      if (element.type === 'text') {
        const object = document.createElement('div');
        object.className = 'text-object'; object.dataset.id = element.id;
        object.style.left = `${element.x}px`; object.style.top = `${element.y}px`;
        const dragHandle = document.createElement('div');
        dragHandle.className = 'text-drag-handle';
        const deleteButton = document.createElement('button');
        deleteButton.className = 'element-delete'; deleteButton.type = 'button'; deleteButton.title = 'Delete textbox'; deleteButton.setAttribute('aria-label', 'Delete textbox'); deleteButton.textContent = '×';
        deleteButton.addEventListener('click', (event) => {
          event.stopPropagation();
          state.currentPad.elements = state.currentPad.elements.filter((item) => item.id !== element.id);
          renderElements(); markDirty();
        });
        dragHandle.appendChild(deleteButton);
        const dragLabel = document.createElement('span'); dragLabel.textContent = 'move'; dragHandle.appendChild(dragLabel);
        const input = document.createElement('textarea');
        input.className = 'canvas-text'; input.dataset.id = element.id; input.placeholder = 'type an idea…'; input.value = element.text || '';
        input.style.color = element.color || state.color;
        input.addEventListener('input', () => { element.text = input.value; markDirty(); });
        object.append(dragHandle, input);
        makeElementDraggable(object, dragHandle, element);
        $('#text-layer').appendChild(object);
      } else if (element.type === 'sticky') {
        const note = document.createElement('div');
        note.className = 'sticky-note'; note.dataset.id = element.id; note.contentEditable = 'true'; note.spellcheck = true; note.textContent = element.text || '';
        note.style.left = `${element.x}px`; note.style.top = `${element.y}px`;
        note.addEventListener('input', () => { element.text = note.textContent; markDirty(); });
        $('#sticky-layer').appendChild(note);
      } else if (element.type === 'image') {
        const img = document.createElement('img'); img.className = 'image-object'; img.src = element.src; img.alt = 'Idea image'; img.style.left = `${element.x}px`; img.style.top = `${element.y}px`;
        $('#image-layer').appendChild(img);
      }
    });
  }

  function makeElementDraggable(object, handle, element) {
    handle.addEventListener('pointerdown', (event) => {
      if (event.target.closest('.element-delete')) return;
      event.preventDefault();
      const stageRect = canvasStage.getBoundingClientRect();
      const objectRect = object.getBoundingClientRect();
      const offsetX = event.clientX - objectRect.left;
      const offsetY = event.clientY - objectRect.top;
      const move = (moveEvent) => {
        const nextX = moveEvent.clientX - stageRect.left - offsetX;
        const nextY = moveEvent.clientY - stageRect.top - offsetY;
        element.x = Math.max(0, Math.min(nextX, canvasStage.clientWidth - object.offsetWidth));
        element.y = Math.max(0, Math.min(nextY, canvasStage.clientHeight - object.offsetHeight));
        object.style.left = `${element.x}px`;
        object.style.top = `${element.y}px`;
      };
      const end = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', end);
        handle.removeEventListener('pointercancel', end);
        markDirty();
      };
      if (handle.setPointerCapture) handle.setPointerCapture(event.pointerId);
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    });
  }

  function handleImage(event) {
    const file = event.target.files?.[0];
    if (!file || !state.currentPad) return;
    const reader = new FileReader();
    reader.onload = () => { state.currentPad.elements.push({ id: makeId(), type: 'image', src: reader.result, x: 100, y: 90 }); renderElements(); markDirty(); };
    reader.readAsDataURL(file); event.target.value = '';
  }

  function handleCardAction(action, id) {
    const group = state.groups.find((item) => item.id === id);
    if (group) {
      if (action === 'rename') {
        const nextName = window.prompt('Rename this folder', group.name || 'Untitled folder');
        if (nextName === null) return;
        group.name = nextName.trim(); group.updatedAt = Date.now(); persistGroups(); renderLibrary();
      } else if (action === 'add') {
        openAddToFolderModal(id);
      } else if (action === 'delete') {
        if (!window.confirm('Delete this folder? The original pads will stay safe.')) return;
        const movedPads = groupMembers(group);
        state.pads.push(...movedPads);
        state.groups = state.groups.filter((item) => item.id !== id); persistGroups(); renderLibrary();
        persistPads();
      }
      return;
    }
    const pad = state.pads.find((item) => item.id === id);
    if (!pad) return;
    if (action === 'rename') {
      const nextName = window.prompt('Rename this pad', pad.name || 'Untitled idea');
      if (nextName === null) return;
      pad.name = nextName.trim(); pad.updatedAt = Date.now(); persistPads(); renderLibrary();
    } else if (action === 'delete') {
      if (!window.confirm('Delete this pad? This cannot be undone.')) return;
      state.pads = state.pads.filter((item) => item.id !== id); persistPads(); renderLibrary();
    } else if (action === 'merge') {
      openMergeModal(id);
    }
  }

  function openMergeModal(sourceId) {
    const choices = state.pads.filter((pad) => pad.id !== sourceId);
    if (!choices.length) { window.alert('Save another scratchpad first, then you can make a folder.'); return; }
    const target = choices[0];
    state.mergeSource = { sourceId, targetId: target.id, folderId: null };
    $('#merge-first-label').textContent = state.pads.find((pad) => pad.id === sourceId)?.name || 'Untitled idea';
    $('#merge-second-label').textContent = target.name || 'Untitled idea';
    $('#folder-modal-title').innerHTML = 'Make a<br><em>folder?</em>';
    $('#folder-modal-copy').textContent = 'Create a big paper folder with one sticky note for each scratchpad. The scratchpads will move into the folder.';
    $('#confirm-merge-button').innerHTML = 'Create folder <span>↗</span>';
    $('#confirm-modal').hidden = false;
  }

  function openAddToFolderModal(folderId) {
    const folder = state.groups.find((item) => item.id === folderId);
    if (!folder) return;
    const choices = state.pads.filter((pad) => !folder.memberIds.includes(pad.id));
    if (!choices.length) { window.alert('Every scratchpad is already in this folder.'); return; }
    const source = choices[0];
    state.mergeSource = { sourceId: source.id, targetId: null, folderId };
    $('#merge-first-label').textContent = source.name || 'Untitled idea';
    $('#merge-second-label').textContent = folder.name || 'Untitled folder';
    $('#folder-modal-title').innerHTML = 'Add a scratchpad<br><em>to this folder?</em>';
    $('#folder-modal-copy').textContent = 'This scratchpad will move into the folder as a new sticky note on the folder paper.';
    $('#confirm-merge-button').innerHTML = 'Add to folder <span>↗</span>';
    $('#confirm-modal').hidden = false;
  }

  function confirmMerge() {
    if (!state.mergeSource) return;
    const source = state.pads.find((pad) => pad.id === state.mergeSource.sourceId);
    if (state.mergeSource.folderId) {
      const folder = state.groups.find((item) => item.id === state.mergeSource.folderId);
      if (!source || !folder || folder.memberIds.includes(source.id)) return;
      folder.pads = folder.pads || [];
      folder.pads.push(source);
      state.pads = state.pads.filter((pad) => pad.id !== source.id);
      folder.memberIds = folder.pads.map((pad) => pad.id);
      folder.updatedAt = Date.now();
      persistGroups(); persistPads(); closeModals(); renderLibrary();
      return;
    }
    const target = state.pads.find((pad) => pad.id === state.mergeSource.targetId);
    if (!source || !target) return;
    const members = [source.id, target.id].sort();
    const existingGroup = state.groups.find((group) => groupMembers(group).map((pad) => pad.id).sort().join('|') === members.join('|'));
    if (!existingGroup) {
      const folderPads = [source, target];
      state.groups.unshift({
        id: makeId(),
        name: `${source.name || 'Untitled idea'} + ${target.name || 'Untitled idea'}`,
        memberIds: members,
        pads: folderPads,
        layout: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      persistGroups();
    }
    state.pads = state.pads.filter((pad) => pad.id !== source.id && pad.id !== target.id);
    persistPads();
    closeModals(); renderLibrary();
  }

  function wireEvents() {
    $('#new-pad-button').addEventListener('click', openNameModal);
    $$('[data-action="new-pad"]').forEach((button) => button.addEventListener('click', openNameModal));
    $$('[data-action="close-name-modal"], [data-action="close-confirm-modal"]').forEach((button) => button.addEventListener('click', closeModals));
    $('#name-form').addEventListener('submit', (event) => { event.preventDefault(); openNewPad(); state.currentPad.name = $('#new-pad-name').value.trim(); $('#editor-title').value = state.currentPad.name; });
    $('#save-pad-button').addEventListener('click', saveCurrentPad);
    $('[data-action="back-to-library"]').addEventListener('click', () => {
      if (state.isDirty && !window.confirm('Leave without saving this pad?')) return;
      if (state.currentFolderId) openGroup(state.currentFolderId);
      else showLibrary();
    });
    $('[data-action="home"]').addEventListener('click', (event) => { event.preventDefault(); showLibrary(); });
    window.addEventListener('hashchange', openHashItem);
    $('[data-action="clear-canvas"]').addEventListener('click', () => { if (window.confirm('Clear every drawing on this pad?')) clearCanvas(true); });
    $('#confirm-merge-button').addEventListener('click', confirmMerge);
    $('#search-input').addEventListener('input', renderLibrary);
    $('#color-input').addEventListener('input', (event) => {
      state.color = event.target.value;
      $$('.canvas-text[data-id]').forEach((input) => { input.style.color = state.color; });
      if (state.currentPad) {
        state.currentPad.elements.filter((element) => element.type === 'text').forEach((element) => { element.color = state.color; });
        markDirty();
      }
    });
    document.addEventListener('click', (event) => { if (!event.target.closest('.card-menu, .card-actions')) $$('.card-actions').forEach((menu) => { menu.hidden = true; }); });
    $$('[data-tool]').forEach((button) => button.addEventListener('click', () => selectTool(button.dataset.tool)));
    $('#image-input').addEventListener('change', handleImage);
    $('#editor-title').addEventListener('input', markDirty);
    document.addEventListener('keydown', (event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#search-input').focus(); } if (event.key === 'Escape') closeModals(); });
  }

  migrateLegacyFolders();
  setupDrawing(); wireEvents(); renderLibrary(); openHashItem();
})();
