document.addEventListener("DOMContentLoaded", () => {
  const tabExtract = document.getElementById("tabExtract");
  const tabSend = document.getElementById("tabSend");
  const tabSettings = document.getElementById("tabSettings");
  const panelExtract = document.getElementById("panelExtract");
  const panelSend = document.getElementById("panelSend");
  const panelSettings = document.getElementById("panelSettings");

  const extractButton = document.getElementById("extract");
  const statusLine = document.getElementById("statusLine");
  const statusMeta = document.getElementById("statusMeta");
  const spinner = document.getElementById("spinner");
  const bar = document.getElementById("bar");

  const recipientsMeta = document.getElementById("recipientsMeta");
  const sendSpinner = document.getElementById("sendSpinner");
  const sendBar = document.getElementById("sendBar");
  const sendStatusLine = document.getElementById("sendStatusLine");
  const sendStatusMeta = document.getElementById("sendStatusMeta");
  const sendHints = document.getElementById("sendHints");
  const importFileInput = document.getElementById("importFile");
  const singlePhoneInput = document.getElementById("singlePhone");
  const addPhoneButton = document.getElementById("addPhone");
  const msgPoolMeta = document.getElementById("msgPoolMeta");
  const newMessageInput = document.getElementById("newMessage");
  const addMessageButton = document.getElementById("addMessage");
  const clearMessagesButton = document.getElementById("clearMessages");
  const messagesList = document.getElementById("messagesList");
  const randomDelayCheckbox = document.getElementById("randomDelay");
  const delayMinMsInput = document.getElementById("delayMinMs");
  const delayMaxMsInput = document.getElementById("delayMaxMs");
  const startSendButton = document.getElementById("startSend");
  const stopSendButton = document.getElementById("stopSend");
  const openNextButton = document.getElementById("openNext");

  if (!extractButton) return;

  const setActiveTab = (name) => {
    const isExtract = name === "extract";
    const isSend = name === "send";
    const isSettings = name === "settings";
    if (tabExtract) tabExtract.classList.toggle("active", isExtract);
    if (tabSend) tabSend.classList.toggle("active", isSend);
    if (tabSettings) tabSettings.classList.toggle("active", isSettings);
    if (panelExtract) panelExtract.classList.toggle("active", isExtract);
    if (panelSend) panelSend.classList.toggle("active", isSend);
    if (panelSettings) panelSettings.classList.toggle("active", isSettings);
  };

  const setExtractUi = ({ busy, line, meta, percent, indeterminate }) => {
    if (typeof line === "string" && statusLine) statusLine.textContent = line;
    if (typeof meta === "string" && statusMeta) statusMeta.textContent = meta;

    if (spinner) spinner.classList.toggle("active", Boolean(busy));
    if (extractButton) extractButton.disabled = Boolean(busy);

    if (bar) {
      bar.classList.toggle("indeterminate", Boolean(indeterminate));
      if (!indeterminate && typeof percent === "number") {
        const clamped = Math.max(0, Math.min(100, Math.round(percent)));
        bar.style.width = `${clamped}%`;
      } else if (indeterminate) {
        bar.style.width = "";
      } else {
        bar.style.width = "0%";
      }
    }
  };

  const sanitizeDigits = (value) => String(value || "").replace(/[^\d]/g, "");

  const normalizeRecipientList = (items) => {
    const list = Array.isArray(items) ? items : [];
    const out = [];
    const seen = new Set();
    for (const it of list) {
      const phone = sanitizeDigits(it?.phone ?? it?.number ?? it);
      if (!phone || phone.length < 10) continue;
      if (seen.has(phone)) continue;
      seen.add(phone);
      out.push({ phone, name: String(it?.name || "").trim() });
    }
    return out;
  };

  let runId = null;
  let lastProgressAt = 0;
  let lastTabId = null;
  let recipients = [];
  let nextIndex = 0;
  let sending = false;
  let messagePool = [];

  const ensureActiveTabId = () =>
    new Promise((resolve) => {
      if (lastTabId) return resolve(lastTabId);
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs?.[0];
        if (tab?.id) lastTabId = tab.id;
        resolve(lastTabId);
      });
    });

  const refreshSendUi = () => {
    if (recipientsMeta) recipientsMeta.textContent = `Recipients: ${recipients.length}`;
    const has = recipients.length > 0;
    const selectedMsgCount = getSelectedMessages().length;
    const readyMessages = selectedMsgCount >= 5 && selectedMsgCount <= 55;
    if (openNextButton) openNextButton.disabled = !has || !lastTabId || !readyMessages;
    if (startSendButton) startSendButton.disabled = !has || !lastTabId || sending || !readyMessages;
    if (stopSendButton) stopSendButton.disabled = !sending;
    if (sendStatusLine && !sending) {
      if (!has) sendStatusLine.textContent = "No recipients";
      else if (selectedMsgCount < 5) sendStatusLine.textContent = "Select at least 5 messages in Settings";
      else if (selectedMsgCount > 55) sendStatusLine.textContent = "Select max 55 messages in Settings";
      else sendStatusLine.textContent = "Ready";
    }
    if (sendStatusLine) {
      sendStatusLine.classList.toggle("danger", Boolean(has && !readyMessages && !sending));
    }
    if (sendHints) {
      sendHints.textContent = `Needs phone numbers + 5-55 messages selected (selected: ${selectedMsgCount}).`;
    }
  };

  const saveMessagePool = async () => {
    await chrome.storage.local.set({ branddeo_messagePool: messagePool });
  };

  const getSelectedMessages = () => {
    return (messagePool || [])
      .filter((m) => m?.enabled && String(m?.text || "").trim())
      .map((m) => String(m.text).trim());
  };

  const refreshMessagePoolUi = () => {
    const selectedCount = getSelectedMessages().length;
    if (msgPoolMeta) msgPoolMeta.textContent = `Selected: ${selectedCount} (min 5, max 55)`;
    if (!messagesList) return;
    messagesList.innerHTML = "";

    for (const msg of messagePool) {
      const row = document.createElement("div");
      row.style.display = "flex";
      row.style.gap = "10px";
      row.style.alignItems = "center";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = Boolean(msg.enabled);
      cb.addEventListener("change", async () => {
        msg.enabled = cb.checked;
        await saveMessagePool();
        refreshMessagePoolUi();
      });

      const txt = document.createElement("div");
      txt.style.flex = "1";
      txt.style.fontSize = "12px";
      txt.style.color = "#0f172a";
      txt.style.whiteSpace = "nowrap";
      txt.style.overflow = "hidden";
      txt.style.textOverflow = "ellipsis";
      txt.textContent = String(msg.text || "");

      const del = document.createElement("button");
      del.type = "button";
      del.textContent = "Del";
      del.style.flex = "0 0 auto";
      del.style.width = "60px";
      del.style.background = "#ef4444";
      del.addEventListener("click", async () => {
        messagePool = messagePool.filter((m) => m.id !== msg.id);
        await saveMessagePool();
        refreshMessagePoolUi();
      });

      row.appendChild(cb);
      row.appendChild(txt);
      row.appendChild(del);
      messagesList.appendChild(row);
    }

    refreshSendUi();
  };

  const setRecipients = (items) => {
    recipients = normalizeRecipientList(items);
    nextIndex = 0;
    refreshSendUi();
  };

  const mergeRecipient = (phone, name) => {
    const digits = sanitizeDigits(phone);
    if (!digits || digits.length < 10) return;
    if (recipients.some((r) => r.phone === digits)) return;
    recipients = [...recipients, { phone: digits, name: String(name || "").trim() }];
    refreshSendUi();
  };

  const addRecipients = (items) => {
    const combined = normalizeRecipientList([...(recipients || []), ...(items || [])]);
    recipients = combined;
    refreshSendUi();
  };

  const loadLastExtract = async () => {
    const data = await new Promise((resolve) => {
      chrome.storage.local.get(["branddeo_lastExtract"], (res) => resolve(res?.branddeo_lastExtract ?? null));
    });
    const list = Array.isArray(data?.contacts) ? data.contacts : [];
    setRecipients(list.map((c) => ({ phone: c?.number, name: c?.name })));
  };

  const loadMessagePool = async () => {
    const data = await new Promise((resolve) => {
      chrome.storage.local.get(["branddeo_messagePool"], (res) => resolve(res?.branddeo_messagePool ?? []));
    });
    messagePool = Array.isArray(data) ? data : [];
    refreshMessagePoolUi();
  };

  const onExtractorProgress = (message) => {
    if (!message || message.type !== "wa_extractor_progress") return;
    if (runId && message.runId && message.runId !== runId) return;

    lastProgressAt = Date.now();
    const stage = message.stage || "Working...";
    const detail = message.detail || "";
    const percent = typeof message.percent === "number" ? message.percent : null;
    const indeterminate = Boolean(message.indeterminate);

    setExtractUi({
      busy: true,
      line: stage,
      meta: detail || "In progress...",
      percent: percent ?? 0,
      indeterminate,
    });

    if (message.state === "done") {
      const count = typeof message.count === "number" ? message.count : null;
      const expected = typeof message.expected === "number" ? message.expected : null;
      const partial = Boolean(expected != null && count != null && count < expected);
      setExtractUi({
        busy: false,
        line: "Done",
        meta:
          count != null && expected != null
            ? `${count}/${expected} exported${partial ? " (partial)" : ""}`
            : count != null
              ? `${count} exported`
              : "Export done",
        percent: 100,
        indeterminate: false,
      });
      loadLastExtract();
    }

    if (message.state === "error") {
      setExtractUi({
        busy: false,
        line: "Error",
        meta: message.error || "Export failed",
        percent: 0,
        indeterminate: false,
      });
    }
  };

  const onSenderProgress = (message) => {
    if (!message || message.type !== "wa_sender_progress") return;
    const total = Number(message.total || 0);
    const sent = Number(message.sent || 0);
    const state = String(message.state || "");
    const detail = String(message.detail || "");
    const etaMs = Number.isFinite(Number(message.etaMs)) ? Number(message.etaMs) : null;
    const pauseLeftMs = Number.isFinite(Number(message.pauseLeftMs)) ? Number(message.pauseLeftMs) : null;

    const formatDuration = (ms) => {
      const totalSec = Math.max(0, Math.round(Number(ms || 0) / 1000));
      const h = Math.floor(totalSec / 3600);
      const m = Math.floor((totalSec % 3600) / 60);
      const s = totalSec % 60;
      const pad2 = (n) => String(n).padStart(2, "0");
      if (h > 0) return `${h}:${pad2(m)}:${pad2(s)}`;
      return `${m}:${pad2(s)}`;
    };

    const running = state !== "done" && state !== "stopped" && state !== "error";
    sending = running;
    if (sendSpinner) sendSpinner.classList.toggle("active", running);
    if (sendStatusLine) {
      if (state === "done") sendStatusLine.textContent = "Done";
      else if (state === "stopped") sendStatusLine.textContent = "Stopped";
      else if (state.startsWith("error")) sendStatusLine.textContent = "Error";
      else sendStatusLine.textContent = detail || "Sending";
    }
    if (sendStatusMeta) {
      const remaining = Math.max(0, total - sent);
      const etaText = etaMs != null ? ` | ETA: ${formatDuration(etaMs)}` : "";
      const pauseText = pauseLeftMs != null ? ` | Pause: ${formatDuration(pauseLeftMs)}` : "";
      sendStatusMeta.textContent = `Sent: ${sent} | Remaining: ${remaining}${etaText}${pauseText}`;
    }
    if (sendBar) {
      const percent = total ? Math.round((sent / total) * 100) : 0;
      sendBar.classList.toggle("indeterminate", !total && running);
      if (total) sendBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
      else if (running) sendBar.style.width = "";
      else sendBar.style.width = "0%";
    }
    refreshSendUi();
  };

  chrome.runtime.onMessage.addListener(onExtractorProgress);
  chrome.runtime.onMessage.addListener(onSenderProgress);

  if (tabExtract) tabExtract.addEventListener("click", () => setActiveTab("extract"));
  if (tabSend) tabSend.addEventListener("click", () => setActiveTab("send"));
  if (tabSettings) tabSettings.addEventListener("click", () => setActiveTab("settings"));

  setExtractUi({ busy: false, line: "Ready", meta: "No export running", percent: 0, indeterminate: false });
  refreshSendUi();
  ensureActiveTabId().then(() => refreshSendUi());
  loadLastExtract();
  loadMessagePool();

  chrome.storage.local.remove(["openrouterKey", "openrouterModel"]);

  extractButton.addEventListener("click", () => {
    runId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    lastProgressAt = Date.now();
    setExtractUi({ busy: true, line: "Starting...", meta: "Connecting to WhatsApp Web", percent: 0, indeterminate: true });

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs?.[0];
      if (!tab?.id) {
        setExtractUi({ busy: false, line: "Ready", meta: "No active tab detected", percent: 0, indeterminate: false });
        return;
      }
      lastTabId = tab.id;
      refreshSendUi();

      chrome.scripting.executeScript(
        {
          target: { tabId: tab.id },
          files: ["xlsx.full.min.js", "content.js"],
        },
        () => {
          if (chrome.runtime.lastError) {
            setExtractUi({
              busy: false,
              line: "Error",
              meta: chrome.runtime.lastError.message || "Cannot start extraction",
              percent: 0,
              indeterminate: false,
            });
          }
        }
      );
    });

    const watchdog = () => {
      if (!extractButton.disabled) return;
      if (Date.now() - lastProgressAt > 20_000) {
        setExtractUi({
          busy: false,
          line: "Ready",
          meta: "No progress received. Open WhatsApp Web and members list, then retry.",
          percent: 0,
          indeterminate: false,
        });
        return;
      }
      setTimeout(watchdog, 1_000);
    };
    setTimeout(watchdog, 1_000);
  });

  if (importFileInput) {
    importFileInput.addEventListener("change", async (e) => {
      const files = Array.from(e.target?.files || []);
      if (files.length === 0) return;

      const picked = files.slice(0, 5);
      if (sendStatusLine) {
        sendStatusLine.textContent = files.length > 5 ? "Importing first 5 files..." : "Importing...";
      }
      if (sendStatusMeta) sendStatusMeta.textContent = "Reading files...";

      const readAsText = (file) =>
        new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result || ""));
          r.onerror = () => reject(new Error("read failed"));
          r.readAsText(file);
        });

      const readAsArrayBuffer = (file) =>
        new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.onerror = () => reject(new Error("read failed"));
          r.readAsArrayBuffer(file);
        });

      try {
        let imported = 0;
        let importedContacts = 0;
        let totalRowsInFiles = 0;
        let sendableRows = 0;
        const importedPhones = new Set();

        for (const currentFile of picked) {
          const lower = String(currentFile.name || "").toLowerCase();
          if (sendStatusLine) sendStatusLine.textContent = `Importing: ${currentFile.name}`;

          if (lower.endsWith(".csv")) {
            const text = await readAsText(currentFile);
            const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
            totalRowsInFiles += Math.max(0, lines.length - 1);
            const items = [];
            for (const line of lines.slice(0, 300000)) {
              const parts = line.split(/[;,]/).map((p) => p.trim());
              const phone = parts[0];
              const nm = parts[1] || "";
              items.push({ phone, name: nm });
            }
            for (const it of items) {
              const ph = sanitizeDigits(it?.phone);
              if (ph && ph.length >= 10) {
                importedPhones.add(ph);
                sendableRows += 1;
              }
            }
            addRecipients(items);
            imported += 1;
            continue;
          }

          const buf = await readAsArrayBuffer(currentFile);
          const XLSX = window.XLSX;
          if (!XLSX?.read) continue;
          const wb = XLSX.read(buf, { type: "array" });
          const pickWorksheet = () => {
            if (wb.Sheets?.Contacts) return { name: "Contacts", ws: wb.Sheets.Contacts };
            if (wb.Sheets?.contacts) return { name: "contacts", ws: wb.Sheets.contacts };
            if (wb.SheetNames?.includes("Contacts")) return { name: "Contacts", ws: wb.Sheets["Contacts"] };
            if (wb.SheetNames?.includes("contacts")) return { name: "contacts", ws: wb.Sheets["contacts"] };

            const phoneHeaderKeys = [
              "phone",
              "Phone",
              "number",
              "Number",
              "numero",
              "Numero",
              "numéro",
              "Numéro",
              "tel",
              "Tel",
              "telephone",
              "Telephone",
              "mobile",
              "Mobile",
            ];

            for (const name of wb.SheetNames || []) {
              const ws = wb.Sheets?.[name];
              if (!ws) continue;
              const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false });
              const header = rows?.[0] || [];
              const headerStr = header.map((h) => String(h || "")).join("|");
              if (phoneHeaderKeys.some((k) => headerStr.includes(k))) return { name, ws };
            }

            const fallbackName = wb.SheetNames?.[0];
            return fallbackName ? { name: fallbackName, ws: wb.Sheets?.[fallbackName] } : { name: null, ws: null };
          };

          const pickedWs = pickWorksheet();
          const ws = pickedWs.ws;
          if (!ws) continue;
          const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
          totalRowsInFiles += rows.length;
          const items = [];
          for (const r of rows) {
            const phone =
              r.phone ||
              r.Phone ||
              r.number ||
              r.Number ||
              r.numero ||
              r.Numero ||
              r["numéro"] ||
              r["Numéro"] ||
              r.tel ||
              r.Tel ||
              r.telephone ||
              r.Telephone ||
              r.mobile ||
              r.Mobile;
            const nm = r.name || r.Name || r.nom || r.Nom || "";
            items.push({ phone, name: nm });
          }
          for (const it of items) {
            const ph = sanitizeDigits(it?.phone);
            if (ph && ph.length >= 10) {
              importedPhones.add(ph);
              sendableRows += 1;
            }
          }
          addRecipients(items);
          imported += 1;
        }
        importedContacts = importedPhones.size;
        if (sendStatusLine) sendStatusLine.textContent = `Imported contacts: ${importedContacts}`;
        if (sendStatusMeta) {
          const missing = Math.max(0, totalRowsInFiles - sendableRows);
          sendStatusMeta.textContent = `File total: ${totalRowsInFiles} | With phone: ${sendableRows} | Missing: ${missing}`;
        }
        refreshSendUi();
      } catch {
        if (sendStatusLine) sendStatusLine.textContent = "Import failed";
        if (sendStatusMeta) sendStatusMeta.textContent = "File total: 0 | Sendable: 0";
      }
    });
  }

  if (addMessageButton) {
    addMessageButton.addEventListener("click", async () => {
      const text = String(newMessageInput?.value || "").trim();
      if (!text) return;
      const msg = { id: `${Date.now()}_${Math.random().toString(16).slice(2)}`, text, enabled: true };
      messagePool = [msg, ...(messagePool || [])];
      await saveMessagePool();
      if (newMessageInput) newMessageInput.value = "";
      refreshMessagePoolUi();
    });
  }

  if (clearMessagesButton) {
    clearMessagesButton.addEventListener("click", async () => {
      messagePool = [];
      await saveMessagePool();
      refreshMessagePoolUi();
    });
  }

  if (singlePhoneInput) {
    const addFromInput = () => {
      const v = String(singlePhoneInput.value || "").trim();
      if (!v) return;
      const before = recipients.length;
      mergeRecipient(v, "");
      const after = recipients.length;
      if (sendStatusLine) {
        sendStatusLine.textContent = after > before ? "Added" : "Already added";
      }
    };
    singlePhoneInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") addFromInput();
    });
    if (addPhoneButton) addPhoneButton.addEventListener("click", addFromInput);
  }

  if (openNextButton) {
    openNextButton.addEventListener("click", async () => {
      await ensureActiveTabId();
      if (!lastTabId || recipients.length === 0) return;
      const messages = getSelectedMessages();
      if (messages.length < 5) {
        if (sendStatusLine) sendStatusLine.textContent = "Select at least 5 messages in Settings";
        return;
      }
      if (nextIndex >= recipients.length) nextIndex = 0;
      const item = recipients[nextIndex];
      chrome.runtime.sendMessage({
        type: "wa_sender_open_one",
        tabId: lastTabId,
        recipient: item,
        messages,
      });
      nextIndex += 1;
    });
  }

  if (startSendButton) {
    startSendButton.addEventListener("click", async () => {
      await ensureActiveTabId();
      if (!lastTabId || recipients.length === 0) return;
      const messages = getSelectedMessages();
      if (messages.length < 5) {
        if (sendStatusLine) sendStatusLine.textContent = "Select at least 5 messages in Settings";
        return;
      }
      const randomDelay = Boolean(randomDelayCheckbox?.checked);
      const delayMinMs = Math.max(800, Number(delayMinMsInput?.value || 1500));
      const delayMaxMs = Math.max(delayMinMs, Number(delayMaxMsInput?.value || delayMinMs));

      chrome.runtime.sendMessage({
        type: "wa_sender_start",
        tabId: lastTabId,
        recipients,
        messages,
        randomDelay,
        delayMinMs,
        delayMaxMs,
      });
      sending = true;
      refreshSendUi();
    });
  }

  if (stopSendButton) {
    stopSendButton.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "wa_sender_stop" });
      sending = false;
      refreshSendUi();
    });
  }
});
