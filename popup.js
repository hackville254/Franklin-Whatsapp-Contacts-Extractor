document.addEventListener("DOMContentLoaded", () => {
  const tabExtract = document.getElementById("tabExtract");
  const tabSend = document.getElementById("tabSend");
  const panelExtract = document.getElementById("panelExtract");
  const panelSend = document.getElementById("panelSend");

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
  const importFileInput = document.getElementById("importFile");
  const singlePhoneInput = document.getElementById("singlePhone");
  const messageText = document.getElementById("messageText");
  const imageFileInput = document.getElementById("imageFile");
  const randomDelayCheckbox = document.getElementById("randomDelay");
  const delayMinMsInput = document.getElementById("delayMinMs");
  const delayMaxMsInput = document.getElementById("delayMaxMs");
  const startSendButton = document.getElementById("startSend");
  const stopSendButton = document.getElementById("stopSend");
  const openNextButton = document.getElementById("openNext");

  if (!extractButton) return;

  const setActiveTab = (name) => {
    const isExtract = name === "extract";
    if (tabExtract) tabExtract.classList.toggle("active", isExtract);
    if (tabSend) tabSend.classList.toggle("active", !isExtract);
    if (panelExtract) panelExtract.classList.toggle("active", isExtract);
    if (panelSend) panelSend.classList.toggle("active", !isExtract);
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

  const renderTemplate = (template, recipient, index) => {
    const phone = String(recipient?.phone ?? "");
    const name = String(recipient?.name ?? "");
    const id = `${Date.now().toString(36)}${(index + 1).toString(36)}`;
    return String(template || "")
      .replaceAll("{phone}", phone)
      .replaceAll("{name}", name)
      .replaceAll("{index}", String(index + 1))
      .replaceAll("{id}", id);
  };

  let runId = null;
  let lastProgressAt = 0;
  let lastTabId = null;
  let recipients = [];
  let nextIndex = 0;
  let imagePayload = null;
  let sending = false;

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
    if (openNextButton) openNextButton.disabled = !has || !lastTabId;
    if (startSendButton) startSendButton.disabled = !has || !lastTabId || sending;
    if (stopSendButton) stopSendButton.disabled = !sending;
    if (sendStatusLine && !sending) sendStatusLine.textContent = has ? "Ready" : "No recipients";
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

  const loadLastExtract = async () => {
    const data = await new Promise((resolve) => {
      chrome.storage.local.get(["branddeo_lastExtract"], (res) => resolve(res?.branddeo_lastExtract ?? null));
    });
    const list = Array.isArray(data?.contacts) ? data.contacts : [];
    setRecipients(list.map((c) => ({ phone: c?.number, name: c?.name })));
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
      sendStatusMeta.textContent = `Sent: ${sent} | Remaining: ${remaining}`;
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

  setExtractUi({ busy: false, line: "Ready", meta: "No export running", percent: 0, indeterminate: false });
  refreshSendUi();
  ensureActiveTabId().then(() => refreshSendUi());
  loadLastExtract();

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
      const file = e.target?.files?.[0];
      if (!file) return;

      const readAsText = () =>
        new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result || ""));
          r.onerror = () => reject(new Error("read failed"));
          r.readAsText(file);
        });

      const readAsArrayBuffer = () =>
        new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.onerror = () => reject(new Error("read failed"));
          r.readAsArrayBuffer(file);
        });

      try {
        const lower = String(file.name || "").toLowerCase();
        if (lower.endsWith(".csv")) {
          const text = await readAsText();
          const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
          const items = [];
          for (const line of lines.slice(0, 200000)) {
            const parts = line.split(/[;,]/).map((p) => p.trim());
            const phone = parts[0];
            const nm = parts[1] || "";
            items.push({ phone, name: nm });
          }
          setRecipients(items);
          return;
        }

        const buf = await readAsArrayBuffer();
        const XLSX = window.XLSX;
        if (!XLSX?.read) return;
        const wb = XLSX.read(buf, { type: "array" });
        const sheetName = wb.SheetNames?.[0];
        const ws = wb.Sheets?.[sheetName];
        if (!ws) return;
        const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
        const items = [];
        for (const r of rows) {
          const phone =
            r.phone || r.Phone || r.number || r.Number || r.numero || r.Numero || r.tel || r.Tel || r.mobile || r.Mobile;
          const nm = r.name || r.Name || r.nom || r.Nom || "";
          items.push({ phone, name: nm });
        }
        setRecipients(items);
      } catch {
        setRecipients([]);
      } finally {
        importFileInput.value = "";
      }
    });
  }

  if (singlePhoneInput) {
    const addFromInput = () => {
      const v = String(singlePhoneInput.value || "").trim();
      if (!v) return;
      mergeRecipient(v, "");
      singlePhoneInput.value = "";
    };
    singlePhoneInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") addFromInput();
    });
    singlePhoneInput.addEventListener("blur", addFromInput);
  }

  if (imageFileInput) {
    imageFileInput.addEventListener("change", async (e) => {
      const file = e.target?.files?.[0];
      if (!file) {
        imagePayload = null;
        return;
      }
      const readAsArrayBuffer = () =>
        new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.onerror = () => reject(new Error("read failed"));
          r.readAsArrayBuffer(file);
        });
      try {
        const data = await readAsArrayBuffer();
        imagePayload = { name: String(file.name || "image"), type: String(file.type || "image/*"), data };
        if (sendStatusLine) sendStatusLine.textContent = `Image loaded: ${imagePayload.name}`;
      } catch {
        imagePayload = null;
      } finally {
        imageFileInput.value = "";
      }
    });
  }

  if (openNextButton) {
    openNextButton.addEventListener("click", async () => {
      await ensureActiveTabId();
      if (!lastTabId || recipients.length === 0) return;
      if (nextIndex >= recipients.length) nextIndex = 0;
      const item = recipients[nextIndex];
      const text = renderTemplate(messageText?.value || "", item, nextIndex);
      chrome.runtime.sendMessage({
        type: "wa_sender_open_one",
        tabId: lastTabId,
        recipient: item,
        text,
        image: imagePayload,
      });
      nextIndex += 1;
    });
  }

  if (startSendButton) {
    startSendButton.addEventListener("click", async () => {
      await ensureActiveTabId();
      if (!lastTabId || recipients.length === 0) return;
      const randomDelay = Boolean(randomDelayCheckbox?.checked);
      const delayMinMs = Math.max(800, Number(delayMinMsInput?.value || 1500));
      const delayMaxMs = Math.max(delayMinMs, Number(delayMaxMsInput?.value || delayMinMs));
      const text = String(messageText?.value || "");

      chrome.runtime.sendMessage({
        type: "wa_sender_start",
        tabId: lastTabId,
        recipients,
        text,
        randomDelay,
        delayMinMs,
        delayMaxMs,
        image: imagePayload,
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
