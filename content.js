(() => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const waitFor = async (fn, { timeoutMs = 10_000, intervalMs = 150 } = {}) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const value = fn();
      if (value) return value;
      await sleep(intervalMs);
    }
    return null;
  };

  const report = (() => {
    let lastSentAt = 0;
    let lastStage = "";
    let lastPercent = -1;

    return (payload) => {
      try {
        if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
        const now = Date.now();
        const stage = String(payload?.stage ?? "");
        const percent = typeof payload?.percent === "number" ? Math.round(payload.percent) : null;
        const shouldSend =
          stage !== lastStage || (percent != null && Math.abs(percent - lastPercent) >= 1) || now - lastSentAt >= 250;
        if (!shouldSend) return;

        chrome.runtime.sendMessage({ type: "wa_extractor_progress", ...payload });
        lastSentAt = now;
        lastStage = stage;
        if (percent != null) lastPercent = percent;
      } catch {}
    };
  })();

  const escapeCsvValue = (value) => {
    const s = String(value ?? "");
    if (/[";,\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const normalizePhone = (raw) => {
    if (!raw) return "";
    const trimmed = String(raw).trim();
    if (!trimmed) return "";
    const keepPlus = trimmed.startsWith("+");
    const digits = trimmed.replace(/[^\d]/g, "");
    if (digits.length < 10) return "";
    return keepPlus ? `+${digits}` : digits;
  };

  const extractPhoneFromString = (text) => {
    if (!text) return "";
    const match = String(text).match(/(\+?\d[\d\s().-]{5,}\d)/);
    return normalizePhone(match?.[1] ?? "");
  };

  const extractPhonesFromString = (text) => {
    if (!text) return [];
    const matches = String(text).match(/(\+?\d[\d\s().-]{5,}\d)/g) ?? [];
    const normalized = matches.map((m) => normalizePhone(m)).filter(Boolean);
    return [...new Set(normalized)];
  };

  const pickBestPhone = (phones) => {
    if (!phones || phones.length === 0) return "";
    const sorted = [...phones].sort((a, b) => {
      const aScore = (a.startsWith("+") ? 1000 : 0) + a.length;
      const bScore = (b.startsWith("+") ? 1000 : 0) + b.length;
      return bScore - aScore;
    });
    return sorted[0] || "";
  };

  const extractFromPossibleJid = (text) => {
    if (!text) return "";
    const match = String(text).match(/(\d{6,})@c\.us/i);
    return normalizePhone(match?.[1] ?? "");
  };

  const extractJidFromElement = (el) => {
    if (!el?.getAttributeNames) return "";
    const attrs = el.getAttributeNames() ?? [];
    for (const name of attrs) {
      const value = el.getAttribute(name);
      const match = String(value || "").match(/(\d{6,})@c\.us/i);
      if (match?.[1]) return match[1];
    }
    const descendants = el.querySelectorAll?.("*") ?? [];
    for (const node of descendants) {
      if (!node?.getAttributeNames) continue;
      const nodeAttrs = node.getAttributeNames() ?? [];
      for (const name of nodeAttrs) {
        const value = node.getAttribute(name);
        const match = String(value || "").match(/(\d{6,})@c\.us/i);
        if (match?.[1]) return match[1];
      }
    }
    return "";
  };

  const extractIndexHintFromElement = (el) => {
    const attrsToTry = ["aria-posinset", "aria-rowindex", "data-index", "data-rowindex", "data-idx"];

    const parsePositiveInt = (value) => {
      const raw = String(value ?? "").replace(/[^\d]/g, "");
      if (!raw) return null;
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n <= 0) return null;
      return n;
    };

    const tryNode = (node) => {
      if (!node?.getAttribute) return null;
      for (const attr of attrsToTry) {
        const v = node.getAttribute(attr);
        const n = parsePositiveInt(v);
        if (n != null) return n;
      }
      return null;
    };

    const direct = tryNode(el);
    if (direct != null) return direct;

    const descendants = el?.querySelectorAll?.("*") ?? [];
    for (const node of descendants) {
      const n = tryNode(node);
      if (n != null) return n;
    }
    return null;
  };

  const hashString = (input) => {
    const s = String(input ?? "");
    let h = 5381;
    for (let i = 0; i < s.length; i += 1) {
      h = ((h << 5) + h) ^ s.charCodeAt(i);
    }
    return (h >>> 0).toString(36);
  };

  const extractIdentityFingerprint = (row) => {
    const root = row;
    const values = [];

    const pushIfUseful = (v) => {
      const s = String(v ?? "").replace(/\s+/g, " ").trim();
      if (!s) return;
      if (s.length >= 8 || /\d/.test(s) || /@c\.us/i.test(s)) values.push(s);
    };

    pushIfUseful(root?.getAttribute?.("aria-label"));
    pushIfUseful(root?.getAttribute?.("title"));
    pushIfUseful(root?.getAttribute?.("href"));
    pushIfUseful(root?.getAttribute?.("data-id"));
    pushIfUseful(root?.getAttribute?.("id"));
    pushIfUseful(root?.textContent);

    const nodes = root?.querySelectorAll?.("*") ?? [];
    for (let i = 0; i < nodes.length && values.length < 80; i += 1) {
      const n = nodes[i];
      pushIfUseful(n?.getAttribute?.("aria-label"));
      pushIfUseful(n?.getAttribute?.("title"));
      pushIfUseful(n?.getAttribute?.("href"));
      pushIfUseful(n?.getAttribute?.("data-id"));
      pushIfUseful(n?.getAttribute?.("id"));
    }

    return values.join("|");
  };

  const extractPhoneFromElement = (el) => {
    if (!el) return "";

    const text = el.textContent || "";
    const fromText = extractPhoneFromString(text);
    if (fromText) return fromText;

    const attrs = el.getAttributeNames?.() ?? [];
    for (const name of attrs) {
      const value = el.getAttribute(name);
      const fromJid = extractFromPossibleJid(value);
      if (fromJid) return fromJid;
      const fromAttr = extractPhoneFromString(value);
      if (fromAttr) return fromAttr;
    }

    const descendants = el.querySelectorAll?.("*") ?? [];
    for (const node of descendants) {
      const nodeAttrs = node.getAttributeNames?.() ?? [];
      for (const name of nodeAttrs) {
        const value = node.getAttribute(name);
        const fromJid = extractFromPossibleJid(value);
        if (fromJid) return fromJid;
        const fromAttr = extractPhoneFromString(value);
        if (fromAttr) return fromAttr;
      }
      const fromNodeText = extractPhoneFromString(node.textContent || "");
      if (fromNodeText) return fromNodeText;
    }

    return "";
  };

  const isProbablyUiRow = (text) => {
    const t = String(text || "").trim().toLowerCase();
    if (!t) return true;
    const blocked = [
      "rechercher",
      "search",
      "menu",
      "appeler",
      "appel",
      "appel vidéo",
      "étiqueter",
      "label",
      "mute",
      "notifications",
      "médias",
      "liens",
      "docs",
      "encryption",
      "chiffr",
      "ajouter",
      "add",
      "inviter",
      "invite",
    ];
    return blocked.some((w) => t === w || t.includes(`${w} `) || t.includes(` ${w}`));
  };

  const openGroupInfoDrawer = async () => {
    const header = document.querySelector('header[data-testid="conversation-header"]');
    if (!header) return false;

    const drawer = document.querySelector('section[data-testid="group-info-drawer-body"]');
    if (drawer) return true;

    const clickTargets = [
      header.querySelector('div[title="Détails du profil"][role="button"]'),
      header.querySelector('div[data-testid="conversation-info-header"][role="button"]'),
      header.querySelector('[data-testid="conversation-info-header"]'),
    ].filter(Boolean);

    for (const target of clickTargets) {
      target.click();
      const appeared = await waitFor(
        () => document.querySelector('section[data-testid="group-info-drawer-body"]'),
        { timeoutMs: 5_000 }
      );
      if (appeared) return true;
    }

    return false;
  };

  const findScrollableAncestor = (node) => {
    let current = node;
    for (let i = 0; i < 10 && current; i += 1) {
      const style = window.getComputedStyle(current);
      const overflowY = style.overflowY;
      const canScroll = (overflowY === "auto" || overflowY === "scroll") && current.scrollHeight > current.clientHeight;
      if (canScroll) return current;
      current = current.parentElement;
    }
    return null;
  };

  const findBestScrollableDescendant = (root) => {
    if (!root?.querySelectorAll) return null;
    const all = [root, ...root.querySelectorAll("*")];
    let best = null;
    let bestDelta = 0;
    for (const el of all) {
      const delta = (el.scrollHeight || 0) - (el.clientHeight || 0);
      if (delta <= 40) continue;
      const style = window.getComputedStyle(el);
      if (style.overflowY === "hidden") continue;
      if (delta > bestDelta) {
        bestDelta = delta;
        best = el;
      }
    }
    return best;
  };

  const ensureFocusable = (el) => {
    if (!el || typeof el.focus !== "function") return false;
    const tabIndex = el.getAttribute?.("tabindex");
    if (tabIndex == null) el.setAttribute?.("tabindex", "0");
    el.focus({ preventScroll: true });
    return document.activeElement === el;
  };

  const getFocusableElements = (root) => {
    if (!root?.querySelectorAll) return [];
    const candidates = root.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"]), [role="button"]'
    );
    return [...candidates].filter((el) => el && el.offsetParent !== null && !el.hasAttribute("disabled"));
  };

  const focusNextWithin = (root, times) => {
    const focusables = getFocusableElements(root);
    if (focusables.length === 0) return null;
    let active = document.activeElement;
    let idx = focusables.indexOf(active);
    if (idx < 0) idx = 0;
    for (let i = 0; i < times; i += 1) {
      idx = (idx + 1) % focusables.length;
      focusables[idx].focus();
    }
    return focusables[idx] || null;
  };

  const dispatchKey = (target, key) => {
    if (!target) return;
    const init = { key, bubbles: true, cancelable: true };
    try {
      target.dispatchEvent(new KeyboardEvent("keydown", init));
      target.dispatchEvent(new KeyboardEvent("keyup", init));
    } catch {}
  };

  const scrollToLoadAll = async (drawer) => {
    const scrollable =
      findScrollableAncestor(drawer) ||
      drawer.querySelector('div[tabindex="-1"]') ||
      drawer.parentElement ||
      drawer;

    let stableRounds = 0;
    let lastHeight = -1;
    let lastCount = -1;
    for (let i = 0; i < 40; i += 1) {
      report({
        stage: "Loading members...",
        detail: "Scrolling to load full list",
        percent: Math.round(((i + 1) / 40) * 100),
        indeterminate: true,
      });

      scrollable.scrollTop = scrollable.scrollHeight;
      await sleep(350);
      const height = scrollable.scrollHeight;
      const count = drawer.querySelectorAll('div[role="listitem"]').length;
      if (height === lastHeight && count === lastCount) {
        stableRounds += 1;
        if (stableRounds >= 3) break;
      } else {
        stableRounds = 0;
      }
      lastHeight = height;
      lastCount = count;
    }
  };

  const collectParticipantRows = (drawer) => {
    const listItems = [...drawer.querySelectorAll('div[role="listitem"]')];
    const candidates = listItems.length > 0 ? listItems : [...drawer.querySelectorAll('div[role="button"]')];

    const rows = [];
    for (const el of candidates) {
      const text = (el.textContent || el.innerText || "").trim();
      if (!text) continue;
      if (isProbablyUiRow(text)) continue;

      rows.push(el);
    }
    return rows;
  };

  const extractNameFromRow = (row) => {
    const titleSpan = row.querySelector("span[title]");
    const title = titleSpan?.getAttribute("title")?.trim();
    if (title && !isProbablyUiRow(title)) return title;

    const selectable = row.querySelector('span[data-testid="selectable-text"]');
    const selectableTitle = selectable?.getAttribute("title")?.trim();
    if (selectableTitle && !isProbablyUiRow(selectableTitle)) return selectableTitle;

    const text = (row.textContent || row.innerText || "").trim();
    const firstLine = text.split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? "";
    return firstLine;
  };

  const isPhoneLike = (value) => {
    return Boolean(normalizePhone(value));
  };

  const findMembersContainer = () => {
    const contactsModal = document.querySelector('div[data-testid="contacts-modal"]');
    if (contactsModal) return contactsModal;

    const groupDrawer = document.querySelector('section[data-testid="group-info-drawer-body"]');
    if (groupDrawer) return groupDrawer;

    const searchInput = document.querySelector(
      'input[placeholder*="membres" i], input[aria-label*="membres" i], input[placeholder*="members" i], input[aria-label*="members" i]'
    );
    if (searchInput) {
      const panel =
        searchInput.closest('div[data-testid]') ||
        searchInput.closest('div[role="dialog"]') ||
        searchInput.closest("section") ||
        searchInput.closest("div");
      if (panel && panel.querySelectorAll('div[role="listitem"]').length >= 3) return panel;
    }

    return null;
  };

  const isContactsModal = (container) => container?.getAttribute?.("data-testid") === "contacts-modal";

  const parseExpectedCountFromContainer = (container) => {
    if (!container) return null;
    const header = container.querySelector("header");
    const text = String(header?.textContent || "").replace(/\s+/g, " ").trim();
    if (!text) return null;

    const paren = text.match(/\(([\d\s.,]+)\)/);
    const raw = (paren?.[1] ?? "").replace(/[^\d]/g, "");
    if (raw) {
      const n = Number.parseInt(raw, 10);
      return Number.isFinite(n) ? n : null;
    }

    const any = text.match(/(\d[\d\s.,]{2,})/);
    const rawAny = (any?.[1] ?? "").replace(/[^\d]/g, "");
    if (!rawAny) return null;
    const nAny = Number.parseInt(rawAny, 10);
    return Number.isFinite(nAny) ? nAny : null;
  };

  const getExportTitle = (container) => {
    const groupTitleEl = document.querySelector('span[data-testid="conversation-info-header-chat-title"]');
    const groupTitle = (groupTitleEl?.innerText || groupTitleEl?.textContent || "").trim();
    if (groupTitle) return groupTitle;

    const headerText = (container?.querySelector("header")?.innerText || container?.innerText || "").trim();
    const firstLine = headerText.split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? "";
    if (firstLine && firstLine.length <= 80) return firstLine;

    const title = String(document.title || "").trim();
    if (title) return title.slice(0, 80);
    return "WhatsApp";
  };

  const addRowToContacts = (row, { contacts, seenByKey }) => {
    const label = extractNameFromRow(row) || "";
    const number = isPhoneLike(label) ? normalizePhone(label) : "";
    const name = number ? "" : label;
    const jid = extractJidFromElement(row);
    const idx = extractIndexHintFromElement(row);
    const fingerprint = extractIdentityFingerprint(row);
    const key =
      number ? `n:${number}` : jid ? `j:${jid}` : idx != null ? `i:${idx}` : fingerprint ? `h:${hashString(fingerprint)}` : "";

    if (!name && !number) return false;
    if (!key) return false;
    if (seenByKey.has(key)) return false;
    seenByKey.add(key);

    contacts.push({ name: name || "", number: number || "" });
    return true;
  };

  const extractFromContactsModal = async (container, { contacts, seenByKey }) => {
    const expected = parseExpectedCountFromContainer(container);
    const modalRoot =
      container.closest('div[data-testid="popup-contents"]') || container.closest('div[data-animate-modal-body="true"]') || container;
    const scrollable = findBestScrollableDescendant(container) || findScrollableAncestor(container) || container;

    const closeButton = modalRoot.querySelector('button[aria-label="Fermer"], button[aria-label="Close"]');
    if (closeButton) closeButton.focus();
    focusNextWithin(modalRoot, 3);
    ensureFocusable(scrollable);

    scrollable.scrollTop = 0;
    await sleep(200);

    let stableRounds = 0;
    let lastSeenKeySize = -1;
    let lastScrollTop = -1;
    let lastLoadedCount = -1;
    let lastLastRowSig = "";

    const initialRows = collectParticipantRows(container);
    const visibleCount = Math.max(8, initialRows.length || 0);
    const targetRounds = expected ? Math.ceil(expected / visibleCount) + 250 : 900;
    const maxRounds = Math.min(5000, Math.max(400, targetRounds));

    for (let round = 0; round < maxRounds; round += 1) {
      const rows = collectParticipantRows(container);
      for (const row of rows) {
        addRowToContacts(row, { contacts, seenByKey });
      }

      const percent =
        expected && expected > 0 ? Math.max(0, Math.min(100, (contacts.length / expected) * 100)) : 0;
      report({
        stage: "Scanning...",
        detail: expected ? `${contacts.length}/${expected} exported | ${rows.length} loaded` : `${contacts.length} exported | ${rows.length} loaded`,
        percent,
        indeterminate: expected == null,
      });

      if (expected != null && contacts.length >= expected) break;

      const lastRow = rows[rows.length - 1];
      if (lastRow?.scrollIntoView) {
        lastRow.scrollIntoView({ block: "end" });
      } else {
        const step = Math.max(260, Math.floor(scrollable.clientHeight * 0.85));
        const nextTop = Math.min(scrollable.scrollTop + step, scrollable.scrollHeight);
        scrollable.scrollTop = nextTop;
      }
      dispatchKey(document.activeElement || scrollable, "PageDown");
      dispatchKey(document.activeElement || scrollable, "ArrowUp");
      dispatchKey(document.activeElement || scrollable, "ArrowDown");
      await sleep(320);

      const atBottom = scrollable.scrollTop + scrollable.clientHeight >= scrollable.scrollHeight - 4;
      const seenKeySize = seenByKey.size;
      const loadedCount = collectParticipantRows(container).length;
      const scrollDidMove = scrollable.scrollTop !== lastScrollTop;
      const currentLastRow = collectParticipantRows(container).slice(-1)[0];
      const currentLastRowSig = currentLastRow
        ? `${extractNameFromRow(currentLastRow) || ""}|${extractJidFromElement(currentLastRow) || ""}|${normalizePhone(currentLastRow.textContent || "") || ""}`
        : "";
      const lastRowChanged = currentLastRowSig && currentLastRowSig !== lastLastRowSig;

      const progressed =
        seenKeySize !== lastSeenKeySize || loadedCount !== lastLoadedCount || scrollDidMove || lastRowChanged;

      if (!progressed) {
        stableRounds += 1;
      } else {
        stableRounds = 0;
      }

      lastSeenKeySize = seenKeySize;
      lastLoadedCount = loadedCount;
      lastScrollTop = scrollable.scrollTop;
      lastLastRowSig = currentLastRowSig || lastLastRowSig;

      const stableLimit = expected ? 120 : 60;
      if (atBottom && stableRounds >= 6) break;
      if (stableRounds >= stableLimit) break;
    }

    return expected;
  };

  const pad2 = (n) => String(n).padStart(2, "0");

  const formatDateTimeForFilename = (d) => {
    const yyyy = d.getFullYear();
    const mm = pad2(d.getMonth() + 1);
    const dd = pad2(d.getDate());
    const hh = pad2(d.getHours());
    const mi = pad2(d.getMinutes());
    return `${yyyy}-${mm}-${dd}_${hh}-${mi}`;
  };

  const sanitizeFilenamePart = (value) => {
    const s = String(value || "").trim();
    return s
      .replace(/[\\/:*?"<>|]/g, "-")
      .replace(/\s+/g, " ")
      .replace(/\.+$/g, "")
      .trim()
      .slice(0, 80);
  };

  const downloadBlob = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const buildExportRows = (contacts) => {
    const rows = contacts.map((c) => {
      const name = String(c.name || "").trim();
      const number = String(c.number || "").trim();
      const saved = Boolean(name);
      const status = number ? "OK" : "Name only";
      return {
        Nom: name,
        Numero: number,
        Enregistre: saved ? "Oui" : "Non",
        Statut: status,
      };
    });

    rows.sort((a, b) => {
      const aName = a.Nom.toLowerCase();
      const bName = b.Nom.toLowerCase();
      if (aName !== bName) return aName.localeCompare(bName);
      return String(a.Numero).localeCompare(String(b.Numero));
    });

    return rows;
  };

  const downloadXlsxIfAvailable = (contacts, { groupTitle, extractedAt }) => {
    const XLSX = window.XLSX;
    if (!XLSX?.utils || !XLSX?.write) return false;

    const exportRows = buildExportRows(contacts);
    const wb = XLSX.utils.book_new();

    const wsContacts = XLSX.utils.json_to_sheet(exportRows, { header: ["Nom", "Numero", "Enregistre", "Statut"] });
    wsContacts["!cols"] = [{ wch: 34 }, { wch: 20 }, { wch: 12 }, { wch: 18 }];
    wsContacts["!autofilter"] = { ref: `A1:D${exportRows.length + 1}` };
    XLSX.utils.book_append_sheet(wb, wsContacts, "Contacts");

    const extractedAtText = extractedAt.toLocaleString();
    const wsSummary = XLSX.utils.aoa_to_sheet([
      ["Group", groupTitle],
      ["Extracted at", extractedAtText],
      ["Total", exportRows.length],
      ["Source", "WhatsApp Web"],
    ]);
    wsSummary["!cols"] = [{ wch: 14 }, { wch: 48 }];
    XLSX.utils.book_append_sheet(wb, wsSummary, "Summary");

    const wbout = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    const blob = new Blob([wbout], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    const filename = `WhatsApp_${sanitizeFilenamePart(groupTitle)}_Contacts_${formatDateTimeForFilename(extractedAt)}.xlsx`;
    downloadBlob(blob, filename);
    return true;
  };

  const downloadCsv = (contacts, { groupTitle, extractedAt }) => {
    const exportRows = buildExportRows(contacts);
    const delimiter = ";";
    const header = ["Nom", "Numero", "Enregistre", "Statut"];
    const lines = [header.map(escapeCsvValue).join(delimiter)];
    for (const row of exportRows) {
      lines.push([row.Nom, row.Numero, row.Enregistre, row.Statut].map(escapeCsvValue).join(delimiter));
    }
    const bom = "\uFEFF";
    const csv = `${bom}${lines.join("\r\n")}\r\n`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const filename = `WhatsApp_${sanitizeFilenamePart(groupTitle)}_Contacts_${formatDateTimeForFilename(extractedAt)}.csv`;
    downloadBlob(blob, filename);
  };

  const extractContacts = async () => {
    if (!/web\.whatsapp\.com/i.test(window.location.hostname)) {
      report({ stage: "Error", state: "error", error: "WhatsApp Web is not open" });
      alert("Open WhatsApp Web (web.whatsapp.com), then open a group or community before export.");
      return;
    }

    report({ stage: "Preparing...", detail: "Finding members list", indeterminate: true });

    let container = findMembersContainer();
    if (!container) {
      const opened = await openGroupInfoDrawer();
      if (opened) {
        container = await waitFor(() => findMembersContainer(), { timeoutMs: 10_000 });
      }
    }

    if (!container) {
      report({ stage: "Error", state: "error", error: "Members list not found" });
      alert("Members list not found. Open a group or community, then open the members list.");
      return;
    }

    const contacts = [];
    const seenByKey = new Set();

    let expected = null;
    if (isContactsModal(container)) {
      const total = parseExpectedCountFromContainer(container);
      report({
        stage: "Loading members...",
        detail: total != null ? `Total detected: ${total}` : "Total not detected",
        indeterminate: true,
      });
      expected = await extractFromContactsModal(container, { contacts, seenByKey });
    } else {
      await scrollToLoadAll(container);
      await sleep(200);
      const rows = collectParticipantRows(container);
      report({
        stage: "Scanning...",
        detail: `${rows.length} item(s) detected`,
        percent: 0,
        indeterminate: false,
      });

      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i];
        report({
          stage: "Scanning...",
          detail: `${i + 1}/${rows.length}`,
          percent: rows.length ? ((i + 1) / rows.length) * 100 : 0,
          indeterminate: false,
        });
        addRowToContacts(row, { contacts, seenByKey });
      }
    }

    if (contacts.length === 0) {
      report({ stage: "Error", state: "error", error: "No contacts detected" });
      alert(
        "No contacts detected.\n\nTip: WhatsApp Web does not always show numbers for saved contacts. Numbers may appear only for unsaved contacts."
      );
      return;
    }

    const groupTitle = getExportTitle(container);
    const extractedAt = new Date();

    report({ stage: "Exporting...", detail: "Generating file", indeterminate: true, percent: 100 });
    const exportedXlsx = downloadXlsxIfAvailable(contacts, { groupTitle, extractedAt });
    if (!exportedXlsx) {
      downloadCsv(contacts, { groupTitle, extractedAt });
    }

    try {
      window.__BRANDDEO_WA_EXTRACTOR_LAST = {
        contacts,
        expected: expected ?? null,
        groupTitle,
        extractedAt: extractedAt.toISOString(),
      };
    } catch {}

    report({
      stage: "Done",
      state: "done",
      count: contacts.length,
      expected: expected ?? undefined,
      indeterminate: false,
      percent: 100,
    });

    try {
      chrome.runtime.sendMessage({
        type: "wa_extractor_done",
        payload: {
          contacts,
          expected: expected ?? null,
          groupTitle,
          extractedAt: extractedAt.toISOString(),
        },
      });
    } catch {}
    alert(`Export done: ${contacts.length} contact(s).`);
  };

  extractContacts().catch(() => {
    report({ stage: "Error", state: "error", error: "Extraction failed" });
    alert("Export error. Reload WhatsApp Web and retry.");
  });
})();
