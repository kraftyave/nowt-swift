const STORAGE_KEY = "nowt.notes.v1";
const SESSION_KEY = "nowt.session.v1";
const DB_NAME = "nowt-media";
const DB_STORE = "files";
const categories = ["all", "text", "images", "links", "voice"];
const FOLDER_HANDLE_KEY = "nowt.folder.handle";
const PRO_KEY = "nowt.pro.v1";
const THEME_KEY = "nowt.theme.v1";
const DODO_MONTHLY_ID = "pdt_0NfgzTdbx1s8BzqSXZHHv";
const DODO_ANNUAL_ID  = "pdt_0Nfl4oQx1s5uAd5MUyTvm";
const DODO_PORTAL_URL = "https://billing.dodopayments.com/portal";
const DOWNLOAD_URL_ARM64 = "https://github.com/kraftyave/nowt-releases/releases/download/v1.0.0/Nowt-1.0.0-arm64.dmg";
const DOWNLOAD_URL_X64   = "https://github.com/kraftyave/nowt-releases/releases/download/v1.0.0/Nowt-1.0.0.dmg";
const isIntelMac = typeof navigator !== "undefined" && navigator.userAgent.includes("Intel Mac OS X");

window.nowtNative = {
  readFile: () => Promise.resolve(null),
  writeFile: () => Promise.resolve(),
  readBinary: () => Promise.resolve(null),
  writeBinary: () => Promise.resolve(),
  exists: () => Promise.resolve(false),
  ensureDir: () => Promise.resolve(),
  pickPhoto: () => Promise.resolve(null),
  openCheckout: () => Promise.resolve({ success: true }),
  onMenu: (cb) => { window.__nowtMenuCallback = cb; }
};
window.__nowtPending = {};
window.__nowtCallId = 0;
window.__nowtCall = () => Promise.resolve(null);
window.__nowtResolve = () => {};
window.__nowtReject = () => {};
window.__nowtMenu = (action) => { if (window.__nowtMenuCallback) window.__nowtMenuCallback(action); };
const DOWNLOAD_URL = isIntelMac ? DOWNLOAD_URL_X64 : DOWNLOAD_URL_ARM64;

function track(name, data) { window.va?.("event", { name, ...(data && { data }) }); }

async function verifySubscription(email) {
  try {
    const r = await fetch(`/api/verify?email=${encodeURIComponent(email)}`);
    if (!r.ok) return null;
    const { pro } = await r.json();
    return pro; // true | false | null (null = unknown, fail open)
  } catch {
    return null;
  }
}
const statuses = ["active", "archived"];
const listFilters = ["notes", "archive", "trash"];
const commands = [
  ["H1", "H1", "formatBlock", "h1"],
  ["H2", "H2", "formatBlock", "h2"],
  ["H3", "H3", "formatBlock", "h3"],
  ["B", "B", "bold"],
  ["I", "I", "italic"],
  ["Quote", "“”", "formatBlock", "blockquote"],
  ["List", "•", "insertUnorderedList"],
  ["Numbered list", "1.", "insertOrderedList"],
  ["Line spacing", "↕", "lineSpacing"],
];

let mediaDb;
let state = loadState();
let session = loadSession();
let objectUrls = new Map();
let recorder = null;
let chunks = [];
let liveTranscript = "";
let recognition = null;
let activeBlockId = null;
let pendingJump = null;
let _dragMediaId = null;
let pendingTableCell = null;
let searchFrame = null;
let folderHandle = null;
let folderWriteTimer = null;
let proUpgradeOpen = false;
let proUpgradeReason = "";
let proRestoreOpen = false;
let proRestoreFromCheckout = false;
let proCheckoutPending = false;
let proUpgradeBilling = "annual";
let landingBilling = "annual";
let landingAnimCleanup = null;
let sketchOpen = false;
let activeSketchId = null;
let _sketchCtx = null;
let _dragCheckBlock = null;
let selectedNoteIds = new Set();
let selectMode = false;
let ocrWorker = null;
let ocrWorkerLoading = false;
let _lastEditorRange = null;
let linkInputOpen = false;
let _linkSelectionRange = null;

const app = document.querySelector("#app");
normalizeState();

if (typeof DodoPayments !== "undefined") {
  DodoPayments.Initialize({
    mode: "live",
    displayType: "overlay",
    onEvent: (event) => {
      if (event.event_type === "checkout.payment_succeeded" || event.event_type === "subscription.active") {
        const email = event.data?.customer?.email || event.data?.email || "";
        const subId  = event.data?.subscription_id || event.data?.payment_id || "";
        if (email) { activatePro(email, subId); proRestoreOpen = false; proUpgradeOpen = false; render(); }
        else { proRestoreOpen = true; render(); }
      }
    },
  });
}

function uid(prefix = "id") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function now() {
  return new Date().toISOString();
}

function stripHtml(html) {
  const div = document.createElement("div");
  div.innerHTML = html || "";
  return div.textContent || div.innerText || "";
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[char]);
}

function serializeEditor(el) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll("img").forEach((img) => img.removeAttribute("src"));
  clone.querySelectorAll("audio").forEach((audio) => audio.removeAttribute("src"));
  clone.querySelectorAll(".att-controls").forEach((e) => e.remove());
  clone.querySelectorAll(".inline-figure .image-size").forEach((e) => e.remove());
  clone.querySelectorAll(".inline-figure img").forEach((e) => e.remove());
  clone.querySelectorAll(".inline-voice").forEach((div) => { div.innerHTML = ""; });
  clone.querySelectorAll(".inline-table .table-actions").forEach((e) => e.remove());
  clone.querySelectorAll(".inline-table td").forEach((td) => {
    td.removeAttribute("contenteditable");
    td.removeAttribute("data-table-cell");
  });
  clone.querySelectorAll(".check-drag-handle").forEach((e) => e.remove());
  clone.querySelectorAll(".h-toggle").forEach((e) => e.remove());
  clone.querySelectorAll("[data-collapsed]").forEach((e) => e.removeAttribute("data-collapsed"));
  return clone.innerHTML || "<p></p>";
}

function migrateBlocksToInline(tab) {
  if (!tab.blocks?.length) return tab.content || "<p></p>";
  return tab.blocks.map((block) => {
    if (block.type === "text") return block.html || "";
    if (block.type === "image" || block.type === "voice") {
      const item = tab.attachments.find((a) => a.id === block.attachmentId);
      if (!item) return "";
      if (item.kind === "photo") return `<span contenteditable="false" class="inline-figure" data-attachment="${item.id}" style="--image-width:${item.width || 42}%"></span>`;
      return `<span contenteditable="false" class="inline-voice" data-attachment="${item.id}"></span>`;
    }
    if (block.type === "table") {
      const rows = block.rows || [["", ""], ["", ""]];
      const tbody = rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("");
      return `<div contenteditable="false" class="inline-table" data-table-id="${block.id}"><table><tbody>${tbody}</tbody></table></div>`;
    }
    return "";
  }).join("") || "<p></p>";
}

function applyTheme() {
  const theme = localStorage.getItem(THEME_KEY) || "system";
  document.documentElement.classList.remove("light", "dark");
  if (theme === "dark") document.documentElement.classList.add("dark");
  if (theme === "light") document.documentElement.classList.add("light");
}

function isDark() {
  const theme = localStorage.getItem(THEME_KEY) || "system";
  if (theme === "dark") return true;
  if (theme === "light") return false;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

function toggleHeadingCollapse(heading) {
  const level = parseInt(heading.tagName[1]);
  const isCollapsed = heading.dataset.collapsed === "true";
  const body = [];
  let el = heading.nextElementSibling;
  while (el) {
    const m = el.tagName?.match(/^H([123])$/);
    if (m && parseInt(m[1]) <= level) break;
    body.push(el);
    el = el.nextElementSibling;
  }
  const toggle = heading.querySelector(".h-toggle");
  if (isCollapsed) {
    delete heading.dataset.collapsed;
    body.forEach((el) => (el.style.display = ""));
    if (toggle) toggle.textContent = "▸";
  } else {
    heading.dataset.collapsed = "true";
    body.forEach((el) => (el.style.display = "none"));
    if (toggle) toggle.textContent = "▾";
  }
}

function initHeadingToggles() {
  document.querySelectorAll("[data-editor]").forEach((editor) => {
    editor.querySelectorAll("h1, h2, h3").forEach((heading) => {
      if (heading.querySelector(".h-toggle")) return;
      const btn = document.createElement("span");
      btn.className = "h-toggle";
      btn.contentEditable = "false";
      btn.textContent = "▸";
      heading.insertBefore(btn, heading.firstChild);
    });
  });
}

// ── Markdown shortcuts ────────────────────────────────────────────────────────

function getEditorBlock(editor, node) {
  if (node.nodeType === Node.TEXT_NODE) node = node.parentNode;
  while (node && node !== editor) {
    if (["P", "DIV", "H1", "H2", "H3", "LI", "BLOCKQUOTE"].includes(node.tagName)) return node;
    node = node.parentNode;
  }
  return null;
}

function base64ToFile(b64, name, type) {
  const bytes = atob(b64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new File([arr], name, { type });
}

function createCheckboxElement() {
  const span = document.createElement("span");
  span.contentEditable = "false";
  span.className = "inline-check";
  span.setAttribute("data-checked", "false");
  return span;
}

function isAtomicInlineBlock(el) {
  return el?.matches?.(".inline-voice, .inline-figure, .inline-table");
}

function isEditableTextBlock(el) {
  return el?.matches?.("p, h1, h2, h3, blockquote") && el.getAttribute("contenteditable") !== "false";
}

function isEditableParagraphBlock(el) {
  return el?.matches?.("p, div") && el.getAttribute("contenteditable") !== "false" && !isAtomicInlineBlock(el);
}

function createEmptyParagraph() {
  const p = document.createElement("p");
  p.innerHTML = "<br>";
  return p;
}

function directEditorChild(node, editor) {
  if (!node) return null;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentNode;
  while (node && node.parentElement !== editor) node = node.parentElement;
  return node === editor ? null : node;
}

function mediaHtml(kind, id, width = 42) {
  if (kind === "voice") return `<span contenteditable="false" class="inline-voice" data-attachment="${id}"></span>`;
  return `<span contenteditable="false" class="inline-figure" data-attachment="${id}" style="--image-width:${width}%"></span>`;
}

function insertInlineHtml(editor, html) {
  editor.focus();
  const sel = window.getSelection();
  if (sel?.rangeCount && editor.contains(sel.getRangeAt(0).commonAncestorContainer)) {
    document.execCommand("insertHTML", false, html);
    return;
  }
  let target = Array.from(editor.children).reverse().find(isEditableParagraphBlock);
  if (!target) {
    target = createEmptyParagraph();
    editor.appendChild(target);
  }
  target.insertAdjacentHTML("beforeend", html);
}

function insertCheckboxAtCursor(editor) {
  const sel = window.getSelection();
  if (!sel?.rangeCount) return;
  const range = sel.getRangeAt(0);
  let block = getEditorBlock(editor, range.startContainer);
  // Cursor is at editor root (empty editor or first line before any block)
  if (!isEditableParagraphBlock(block)) {
    block = Array.from(editor.children).find(isEditableParagraphBlock);
    if (!block) {
      block = createEmptyParagraph();
      editor.prepend(block);
    }
  }
  block.innerHTML = "";
  block.appendChild(createCheckboxElement());
  const space = document.createTextNode(" ");
  block.appendChild(space);
  normalizeChecklistBlock(block);
  const r = document.createRange();
  r.setStart(space, 1);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
  const tab = activeTab();
  tab.inlineContent = serializeEditor(editor);
  activeNote().updatedAt = now();
  saveState();
  hydrateChecklistDnd();
}

function tryMarkdownSpace(editor, e) {
  const sel = window.getSelection();
  if (!sel?.rangeCount) return false;
  const range = sel.getRangeAt(0);
  if (!range.collapsed) return false;
  const block = getEditorBlock(editor, range.startContainer);
  if (!isEditableParagraphBlock(block)) return false;
  const text = (block.textContent || "").trim();
  for (const [prefix, tag] of [["###", "h3"], ["##", "h2"], ["#", "h1"]]) {
    if (text === prefix) {
      e.preventDefault();
      // Explicitly clear block and reset selection before execCommand
      block.textContent = "";
      const r = document.createRange();
      r.setStart(block, 0);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
      document.execCommand("formatBlock", false, tag);
      initHeadingToggles();
      return true;
    }
  }
  if (text === "- [ ]" || text === "- []") {
    e.preventDefault();
    block.innerHTML = "";
    block.appendChild(createCheckboxElement());
    const space = document.createTextNode(" ");
    block.appendChild(space);
    normalizeChecklistBlock(block);
    const r = document.createRange();
    r.setStart(space, 1);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    // Save since e.preventDefault() suppresses the input event
  const tab = activeTab();
  tab.inlineContent = serializeEditor(editor);
  activeNote().updatedAt = now();
  state.syncStatus = "local";
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  hydrateChecklistDnd();
    return true;
  }
  return false;
}

function tryBlockquoteExit(editor, e) {
  const sel = window.getSelection();
  if (!sel?.rangeCount) return false;
  const range = sel.getRangeAt(0);
  if (!range.collapsed) return false;
  let node = range.startContainer;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentNode;
  const bq = node.closest?.("blockquote");
  if (!bq || !editor.contains(bq)) return false;
  // Find the immediate child block of the blockquote at the cursor
  let currentLine = node;
  while (currentLine && currentLine.parentElement !== bq) currentLine = currentLine.parentElement;
  if (!currentLine || currentLine === bq) currentLine = bq;
  if (currentLine.textContent.trim()) return false;
  e.preventDefault();
  if (currentLine !== bq) currentLine.remove();
  const p = document.createElement("p");
  p.innerHTML = "<br>";
  bq.after(p);
  if (!bq.textContent.trim()) bq.remove();
  const r = document.createRange();
  r.setStart(p, 0);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
  const tab = activeTab();
  tab.inlineContent = serializeEditor(editor);
  activeNote().updatedAt = now();
  saveState();
  return true;
}

function tryChecklistEnter(editor, e) {
  const sel = window.getSelection();
  if (!sel?.rangeCount) return false;
  const range = sel.getRangeAt(0);
  if (!range.collapsed) return false;
  const block = getEditorBlock(editor, range.startContainer);
  if (!isEditableParagraphBlock(block) || !block.querySelector(".inline-check")) return false;
  e.preventDefault();
  if (!block.textContent.trim()) {
    const p = createEmptyParagraph();
    block.after(p);
    block.remove();
    const r = document.createRange();
    r.setStart(p, 0);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  } else {
    document.execCommand("insertParagraph");
    let newBlock = sel.getRangeAt(0).startContainer;
    if (newBlock.nodeType === Node.TEXT_NODE) newBlock = newBlock.parentNode;
    while (newBlock && newBlock !== editor && !["P", "DIV"].includes(newBlock.tagName)) newBlock = newBlock.parentNode;
    if (newBlock && newBlock !== editor) {
      // Capture text that insertParagraph split into the new block (text after cursor)
      const tailText = Array.from(newBlock.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent)
        .join("");

      newBlock.innerHTML = "";
      newBlock.appendChild(createCheckboxElement());

      // Preserve tail text, or use a space placeholder for empty new items
      const textNode = document.createTextNode(tailText.length > 0 ? tailText : " ");
      newBlock.appendChild(textNode);
      normalizeChecklistBlock(newBlock);

      const r = document.createRange();
      r.setStart(textNode, tailText.length > 0 ? 0 : 1);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    }
  }
  const tab = activeTab();
  tab.inlineContent = serializeEditor(editor);
  activeNote().updatedAt = now();
  saveState();
  hydrateChecklistDnd();
  return true;
}

function checklistUserText(block) {
  return Array.from(block.childNodes)
    .filter((n) => n.nodeType === Node.TEXT_NODE)
    .map((n) => n.textContent)
    .join("")
    .trim();
}

function normalizeChecklistBlock(block) {
  const check = block?.querySelector?.(".inline-check");
  if (!block || !check) return;
  block.classList.add("checklist-item");
  block.querySelectorAll(".check-drag-handle").forEach((el) => el.remove());

  if (block.firstChild !== check) block.insertBefore(check, block.firstChild);

  const next = check.nextSibling;
  if (!next || next.nodeType !== Node.TEXT_NODE) {
    check.after(document.createTextNode(" "));
  } else if (!next.textContent.startsWith(" ")) {
    next.textContent = " " + next.textContent;
  }

  if (!Array.from(block.childNodes).some((n) => n.nodeType === Node.TEXT_NODE)) {
    block.appendChild(document.createTextNode(" "));
  }
}

function setCaretToChecklistTextStart(block) {
  normalizeChecklistBlock(block);
  const firstText = Array.from(block.childNodes).find((n) => n.nodeType === Node.TEXT_NODE);
  if (!firstText) return;
  const offset = firstText.textContent === " " ? 1 : 0;
  const r = document.createRange();
  r.setStart(firstText, Math.min(offset, firstText.textContent.length));
  r.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

function selectionBeforeChecklistText(block, range) {
  const nodes = Array.from(block.childNodes);
  const firstTextIndex = nodes.findIndex((n) => n.nodeType === Node.TEXT_NODE);
  if (range.startContainer === block) return range.startOffset <= firstTextIndex;
  const startIndex = nodes.indexOf(range.startContainer);
  return startIndex !== -1 && firstTextIndex !== -1 && startIndex < firstTextIndex;
}

function tryChecklistBackspace(editor, e) {
  const sel = window.getSelection();
  if (!sel?.rangeCount) return false;
  const range = sel.getRangeAt(0);
  if (!range.collapsed) return false;
  const block = getEditorBlock(editor, range.startContainer);
  const checkEl = block?.querySelector(".inline-check");
  if (!isEditableParagraphBlock(block) || !checkEl) return false;

  // Find the first editable text node (after the contenteditable=false nodes)
  const firstText = Array.from(block.childNodes).find((n) => n.nodeType === Node.TEXT_NODE);
  const nonTextCount = Array.from(block.childNodes).filter((n) => n.nodeType !== Node.TEXT_NODE).length;
  const isAtStart =
    (firstText && range.startContainer === firstText && range.startOffset === 0) ||
    (firstText && firstText.textContent === " " && range.startContainer === firstText && range.startOffset === 1) ||
    (range.startContainer === block && range.startOffset <= nonTextCount);

  if (!isAtStart) return false;
  e.preventDefault();

  const prevBlock = block.previousElementSibling;
  // Only count actual text nodes (not the handle/checkbox element text) to determine emptiness
  const userText = checklistUserText(block);
  if (!userText) {
    // Empty checklist item — remove and move cursor to previous block
    if (prevBlock) {
      const r = document.createRange();
      r.selectNodeContents(prevBlock);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    block.remove();
  } else {
    // Non-empty: remove checkbox (and drag handle) to convert to plain paragraph
    block.querySelectorAll(".inline-check, .check-drag-handle").forEach((el) => el.remove());
    block.classList.remove("checklist-item");
    // Trim the leading space that followed the checkbox
    const t = Array.from(block.childNodes).find((n) => n.nodeType === Node.TEXT_NODE);
    if (t && t.textContent.startsWith(" ")) t.textContent = t.textContent.slice(1);
    const r = document.createRange();
    r.setStart(block, 0);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }
  const tab = activeTab();
  tab.inlineContent = serializeEditor(editor);
  activeNote().updatedAt = now();
  saveState();
  return true;
}

function tryInlineMarkdown(editor) {
  const sel = window.getSelection();
  if (!sel?.rangeCount) return;
  const range = sel.getRangeAt(0);
  if (!range.collapsed) return;
  const textNode = range.startContainer;
  if (textNode.nodeType !== Node.TEXT_NODE) return;
  if (["CODE", "PRE"].includes(textNode.parentNode?.tagName)) return;
  const text = textNode.textContent;
  const cursorPos = range.startOffset;
  for (const { open, close, tag } of [
    { open: "**", close: "**", tag: "strong" },
    { open: "*", close: "*", tag: "em" },
    { open: "`", close: "`", tag: "code" },
  ]) {
    const closeLen = close.length;
    if (cursorPos < open.length + 1 + closeLen) continue;
    if (text.slice(cursorPos - closeLen, cursorPos) !== close) continue;
    const beforeClose = text.slice(0, cursorPos - closeLen);
    const openIdx = beforeClose.lastIndexOf(open);
    if (openIdx === -1) continue;
    const content = beforeClose.slice(openIdx + open.length);
    if (!content || content.includes(open)) continue;
    if (open === "*" && openIdx > 0 && text[openIdx - 1] === "*") continue;
    const parent = textNode.parentNode;
    const frag = document.createDocumentFragment();
    const before = text.slice(0, openIdx);
    if (before) frag.appendChild(document.createTextNode(before));
    const el = document.createElement(tag);
    el.textContent = content;
    frag.appendChild(el);
    const cursorAnchor = document.createTextNode(text.slice(cursorPos));
    frag.appendChild(cursorAnchor);
    parent.replaceChild(frag, textNode);
    const r = document.createRange();
    r.setStart(cursorAnchor, 0);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    const tab = activeTab();
    if (tab) { tab.inlineContent = serializeEditor(editor); activeNote().updatedAt = now(); saveState(); }
    return;
  }
  // Auto-link: word ending with space that looks like a URL
  if (cursorPos >= 2 && text[cursorPos - 1] === " " && !textNode.parentNode?.closest("a")) {
    const beforeSpace = text.slice(0, cursorPos - 1);
    const wordMatch = beforeSpace.match(/(\S+)$/);
    if (wordMatch) {
      const word = wordMatch[1];
      const isUrl = /^https?:\/\/\S+$/.test(word) || /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,6}(\/\S*)?$/i.test(word);
      if (isUrl) {
        const href = /^https?:\/\//.test(word) ? word : `https://${word}`;
        const wordStart = cursorPos - 1 - word.length;
        const parent = textNode.parentNode;
        const frag = document.createDocumentFragment();
        if (wordStart > 0) frag.appendChild(document.createTextNode(text.slice(0, wordStart)));
        const a = document.createElement("a");
        a.href = href;
        a.textContent = word;
        frag.appendChild(a);
        const spaceNode = document.createTextNode(" " + text.slice(cursorPos));
        frag.appendChild(spaceNode);
        parent.replaceChild(frag, textNode);
        const r = document.createRange();
        r.setStart(spaceNode, 1);
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
        const tab = activeTab();
        if (tab) { tab.inlineContent = serializeEditor(editor); activeNote().updatedAt = now(); saveState(); }
        return;
      }
    }
  }
}

// ── Sketch ────────────────────────────────────────────────────────────────────

function openSketchCanvas(existingId = null) {
  if (!isProSubscriber()) {
    proUpgradeReason = "sketches";
    proUpgradeOpen = true;
    render();
    return;
  }
  activeSketchId = existingId;
  sketchOpen = true;
  _sketchCtx = null;
  render();
}

function renderSketchOverlay() {
  return `
    <div class="sketch-overlay">
      <div class="sketch-canvas-wrap">
        <canvas id="sketch-canvas"></canvas>
      </div>
      <div class="sketch-bar">
        <div class="sketch-tools">
          <button class="sketch-size-btn" data-sketch-size="2" title="Fine"><span class="sketch-dot" style="width:3px;height:3px"></span></button>
          <button class="sketch-size-btn active" data-sketch-size="5" title="Medium"><span class="sketch-dot" style="width:6px;height:6px"></span></button>
          <button class="sketch-size-btn" data-sketch-size="13" title="Thick"><span class="sketch-dot" style="width:11px;height:11px"></span></button>
          <button class="sketch-eraser-btn" data-sketch-eraser title="Eraser"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M12 3L9 1 2 8l1 4 4 1 5-7z"/><line x1="6" y1="4" x2="11" y2="9"/></svg></button>
        </div>
        <div class="sketch-colors">
          <button class="sketch-color-btn active" data-sketch-color="ink" title="Ink"></button>
          <button class="sketch-color-btn" data-sketch-color="#c1440e" style="--c:#c1440e" title="Red"></button>
          <button class="sketch-color-btn" data-sketch-color="#2e6b9e" style="--c:#2e6b9e" title="Blue"></button>
          <button class="sketch-color-btn" data-sketch-color="#3d7a4e" style="--c:#3d7a4e" title="Green"></button>
        </div>
        <div class="sketch-actions">
          <button class="sketch-action-btn" data-action="sketch-clear">Clear</button>
          <button class="sketch-action-btn" data-action="sketch-cancel">Cancel</button>
          <button class="sketch-action-btn sketch-action-btn--done" data-action="sketch-done">Done</button>
        </div>
      </div>
    </div>
  `;
}

function hydrateSketchCanvas() {
  const canvas = document.getElementById("sketch-canvas");
  if (!canvas) return;
  const wrap = canvas.parentElement;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const displayW = wrap.clientWidth;
  const displayH = wrap.clientHeight;
  canvas.width = Math.round(displayW * dpr);
  canvas.height = Math.round(displayH * dpr);
  canvas.style.width = displayW + "px";
  canvas.style.height = displayH + "px";
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  _sketchCtx = ctx;
  const defaultInkColor = isDark() ? "#f0ece0" : "#1a1a15";
  // Canvas stays transparent — CSS background provides paper color visually; PNG export is transparent
  if (activeSketchId) {
    mediaUrl(activeSketchId).then(url => {
      if (!url) return;
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0, displayW, displayH);
      img.src = url;
    });
  }
  let isDrawing = false;
  let strokeSize = 5;
  let strokeColor = defaultInkColor;
  let isEraser = false;
  function getPos(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }
  function applyEraserMode(on) {
    if (on) {
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "rgba(0,0,0,1)";
      ctx.fillStyle = "rgba(0,0,0,1)";
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = strokeColor;
      ctx.fillStyle = strokeColor;
    }
  }
  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    isDrawing = true;
    canvas.setPointerCapture(e.pointerId);
    const { x, y } = getPos(e);
    applyEraserMode(isEraser);
    ctx.beginPath();
    ctx.arc(x, y, (isEraser ? 20 : strokeSize) / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineWidth = isEraser ? 20 : strokeSize;
  }, { passive: false });
  canvas.addEventListener("pointermove", (e) => {
    if (!isDrawing) return;
    e.preventDefault();
    const { x, y } = getPos(e);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, y);
  }, { passive: false });
  const endStroke = () => { isDrawing = false; };
  canvas.addEventListener("pointerup", endStroke);
  canvas.addEventListener("pointercancel", endStroke);
  document.querySelectorAll("[data-sketch-size]").forEach(btn => {
    btn.addEventListener("mousedown", e => e.preventDefault());
    btn.addEventListener("click", () => {
      strokeSize = parseInt(btn.dataset.sketchSize);
      isEraser = false;
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = strokeColor;
      ctx.fillStyle = strokeColor;
      document.querySelectorAll("[data-sketch-size]").forEach(b => b.classList.remove("active"));
      document.querySelector("[data-sketch-eraser]")?.classList.remove("active");
      btn.classList.add("active");
    });
  });
  const eraserBtn = document.querySelector("[data-sketch-eraser]");
  if (eraserBtn) {
    eraserBtn.addEventListener("mousedown", e => e.preventDefault());
    eraserBtn.addEventListener("click", () => {
      isEraser = !isEraser;
      eraserBtn.classList.toggle("active", isEraser);
      if (isEraser) document.querySelectorAll("[data-sketch-size]").forEach(b => b.classList.remove("active"));
    });
  }
  document.querySelectorAll("[data-sketch-color]").forEach(btn => {
    btn.addEventListener("mousedown", e => e.preventDefault());
    btn.addEventListener("click", () => {
      const c = btn.dataset.sketchColor;
      strokeColor = c === "ink" ? defaultInkColor : c;
      isEraser = false;
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = strokeColor;
      ctx.fillStyle = strokeColor;
      document.querySelectorAll("[data-sketch-color]").forEach(b => b.classList.remove("active"));
      eraserBtn?.classList.remove("active");
      btn.classList.add("active");
    });
  });
}

async function saveSketch() {
  const canvas = document.getElementById("sketch-canvas");
  if (!canvas) { sketchOpen = false; activeSketchId = null; document.querySelector(".sketch-overlay")?.remove(); render(); return; }
  canvas.toBlob(async (blob) => {
    if (!blob) { sketchOpen = false; activeSketchId = null; document.querySelector(".sketch-overlay")?.remove(); render(); return; }
    const id = activeSketchId || uid("sketch");
    try {
      await putMedia(id, blob);
      await writeMediaToFolder(id, blob, "image/png");
      const tab = activeTab();
      if (activeSketchId) {
        const att = tab.attachments.find(a => a.id === activeSketchId);
        if (att) att.updatedAt = now();
        const oldUrl = objectUrls.get(activeSketchId);
        if (oldUrl) { URL.revokeObjectURL(oldUrl); objectUrls.delete(activeSketchId); }
      } else {
        tab.attachments.push({ id, kind: "sketch", name: "Sketch", width: 42, createdAt: now() });
        const figHtml = mediaHtml("image", id);
        const editor = document.querySelector("[data-editor]");
        if (editor) {
          insertInlineHtml(editor, figHtml);
          tab.inlineContent = serializeEditor(editor);
        } else {
          tab.inlineContent = (tab.inlineContent || "<p></p>") + figHtml;
        }
      }
      activeNote().updatedAt = now();
    } catch (_) {}
    sketchOpen = false;
    activeSketchId = null;
    _sketchCtx = null;
    document.querySelector(".sketch-overlay")?.remove();
    saveState();
    render();
  }, "image/png");
}

// ─────────────────────────────────────────────────────────────────────────────

function loadState() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) return JSON.parse(saved);
  return {
    notes: [],
    activeNoteId: null,
    search: "",
    category: "all",
    listFilter: "notes",
    view: "list",
    searchOpen: false,
    syncStatus: "local",
  };
}

function normalizeState() {
  state.notes ||= [];
  state.notes.forEach((note) => {
    note.status ||= "active";
    if (note.status === "draft") note.status = "active";
    note.pinned ||= false;
    note.tabs ||= [];
    note.tabs.forEach((tab) => {
      tab.attachments ||= [];
      tab.attachments.forEach((item) => {
        if (item.kind === "photo" || item.kind === "sketch") item.width ||= 100;
      });
      const linkAttachments = tab.attachments.filter((item) => item.kind === "link");
      if (linkAttachments.length) {
        tab.content = `${tab.content || ""}${linkAttachments.map((item) => `<p><a href="${escapeHtml(item.url)}">${escapeHtml(item.url)}</a></p>`).join("")}`;
        tab.attachments = tab.attachments.filter((item) => item.kind !== "link");
      }
      if (!tab.inlineContent) {
        tab.inlineContent = migrateBlocksToInline(tab);
      }
      tab.type ||= "note";
      tab.checklist ||= null;
      tab.lineSpacing ||= "normal";
      tab.titleTouched ||= Boolean(tab.title && !/^tab \d+$/i.test(tab.title) && tab.title !== "Note");
    });
  });
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  state.notes = state.notes.filter((note) => !note.deletedAt || new Date(note.deletedAt).getTime() > cutoff);
  state.activeNoteId ||= state.notes[0]?.id;
  state.search ||= "";
  state.category ||= "all";
  state.listFilter ||= "notes";
  if (state.listFilter === "drafts") state.listFilter = "notes";
  if (state.category === "photos") state.category = "images";
  state.searchScope ||= "all";
  state.view ||= "list";
  state.searchOpen ||= false;
  state.settingsOpen ||= false;
  state.libraryOpen ||= false;
  state.libraryTab ||= "photos";
  state.tabLayout ||= "horizontal";
  // migrate old boolean verticalTabsPinned → vtabsMode
  if (state.verticalTabsPinned === true)  { state.vtabsMode = "expanded"; delete state.verticalTabsPinned; }
  if (state.verticalTabsPinned === false) { delete state.verticalTabsPinned; }
  state.vtabsMode ||= "normal";
}

function loadSession() {
  return JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
}

function saveSession(nextSession) {
  session = nextSession;
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  render();
}

function saveState() {
  if (!folderHandle && !(window.nowtNative && state.desktopFolder)) state.syncStatus = "local";
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  scheduleFolderWrite();
}

function getDb() {
  if (mediaDb) return Promise.resolve(mediaDb);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      mediaDb = request.result;
      resolve(mediaDb);
    };
  });
}

async function putMedia(id, blob) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put(blob, id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function getMedia(id) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readonly");
    const request = tx.objectStore(DB_STORE).get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function mediaUrl(id) {
  if (objectUrls.has(id)) return objectUrls.get(id);
  const blob = await getMedia(id);
  if (!blob) return "";
  const url = URL.createObjectURL(blob);
  objectUrls.set(id, url);
  return url;
}

function activeNote() {
  return state.notes.find((note) => note.id === state.activeNoteId) || state.notes[0];
}

function activeTab(note = activeNote()) {
  return note.tabs.find((tab) => tab.id === note.activeTabId) || note.tabs[0];
}

function updateNote(mutator, shouldRender = true) {
  const note = activeNote();
  mutator(note);
  note.updatedAt = now();
  saveState();
  if (shouldRender) render();
}

function createNote() {
  const tabId = uid("tab");
  const note = {
    id: uid("note"),
    title: "Untitled note",
    status: "active",
    pinned: false,
    createdAt: now(),
    updatedAt: now(),
    activeTabId: tabId,
    tabs: [{ id: tabId, title: "", titleTouched: false, type: "note", inlineContent: "<p></p>", lineSpacing: "normal", attachments: [] }],
  };
  state.notes.unshift(note);
  state.activeNoteId = note.id;
  state.view = "editor";
  saveState();
  render();
}

const FREE_TAB_LIMIT = 3;

function addTab(type = "note") {
  const note = activeNote();
  if (!isProSubscriber() && note && note.tabs.length >= FREE_TAB_LIMIT) {
    proUpgradeReason = "tabs";
    proUpgradeOpen = true;
    render();
    return;
  }
  updateNote((note) => {
    const tab = { id: uid("tab"), title: "", titleTouched: false, type, inlineContent: "<p></p>", lineSpacing: "normal", attachments: [] };
    if (type === "checklist") tab.checklist = { items: [] };
    note.tabs.push(tab);
    note.activeTabId = tab.id;
  });
}

function duplicateTab() {
  updateNote((note) => {
    const tab = note.tabs.find((t) => t.id === note.activeTabId);
    if (!tab) return;
    const copy = JSON.parse(JSON.stringify(tab));
    copy.id = uid("tab");
    copy.title = tab.title ? `${tab.title} copy` : "";
    const idx = note.tabs.findIndex((t) => t.id === note.activeTabId);
    note.tabs.splice(idx + 1, 0, copy);
    note.activeTabId = copy.id;
  });
}

function markdownToHtml(md) {
  return md.split(/\n{2,}/).map((block) => {
    if (/^### /.test(block)) return `<h3>${block.slice(4).trim()}</h3>`;
    if (/^## /.test(block)) return `<h2>${block.slice(3).trim()}</h2>`;
    if (/^# /.test(block)) return `<h1>${block.slice(2).trim()}</h1>`;
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.every((l) => /^[-*] /.test(l))) return `<ul>${lines.map((l) => `<li>${l.slice(2)}</li>`).join("")}</ul>`;
    if (lines.every((l) => /^\d+\. /.test(l))) return `<ol>${lines.map((l) => `<li>${l.replace(/^\d+\. /, "")}</li>`).join("")}</ol>`;
    return `<p>${block.replace(/\n/g, " ").trim()}</p>`;
  }).join("");
}

function importMarkdownFile(filename, content) {
  const title = filename.replace(/\.(md|txt|markdown)$/i, "");
  const firstTab = uid("tab");
  const note = {
    id: uid("note"), title, status: "active", pinned: false,
    updatedAt: now(), createdAt: now(), activeTabId: firstTab,
    tabs: [{ id: firstTab, title: "", titleTouched: false, lineSpacing: "normal", attachments: [],
      inlineContent: markdownToHtml(content) }],
  };
  state.notes.unshift(note);
  state.activeNoteId = note.id;
  state.view = "editor";
  saveState();
  render();
}

function exportNotes() {
  const data = JSON.stringify({ exported: new Date().toISOString(), notes: state.notes }, null, 2);
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([data], { type: "application/json" })),
    download: `nowt-export-${new Date().toISOString().slice(0, 10)}.json`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
}

let _pendingTabDelete = null;

function deleteActiveTab() {
  const note = activeNote();
  if (!note || note.tabs.length <= 1) return;
  if (_pendingTabDelete) {
    clearTimeout(_pendingTabDelete.timer);
    _pendingTabDelete = null;
  }
  const index = note.tabs.findIndex((t) => t.id === note.activeTabId);
  if (index === -1) return;
  const tabData = note.tabs[index];
  note.tabs.splice(index, 1);
  note.activeTabId = note.tabs[Math.max(0, index - 1)]?.id || note.tabs[0]?.id;
  note.updatedAt = now();
  render();
  _pendingTabDelete = {
    tabId: tabData.id, tabData, noteId: note.id,
    insertAt: Math.min(index, note.tabs.length),
    timer: setTimeout(() => {
      _pendingTabDelete = null;
      saveState();
      document.querySelector(".undo-bar")?.remove();
    }, 6000)
  };
  document.querySelector(".undo-bar")?.remove();
  const bar = document.createElement("div");
  bar.className = "undo-bar";
  bar.innerHTML = '<span>Tab deleted</span><button>Undo</button>';
  bar.querySelector("button").addEventListener("click", undoDeleteTab);
  document.body.appendChild(bar);
}

function undoDeleteTab() {
  if (!_pendingTabDelete) return;
  clearTimeout(_pendingTabDelete.timer);
  const note = state.notes.find((n) => n.id === _pendingTabDelete.noteId);
  if (note) {
    note.tabs.splice(_pendingTabDelete.insertAt, 0, _pendingTabDelete.tabData);
    note.activeTabId = _pendingTabDelete.tabId;
    note.updatedAt = now();
    saveState();
  }
  _pendingTabDelete = null;
  document.querySelector(".undo-bar")?.remove();
  render();
}

function setNoteStatus(status) {
  updateNote((note) => {
    note.status = status;
  });
}

function moveNoteToTrash(id = state.activeNoteId) {
  const note = state.notes.find((item) => item.id === id);
  if (!note) return;
  note.deletedAt = now();
  note.pinned = false;
  note.updatedAt = now();
  const nextNote = sortedNotes().find((n) => n.id !== id);
  state.activeNoteId = nextNote?.id || state.notes.find((item) => !item.deletedAt && item.id !== id)?.id || state.notes[0]?.id;
  state.view = "list";
  state.syncStatus = "local";
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  render();
}

function restoreNote(id) {
  const note = state.notes.find((item) => item.id === id);
  if (!note) return;
  delete note.deletedAt;
  note.status = "active";
  note.updatedAt = now();
  state.activeNoteId = id;
  state.view = "editor";
  saveState();
  render();
}

function unarchiveNote(id) {
  const note = state.notes.find((item) => item.id === id);
  if (!note) return;
  note.status = "active";
  note.updatedAt = now();
  state.listFilter = "notes";
  state.activeNoteId = id;
  state.view = "editor";
  saveState();
  render();
}

function permanentlyDeleteNote(id) {
  const note = state.notes.find((item) => item.id === id);
  if (!note) return;
  if (!confirm(`Permanently delete "${note.title || "Untitled"}"? This cannot be undone.`)) return;
  state.notes = state.notes.filter((item) => item.id !== id);
  state.activeNoteId = sortedNotes()[0]?.id || state.notes[0]?.id;
  saveState();
  render();
}

function duplicateNote(id) {
  const src = state.notes.find((n) => n.id === id);
  if (!src) return;
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = uid("note");
  copy.title = (src.title || "Untitled") + " copy";
  copy.createdAt = now();
  copy.updatedAt = now();
  copy.pinned = false;
  copy.tabs = copy.tabs.map((t) => ({ ...t, id: uid("tab") }));
  const idx = state.notes.findIndex((n) => n.id === id);
  state.notes.splice(idx + 1, 0, copy);
  state.activeNoteId = copy.id;
  state.view = "editor";
  saveState();
  render();
}

function bulkAction(action) {
  const ids = [...selectedNoteIds];
  if (!ids.length) return;
  if (action === "trash") {
    if (!confirm(`Move ${ids.length} note${ids.length > 1 ? "s" : ""} to Trash?`)) return;
    ids.forEach((id) => {
      const n = state.notes.find((x) => x.id === id);
      if (n) { n.deletedAt = now(); n.pinned = false; n.updatedAt = now(); }
    });
    if (selectedNoteIds.has(state.activeNoteId)) state.activeNoteId = sortedNotes().find((n) => !selectedNoteIds.has(n.id))?.id || null;
  } else if (action === "archive") {
    ids.forEach((id) => {
      const n = state.notes.find((x) => x.id === id);
      if (n && !n.deletedAt) { n.status = "archived"; n.updatedAt = now(); }
    });
  } else if (action === "restore") {
    ids.forEach((id) => {
      const n = state.notes.find((x) => x.id === id);
      if (n) { delete n.deletedAt; n.status = "active"; n.updatedAt = now(); }
    });
  } else if (action === "delete-forever") {
    if (!confirm(`Permanently delete ${ids.length} note${ids.length > 1 ? "s" : ""}? This cannot be undone.`)) return;
    state.notes = state.notes.filter((n) => !selectedNoteIds.has(n.id));
    if (selectedNoteIds.has(state.activeNoteId)) state.activeNoteId = state.notes[0]?.id || null;
  }
  selectedNoteIds.clear();
  selectMode = false;
  saveState();
  render();
}

function emptyTrash() {
  const trashed = state.notes.filter((n) => n.deletedAt);
  if (!trashed.length) return;
  if (!confirm(`Permanently delete ${trashed.length} note${trashed.length > 1 ? "s" : ""} in Trash? This cannot be undone.`)) return;
  const trashedIds = new Set(trashed.map((n) => n.id));
  state.notes = state.notes.filter((n) => !trashedIds.has(n.id));
  if (trashedIds.has(state.activeNoteId)) state.activeNoteId = state.notes[0]?.id || null;
  saveState();
  render();
}

function showNoteContextMenu(noteId, x, y) {
  document.querySelector(".note-ctx-menu")?.remove();
  const note = state.notes.find((n) => n.id === noteId);
  if (!note) return;
  const menu = document.createElement("div");
  menu.className = "note-ctx-menu";
  menu.innerHTML = `
    <button data-ctx="duplicate">Duplicate</button>
    <div class="ctx-sep"></div>
    <button data-ctx="archive">Archive</button>
    <div class="ctx-sep"></div>
    <button data-ctx="trash" class="ctx-danger">Delete</button>
  `;
  menu.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:200`;
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${x - rect.width}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${y - rect.height}px`;
  menu.addEventListener("click", (e) => {
    const action = e.target.closest("[data-ctx]")?.dataset.ctx;
    menu.remove();
    if (!action) return;
    if (action === "duplicate") { duplicateNote(noteId); return; }
    if (action === "trash") {
      if (!confirm(`Move "${note.title || "Untitled"}" to Trash?`)) return;
      note.deletedAt = now(); note.pinned = false; note.updatedAt = now();
      if (state.activeNoteId === noteId) state.activeNoteId = sortedNotes().find((n) => n.id !== noteId)?.id || null;
      saveState(); render(); return;
    }
    if (!note.deletedAt) { note.status = "archived"; note.updatedAt = now(); saveState(); render(); }
  });
  const dismiss = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener("mousedown", dismiss); } };
  setTimeout(() => document.addEventListener("mousedown", dismiss), 0);
}

function reorder(list, fromId, toId) {
  const from = list.findIndex((item) => item.id === fromId);
  const to = list.findIndex((item) => item.id === toId);
  if (from < 0 || to < 0 || from === to) return list;
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}


function attachLink(rawUrl) {
  const href = rawUrl.startsWith("http") ? rawUrl : `https://${rawUrl}`;
  const editor = document.querySelector("[data-editor]");
  if (!editor) return;
  editor.focus();
  if (_linkSelectionRange) {
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(_linkSelectionRange);
  }
  _linkSelectionRange = null;
  document.execCommand("createLink", false, href);
  const tab = activeTab();
  if (tab) { tab.inlineContent = serializeEditor(editor); activeNote().updatedAt = now(); saveState(); }
  render();
}

function deleteInlineAttachment(id) {
  const editor = document.querySelector("[data-editor]");
  const tab = activeTab();
  tab.attachments = tab.attachments.filter((a) => a.id !== id);
  if (editor) {
    editor.querySelector(`[data-attachment="${id}"]`)?.remove();
    tab.inlineContent = serializeEditor(editor);
    activeNote().updatedAt = now();
    saveState();
  } else {
    updateNote(() => {
      const div = document.createElement("div");
      div.innerHTML = tab.inlineContent || "<p></p>";
      div.querySelector(`[data-attachment="${id}"]`)?.remove();
      tab.inlineContent = div.innerHTML || "<p></p>";
    });
  }
}

function insertTable() {
  const tableId = uid("table");
  const tableHtml = `<div contenteditable="false" class="inline-table" data-table-id="${tableId}"><table><tbody><tr><td></td><td></td><td></td></tr><tr><td></td><td></td><td></td></tr></tbody></table></div><p><br></p>`;
  const editor = document.querySelector("[data-editor]");
  if (!editor) return;
  const sel = window.getSelection();
  if (sel?.rangeCount && editor.contains(sel.getRangeAt(0).commonAncestorContainer)) {
    document.execCommand("insertHTML", false, tableHtml);
  } else {
    editor.insertAdjacentHTML("beforeend", tableHtml);
  }
  const tab = activeTab();
  tab.inlineContent = serializeEditor(editor);
  activeNote().updatedAt = now();
  saveState();
  hydrateInlineEditor();
}

function deleteInlineTable(tableId) {
  const editor = document.querySelector("[data-editor]");
  if (!editor) return;
  editor.querySelector(`[data-table-id="${tableId}"]`)?.remove();
  const tab = activeTab();
  tab.inlineContent = serializeEditor(editor);
  activeNote().updatedAt = now();
  saveState();
}

function addInlineTableRow(tableId) {
  const editor = document.querySelector("[data-editor]");
  if (!editor) return;
  const tableDiv = editor.querySelector(`[data-table-id="${tableId}"]`);
  if (!tableDiv) return;
  const tbody = tableDiv.querySelector("tbody");
  const colCount = tbody.rows[0]?.cells.length || 2;
  const newRow = tbody.insertRow();
  for (let i = 0; i < colCount; i++) newRow.insertCell();
  hydrateInlineEditor();
  const tab = activeTab();
  tab.inlineContent = serializeEditor(editor);
  activeNote().updatedAt = now();
  saveState();
}

function addInlineTableCol(tableId) {
  const editor = document.querySelector("[data-editor]");
  if (!editor) return;
  const tableDiv = editor.querySelector(`[data-table-id="${tableId}"]`);
  if (!tableDiv) return;
  tableDiv.querySelectorAll("tr").forEach((row) => row.insertCell());
  hydrateInlineEditor();
  const tab = activeTab();
  tab.inlineContent = serializeEditor(editor);
  activeNote().updatedAt = now();
  saveState();
}

function firstLineFromHtml(html) {
  return stripHtml(html || "").split(/\n|\. |\? |! /)[0]?.trim().slice(0, 42) || "";
}

function inferTabTitle(tab) {
  if (tab.type === "checklist") {
    return tab.checklist?.items?.[0]?.text?.slice(0, 42) || "Checklist";
  }
  return firstLineFromHtml(tab.inlineContent || tab.content || "");
}

function tabLabel(tab) {
  const label = tab.title || inferTabTitle(tab) || "Tab";
  return tab.type === "checklist" ? "☐ " + label : label;
}

function updateTabButtonLabel(tab) {
  const btn = document.querySelector(`.tab[data-tab="${tab.id}"]`);
  if (!btn) return;
  const close = btn.querySelector(".tab-close");
  btn.textContent = tabLabel(tab);
  if (close) btn.appendChild(close);
}

function maybeAutoTitleTab(tab) {
  if (tab.titleTouched) return;
  const inferred = inferTabTitle(tab);
  if (inferred && inferred !== tab.title) {
    tab.title = inferred;
    updateTabButtonLabel(tab);
  }
}

function cycleLineSpacing() {
  updateNote(() => {
    const tab = activeTab();
    const order = ["tight", "normal", "loose"];
    tab.lineSpacing = order[(order.indexOf(tab.lineSpacing || "normal") + 1) % order.length];
  });
}

async function attachPhoto(file) {
  const id = uid("image");
  await putMedia(id, file);
  await writeMediaToFolder(id, file, file.type);
  const tab = activeTab();
  tab.attachments.push({ id, kind: "photo", name: file.name, type: file.type, width: 42, ocrText: "", createdAt: now() });
  const figHtml = mediaHtml("image", id);
  const editor = document.querySelector("[data-editor]");
  if (editor) {
    insertInlineHtml(editor, figHtml);
    tab.inlineContent = serializeEditor(editor);
  } else {
    tab.inlineContent = (tab.inlineContent || "<p></p>") + figHtml;
  }
  activeNote().updatedAt = now();
  saveState();
  hydrateInlineEditor();
  hydrateMedia();
  runOcr(id);
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function ensureOcrWorker() {
  if (ocrWorker) return ocrWorker;
  if (ocrWorkerLoading) {
    return new Promise((resolve) => {
      const t = setInterval(() => {
        if (ocrWorker) { clearInterval(t); resolve(ocrWorker); }
        else if (!ocrWorkerLoading) { clearInterval(t); resolve(null); }
      }, 150);
    });
  }
  ocrWorkerLoading = true;
  try {
    if (!window.Tesseract) {
      await loadScript("https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js");
    }
    ocrWorker = await window.Tesseract.createWorker("eng", 1, {
      workerPath: "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js",
      corePath: "https://cdn.jsdelivr.net/npm/tesseract.js-core@5/tesseract-core-simd-lstm.wasm.js",
      langPath: "https://tessdata.projectnaptha.com/4.0.0",
      logger: () => {},
    });
    return ocrWorker;
  } catch {
    ocrWorkerLoading = false;
    return null;
  }
}

async function runOcr(id) {
  const tab = activeTab();
  const attachment = tab.attachments.find((item) => item.id === id);
  if (!attachment || attachment.kind !== "photo") return;
  try {
    const worker = await ensureOcrWorker();
    if (!worker) { attachment.ocrText = ""; saveState(); return; }
    const url = await mediaUrl(id);
    const { data: { text } } = await worker.recognize(url);
    attachment.ocrText = text.trim() || "";
  } catch {
    attachment.ocrText = "";
  }
  saveState();
}

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia) {
    alert("Voice recording needs a browser with microphone support.");
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    alert("Nowt could not access the microphone. Check microphone permission and try again.");
    return;
  }
  chunks = [];
  liveTranscript = "";
  const activeRecorder = new MediaRecorder(stream);
  const startedAt = Date.now();
  recorder = activeRecorder;
  activeRecorder.ondataavailable = (event) => event.data.size && chunks.push(event.data);
  activeRecorder.onerror = () => {
    stream.getTracks().forEach((track) => track.stop());
    alert("Nowt could not save that voice memo. Please try again.");
  };
  activeRecorder.onstop = async () => {
    const mimeType = activeRecorder.mimeType || chunks[0]?.type || "audio/webm";
    const blob = new Blob(chunks, { type: mimeType });
    const id = uid("voice");
    try {
      await putMedia(id, blob);
      await writeMediaToFolder(id, blob, mimeType);
      const tab = activeTab();
      const voiceCount = tab.attachments.filter((a) => a.kind === "voice").length;
      const attachment = {
        id, kind: "voice", name: `Recording ${voiceCount + 1}`, transcript: liveTranscript.trim(),
        duration: Math.max(1, Math.round((Date.now() - startedAt) / 1000)),
        mimeType, size: blob.size, createdAt: now(),
      };
      tab.attachments.push(attachment);
      const voiceHtml = mediaHtml("voice", id);
      const editor = document.querySelector("[data-editor]");
      if (editor) {
        const sel2 = window.getSelection();
        if (_lastEditorRange && editor.contains(_lastEditorRange.commonAncestorContainer)) {
          sel2.removeAllRanges();
          sel2.addRange(_lastEditorRange);
        }
        insertInlineHtml(editor, voiceHtml);
        tab.inlineContent = serializeEditor(editor);
      } else {
        tab.inlineContent = (tab.inlineContent || "<p></p>") + voiceHtml;
      }
      activeNote().updatedAt = now();
      saveState();
      render();
    } catch {
      alert("Nowt recorded audio but could not store it on this device.");
      render();
    }
    stream.getTracks().forEach((track) => track.stop());
  };
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SpeechRecognition) {
    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      liveTranscript = Array.from(event.results).map((result) => result[0].transcript).join(" ");
      const node = document.querySelector("[data-live-transcript]");
      if (node) node.textContent = liveTranscript || "Listening...";
    };
    recognition.start();
  }
  activeRecorder.start();
  // Update edit-bar in-place so editor DOM (and _lastEditorRange) stays intact
  const editBar = document.querySelector(".edit-bar");
  if (editBar) {
    editBar.innerHTML = `
      <div class="recording-inline">
        <span class="recording-dot"></span>
        <em data-live-transcript>Listening...</em>
        <button class="recording-stop-btn" data-action="stop-recording">Stop</button>
      </div>`;
    editBar.querySelector('[data-action="stop-recording"]').addEventListener("click", stopRecording);
  }
}

function stopRecording() {
  if (recognition) recognition.stop();
  const activeRecorder = recorder;
  if (activeRecorder && activeRecorder.state !== "inactive") activeRecorder.stop();
  recorder = null;
  recognition = null;
  // Don't render here — onstop fires async and needs _lastEditorRange intact
}

function searchIndex(note) {
  const rows = [];
  note.tabs.forEach((tab) => {
    const content = tab.inlineContent || tab.content || "";
    rows.push({ note, tab, kind: "text", label: "Text", text: `${note.title} ${tabLabel(tab)} ${stripHtml(content)}` });
    extractLinks(content).forEach((url) => {
      rows.push({ note, tab, kind: "links", label: "Link", text: url, url });
    });
    tab.attachments.forEach((item) => {
      if (item.kind === "photo" || item.kind === "sketch") rows.push({ note, tab, blockId: item.id, item, kind: "images", label: item.kind === "sketch" ? "Sketch" : "Image", text: `${item.name || ""} ${item.ocrText || ""}` });
      if (item.kind === "voice") rows.push({ note, tab, blockId: item.id, item, kind: "voice", label: "Voice", text: `${item.name || ""} ${item.transcript || ""}` });
    });
    if (tab.checklist?.items) {
      tab.checklist.items.forEach((item) => {
        rows.push({ note, tab, blockId: item.id, item, kind: "text", label: "Checklist", text: item.text });
      });
    }
  });
  return rows;
}

function extractLinks(html) {
  const text = stripHtml(html || "");
  const urls = new Set();
  Array.from((html || "").matchAll(/href=["']([^"']+)["']/gi)).forEach((match) => urls.add(match[1]));
  Array.from(text.matchAll(/\bhttps?:\/\/[^\s<>"']+|\b[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s<>"']*)?/gi)).forEach((match) => {
    const raw = match[0];
    urls.add(raw.startsWith("http") ? raw : `https://${raw}`);
  });
  return [...urls];
}

// ── Pro subscription ──────────────────────────────────────────────────────────

function isProSubscriber() {
  try { return JSON.parse(localStorage.getItem(PRO_KEY) || "null")?.status === "active"; }
  catch { return false; }
}

function proEmail() {
  try { return JSON.parse(localStorage.getItem(PRO_KEY) || "null")?.email || ""; }
  catch { return ""; }
}

function activatePro(email, subscriptionId = "") {
  localStorage.setItem(PRO_KEY, JSON.stringify({ email, subscriptionId, status: "active", activatedAt: Date.now() }));
}

function deactivatePro() {
  localStorage.removeItem(PRO_KEY);
}

async function checkUrlForSubscription() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("payment") !== "success") return;
  window.history.replaceState({}, "", window.location.pathname);
  const email = params.get("customer_email") || params.get("email") || "";
  const subId  = params.get("subscription_id") || "";
  if (email) { activatePro(email, subId); }
  else { proRestoreOpen = true; } // ask user to enter their billing email
}

async function openCheckout(plan = "annual") {
  track("upgrade_click", { plan });
  const productId = plan === "monthly" ? DODO_MONTHLY_ID : DODO_ANNUAL_ID;
  const successUrl = encodeURIComponent("https://takenowt.vercel.app?payment=success");
  const checkoutUrl = `https://checkout.dodopayments.com/buy/${productId}?quantity=1&redirect_url=${successUrl}`;

  proUpgradeOpen = false;
  render();

  if (typeof DodoPayments !== "undefined") {
    DodoPayments.Checkout.open({ checkoutUrl });
    return;
  }

  if (window.nowtNative?.openCheckout) {
    const result = await window.nowtNative.openCheckout(checkoutUrl);
    if (result.success) {
      if (result.email) {
        activatePro(result.email, result.subscriptionId);
      } else {
        proRestoreOpen = true;
        proRestoreFromCheckout = true;
      }
      render();
    }
    return;
  }

  window.open(checkoutUrl, "_blank");
}

// ── Folder sync (File System Access API) ─────────────────────────────────────

function extFromMime(mimeType) {
  const map = {
    "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif",
    "image/webp": "webp", "image/heic": "heic",
    "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/wav": "wav",
  };
  return map[(mimeType || "").split(";")[0]] || "bin";
}

async function loadFolderHandle() {
  const db = await getDb();
  return new Promise((resolve) => {
    const tx = db.transaction(DB_STORE, "readonly");
    const req = tx.objectStore(DB_STORE).get(FOLDER_HANDLE_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
}

async function persistFolderHandle(handle) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put(handle, FOLDER_HANDLE_KEY);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function removeFolderHandle() {
  const db = await getDb();
  return new Promise((resolve) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).delete(FOLDER_HANDLE_KEY);
    tx.oncomplete = resolve;
    tx.onerror = resolve;
  });
}

async function writeNotesToFolder() {
  const payload = JSON.stringify({ ...state, folderSavedAt: now() });
  if (window.nowtNative && state.desktopFolder) {
    await window.nowtNative.writeFile(`${state.desktopFolder}/notes.json`, payload);
    return;
  }
  if (!folderHandle || state.syncStatus === "reconnect") return;
  try {
    const fh = await folderHandle.getFileHandle("notes.json", { create: true });
    const writable = await fh.createWritable();
    await writable.write(payload);
    await writable.close();
  } catch {
    // Non-fatal — don't interrupt the writing experience
  }
}

async function readNotesFromFolder() {
  if (!folderHandle) return null;
  try {
    const fh = await folderHandle.getFileHandle("notes.json");
    const file = await fh.getFile();
    return JSON.parse(await file.text());
  } catch {
    return null;
  }
}

async function writeMediaToFolder(id, blob, mimeType) {
  const ext = extFromMime(mimeType || blob.type);
  if (window.nowtNative && state.desktopFolder) {
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    await window.nowtNative.writeBinary(`${state.desktopFolder}/media/${id}.${ext}`, btoa(binary));
    return;
  }
  if (!folderHandle || state.syncStatus === "reconnect") return;
  try {
    const mediaDir = await folderHandle.getDirectoryHandle("media", { create: true });
    const fh = await mediaDir.getFileHandle(`${id}.${ext}`, { create: true });
    const writable = await fh.createWritable();
    await writable.write(blob);
    await writable.close();
  } catch {
    // Non-fatal
  }
}

function scheduleFolderWrite() {
  if ((!folderHandle && !(window.nowtNative && state.desktopFolder)) || state.syncStatus === "reconnect") return;
  clearTimeout(folderWriteTimer);
  folderWriteTimer = setTimeout(() => { writeNotesToFolder().catch(() => {}); }, 2000);
}

function mergeFromFolder(folderState) {
  const localMap = new Map(state.notes.map((n) => [n.id, n]));
  const folderMap = new Map((folderState.notes || []).map((n) => [n.id, n]));
  const merged = new Map([...localMap]);
  folderMap.forEach((folderNote, id) => {
    const local = localMap.get(id);
    if (!local || new Date(folderNote.updatedAt) > new Date(local.updatedAt)) {
      merged.set(id, folderNote);
    }
  });
  state.notes = [...merged.values()];
  normalizeState();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

async function connectFolder() {
  if (!isProSubscriber()) { proUpgradeOpen = true; render(); return; }
  if (!("showDirectoryPicker" in window)) {
    alert("Folder sync needs Safari on macOS or Chrome. Not supported on this browser.");
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    folderHandle = handle;
    await persistFolderHandle(handle);
    state.syncStatus = "folder";
    await writeNotesToFolder();
    saveState();
    render();
  } catch (err) {
    if (err.name !== "AbortError") alert("Could not connect folder.");
  }
}

async function disconnectFolder() {
  folderHandle = null;
  await removeFolderHandle();
  state.syncStatus = "local";
  saveState();
  render();
}

async function reconnectFolder() {
  if (!folderHandle) return;
  try {
    const perm = await folderHandle.requestPermission({ mode: "readwrite" });
    if (perm === "granted") {
      const folderState = await readNotesFromFolder();
      if (folderState) mergeFromFolder(folderState);
      state.syncStatus = "folder";
      saveState();
      render();
    }
  } catch {
    // User dismissed — stay in reconnect state
  }
}

async function initFolder() {
  // Electron: use native FS bridge with auto-detected iCloud Drive folder
  if (window.nowtNative) {
    const params = new URLSearchParams(window.location.search);
    const desktopFolder = params.get("desktopFolder");
    if (desktopFolder) {
      state.desktopFolder = desktopFolder;
      const notesPath = `${desktopFolder}/notes.json`;
      if (await window.nowtNative.exists(notesPath)) {
        try {
          const folderState = JSON.parse(await window.nowtNative.readFile(notesPath));
          if (folderState) mergeFromFolder(folderState);
        } catch {}
      }
      state.syncStatus = "folder";
      state.folderName = "iCloud Drive / Nowt";
    }
    return;
  }
  // Web: File System Access API
  folderHandle = await loadFolderHandle();
  if (!folderHandle) return;
  const perm = await folderHandle.queryPermission({ mode: "readwrite" });
  if (perm === "granted") {
    const folderState = await readNotesFromFolder();
    if (folderState) mergeFromFolder(folderState);
    state.syncStatus = "folder";
  } else {
    state.syncStatus = "reconnect";
  }
}

// ─────────────────────────────────────────────────────────────────────────────

function results() {
  const q = state.search.trim().toLowerCase();
  if (!q && state.category === "all") return [];
  const sourceNotes = state.searchScope === "note" ? [activeNote()] : state.notes;
  return sourceNotes.flatMap(searchIndex).filter((row) => {
    const categoryMatch = state.category === "all" || row.kind === state.category;
    const queryMatch = !q || row.text.toLowerCase().includes(q);
    return categoryMatch && queryMatch;
  }).slice(0, 30);
}

function highlight(text) {
  const q = state.search.trim();
  const safe = escapeHtml(text || "No text indexed yet.");
  if (!q) return safe;
  return safe.replace(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig"), "<mark>$1</mark>");
}

function snippet(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  const q = state.search.trim().toLowerCase();
  if (!q) return clean.slice(0, 140);
  const index = clean.toLowerCase().indexOf(q);
  return clean.slice(Math.max(0, index - 42), index + q.length + 98);
}

function syncCopy() {
  if (state.syncStatus === "folder") return `Synced · ${state.folderName || folderHandle?.name || "folder"}`;
  if (state.syncStatus === "reconnect") return "Tap to reconnect your folder.";
  return "Local on this device.";
}

async function fakeSync() {
  if (!session) return;
  state.syncStatus = "syncing";
  render();
  await new Promise((resolve) => setTimeout(resolve, 900));
  state.syncStatus = "synced";
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  render();
}

function hydrateInlineEditor() {
  const note = activeNote();
  if (!note) return;
  const tab = activeTab(note);
  const editor = document.querySelector("[data-editor]");
  if (!editor) return;

  editor.querySelectorAll(".inline-figure[data-attachment]").forEach((figure) => {
    const id = figure.dataset.attachment;
    const item = tab.attachments.find((a) => a.id === id);
    if (!item) return;
    if (!figure.querySelector(".att-controls")) {
      const ctrl = document.createElement("span");
      ctrl.className = "att-controls";
      const editBtn = item.kind === "sketch" ? `<button class="att-edit-sketch" data-edit-sketch="${id}" title="Edit sketch"><svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M7.5 1.5l2 2-5.5 5.5H2v-2L7.5 1.5z"/></svg></button>` : "";
      ctrl.innerHTML = `<span class="att-drag" data-drag-media="${id}" title="Drag to reorder" draggable="true">⠿</span>${editBtn}<button class="att-delete" data-delete-attachment="${id}" title="Delete">×</button>`;
      figure.prepend(ctrl);
    }
    if (!figure.querySelector("img")) {
      const img = document.createElement("img");
      img.dataset.media = id;
      img.draggable = false;
      img.alt = item.name || "Image";
      figure.appendChild(img);
    }
    if (!figure.querySelector(".image-size")) {
      const range = document.createElement("input");
      range.className = "image-size";
      range.type = "range";
      range.min = "28";
      range.max = "100";
      range.step = "4";
      range.value = String(item.width || 100);
      range.dataset.imageSize = id;
      range.setAttribute("aria-label", "Resize image");
      figure.appendChild(range);
    }
  });

  editor.querySelectorAll(".inline-voice[data-attachment]").forEach((div) => {
    const id = div.dataset.attachment;
    const item = tab.attachments.find((a) => a.id === id);
    if (!item || div.querySelector("audio")) return;
    const waves = Array.from({ length: 24 }, (_, i) => `<i style="--h:${20 + ((i * 17) % 54)}%"></i>`).join("");
    div.innerHTML = `
      <span class="att-controls" contenteditable="false"><span class="att-drag" data-drag-media="${id}" title="Drag to reorder" draggable="true">⠿</span><button class="att-delete" data-delete-attachment="${id}" title="Delete">×</button></span>
      <span class="wave" contenteditable="false">${waves}</span>
      <span class="voice-meta" contenteditable="false"><span class="voice-name" data-voice-name="${id}" title="Click to rename">${escapeHtml(item.name || "Voice memo")}</span> · ${item.duration ? `${item.duration}s` : "—"}${item.size ? ` · ${Math.round(item.size / 1024)} KB` : ""}</span>
      <audio controls data-audio="${id}"></audio>
      <span class="transcript-readonly" contenteditable="false">${escapeHtml(item.transcript || "No transcript captured.")}</span>
    `;
    const audio = div.querySelector("audio");
    const wave = div.querySelector(".wave");
    if (audio && wave) {
      audio.addEventListener("play", () => wave.classList.add("playing"));
      audio.addEventListener("pause", () => wave.classList.remove("playing"));
      audio.addEventListener("ended", () => wave.classList.remove("playing"));
    }
  });

  editor.querySelectorAll(".inline-table[data-table-id]").forEach((div) => {
    const tableId = div.dataset.tableId;
    div.querySelectorAll("tr").forEach((row, ri) => {
      row.querySelectorAll("td").forEach((cell, ci) => {
        cell.setAttribute("contenteditable", "true");
        cell.dataset.tableCell = `${tableId}:${ri}:${ci}`;
      });
    });
    if (!div.querySelector(".att-controls")) {
      const ctrl = document.createElement("div");
      ctrl.className = "att-controls";
      ctrl.setAttribute("contenteditable", "false");
      ctrl.innerHTML = `<span class="att-drag" data-drag-table="${tableId}" title="Drag to reorder" draggable="true">⠿</span><button type="button" class="att-delete" data-delete-inline-table="${tableId}" title="Delete table" contenteditable="false">×</button>`;
      div.prepend(ctrl);
    }
    if (!div.querySelector(".table-actions")) {
      const actions = document.createElement("div");
      actions.className = "table-actions";
      actions.setAttribute("contenteditable", "false");
      actions.innerHTML = `<button type="button" class="table-add-btn" data-table-add-row="${tableId}" title="Add row" contenteditable="false"><svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="5" y1="1" x2="5" y2="9"/><line x1="1" y1="5" x2="9" y2="5"/></svg> Row</button><button type="button" class="table-add-btn" data-table-add-col="${tableId}" title="Add column" contenteditable="false"><svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="5" y1="1" x2="5" y2="9"/><line x1="1" y1="5" x2="9" y2="5"/></svg> Col</button>`;
      div.appendChild(actions);
    }
  });
}

function hydrateChecklistDnd() {
  const editor = document.querySelector("[data-editor]");
  if (!editor) return;

  editor.querySelectorAll("p, div").forEach((block) => {
    if (!block.querySelector(".inline-check")) return;
    normalizeChecklistBlock(block);
  });

  if (editor.dataset.checkDndBound) return;
  editor.dataset.checkDndBound = "1";

  editor.addEventListener("dragover", (e) => {
    if (!_dragCheckBlock) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const target = directEditorChild(e.target, editor);
    if (!target || isAtomicInlineBlock(target) || target === _dragCheckBlock) return;
    editor.querySelectorAll(".check-drag-over").forEach((el) => el.classList.remove("check-drag-over"));
    target.classList.add("check-drag-over");
  }, { passive: false });

  editor.addEventListener("drop", (e) => {
    if (!_dragCheckBlock) return;
    e.preventDefault();
    const target = directEditorChild(e.target, editor);
    if (!target || isAtomicInlineBlock(target) || target === _dragCheckBlock) return;
    editor.querySelectorAll(".check-drag-over").forEach((el) => el.classList.remove("check-drag-over"));

    const all = Array.from(editor.children);
    const fromIdx = all.indexOf(_dragCheckBlock);
    const toIdx = all.indexOf(target);
    if (fromIdx === -1 || toIdx === -1) return;

    if (fromIdx < toIdx) target.after(_dragCheckBlock);
    else target.before(_dragCheckBlock);

    _dragCheckBlock = null;
    const tab = activeTab();
    tab.inlineContent = serializeEditor(editor);
    activeNote().updatedAt = now();
    saveState();
  });
}

function render() {
  document.querySelector(".undo-bar")?.remove();
  try {
    if (landingAnimCleanup) { landingAnimCleanup(); landingAnimCleanup = null; }
    if (!isElectron && state.view !== "landing") { state.view = "landing"; }
    if (state.view === "landing") {
      app.innerHTML = renderLanding();
      landingAnimCleanup = initLandingAnimations();
      bindEvents();
      return;
    }
    const notesInFilter = sortedNotes();
    const rawNote = activeNote();
    const note = rawNote && notesInFilter.some((n) => n.id === rawNote.id) ? rawNote : (notesInFilter[0] || null);
    if (note && note.id !== state.activeNoteId) state.activeNoteId = note.id;
    const tab = note ? activeTab(note) : null;
    if (state.notes.length === 0) {
      app.innerHTML = `<main class="app-frame">${renderEmptyState()}${proUpgradeOpen ? renderProUpgrade() : ""}${proRestoreOpen ? renderProRestore() : ""}${proCheckoutPending ? renderProCheckoutPending() : ""}</main>`;
    } else {
      app.innerHTML = `
        <main class="app-frame">
          ${state.view === "editor" && note ? `<div class="workspace">${renderList(true)}${renderEditor(note, tab)}</div>` : renderList(false)}
          ${state.searchOpen && (state.view !== "editor" || state.searchScope !== "note") ? renderSearchSheet() : ""}
          ${state.settingsOpen ? renderSettings() : ""}
          ${state.view !== "editor" && state.libraryOpen && note ? renderLibrary(note) : ""}
          ${proUpgradeOpen ? renderProUpgrade() : ""}
          ${proRestoreOpen ? renderProRestore() : ""}
          ${proCheckoutPending ? renderProCheckoutPending() : ""}
        </main>
      `;
    }
    if (sketchOpen) document.body.insertAdjacentHTML("beforeend", renderSketchOverlay());
    hydrateInlineEditor();
    hydrateMedia();
    if (sketchOpen) hydrateSketchCanvas();
    if (pendingJump) {
      const target = pendingJump;
      pendingJump = null;
      requestAnimationFrame(() => jumpToBlock(target));
    }
  } catch (e) {
    console.error('[NowT] render error:', e);
  }
  bindEvents();
}

function renderEmptyState() {
  return `
    <div class="empty-state">
      <img src="logotype.svg" alt="Nowt" />
      <p>No notes yet.</p>
      <button data-action="new-note">Start a note</button>
    </div>
  `;
}

function renderProUpgrade() {
  const isAnnual = proUpgradeBilling === "annual";
  const reasonCopy = {
    tabs: { headline: "You've hit the free tab limit.", body: "Free notes get 3 tabs. Go Pro for unlimited tabs per note — keep every angle of a project in one place." },
    sketches: { headline: "Sketches are a Pro feature.", body: "Draw, annotate, and embed freehand sketches inline in your notes. Available on Pro." },
  }[proUpgradeReason] || { headline: "Nowt Pro", body: "iCloud Drive sync keeps your notes in your own folder, available across all your Apple devices. No servers. No lock-in." };
  return `
    <div class="pro-upgrade-backdrop" data-action="close-pro-upgrade">
      <div class="pro-upgrade-modal" onclick="event.stopPropagation()">
        <div class="pro-upgrade-head">
          <strong>${reasonCopy.headline}</strong>
          <button class="settings-close" data-action="close-pro-upgrade">×</button>
        </div>
        <p class="pro-upgrade-desc">${reasonCopy.body}</p>
        <div class="billing-toggle">
          <button class="billing-opt${!isAnnual ? " billing-opt--active" : ""}" data-action="upgrade-billing-monthly">Monthly</button>
          <button class="billing-opt${isAnnual ? " billing-opt--active" : ""}" data-action="upgrade-billing-annual">Annual <span class="billing-save">Save 35%</span></button>
        </div>
        <div class="pro-upgrade-price">
          <span class="pro-upgrade-amount">${isAnnual ? "$3.25" : "$4.99"}<small>/mo</small></span>
          <span class="pro-upgrade-billing-note">${isAnnual ? "Billed $39/year" : "Billed monthly"}</span>
        </div>
        <button class="pro-plan-btn pro-plan-btn--primary" data-action="${isAnnual ? "buy-annual" : "buy-monthly"}">Get Pro</button>
        <button class="pro-restore-link" data-action="open-restore">Already subscribed? Restore access</button>
      </div>
    </div>
  `;
}

function renderProRestore() {
  return `
    <div class="pro-upgrade-backdrop" data-action="close-pro-restore">
      <div class="pro-upgrade-modal" onclick="event.stopPropagation()">
        <div class="pro-upgrade-head">
          <strong>Restore access</strong>
          <button class="settings-close" data-action="close-pro-restore">×</button>
        </div>
        ${proRestoreFromCheckout
          ? `<p class="pro-upgrade-desc">Complete your payment in the browser, then enter the email you used at checkout below.</p>`
          : `<p class="pro-upgrade-desc">Enter the email you used when subscribing to Nowt Pro.</p>`
        }
        <div class="pro-restore-row">
          <input class="settings-input" type="email" placeholder="your@email.com" data-restore-email autocomplete="email" />
          <button class="settings-btn settings-btn--primary" data-action="confirm-restore">Restore</button>
        </div>
        <p class="pro-upgrade-hint">Can't find your email? <a href="${DODO_PORTAL_URL}" target="_blank">Open billing portal →</a></p>
      </div>
    </div>
  `;
}

function renderProCheckoutPending() {
  return `
    <div class="pro-upgrade-backdrop" data-action="close-checkout-pending">
      <div class="pro-upgrade-modal" onclick="event.stopPropagation()">
        <div class="pro-upgrade-head">
          <strong>Complete your payment</strong>
          <button class="settings-close" data-action="close-checkout-pending">×</button>
        </div>
        <p class="pro-upgrade-desc">Your browser just opened with the Nowt Pro checkout. Complete your payment there, then come back here.</p>
        <button class="pro-plan-btn pro-plan-btn--primary" data-action="confirm-checkout-paid">I've paid — activate Pro</button>
        <button class="pro-restore-link" data-action="close-checkout-pending">Cancel</button>
      </div>
    </div>
  `;
}

function renderLanding() {
  return `
  <div class="lp">

    <nav class="lp-nav">
      <div class="lp-nav-brand">
        <img src="${isDark() ? "logotype-landing-dark.svg" : "logotype.svg"}" class="lp-logotype" alt="Nowt" />
      </div>
      <div class="lp-nav-right">
        <a class="lp-ghost-btn" href="#get-nowt">Download</a>
        <button class="lp-dark-btn" data-action="buy-annual">Pro — $39/yr</button>
      </div>
    </nav>

    <section class="lp-hero">
      <div class="lp-hero-copy">
        <h1>One note.<br>Multiple tabs.<br>Everything findable.</h1>
        <p>Nowt is for notes that become little worlds — a launch plan, a trip, a research rabbit hole. Multiple tabs per note. Images, voice, checklists, and tables inline. Search by type.</p>
        <div class="lp-hero-actions">
          <a class="lp-dark-btn lp-dark-btn--lg" href="#get-nowt">Download for Mac — Free</a>
          <button class="lp-ghost-btn lp-ghost-btn--lg" data-action="buy-annual">Get Pro — $39/year</button>
        </div>
        <span class="lp-onetime">macOS 12+ · No account needed · iOS app coming soon — free to download</span>
      </div>
      <div class="lp-window">
        <div class="lp-titlebar">
          <span class="lp-dot lp-dot--red"></span>
          <span class="lp-dot lp-dot--yellow"></span>
          <span class="lp-dot lp-dot--green"></span>
        </div>
        <div class="lp-window-body">
          <div class="lp-w-sidebar">
            <div class="lp-w-brand">
              <span class="lp-w-mark"></span>
              <div><strong>Nowt</strong><small>4 notes</small></div>
            </div>
            <div class="lp-w-note lp-w-note--active">
              <strong>Tokyo Trip</strong>
              <span>Fuunji for ramen, teamLab Planets on Tuesday, budget ¥</span>
              <small>Today</small>
            </div>
            <div class="lp-w-note">
              <strong>Brand Refresh</strong>
              <span>Logo direction — leaning into the geometric mark</span>
              <small>Yesterday</small>
            </div>
            <div class="lp-w-note">
              <strong>Q3 Review</strong>
              <span>Revenue up 34%, churn needs attention in month 2</span>
              <small>Jun 2</small>
            </div>
            <div class="lp-w-note">
              <strong>Podcast Research</strong>
              <span>Guests shortlist, format ideas, equipment notes</span>
              <small>May 28</small>
            </div>
          </div>
          <div class="lp-w-editor">
            <div class="lp-w-crumb">Tokyo Trip / Restaurants</div>
            <div class="lp-w-title">Tokyo Trip</div>
            <div class="lp-w-tabs">
              <span class="lp-w-tab">Itinerary</span>
              <span class="lp-w-tab lp-w-tab--active">Restaurants</span>
              <span class="lp-w-tab">Budget</span>
              <span class="lp-w-tab">Packing</span>
            </div>
            <div class="lp-w-body">
              <p><strong>Ramen</strong></p>
              <p>Fuunji (Shinjuku) — tsukemen, arrive before 11am. Ichiran for solo late-night bowl. Afuri in Ebisu for yuzu shio.</p>
              <p><strong>Sushi</strong></p>
              <p>Sushi Saito if we get lucky with a reservation. Tsukiji outer market for morning breakfast omakase.</p>
              <img class="lp-w-img-block" src="lp-hero-img.webp" alt="" />
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="lp-features">

      <div class="lp-feature">
        <div class="lp-feature-copy">
          <span class="lp-label">Tabs</span>
          <h2>One note. Every tab.</h2>
          <p>When a topic grows, add a tab. Your research, links, receipts, and reference material all live inside the same note. Text, images, voice, checklists, and tables, all inline. No separate documents, no folders.</p>
        </div>
        <div class="lp-mock lp-mock--tabs">
          <div class="lp-w-title" style="padding:20px 20px 12px;font-size:22px">Brand Refresh</div>
          <div class="lp-w-tabs" style="padding:0 20px 12px;margin:0">
            <span class="lp-w-tab lp-w-tab--active">Direction</span>
            <span class="lp-w-tab">Mood refs</span>
            <span class="lp-w-tab">Feedback</span>
            <span class="lp-w-tab">Copy</span>
            <span class="lp-w-tab lp-w-tab--add">+</span>
          </div>
          <div class="lp-mock-content" style="padding:16px 20px 20px;font-size:14px;line-height:1.65;border-top:1px solid var(--rule)">
            <p style="margin:0 0 8px"><strong>The mark</strong></p>
            <p style="margin:0 0 8px;color:var(--muted)">Square with a diagonal split — ink and accent. Geometric, confident, doesn't date. Works at 16px and 400px.</p>
            <p style="margin:0 0 8px"><strong>Type pairing</strong></p>
            <p style="margin:0;color:var(--muted)">Space Grotesk for display. DM Sans for body. Both have personality without screaming.</p>
          </div>
        </div>
      </div>

      <div class="lp-feature lp-feature--flip">
        <div class="lp-feature-copy">
          <span class="lp-label">Context search</span>
          <h2>Filter by what it is, not just what it says.</h2>
          <p>Search across all your notes and filter by content type: text, images, links, or voice. Results show the note and tab they came from so you land exactly where you need to be.</p>
        </div>
        <div class="lp-mock lp-mock--search">
          <div style="padding:16px 16px 0">
            <div class="lp-search-bar">ramen</div>
            <div class="lp-search-filters">
              <span class="lp-filter">All</span>
              <span class="lp-filter lp-filter--active">Images</span>
              <span class="lp-filter">Text</span>
              <span class="lp-filter">Links</span>
              <span class="lp-filter">Voice</span>
            </div>
          </div>
          <div class="lp-results-list" style="padding:0 16px 16px">
            <div class="lp-result">
              <div class="lp-result-label">IMAGE · Tokyo Trip / Restaurants</div>
              <img class="lp-result-img" src="lp-result-img.webp" alt="Fuunji tsukemen" />
              <div class="lp-result-snippet">Fuunji counter shot — tsukemen with thick noodles</div>
            </div>
            <div class="lp-result">
              <div class="lp-result-label">IMAGE · Tokyo Trip / Itinerary</div>
              <img class="lp-result-img lp-result-img--wide" src="lp-result-img--wide.webp" alt="Queue outside ramen shop" />
              <div class="lp-result-snippet">Queue outside at 10:45am, worth it</div>
            </div>
          </div>
        </div>
      </div>

      <div class="lp-feature">
        <div class="lp-feature-copy">
          <span class="lp-label">iCloud Drive sync · Pro</span>
          <h2>Your notes live in your folder. Not our servers.</h2>
          <p>Connect your iCloud Drive folder with Nowt Pro. Your notes and media are stored as plain files that Apple syncs across your Mac and iPhone. No servers, no data lock-in. The iOS app is free — Pro is what bridges them.</p>
        </div>
        <div class="lp-mock lp-mock--sync">
          <div class="lp-sync-row">
            <div class="lp-sync-dot"></div>
            <span>Synced · Nowt</span>
          </div>
          <div class="lp-folder-row">
            <span class="lp-folder-icon">📁</span>
            <div>
              <div style="font-size:13px;font-weight:600">iCloud Drive / Nowt</div>
              <div style="font-size:11px;color:var(--muted)">notes.json · media/ (14 files)</div>
            </div>
          </div>
          <div class="lp-file-list">
            <div class="lp-file-row"><span class="lp-file-icon">{ }</span>notes.json <span class="lp-file-meta">4 KB · just now</span></div>
            <div class="lp-file-row"><span class="lp-file-icon">▣</span>image_ab3f.jpg <span class="lp-file-meta">2.1 MB</span></div>
            <div class="lp-file-row"><span class="lp-file-icon">◉</span>voice_c91d.webm <span class="lp-file-meta">840 KB</span></div>
          </div>
        </div>
      </div>

    </section>

    <section class="lp-howtoget" id="get-nowt">
      <div class="lp-howtoget-inner">
        <h2>Get Nowt</h2>
        <div class="lp-platform-grid lp-platform-grid--two">
          <div class="lp-platform">
            <div class="lp-platform-badge">Free · Mac</div>
            <h3>Mac App</h3>
            <p>Native Mac app. Your notes stay on your device. No account, no server, nothing in the cloud unless you choose it.</p>
            <small class="lp-platform-req">macOS 12 Monterey or later</small>
            <div class="lp-download-chips">
              <a class="lp-download-chip-btn" href="${DOWNLOAD_URL_ARM64}" download>Download (Apple Silicon)</a>
              <a class="lp-download-chip-btn" href="${DOWNLOAD_URL_X64}" download>Download (Intel)</a>
            </div>
          </div>
          <div class="lp-platform">
            <div class="lp-platform-badge lp-platform-badge--soon">Coming soon · Free</div>
            <h3>iPhone &amp; iPad</h3>
            <p>Free to download. Local notes on-device, same as Mac. Pro unlocks iCloud sync so your notes travel between your Mac and iPhone automatically.</p>
            <small class="lp-platform-req">iOS 16+ · Pro sync uses same iCloud folder as Mac</small>
            <a class="lp-ghost-btn lp-platform-cta" href="mailto:kraftyave@gmail.com?subject=Nowt%20iOS%20%E2%80%94%20notify%20me" data-track="notify-ios">Notify me when it ships →</a>
          </div>
        </div>
      </div>
    </section>

    <section class="lp-pricing">
      <div class="lp-pricing-label">Pricing</div>

      <div class="lp-billing-toggle">
        <button class="lp-billing-opt${landingBilling === "monthly" ? " lp-billing-opt--active" : ""}" data-action="landing-billing-monthly">Monthly</button>
        <button class="lp-billing-opt${landingBilling === "annual" ? " lp-billing-opt--active" : ""}" data-action="landing-billing-annual">Annual <span class="lp-billing-save">Save 35%</span></button>
      </div>

      <div class="lp-pricing-grid">

        <div class="lp-plan">
          <div class="lp-plan-name">Free</div>
          <div class="lp-plan-price">$0 <span>forever</span></div>
          <ul class="lp-plan-features">
            <li>Unlimited notes</li>
            <li>3 tabs per note</li>
            <li>Inline images &amp; voice</li>
            <li>Tables &amp; checklists</li>
            <li>Full search with context filters</li>
            <li>Offline-first — your data, on-device</li>
          </ul>
          <a class="lp-ghost-btn lp-ghost-btn--full" href="#get-nowt">Download for Mac free →</a>
        </div>

        <div class="lp-plan lp-plan--pro">
          <div class="lp-plan-name">Pro <span class="lp-pro-tag">✦</span></div>
          ${landingBilling === "annual"
            ? `<div class="lp-plan-price">$3.25 <span>/mo</span></div><div class="lp-plan-alt">Billed $39/year</div>`
            : `<div class="lp-plan-price">$4.99 <span>/mo</span></div><div class="lp-plan-alt">Billed monthly</div>`
          }
          <ul class="lp-plan-features">
            <li>Everything in Free</li>
            <li>Unlimited tabs per note</li>
            <li>Freehand sketches inline</li>
            <li>iCloud Drive sync</li>
            <li>iOS app (free) + iCloud sync between devices</li>
          </ul>
          <button class="lp-dark-btn lp-dark-btn--full" data-action="${landingBilling === "annual" ? "buy-annual" : "buy-monthly"}">
            Get Pro — ${landingBilling === "annual" ? "$39/year" : "$4.99/mo"}
          </button>
        </div>

      </div>
    </section>

    <footer class="lp-footer">
      <div class="lp-footer-brand">
        <img src="${isDark() ? "logotype-landing-dark.svg" : "logotype.svg"}" class="lp-logotype lp-footer-logotype" alt="Nowt" />
      </div>
      <span>© 2026 · Made with intention</span>
    </footer>

  </div>
  `;
}

function initLandingAnimations() {
  const timers = [];

  // ── Hero: cycle notes + editor content ────────────────────────────────────
  const heroNotes = [...document.querySelectorAll(".lp-w-sidebar .lp-w-note")];
  const heroBody = document.querySelector(".lp-window .lp-w-body");
  const heroCrumb = document.querySelector(".lp-w-crumb");
  const heroTitle = document.querySelector(".lp-window .lp-w-title");
  const heroTabsEl = document.querySelector(".lp-window .lp-w-tabs");

  if (heroNotes.length && heroBody) {
    const heroStates = [
      { note: 0, crumb: "Tokyo Trip / Restaurants", title: "Tokyo Trip",
        tabs: ["Itinerary", "Restaurants", "Budget", "Packing"], activeTab: 1,
        body: `<p><strong>Ramen</strong></p><p>Fuunji (Shinjuku) — tsukemen, arrive before 11am. Ichiran for late-night. Afuri for yuzu shio.</p><p><strong>Sushi</strong></p><p>Sushi Saito if lucky. Tsukiji outer market for morning omakase.</p><img class="lp-w-img-block" src="lp-hero-img.webp" alt="" />` },
      { note: 1, crumb: "Brand Refresh / Direction", title: "Brand Refresh",
        tabs: ["Direction", "Mood refs", "Feedback", "Copy"], activeTab: 0,
        body: `<p><strong>The mark</strong></p><p>Square with diagonal split — ink and accent. Geometric, confident, doesn't date.</p><p><strong>Type pairing</strong></p><p>Space Grotesk for display. DM Sans for body. Personality without screaming.</p>` },
      { note: 2, crumb: "Q3 Review / Results", title: "Q3 Review",
        tabs: ["Results", "Action items", "Notes"], activeTab: 0,
        body: `<p><strong>Revenue</strong></p><p>Up 34% QoQ. ARR crossed $420k. Churn 3.2% — needs attention in month 2.</p><p><strong>Next quarter</strong></p><p>Retention playbook, enterprise tier, second engineering hire.</p>` },
      { note: 3, crumb: "Podcast Research / Guests", title: "Podcast Research",
        tabs: ["Guests", "Format", "Equipment"], activeTab: 0,
        body: `<p><strong>Guests shortlist</strong></p><p>DHH, Anne-Laure Le Cunff, Paul Millerd. 45 min, no slides, let it roam.</p><p><strong>Equipment</strong></p><p>Shure SM7B, Focusrite 2i2, Riverside.fm for remote recording.</p>` },
    ];
    let heroIdx = 0;
    timers.push(setInterval(() => {
      heroIdx = (heroIdx + 1) % heroStates.length;
      const s = heroStates[heroIdx];
      heroNotes.forEach((n, i) => n.classList.toggle("lp-w-note--active", i === s.note));
      if (heroCrumb) heroCrumb.textContent = s.crumb;
      if (heroTitle) heroTitle.textContent = s.title;
      if (heroTabsEl) heroTabsEl.innerHTML = s.tabs.map((t, i) =>
        `<span class="lp-w-tab${i === s.activeTab ? " lp-w-tab--active" : ""}">${t}</span>`
      ).join("") + `<span class="lp-w-tab lp-w-tab--add">+</span>`;
      heroBody.style.opacity = "0";
      setTimeout(() => { if (heroBody.isConnected) { heroBody.innerHTML = s.body; heroBody.style.opacity = "1"; } }, 220);
    }, 3500));
  }

  // ── Tabs feature mock: cycle active tab + content ─────────────────────────
  const mockTabsEl = document.querySelector(".lp-mock--tabs .lp-w-tabs");
  const mockContent = document.querySelector(".lp-mock-content");
  if (mockTabsEl && mockContent) {
    const tabLabels = ["Direction", "Mood refs", "Feedback", "Copy"];
    const tabBodies = [
      `<p style="margin:0 0 8px"><strong>The mark</strong></p><p style="margin:0 0 8px;color:var(--muted)">Square with a diagonal split — ink and accent. Geometric, confident, doesn't date.</p><p style="margin:0 0 8px"><strong>Type pairing</strong></p><p style="margin:0;color:var(--muted)">Space Grotesk for display. DM Sans for body. Both have personality without screaming.</p>`,
      `<p style="margin:0 0 8px"><strong>Visual direction</strong></p><p style="margin:0 0 8px;color:var(--muted)">Brutalist editorial with warmth. Black, cream, brick-red accent. Monocle meets early internet.</p><p style="margin:0;color:var(--muted)">Reference: Emigre Vol. 23, Walker Art Center identity system.</p>`,
      `<p style="margin:0 0 8px"><strong>Client notes — May 14</strong></p><p style="margin:0 0 8px;color:var(--muted)">Loves the mark. Wants to see it smaller in lockup. Ask about animation for digital.</p><p style="margin:0;color:var(--muted)">Follow up by Friday on the secondary wordmark option.</p>`,
      `<p style="margin:0 0 8px"><strong>Tagline candidates</strong></p><p style="margin:0 0 8px;color:var(--muted)">1. Made with craft. Built for scale. 2. Quietly confident. 3. A mark worth keeping.</p><p style="margin:0;color:var(--muted)">Current favourite: #3. Test at small sizes against the mark.</p>`,
    ];
    let tabIdx = 0;
    timers.push(setInterval(() => {
      tabIdx = (tabIdx + 1) % tabLabels.length;
      mockTabsEl.innerHTML = tabLabels.map((t, i) =>
        `<span class="lp-w-tab${i === tabIdx ? " lp-w-tab--active" : ""}">${t}</span>`
      ).join("") + `<span class="lp-w-tab lp-w-tab--add">+</span>`;
      mockContent.style.opacity = "0";
      setTimeout(() => { if (mockContent.isConnected) { mockContent.innerHTML = tabBodies[tabIdx]; mockContent.style.opacity = "1"; } }, 200);
    }, 2200));
  }

  // ── Search mock: cycle filter + results ───────────────────────────────────
  const searchFiltersEl = document.querySelector(".lp-mock--search .lp-search-filters");
  const searchResultsEl = document.querySelector(".lp-results-list");
  if (searchFiltersEl && searchResultsEl) {
    const filterLabels = ["All", "Images", "Text", "Links", "Voice"];
    const filterResults = [
      `<div class="lp-result"><div class="lp-result-label">TEXT · Tokyo Trip / Restaurants</div><div class="lp-result-snippet">Fuunji (Shinjuku) — tsukemen, arrive before 11am. Ichiran for late-night.</div></div><div class="lp-result"><div class="lp-result-label">IMAGE · Tokyo Trip / Itinerary</div><img class="lp-result-img lp-result-img--wide" src="lp-result-img--wide.webp" alt="" /><div class="lp-result-snippet">Queue outside at 10:45am, worth it</div></div>`,
      `<div class="lp-result"><div class="lp-result-label">IMAGE · Tokyo Trip / Restaurants</div><img class="lp-result-img" src="lp-result-img.webp" alt="" /><div class="lp-result-snippet">Fuunji counter shot — tsukemen with thick noodles</div></div><div class="lp-result"><div class="lp-result-label">IMAGE · Tokyo Trip / Itinerary</div><img class="lp-result-img lp-result-img--wide" src="lp-result-img--wide.webp" alt="" /><div class="lp-result-snippet">Queue outside at 10:45am, worth it</div></div>`,
      `<div class="lp-result"><div class="lp-result-label">TEXT · Tokyo Trip / Restaurants</div><div class="lp-result-snippet">Fuunji (Shinjuku) — tsukemen, arrive before 11am. Ichiran for late-night.</div></div><div class="lp-result"><div class="lp-result-label">TEXT · Podcast Research / Guests</div><div class="lp-result-snippet">Format: 45 min no slides. Record in Riverside.fm for remote guests.</div></div>`,
      `<div class="lp-result"><div class="lp-result-label">LINK · Tokyo Trip / Restaurants</div><div class="lp-result-snippet" style="color:var(--ink)">tabelog.com/tokyo/A1304/A130401/13004056</div></div><div class="lp-result"><div class="lp-result-label">LINK · Brand Refresh / Mood refs</div><div class="lp-result-snippet" style="color:var(--ink)">are.na/channel/brutalist-editorial</div></div>`,
      `<div class="lp-result"><div class="lp-result-label">VOICE · Tokyo Trip / Itinerary</div><div class="lp-result-snippet">Note to self: check teamLab Planets ticket availability — preferably morning slot</div></div>`,
    ];
    let filterIdx = 1;
    timers.push(setInterval(() => {
      filterIdx = (filterIdx + 1) % filterLabels.length;
      searchFiltersEl.innerHTML = filterLabels.map((f, i) =>
        `<span class="lp-filter${i === filterIdx ? " lp-filter--active" : ""}">${f}</span>`
      ).join("");
      searchResultsEl.style.opacity = "0";
      setTimeout(() => { if (searchResultsEl.isConnected) { searchResultsEl.innerHTML = filterResults[filterIdx]; searchResultsEl.style.opacity = "1"; } }, 200);
    }, 2500));
  }

  return () => timers.forEach(clearInterval);
}

function renderList(compact = false) {
  const visibleNotes = sortedNotes();
  const selCount = selectedNoteIds.size;
  const allSelected = visibleNotes.length > 0 && visibleNotes.every((n) => selectedNoteIds.has(n.id));
  return `
      <section class="list-view ${compact ? "compact-list" : ""} fade-in${selectMode ? " list-select-mode" : ""}">
      <header class="list-head" ${isElectron ? 'style="-webkit-app-region:drag"' : ''}>
        <div class="head-actions">
          <button class="icon-btn" data-action="open-search" title="Search">⌕</button>
          <button class="icon-btn dark-btn" data-action="new-note" title="New note">+</button>
        </div>
      </header>
      <nav class="list-filters">
        ${listFilters.map((filter) => `<button class="${state.listFilter === filter ? "active" : ""}" data-list-filter="${filter}">${filter}</button>`).join("")}
      </nav>
      <div class="section-label">
        <span>${listFilterLabel()}</span>
        ${state.listFilter === "trash" && visibleNotes.length > 0 && !selectMode
          ? `<button class="empty-trash-btn" data-action="empty-trash">Empty Trash</button>`
          : `<em>${visibleNotes.length} visible</em>`}
      </div>
      <div class="note-list">${visibleNotes.map((item) => renderNoteRow(item)).join("")}</div>
      ${selectMode ? `<div class="bulk-bar">
        <div class="bulk-bar-row">
          <span class="bulk-count">${selCount} selected</span>
          <button class="bulk-select-all" data-action="bulk-toggle-all">${allSelected ? "Deselect" : "All"}</button>
          <button class="bulk-done" data-action="bulk-done">Done</button>
        </div>
        <div class="bulk-bar-actions">
          ${state.listFilter === "trash" ? `
            <button data-bulk-action="restore" ${selCount === 0 ? "disabled" : ""}>Restore</button>
            <button data-bulk-action="delete-forever" class="bulk-danger" ${selCount === 0 ? "disabled" : ""}>Delete Forever</button>
          ` : `
            <button data-bulk-action="archive" ${selCount === 0 ? "disabled" : ""}>Archive</button>
            <button data-bulk-action="trash" class="bulk-danger" ${selCount === 0 ? "disabled" : ""}>Delete</button>
          `}
        </div>
      </div>` : ""}
      <footer class="list-foot">
        <div class="list-foot-left">
          <img src="${isDark() ? "logotype-dark.svg" : "logotype.svg"}" class="logotype" alt="Nowt" />
          <small>${state.notes.filter(n => !n.deletedAt).length} notes</small>
        </div>
        <button class="list-foot-settings" data-action="open-settings" title="Settings">
          <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clip-rule="evenodd"/></svg>
        </button>
      </footer>
    </section>
  `;
}

function renderLibrary(note) {
  const photos = [];
  const links = [];
  const voices = [];
  note.tabs.forEach((tab) => {
    tab.attachments.forEach((item) => {
      if (item.kind === "photo" || item.kind === "sketch") photos.push({ item, tab });
      if (item.kind === "voice") voices.push({ item, tab });
    });
    extractLinks(tab.inlineContent || tab.content || "").forEach((url) => {
      if (!links.find((l) => l.url === url && l.tab.id === tab.id)) {
        links.push({ url, tab });
      }
    });
  });
  const libTab = state.libraryTab || "photos";
  let content = "";
  if (libTab === "photos") {
    content = photos.length
      ? `<div class="library-grid">${photos.map(({ item, tab }) =>
          `<button class="lib-photo" data-result-note="${note.id}" data-result-tab="${tab.id}" data-result-block="${item.id}">
            <img data-media="${item.id}" alt="${escapeHtml(item.name || "Image")}" />
            <span class="lib-chip">${escapeHtml(tabLabel(tab))}</span>
          </button>`).join("")}</div>`
      : `<p class="lib-empty">No images in this note yet.</p>`;
  } else if (libTab === "links") {
    content = links.length
      ? `<div class="lib-list">${links.map(({ url, tab }) =>
          `<button class="lib-link" data-result-note="${note.id}" data-result-tab="${tab.id}" data-result-block="">
            <span class="lib-url">${escapeHtml(url)}</span>
            <span class="lib-chip lib-chip--inline">${escapeHtml(tabLabel(tab))}</span>
          </button>`).join("")}</div>`
      : `<p class="lib-empty">No links in this note yet.</p>`;
  } else {
    content = voices.length
      ? `<div class="lib-list">${voices.map(({ item, tab }) =>
          `<button class="lib-voice" data-result-note="${note.id}" data-result-tab="${tab.id}" data-result-block="${item.id}">
            <span class="lib-voice-meta">${item.duration ? item.duration + "s · " : ""}Voice</span>
            <span class="lib-chip lib-chip--inline">${escapeHtml(tabLabel(tab))}</span>
          </button>`).join("")}</div>`
      : `<p class="lib-empty">No voice memos in this note yet.</p>`;
  }
  return `<div class="sheet-backdrop" data-action="close-library">
    <div class="library-sheet" onclick="event.stopPropagation()">
      <header class="sheet-head">
        <strong>Library</strong>
        <button class="icon-btn" data-action="close-library">×</button>
      </header>
      <nav class="library-nav">
        <button class="${libTab === "photos" ? "active" : ""}" data-lib-tab="photos">Images<em>${photos.length}</em></button>
        <button class="${libTab === "links" ? "active" : ""}" data-lib-tab="links">Links<em>${links.length}</em></button>
        <button class="${libTab === "voice" ? "active" : ""}" data-lib-tab="voice">Voice<em>${voices.length}</em></button>
      </nav>
      <div class="library-body">${content}</div>
    </div>
  </div>`;
}

const _NAV_BACK_SVG = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="10,3 5,8 10,13"/></svg>`;
const _NAV_LIB_SVG = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1" y="1" width="5" height="5" rx="1"/><rect x="8" y="1" width="5" height="5" rx="1"/><rect x="1" y="8" width="5" height="5" rx="1"/><rect x="8" y="8" width="5" height="5" rx="1"/></svg>`;
const _VTABS_ICON_SVG = `<svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="1" y="1" width="11" height="11" rx="1.5"/><line x1="9" y1="1.5" x2="9" y2="11.5"/><line x1="9.5" y1="3.5" x2="12" y2="3.5"/><line x1="9.5" y1="6.5" x2="12" y2="6.5"/><line x1="9.5" y1="9.5" x2="12" y2="9.5"/></svg>`;
const _HTABS_ICON_SVG = `<svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="1" y="1" width="11" height="11" rx="1.5"/><line x1="1.5" y1="5" x2="11.5" y2="5"/><line x1="3.5" y1="1.5" x2="3.5" y2="5"/><line x1="6.5" y1="1.5" x2="6.5" y2="5"/><line x1="9.5" y1="1.5" x2="9.5" y2="5"/></svg>`;
const _PIN_SVG        = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14M8 5h8v7l2 5H6l2-5V5z"/></svg>`;
const _PIN_FILLED_SVG = `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5"><line x1="12" y1="17" x2="12" y2="22" stroke-width="2.2"/><path d="M5 17h14M8 5h8v7l2 5H6l2-5V5z"/></svg>`;
const _EYE_OFF_SVG    = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

function renderVerticalTabBar(note, tab) {
  const mode = state.vtabsMode || "normal";
  const modeClass = mode === "expanded" ? " is-expanded" : mode === "hidden" ? " is-hidden" : "";
  const isLocked = !isProSubscriber() && note.tabs.length >= FREE_TAB_LIMIT;
  const pinIcon = mode === "expanded" ? _PIN_FILLED_SVG : mode === "hidden" ? _EYE_OFF_SVG : _PIN_SVG;
  const pinTitle = mode === "expanded" ? "Pinned open — click to hide bar" : mode === "hidden" ? "Bar hidden — click to reset" : "Pin sidebar open";
  return `
    <nav class="tabs-vertical${modeClass}" data-vtabs>
      <div class="vtabs-list">
        ${note.tabs.map((item) => `
          <button class="vtab${item.id === tab.id ? " active" : ""}" data-tab="${item.id}" title="${escapeHtml(tabLabel(item))}">
            <span class="vtab-abbr">${escapeHtml(tabLabel(item).charAt(0).toUpperCase())}</span>
            <span class="vtab-full">${escapeHtml(tabLabel(item))}</span>
            ${note.tabs.length > 1 ? `<span class="vtab-close" data-close-tab="${item.id}">×</span>` : ""}
          </button>
        `).join("")}
        ${isLocked ? `
        <button class="vtab vtab--add add-tab--locked" title="Upgrade to Pro for unlimited tabs">
          <span class="vtab-abbr">⚿</span>
          <span class="vtab-full">Upgrade to Pro</span>
        </button>` : `
        <button class="vtab vtab--add add-tab-btn" data-add-tab title="Add tab">
          <span class="vtab-abbr">+</span>
          <span class="vtab-full">+ New tab</span>
        </button>`}
      </div>
      <div class="vtabs-footer">
        <button class="vtab-pin-btn${mode !== "normal" ? " active" : ""}" data-action="toggle-vtabs-pin" title="${pinTitle}">${pinIcon}</button>
        <button class="vtab-layout-btn" data-action="toggle-tab-layout" title="Switch to horizontal tabs">${_HTABS_ICON_SVG}</button>
      </div>
    </nav>
  `;
}

function renderEditor(note, tab) {
  const editBar = `
    <div class="edit-bar">
      ${recorder ? `
        <div class="recording-inline">
          <span class="recording-dot"></span>
          <em data-live-transcript>Listening...</em>
          <button class="recording-stop-btn" data-action="stop-recording">Stop</button>
        </div>
      ` : `
        <div class="tool-group" aria-label="Formatting">
          ${commands.map(([label, icon]) => `<button data-command="${label}" title="${label}">${icon}</button>`).join("")}
        </div>
        <div class="tool-group insert-tools" aria-label="Insert">
          <label title="Image">▧<input data-photo type="file" accept="image/*" style="display:none" /></label>
          <button data-action="link" title="Link">⌁</button>
          <button data-action="insert-table" title="Table"><svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="1" y="1" width="11" height="11" rx="1.2"/><line x1="1" y1="4.5" x2="12" y2="4.5"/><line x1="5" y1="4.5" x2="5" y2="12"/><line x1="9" y1="4.5" x2="9" y2="12"/></svg></button>
          <button data-action="open-sketch" title="${isProSubscriber() ? "Sketch" : "Sketch · Pro"}" class="${isProSubscriber() ? "" : "tool-btn--pro"}"><svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M9.5 1.5l2 2-7 7H2.5v-2l7-7z"/><line x1="7.5" y1="3.5" x2="9.5" y2="5.5"/></svg></button>
          <button data-action="record" title="Voice">◉</button>
        </div>
      `}
      <div class="edit-bar-right">
        <button class="icon-btn" data-action="open-library" title="Note library">${_NAV_LIB_SVG}</button>
        <button class="icon-btn" data-action="open-note-search" title="Find in note">⌕</button>
      </div>
    </div>`;

  if (note.deletedAt) {
    const trashScrollContent = `
      <div class="note-nav-float">
        <div class="note-nav-pill">
          <button class="icon-btn" data-action="back" aria-label="Back to notes">${_NAV_BACK_SVG}</button>
        </div>
        <div></div>
      </div>
      <div class="note-status-banner note-status-banner--trash">
        <span>This note is in Trash. Auto-empties after 30 days.</span>
        <div class="note-status-banner-actions">
          <button class="banner-btn" data-restore-note="${note.id}">Restore</button>
          <button class="banner-btn banner-btn--danger" data-delete-forever="${note.id}">Delete forever</button>
        </div>
      </div>
      <div class="breadcrumb">${escapeHtml(note.title || "Untitled")} / ${escapeHtml(tabLabel(tab))}</div>
      <p class="title-input title-input--readonly">${escapeHtml(note.title || "Untitled")}</p>
      ${state.tabLayout !== "vertical" ? `<div class="tabs-wrap"><nav class="tabs" data-tabs>${note.tabs.map((item) => `<button class="tab ${item.id === tab.id ? "active" : ""}" data-tab="${item.id}">${escapeHtml(tabLabel(item))}</button>`).join("")}</nav><button class="tab-layout-toggle" data-action="toggle-tab-layout" title="Vertical tabs">${_VTABS_ICON_SVG}</button></div>` : ""}
      <article class="note-body line-${tab.lineSpacing || "normal"}">
        ${tab.type === "checklist" ? `<div class="checklist-tab">${renderChecklistItemsReadonly(tab)}</div>` : `<div class="editor editor--readonly" contenteditable="false" spellcheck="false">${tab.inlineContent || "<p></p>"}</div>`}
      </article>`;
    if (state.tabLayout === "vertical") {
      return `
        <section class="paper fade-in vtabs-active">
          <div class="vtabs-row">
            <div class="paper-scroll">${trashScrollContent}</div>
            ${renderVerticalTabBar(note, tab)}
          </div>
        </section>`;
    }
    return `
      <section class="paper fade-in">
        <div class="paper-scroll">${trashScrollContent}</div>
      </section>`;
  }
  if (note.status === "archived") {
    const archiveScrollContent = `
      <div class="note-nav-float">
        <div class="note-nav-pill">
          <button class="icon-btn" data-action="back" aria-label="Back to notes">${_NAV_BACK_SVG}</button>
        </div>
        <div></div>
      </div>
      <div class="note-status-banner note-status-banner--archive">
        <span>This note is archived.</span>
        <div class="note-status-banner-actions">
          <button class="banner-btn" data-unarchive-note="${note.id}">Unarchive</button>
        </div>
      </div>
      <div class="breadcrumb">${escapeHtml(note.title || "Untitled")} / ${escapeHtml(tabLabel(tab))}</div>
      <p class="title-input title-input--readonly">${escapeHtml(note.title || "Untitled")}</p>
      ${state.tabLayout !== "vertical" ? `<div class="tabs-wrap"><nav class="tabs" data-tabs>${note.tabs.map((item) => `<button class="tab ${item.id === tab.id ? "active" : ""}" data-tab="${item.id}">${escapeHtml(tabLabel(item))}</button>`).join("")}</nav><button class="tab-layout-toggle" data-action="toggle-tab-layout" title="Vertical tabs">${_VTABS_ICON_SVG}</button></div>` : ""}
      <article class="note-body line-${tab.lineSpacing || "normal"}">
        ${tab.type === "checklist" ? `<div class="checklist-tab">${renderChecklistItemsReadonly(tab)}</div>` : `<div class="editor editor--readonly" contenteditable="false" spellcheck="false">${tab.inlineContent || "<p></p>"}</div>`}
      </article>`;
    if (state.tabLayout === "vertical") {
      return `
        <section class="paper fade-in vtabs-active">
          <div class="vtabs-row">
            <div class="paper-scroll">${archiveScrollContent}</div>
            ${renderVerticalTabBar(note, tab)}
          </div>
        </section>`;
    }
    return `
      <section class="paper fade-in">
        <div class="paper-scroll">${archiveScrollContent}</div>
      </section>`;
  }
  const noteHeader = `
    <div class="note-nav-float">
      <div class="note-nav-pill note-nav-back-pill">
        <button class="icon-btn" data-action="back" aria-label="Back to notes">${_NAV_BACK_SVG}</button>
      </div>
      <div></div>
    </div>
    <div class="breadcrumb">${escapeHtml(note.title || "Untitled")} / ${escapeHtml(tabLabel(tab))}</div>
    <input class="title-input" data-title value="${escapeHtml(note.title)}" placeholder="Untitled" />
    <div class="note-meta">
      <select data-status>${statuses.map((status) => `<option value="${status}" ${note.status === status ? "selected" : ""}>${status}</option>`).join("")}</select>
      <span>${new Date(note.updatedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
      <div class="note-meta-actions">
        <button class="icon-btn${note.pinned ? " active" : ""}" data-action="toggle-pin" title="${note.pinned ? "Unpin" : "Pin note"}"><svg width="13" height="13" viewBox="0 0 24 24" fill="${note.pinned ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14M8 5h8v7l2 5H6l2-5V5z"/></svg></button>
        <button class="icon-btn" data-action="trash-note" title="Move to trash"><svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.4"><polyline points="1,3 12,3"/><path d="M4.5,3V2a.5.5,0,0,1,.5-.5h3a.5.5,0,0,1,.5.5V3"/><path d="M2.5,3l.7,8.5a.5.5,0,0,0,.5.5h5.6a.5.5,0,0,0,.5-.5L10.5,3"/></svg></button>
      </div>
    </div>`;

  function renderContent() {
    if (tab.type === "checklist") {
      return `<article class="note-body"><div class="checklist-tab">${renderChecklistSection(tab)}</div></article>`;
    }
    return `
      <article class="note-body line-${tab.lineSpacing || "normal"}">
        <div class="editor" contenteditable="true" data-editor="${tab.id}" id="editor-${tab.id}" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off" data-gramm="false">${tab.inlineContent || "<p></p>"}</div>
      </article>`;
  }

  const addTabBtn = (() => {
    if (!isProSubscriber() && note.tabs.length >= FREE_TAB_LIMIT) {
      return `<button class="add-tab add-tab--locked" title="Upgrade to Pro for unlimited tabs">⚿</button>`;
    }
    return `<button class="add-tab add-tab-btn" data-add-tab title="Add tab">+</button>`;
  })();

  const tabBar = `
    <div class="tabs-wrap">
      <nav class="tabs" data-tabs>
        ${note.tabs.map((item) => `<button draggable="true" class="tab ${item.id === tab.id ? "active" : ""}" data-tab="${item.id}">${escapeHtml(tabLabel(item))}${note.tabs.length > 1 ? `<span class="tab-close" data-close-tab="${item.id}" title="Close tab">×</span>` : ""}</button>`).join("")}
        ${addTabBtn}
      </nav>
      <button class="tab-layout-toggle" data-action="toggle-tab-layout" title="Vertical tabs">${_VTABS_ICON_SVG}</button>
    </div>`;

  const editorSearch = state.searchOpen && state.searchScope === "note" ? renderSearchSheet() : "";

  const libSheet = state.libraryOpen && note ? renderLibrary(note) : "";

  if (state.tabLayout === "vertical") {
    return `
      <section class="paper fade-in vtabs-active">
        <div class="vtabs-row">
          <div class="paper-scroll">
            ${noteHeader}
            ${renderContent()}
          </div>
          ${renderVerticalTabBar(note, tab)}
        </div>
        ${libSheet}
        ${editorSearch}
        ${editBar}
      </section>
    `;
  }

  return `
      <section class="paper fade-in">
        <div class="paper-scroll">
          ${noteHeader}
          ${tabBar}
          ${renderContent()}
        </div>
        ${libSheet}
        ${editorSearch}
        ${editBar}
      </section>
  `;
}

function renderChecklistSection(tab) {
  if (!tab.checklist?.items) return "";
  return `
    <div class="checklist-panel" data-checklist-tab-id="${tab.id}">
      <div class="checklist-items" data-checklist-items>
        ${tab.checklist.items.map((item) => `
          <div class="checklist-row" data-checklist-row="${item.id}">
            <span class="inline-check" data-checked="${item.checked ? "true" : "false"}" data-checklist-toggle="${item.id}"></span>
            <input class="checklist-text" type="text" value="${escapeHtml(item.text)}" placeholder="Todo..." data-checklist-input="${item.id}" autocomplete="off" autocorrect="off" spellcheck="false" />
            <button class="checklist-delete" data-checklist-delete="${item.id}">×</button>
          </div>
        `).join("")}
      </div>
      <div class="checklist-add-row">
        <input class="checklist-add-input" type="text" placeholder="+ Add item" data-checklist-add="${tab.id}" autocomplete="off" autocorrect="off" spellcheck="false" />
      </div>
    </div>
  `;
}

function renderChecklistItemsReadonly(tab) {
  if (!tab.checklist?.items?.length) return "<p>Empty checklist</p>";
  return tab.checklist.items.map((item) =>
    `<div class="checklist-row"><span class="inline-check" data-checked="${item.checked ? "true" : "false"}"></span><span class="checklist-readonly-text${item.checked ? " checked" : ""}">${escapeHtml(item.text)}</span></div>`
  ).join("");
}

function checklistToggleItem(itemId) {
  const tab = activeTab();
  if (!tab) return;
  const item = tab.checklist?.items?.find((i) => i.id === itemId);
  if (!item) return;
  item.checked = !item.checked;
  activeNote().updatedAt = now();
  saveState();
  const span = document.querySelector(`[data-checklist-toggle="${itemId}"]`);
  if (span) span.setAttribute("data-checked", item.checked ? "true" : "false");
}

function checklistDeleteItem(itemId) {
  const tab = activeTab();
  if (!tab?.checklist?.items) return;
  tab.checklist.items = tab.checklist.items.filter((i) => i.id !== itemId);
  activeNote().updatedAt = now();
  saveState();
  maybeAutoTitleTab(tab);
  render();
}

function checklistAddItem() {
  const tab = activeTab();
  if (!tab) return;
  if (!tab.checklist) tab.checklist = { items: [] };
  const input = document.querySelector(`[data-checklist-add="${tab.id}"]`);
  const text = input?.value?.trim();
  if (!text) return;
  tab.checklist.items.push({ id: uid("chk"), text, checked: false });
  input.value = "";
  activeNote().updatedAt = now();
  saveState();
  maybeAutoTitleTab(tab);
  render();
  requestAnimationFrame(() => {
    const inp = document.querySelector(`[data-checklist-add="${tab.id}"]`);
    if (inp) inp.focus();
  });
}

function checklistUpdateItem(itemId, text) {
  const tab = activeTab();
  if (!tab) return;
  const item = tab.checklist?.items?.find((i) => i.id === itemId);
  if (!item) return;
  item.text = text;
  activeNote().updatedAt = now();
  saveState();
  if (itemId === tab.checklist?.items?.[0]?.id) {
    maybeAutoTitleTab(tab);
  }
}

function renderSettings() {
  const isPro = isProSubscriber();
  const email = proEmail();
  const theme = localStorage.getItem(THEME_KEY) || "system";
  return `
    <div class="settings-backdrop" data-action="close-settings">
      <div class="settings-modal" onclick="event.stopPropagation()">
        <div class="settings-modal-head">
          <span>Settings</span>
          <button class="settings-close" data-action="close-settings">×</button>
        </div>

        <div class="settings-section">
          <p class="settings-label">Plan</p>
          ${isPro ? `
            <div class="settings-row">
              <span class="settings-license-active">Pro</span>
              <span class="settings-value">${email || "Active"}</span>
            </div>
            <div class="settings-row">
              <a class="settings-hint settings-buy-link" href="${DODO_PORTAL_URL}" target="_blank">Manage billing →</a>
            </div>
            <div class="settings-row settings-row--danger">
              <button class="settings-deactivate-btn" data-action="deactivate-pro">Deactivate Pro on this device</button>
            </div>
          ` : `
            <div class="settings-row settings-plan-free">
              <span class="settings-value">Free</span>
              <button class="settings-btn settings-btn--primary" data-action="open-upgrade">Upgrade to Pro</button>
            </div>
            <div class="settings-row">
              <button class="pro-restore-link" data-action="open-restore">Already subscribed? Restore access</button>
            </div>
          `}
        </div>

        <div class="settings-section">
          <p class="settings-label">Sync</p>
          ${isPro ? (
            state.syncStatus === "folder"
              ? `<div class="settings-row"><span class="settings-value">Connected · <strong>${folderHandle?.name || "iCloud Drive"}</strong></span><button class="settings-btn" data-action="disconnect-folder">Disconnect</button></div>`
              : `<div class="settings-row"><button class="settings-btn settings-btn--primary" data-action="connect-folder">Connect iCloud Drive</button><span class="settings-hint">Notes stay on your device.</span></div>`
          ) : `
            <div class="settings-row">
              <span class="settings-value settings-muted">iCloud sync · Pro feature</span>
              <button class="settings-btn settings-btn--primary" data-action="open-upgrade">Upgrade</button>
            </div>
          `}
        </div>

        <div class="settings-section">
          <p class="settings-label">Appearance</p>
          <div class="settings-theme-row">
            <button class="settings-btn${theme === "system" ? " settings-btn--active" : ""}" data-action="set-theme-system">System</button>
            <button class="settings-btn${theme === "light" ? " settings-btn--active" : ""}" data-action="set-theme-light">Light</button>
            <button class="settings-btn${theme === "dark" ? " settings-btn--active" : ""}" data-action="set-theme-dark">Dark</button>
          </div>
        </div>

        <div class="settings-section">
          <p class="settings-label">Data</p>
          <div class="settings-row">
            <button class="settings-btn" data-action="export-notes">Export as JSON</button>
            <span class="settings-hint">Full backup of all notes.</span>
          </div>
        </div>

        <div class="settings-section settings-section--last">
          <p class="settings-label">About</p>
          <p class="settings-value">Nowt v1.0 · <a href="https://takenowt.vercel.app" target="_blank">takenowt.vercel.app</a></p>
        </div>
      </div>
    </div>
  `;
}

function renderSearchSheetContent() {
  const scoped = state.searchScope === "note";
  return `
    <header class="sheet-head">
      <strong>${scoped ? "Find in note" : "Search"}</strong>
      <button class="icon-btn" data-action="close-search">×</button>
    </header>
    ${scoped ? `<p class="sheet-context">${escapeHtml(activeNote()?.title || "Untitled")} / ${escapeHtml(tabLabel(activeTab()))}</p>` : ""}
    <div class="searchbox">
      <input data-search placeholder="Search text, images, links, voice" value="${escapeHtml(state.search)}" autofocus />
      <div class="filters">${categories.map((cat) => `<button class="${state.category === cat ? "active" : ""}" data-category="${cat}">${cat}</button>`).join("")}</div>
    </div>
    <div class="results" data-search-results>${renderResults()}</div>
  `;
}

function renderSearchSheet() {
  return `
    <section class="sheet-backdrop" data-action="close-search">
      <div class="search-sheet" role="dialog" aria-modal="true" onclick="event.stopPropagation()">
        ${renderSearchSheetContent()}
      </div>
    </section>
  `;
}

function renderAuth() {
  if (state.syncStatus === "reconnect") {
    return `<button data-action="reconnect-folder">Reconnect ${folderHandle?.name || "folder"}</button>`;
  }
  return `
    <button data-action="connect-folder">Connect iCloud Drive</button>
    <p class="sync-note">Pick your iCloud Drive folder. Notes stay on your device.</p>
  `;
}

function renderNoteRow(note) {
  const text = stripHtml(note.tabs.map((tab) => tab.inlineContent || tab.content || "").join(" ")).slice(0, 90);
  const isSelected = selectedNoteIds.has(note.id);
  return `<div class="note-row-wrap${isSelected ? " selected" : ""}${selectMode ? " select-mode" : ""}">
    <button class="note-select-check${isSelected ? " checked" : ""}" data-select-note="${note.id}" aria-label="Select note" tabindex="-1">
      <svg width="10" height="8" viewBox="0 0 10 8" fill="none"><path d="M1 4l3 3 5-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
    <button class="note-row ${note.id === state.activeNoteId ? "active" : ""}" data-note="${note.id}">
      <strong>${escapeHtml(note.title || "Untitled")}</strong>
      <span>${escapeHtml(text || "No body text yet")}</span>
      <small>${note.deletedAt ? `Deleted ${new Date(note.deletedAt).toLocaleDateString([], { month: "short", day: "numeric" })}` : note.status} · ${note.tabs.length} tabs · ${new Date(note.updatedAt).toLocaleDateString([], { month: "short", day: "numeric" })}</small>
    </button>
  </div>`;
}

function listFilterLabel() {
  if (state.listFilter === "archive") return "Archive";
  if (state.listFilter === "trash") return "Trash";
  return "Pinned & recent";
}


function renderResults() {
  const rows = results();
  if (!rows.length) return state.search || state.category !== "all" ? `<p class="empty">No matching context yet.</p>` : "";
  const groups = categories.filter((cat) => cat !== "all").map((cat) => [cat, rows.filter((row) => row.kind === cat)]).filter(([, items]) => items.length);
  return groups.map(([cat, items]) => `
    <div class="result-group">
      <div class="section-label"><span>${cat}</span><em>${items.length}</em></div>
      ${items.map((row) => `<button class="result" data-result-note="${row.note.id}" data-result-tab="${row.tab.id}" data-result-block="${row.blockId || ""}">
        <span>${escapeHtml(row.label || row.kind)}</span>
        <strong>${escapeHtml(row.note.title || "Untitled")} / ${escapeHtml(tabLabel(row.tab))}</strong>
        ${row.item?.kind === "photo" ? `<img class="result-image" data-media="${row.item.id}" alt="${escapeHtml(row.item.name || "Image result")}" />` : ""}
        <em>${highlight(snippet(row.text))}</em>
      </button>`).join("")}
    </div>
  `).join("");
}

function updateSearchResultsOnly() {
  const resultsNode = document.querySelector("[data-search-results]");
  if (!resultsNode) return;
  resultsNode.innerHTML = renderResults();
  hydrateMedia();
  bindSearchResultEvents();
}

function jumpToBlock(id) {
  if (!id) return;
  const node = document.querySelector(`[data-attachment="${id}"]`) || document.getElementById(`block-${id}`);
  if (!node) return;
  node.scrollIntoView({ behavior: "smooth", block: "center" });
  node.classList.add("jump-highlight");
  setTimeout(() => node.classList.remove("jump-highlight"), 1400);
}

function sortedNotes() {
  return [...state.notes]
    .filter((note) => {
      if (state.listFilter === "trash") return Boolean(note.deletedAt);
      if (note.deletedAt) return false;
      if (state.listFilter === "archive") return note.status === "archived";
      return note.status !== "archived";
    })
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || new Date(b.updatedAt) - new Date(a.updatedAt));
}

async function hydrateMedia() {
  document.querySelectorAll("[data-media]").forEach(async (img) => {
    img.src = await mediaUrl(img.dataset.media);
  });
  document.querySelectorAll("[data-audio]").forEach(async (audio) => {
    audio.src = await mediaUrl(audio.dataset.audio);
  });
}

function bindEvents() {
  document.querySelector("[data-search]")?.addEventListener("input", (event) => {
    state.search = event.target.value;
    cancelAnimationFrame(searchFrame);
    searchFrame = requestAnimationFrame(updateSearchResultsOnly);
  });
  document.querySelectorAll("[data-category]").forEach((btn) => btn.addEventListener("click", () => {
    state.category = btn.dataset.category; saveState(); render();
  }));
  document.querySelectorAll("[data-list-filter]").forEach((btn) => btn.addEventListener("click", () => {
    state.listFilter = btn.dataset.listFilter;
    if (state.view !== "editor") state.view = "list";
    // Auto-select first note in the new filter; clear selection if none
    const notesInFilter = sortedNotes();
    const activeIsInFilter = notesInFilter.some((n) => n.id === state.activeNoteId);
    if (!activeIsInFilter) state.activeNoteId = notesInFilter[0]?.id || null;
    saveState(); render();
  }));
  document.querySelectorAll("[data-note]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (selectMode) {
        const id = btn.dataset.note;
        if (selectedNoteIds.has(id)) selectedNoteIds.delete(id);
        else selectedNoteIds.add(id);
        render();
        return;
      }
      state.activeNoteId = btn.dataset.note; state.view = "editor"; saveState(); render();
    });
    btn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showNoteContextMenu(btn.dataset.note, e.clientX, e.clientY);
    });
  });
  document.querySelectorAll("[data-select-note]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.dataset.selectNote;
      if (!selectMode) { selectMode = true; selectedNoteIds.clear(); }
      if (selectedNoteIds.has(id)) selectedNoteIds.delete(id);
      else selectedNoteIds.add(id);
      if (selectMode && selectedNoteIds.size === 0) selectMode = false;
      render();
    });
  });
  document.querySelectorAll("[data-bulk-action]").forEach((btn) => {
    btn.addEventListener("click", () => bulkAction(btn.dataset.bulkAction));
  });
  bindSearchResultEvents();
  document.querySelector("[data-title]")?.addEventListener("input", (e) => updateNote((note) => { note.title = e.target.value; }, false));
  document.querySelector("[data-status]")?.addEventListener("change", (e) => updateNote((note) => { note.status = e.target.value; }));
  document.querySelectorAll("[data-photo]").forEach((input) => {
    if (window.nowtNative?.pickPhoto) {
      const label = input.closest("label");
      if (label) {
        label.addEventListener("click", async (e) => {
          e.preventDefault();
          const result = await window.nowtNative.pickPhoto();
          if (result) attachPhoto(base64ToFile(result.data, result.name, result.type));
        });
      }
    }
    input.addEventListener("change", (e) => {
      const file = e.target.files?.[0];
      if (file) attachPhoto(file);
    });
  });
  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.addEventListener("click", (e) => {
      if (e.target.closest("[data-close-tab]")) return;
      if (activeNote()?.activeTabId !== button.dataset.tab)
        updateNote((note) => { note.activeTabId = button.dataset.tab; });
    });
    button.addEventListener("dblclick", () => startTabRename(button));
    button.addEventListener("contextmenu", (e) => { e.preventDefault(); showTabContextMenu(button, e.clientX, e.clientY); });
    button.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/tab", button.dataset.tab));
    button.addEventListener("dragover", (e) => e.preventDefault());
    button.addEventListener("drop", (e) => updateNote((note) => { note.tabs = reorder(note.tabs, e.dataTransfer.getData("text/tab"), button.dataset.tab); }));
  });
  document.querySelectorAll("[data-close-tab]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const tabId = btn.dataset.closeTab;
      updateNote((note) => { note.activeTabId = tabId; });
      deleteActiveTab();
    });
  });

  // Piano hover labels — only in normal (narrow) mode; avoids CSS overflow clipping
  document.getElementById("nowt-vtab-label")?.remove();
  document.querySelectorAll(".vtab[data-tab]").forEach((btn) => {
    btn.addEventListener("mouseenter", () => {
      if (state.vtabsMode !== "normal") return;
      document.getElementById("nowt-vtab-label")?.remove();
      const note = activeNote();
      const t = note?.tabs.find((x) => x.id === btn.dataset.tab);
      if (!t) return;
      const rect = btn.getBoundingClientRect();
      const label = document.createElement("div");
      label.id = "nowt-vtab-label";
      label.className = "vtab-hover-label";
      label.textContent = tabLabel(t);
      label.style.top = `${rect.top + rect.height / 2}px`;
      label.style.right = `${window.innerWidth - rect.left + 8}px`;
      document.body.appendChild(label);
    });
    btn.addEventListener("mouseleave", () => {
      document.getElementById("nowt-vtab-label")?.remove();
    });
  });

  document.querySelectorAll("[data-command]").forEach((button) => {
    button.addEventListener("mousedown", (e) => e.preventDefault());
    button.addEventListener("click", () => {
      const command = commands.find(([label]) => label === button.dataset.command);
      if (!command) return;
      if (command[2] === "lineSpacing") { cycleLineSpacing(); return; }
      const cmdEditor = document.querySelector("[data-editor]");
      document.execCommand(command[2], false, command[3] || null);
      const editor = cmdEditor;
      if (editor) {
        const tab = activeTab();
        tab.inlineContent = serializeEditor(editor);
        activeNote().updatedAt = now();
        saveState();
      }
    });
  });
  document.querySelectorAll("[data-restore-note]").forEach((btn) => btn.addEventListener("click", () => restoreNote(btn.dataset.restoreNote)));
  document.querySelectorAll("[data-delete-forever]").forEach((btn) => btn.addEventListener("click", () => permanentlyDeleteNote(btn.dataset.deleteForever)));
  document.querySelectorAll("[data-unarchive-note]").forEach((btn) => btn.addEventListener("click", () => unarchiveNote(btn.dataset.unarchiveNote)));
  document.querySelectorAll("[data-auth]").forEach((btn) => btn.addEventListener("click", () => {
    const email = document.querySelector("[data-auth-email]")?.value || `${btn.dataset.auth}@nowt.app`;
    saveSession({ provider: btn.dataset.auth, email, signedInAt: now() });
  }));
  document.querySelectorAll("[data-lib-tab]").forEach((btn) => btn.addEventListener("click", () => {
    state.libraryTab = btn.dataset.libTab; render();
  }));
  const linkBtn = document.querySelector('[data-action="link"]');
  if (linkBtn) {
    linkBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const editor = document.querySelector("[data-editor]");
      const sel = window.getSelection();
      _linkSelectionRange = (sel?.rangeCount && editor?.contains(sel.getRangeAt(0).commonAncestorContainer))
        ? sel.getRangeAt(0).cloneRange() : (_lastEditorRange || null);
    });
    linkBtn.addEventListener("click", () => {
      document.getElementById("link-url-input")?.remove();
      const editor = document.querySelector("[data-editor]");
      const input = document.createElement("input");
      input.id = "link-url-input";
      input.className = "link-inline-input";
      input.type = "text";
      input.placeholder = "https://";
      input.autocomplete = "off";
      const submit = () => {
        const url = input.value.trim();
        input.remove();
        if (!url || !editor) { _linkSelectionRange = null; return; }
        editor.focus();
        if (_linkSelectionRange) {
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(_linkSelectionRange);
        }
        _linkSelectionRange = null;
        document.execCommand("createLink", false, url.startsWith("http") ? url : `https://${url}`);
        const tab = activeTab();
        if (tab) { tab.inlineContent = serializeEditor(editor); activeNote().updatedAt = now(); saveState(); }
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); submit(); }
        if (e.key === "Escape") { input.remove(); _linkSelectionRange = null; }
      });
      input.addEventListener("blur", () => setTimeout(() => input.isConnected && input.remove() && (_linkSelectionRange = null), 150));
      linkBtn.after(input);
      input.focus();
    });
  }

  document.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", async (e) => {
    const action = button.dataset.action;
    if (action === "open-app") { state.view = "list"; saveState(); render(); }
    if (action === "new-note") createNote();
    if (action === "toggle-pin") updateNote((note) => { note.pinned = !note.pinned; });
    if (action === "back") { state.view = "list"; saveState(); render(); }
    if (action === "open-search") { state.searchScope = "all"; state.searchOpen = true; saveState(); render(); }
    if (action === "open-note-search") {
      if (state.searchOpen && state.searchScope === "note") {
        state.searchOpen = false;
      } else {
        state.searchScope = "note";
        state.searchOpen = true;
        state.libraryOpen = false;
      }
      saveState();
      render();
    }
    if (action === "close-search") { state.searchOpen = false; saveState(); render(); }
    if (action === "add-tab") addTab("note");
    if (action === "add-note-tab") addTab("note");
    if (action === "add-checklist-tab") addTab("checklist");
    if (action === "duplicate-tab") duplicateTab();
    if (action === "delete-tab") deleteActiveTab();
    if (action === "trash-note") moveNoteToTrash();
    if (action === "empty-trash") emptyTrash();
    if (action === "open-settings") { state.settingsOpen = true; render(); }
    if (action === "close-settings") { state.settingsOpen = false; render(); }
    if (action === "open-library") {
      if (state.libraryOpen) {
        state.libraryOpen = false;
      } else {
        state.libraryOpen = true;
        state.searchOpen = false;
      }
      render();
    }
    if (action === "close-library") { state.libraryOpen = false; render(); }
    if (action === "export-notes") exportNotes();
    if (action === "insert-table") insertTable();
    if (action === "link") { /* handled by mousedown/click on linkBtn in bindEvents */ }
    if (action === "record") startRecording();
    if (action === "stop-recording") stopRecording();
    if (action === "sync") fakeSync();
    if (action === "sign-out") saveSession(null);
    if (action === "connect-folder") connectFolder();
    if (action === "reconnect-folder") reconnectFolder();
    if (action === "disconnect-folder") disconnectFolder();
    if (action === "set-theme-system") { localStorage.setItem(THEME_KEY, "system"); applyTheme(); render(); }
    if (action === "set-theme-light") { localStorage.setItem(THEME_KEY, "light"); applyTheme(); render(); }
    if (action === "set-theme-dark") { localStorage.setItem(THEME_KEY, "dark"); applyTheme(); render(); }
    if (action === "open-sketch") openSketchCanvas();
    if (action === "sketch-cancel") { sketchOpen = false; activeSketchId = null; _sketchCtx = null; document.querySelector(".sketch-overlay")?.remove(); }
    if (action === "sketch-done") saveSketch();
    if (action === "sketch-clear") {
      if (_sketchCtx) {
        const cvs = document.getElementById("sketch-canvas");
        _sketchCtx.save();
        _sketchCtx.globalCompositeOperation = "source-over";
        _sketchCtx.clearRect(0, 0, cvs.offsetWidth, cvs.offsetHeight);
        _sketchCtx.restore();
      }
    }
    if (action === "buy" || action === "buy-annual") openCheckout("annual");
    if (action === "buy-monthly") openCheckout("monthly");
    if (action === "open-upgrade") { proUpgradeOpen = true; render(); }
    if (action === "open-restore") { proRestoreOpen = true; proUpgradeOpen = false; render(); }
    if (action === "close-pro-upgrade") { proUpgradeOpen = false; proUpgradeReason = ""; render(); }
    if (action === "toggle-tab-layout") {
      state.tabLayout = state.tabLayout === "vertical" ? "horizontal" : "vertical";
      saveState(); render();
    }
    if (action === "toggle-vtabs-pin") {
      const modes = ["normal", "expanded", "hidden"];
      state.vtabsMode = modes[(modes.indexOf(state.vtabsMode || "normal") + 1) % 3];
      const vtabs = document.querySelector(".tabs-vertical");
      if (vtabs) {
        vtabs.classList.toggle("is-expanded", state.vtabsMode === "expanded");
        vtabs.classList.toggle("is-hidden",   state.vtabsMode === "hidden");
      }
      const icons = { normal: _PIN_SVG, expanded: _PIN_FILLED_SVG, hidden: _EYE_OFF_SVG };
      const titles = { normal: "Pin sidebar open", expanded: "Pinned open — click to hide bar", hidden: "Bar hidden — click to reset" };
      button.innerHTML = icons[state.vtabsMode];
      button.title = titles[state.vtabsMode];
      button.classList.toggle("active", state.vtabsMode !== "normal");
      saveState();
    }
    if (action === "close-pro-restore") { proRestoreOpen = false; proRestoreFromCheckout = false; render(); }
    if (action === "upgrade-billing-monthly") { proUpgradeBilling = "monthly"; render(); }
    if (action === "upgrade-billing-annual") { proUpgradeBilling = "annual"; render(); }
    if (action === "landing-billing-monthly") { landingBilling = "monthly"; render(); }
    if (action === "landing-billing-annual") { landingBilling = "annual"; render(); }
    if (action === "confirm-checkout-paid") { proCheckoutPending = false; proRestoreOpen = true; proRestoreFromCheckout = true; render(); }
    if (action === "close-checkout-pending") { proCheckoutPending = false; render(); }
    if (action === "deactivate-pro") { if (confirm("Remove Pro access on this device? Your subscription won't be cancelled — just deactivated locally.")) { deactivatePro(); render(); } }
    if (action === "confirm-restore") {
      const email = document.querySelector("[data-restore-email]")?.value?.trim();
      if (!email || !email.includes("@")) { alert("Enter a valid email address."); return; }
      const btn = e.target.closest("[data-action='confirm-restore']");
      if (btn) { btn.disabled = true; btn.textContent = "Checking…"; }
      const result = await verifySubscription(email);
      if (result === false) {
        if (btn) { btn.disabled = false; btn.textContent = "Restore access"; }
        alert("No active subscription found for that email. Double-check your billing email or contact support.");
        return;
      }
      activatePro(email);
      proRestoreOpen = false;
      proUpgradeOpen = false;
      render();
    }
    if (action === "open-app") { state.view = "list"; if (!session) saveSession({ startedAt: Date.now() }); saveState(); render(); }
    if (action === "bulk-toggle-all") {
      const visible = sortedNotes();
      const allSel = visible.every((n) => selectedNoteIds.has(n.id));
      if (allSel) selectedNoteIds.clear();
      else visible.forEach((n) => selectedNoteIds.add(n.id));
      render();
    }
    if (action === "bulk-done") { selectedNoteIds.clear(); selectMode = false; render(); }
  }));

  document.querySelectorAll("[data-add-tab]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const existing = document.querySelector(".hf-dropdown");
      if (existing) { existing.remove(); return; }
      const rect = btn.getBoundingClientRect();
      const isVertical = !!btn.closest(".vtabs-list, .tabs-vertical");
      const menu = document.createElement("div");
      menu.className = "hf-dropdown";
      ["Note", "☐ Checklist"].forEach((label) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.addEventListener("click", (ev) => {
          ev.stopPropagation();
          menu.remove();
          addTab(label === "Note" ? "note" : "checklist");
        });
        menu.appendChild(b);
      });
      if (isVertical) {
        menu.style.top = `${rect.top}px`;
        menu.style.left = `${rect.right + 4}px`;
      } else {
        menu.style.top = `${rect.bottom + 4}px`;
        menu.style.left = `${rect.left}px`;
      }
      document.body.appendChild(menu);
      requestAnimationFrame(() => {
        const mr = menu.getBoundingClientRect();
        if (mr.right > window.innerWidth) menu.style.left = `${window.innerWidth - mr.width - 8}px`;
        if (mr.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - mr.height - 8}px`;
      });
    });
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".hf-dropdown") && !e.target.closest("[data-add-tab]")) {
      document.querySelectorAll(".hf-dropdown").forEach((d) => d.remove());
    }
  });

  // Single inline editor — delegated events
  const editor = document.querySelector("[data-editor]");
  if (editor) {
    editor.addEventListener("blur", () => {
      const sel = window.getSelection();
      if (sel?.rangeCount) _lastEditorRange = sel.getRangeAt(0).cloneRange();
    });
    document.addEventListener("selectionchange", () => {
      const sel = window.getSelection();
      if (sel?.rangeCount && editor.contains(sel.getRangeAt(0).commonAncestorContainer)) {
        _lastEditorRange = sel.getRangeAt(0).cloneRange();
      }
    });

    editor.addEventListener("input", (e) => {
      if (e.target.closest(".inline-table .table-actions") || e.target.closest(".att-controls")) return;
      editor.querySelectorAll(".checklist-item, p:has(.inline-check), div:has(.inline-check)").forEach(normalizeChecklistBlock);
      const tab = activeTab();
      tab.inlineContent = serializeEditor(editor);
      maybeAutoTitleTab(tab);
      activeNote().updatedAt = now();
      saveState();
    });

    editor.addEventListener("input", (e) => {
      if (e.target.matches("[data-image-size]")) {
        const figure = e.target.closest(".inline-figure");
        if (figure) figure.style.setProperty("--image-width", e.target.value + "%");
      }
    }, true);

    editor.addEventListener("change", (e) => {
      if (e.target.matches("[data-image-size]")) {
        const id = e.target.dataset.imageSize;
        const item = activeTab().attachments.find((a) => a.id === id);
        if (item) {
          item.width = Number(e.target.value);
          const tab = activeTab();
          tab.inlineContent = serializeEditor(editor);
          activeNote().updatedAt = now();
          saveState();
        }
      }
    });

    editor.addEventListener("click", (e) => {
      const link = e.target.closest("a[href]");
      if (link && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        const url = link.href;
        if (url.startsWith("http")) window.open(url);
        return;
      }
      const editSketchBtn = e.target.closest("[data-edit-sketch]");
      if (editSketchBtn) { openSketchCanvas(editSketchBtn.dataset.editSketch); return; }
      const checkEl = e.target.closest(".inline-check");
      if (checkEl) {
        const checked = checkEl.getAttribute("data-checked") === "true";
        checkEl.setAttribute("data-checked", checked ? "false" : "true");
        const tab = activeTab();
        tab.inlineContent = serializeEditor(editor);
        activeNote().updatedAt = now();
        saveState();
        return;
      }
      const checklistBlock = e.target.closest(".checklist-item");
      if (checklistBlock && e.clientX < checklistBlock.getBoundingClientRect().left + 44) {
        e.preventDefault();
        setCaretToChecklistTextStart(checklistBlock);
        return;
      }
      const voiceName = e.target.closest("[data-voice-name]");
      if (voiceName) {
        const id = voiceName.dataset.voiceName;
        const tab = activeTab();
        const item = tab.attachments.find((a) => a.id === id);
        if (item) {
          const newName = prompt("Rename recording:", item.name);
          if (newName && newName.trim()) {
            item.name = newName.trim();
            activeNote().updatedAt = now();
            saveState();
            render();
          }
        }
        return;
      }
      const deleteBtn = e.target.closest("[data-delete-attachment]");
      if (deleteBtn) { deleteInlineAttachment(deleteBtn.dataset.deleteAttachment); return; }
      const deleteTable = e.target.closest("[data-delete-inline-table]");
      if (deleteTable) { deleteInlineTable(deleteTable.dataset.deleteInlineTable); return; }
      const addRow = e.target.closest("[data-table-add-row]");
      if (addRow) { addInlineTableRow(addRow.dataset.tableAddRow); return; }
      const addCol = e.target.closest("[data-table-add-col]");
      if (addCol) { addInlineTableCol(addCol.dataset.tableAddCol); return; }
    });

    editor.addEventListener("mousedown", (e) => {
      if (e.target.closest(".table-actions") || (e.target.closest(".att-controls") && !e.target.closest(".att-drag"))) {
        e.preventDefault();
        return;
      }
      if (e.target.matches(".h-toggle")) {
        e.preventDefault();
        e.stopPropagation();
        toggleHeadingCollapse(e.target.closest("h1, h2, h3"));
      }
    });

    editor.addEventListener("keydown", (e) => {
      if (e.key === " " && tryMarkdownSpace(editor, e)) return;
      if (e.key === "Enter" && tryBlockquoteExit(editor, e)) return;
      if (e.key === "Enter" && tryChecklistEnter(editor, e)) return;
      if (e.key === "Backspace" && tryChecklistBackspace(editor, e)) return;
    });

    editor.addEventListener("beforeinput", () => {
      const sel = window.getSelection();
      if (!sel?.rangeCount) return;
      const range = sel.getRangeAt(0);
      if (!range.collapsed) return;
      const block = getEditorBlock(editor, range.startContainer);
      if (block?.querySelector?.(".inline-check") && selectionBeforeChecklistText(block, range)) {
        setCaretToChecklistTextStart(block);
      }
    });

    editor.addEventListener("input", () => tryInlineMarkdown(editor));

    editor.addEventListener("keydown", (e) => {
      if (e.key !== "Tab" || !e.target.matches("[data-table-cell]")) return;
      e.preventDefault();
      const [tableId, ri, ci] = e.target.dataset.tableCell.split(":");
      const tableDiv = editor.querySelector(`[data-table-id="${tableId}"]`);
      if (!tableDiv) return;
      const rows = tableDiv.querySelectorAll("tr");
      const rowCount = rows.length;
      const colCount = rows[0]?.cells.length || 1;
      let nextRi = parseInt(ri);
      let nextCi = parseInt(ci) + (e.shiftKey ? -1 : 1);
      if (nextCi >= colCount) { nextCi = 0; nextRi++; }
      if (nextCi < 0) { nextCi = colCount - 1; nextRi--; }
      if (nextRi >= rowCount) { addInlineTableRow(tableId); editor.querySelector(`[data-table-cell="${tableId}:${rowCount}:0"]`)?.focus(); return; }
      if (nextRi < 0) return;
      editor.querySelector(`[data-table-cell="${tableId}:${nextRi}:${nextCi}"]`)?.focus();
    });

    editor.addEventListener("dragstart", (e) => {
      const mediaHandle = e.target.closest("[data-drag-media]");
      const tableHandle = e.target.closest("[data-drag-table]");
      if (!mediaHandle && !tableHandle) return;
      _dragMediaId = mediaHandle?.dataset.dragMedia || tableHandle?.dataset.dragTable;
      e.dataTransfer.setData(mediaHandle ? "text/nowt-media" : "text/nowt-table", _dragMediaId);
      e.dataTransfer.effectAllowed = "move";
      (mediaHandle || tableHandle).closest(".inline-figure, .inline-voice, .inline-table")?.classList.add("is-dragging");
    });
    editor.addEventListener("dragend", () => {
      editor.querySelectorAll(".is-dragging").forEach((el) => el.classList.remove("is-dragging"));
      _dragMediaId = null;
    });
    editor.addEventListener("dragover", (e) => {
      if (_dragMediaId || [...e.dataTransfer.types].includes("text/nowt-media") || [...e.dataTransfer.types].includes("text/nowt-table") || [...e.dataTransfer.types].includes("Files")) e.preventDefault();
    });
    editor.addEventListener("drop", (e) => {
      const mediaId = e.dataTransfer.getData("text/nowt-media") || _dragMediaId;
      const tableId = e.dataTransfer.getData("text/nowt-table");
      if (mediaId || tableId) {
        e.preventDefault();
        const el = tableId
          ? editor.querySelector(`[data-table-id="${tableId}"]`)
          : editor.querySelector(`[data-attachment="${mediaId}"]`);
        if (el) {
          let range;
          if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(e.clientX, e.clientY);
          else if (document.caretPositionFromPoint) {
            const pos = document.caretPositionFromPoint(e.clientX, e.clientY);
            if (pos) { range = document.createRange(); range.setStart(pos.offsetNode, pos.offset); }
          }
          if (range && !el.contains(range.startContainer)) {
            el.remove();
            range.insertNode(el);
          } else if (!range) {
            const target = directEditorChild(e.target, editor);
            if (target && target !== el && !el.contains(target)) {
              el.remove();
              const rect = target.getBoundingClientRect();
              if (e.clientY > rect.top + rect.height / 2) target.after(el);
              else target.before(el);
            }
          }
        }
        _dragMediaId = null;
        const tab = activeTab();
        if (tab) { tab.inlineContent = serializeEditor(editor); activeNote().updatedAt = now(); saveState(); }
        hydrateInlineEditor();
        hydrateMedia();
        return;
      }
      const files = [...(e.dataTransfer.files || [])].filter((f) => f.type.startsWith("image/"));
      if (!files.length) return;
      e.preventDefault();
      files.forEach((f) => attachPhoto(f));
    });
  }

  document.querySelectorAll("[data-checklist-toggle]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      checklistToggleItem(el.dataset.checklistToggle);
    });
  });
  document.querySelectorAll("[data-checklist-delete]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      checklistDeleteItem(el.dataset.checklistDelete);
    });
  });
  document.querySelectorAll("[data-checklist-add]").forEach((el) => {
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        checklistAddItem();
      }
    });
  });
  document.querySelectorAll("[data-checklist-input]").forEach((el) => {
    el.addEventListener("input", () => {
      checklistUpdateItem(el.dataset.checklistInput, el.value);
    });
  });

  initHeadingToggles();
}

function startTabRename(button) {
  const tabId = button.dataset.tab;
  const tab = activeNote()?.tabs.find((t) => t.id === tabId);
  if (!tab) return;
  const input = document.createElement("input");
  input.className = "tab-rename-input";
  input.value = tab.title || tabLabel(tab);
  input.style.width = Math.max(button.offsetWidth, 80) + "px";
  button.replaceWith(input);
  input.focus(); input.select();
  const save = () => updateNote((note) => {
    const t = note.tabs.find((t) => t.id === tabId);
    if (t) { t.title = input.value.trim(); t.titleTouched = !!input.value.trim(); }
  });
  input.addEventListener("blur", save);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); input.blur(); }
    if (e.key === "Escape") { input.removeEventListener("blur", save); render(); }
  });
}

function showTabContextMenu(button, x, y) {
  document.querySelector(".tab-context-menu")?.remove();
  const tabId = button.dataset.tab;
  const menu = document.createElement("div");
  menu.className = "tab-context-menu";
  menu.style.cssText = `left:${x}px;top:${y}px`;
  menu.innerHTML = `
    <button data-ctx="rename">Rename</button>
    <button data-ctx="duplicate">Duplicate</button>
    <button data-ctx="delete">Delete</button>
  `;
  document.body.appendChild(menu);
  const menuRect = menu.getBoundingClientRect();
  if (menuRect.right > window.innerWidth) menu.style.left = `${x - menuRect.width}px`;
  if (menuRect.bottom > window.innerHeight) menu.style.top = `${y - menuRect.height}px`;
  menu.querySelector("[data-ctx='rename']").addEventListener("click", () => {
    menu.remove();
    const btn = document.querySelector(`[data-tab="${tabId}"]`);
    if (btn) startTabRename(btn);
  });
  menu.querySelector("[data-ctx='duplicate']").addEventListener("click", () => {
    menu.remove();
    updateNote((note) => { note.activeTabId = tabId; });
    duplicateTab();
  });
  menu.querySelector("[data-ctx='delete']").addEventListener("click", () => {
    menu.remove();
    updateNote((note) => { note.activeTabId = tabId; });
    deleteActiveTab();
  });
  const dismiss = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener("click", dismiss); } };
  setTimeout(() => document.addEventListener("click", dismiss), 10);
}

function bindDropImport() {
  document.addEventListener("dragover", (e) => {
    if ([...e.dataTransfer.items].some((i) => i.kind === "file")) e.preventDefault();
  }, { once: false, passive: false });
  document.addEventListener("drop", (e) => {
    const files = [...e.dataTransfer.files].filter((f) =>
      /\.(md|txt|markdown)$/i.test(f.name)
    );
    if (!files.length) return;
    e.preventDefault();
    files.forEach((file) => {
      const reader = new FileReader();
      reader.onload = (ev) => importMarkdownFile(file.name, ev.target.result);
      reader.readAsText(file);
    });
  });
}

function bindSearchResultEvents() {
  document.querySelectorAll("[data-result-note]").forEach((button) => button.addEventListener("click", () => {
    state.activeNoteId = button.dataset.resultNote;
    activeNote().activeTabId = button.dataset.resultTab;
    state.view = "editor";
    state.searchOpen = false;
    state.libraryOpen = false;
    pendingJump = button.dataset.resultBlock || null;
    saveState();
    render();
  }));
}

const isElectron = !!(window.nowtNative || navigator.userAgent.includes("Electron"));

async function init() {
  applyTheme();
  if (isElectron) document.documentElement.classList.add("electron");
  if (isElectron) {
    const splash = document.createElement("div");
    splash.className = "splash";
    splash.innerHTML = `<img src="${isDark() ? "logotype-dark.svg" : "logotype.svg"}" alt="Nowt" />`;
    document.body.appendChild(splash);
    splash.addEventListener("animationend", (e) => { if (e.animationName === "splashOut") splash.remove(); });
  }

  bindDropImport();
  window._nowtNewNote = () => { createNote(); };
  if (window.nowtNative?.onMenu) {
    window.nowtNative.onMenu((action) => {
      if (action === "new-note") { createNote(); render(); }
      if (action === "settings") { state.settingsOpen = true; render(); }
      if (action === "search") { state.searchOpen = true; render(); }
    });
  }
  await checkUrlForSubscription();
  await initFolder();
  // Show landing page only on very first visit (no notes, no prior session)
  if (!session && !state.notes.length && !isElectron) state.view = "landing";
  render();

  // Background: silently revoke Pro if subscription is no longer active
  if (isPro() && !isElectron) {
    const email = proEmail();
    if (email) verifySubscription(email).then(result => { if (result === false) { deactivatePro(); render(); } });
  }
}

init();

// Cmd-held class for link cursor + tooltip
document.addEventListener("keydown", (e) => { if (e.key === "Meta" || e.key === "Control") document.body.classList.add("cmd-held"); });
document.addEventListener("keyup", (e) => { if (e.key === "Meta" || e.key === "Control") document.body.classList.remove("cmd-held"); });
document.addEventListener("mouseover", (e) => {
  const link = e.target.closest(".editor a[href], .sub-editor a[href]");
  if (!link) return;
  let tip = document.getElementById("link-tip");
  if (!tip) { tip = document.createElement("div"); tip.id = "link-tip"; tip.className = "link-tip"; document.body.appendChild(tip); }
  tip.textContent = "⌘ Click to open";
  const r = link.getBoundingClientRect();
  tip.style.left = `${r.left}px`;
  tip.style.top = `${r.top - 26}px`;
});
document.addEventListener("mouseout", (e) => {
  if (e.target.closest(".editor a[href], .sub-editor a[href]")) document.getElementById("link-tip")?.remove();
});

document.addEventListener("click", e => {
  const dl = e.target.closest(".lp-download-chip-btn");
  if (dl) { track("download", { chip: dl.href.includes("arm64") ? "arm64" : "x64" }); return; }
  if (e.target.closest("[data-track='notify-ios']")) track("notify_ios");
});

