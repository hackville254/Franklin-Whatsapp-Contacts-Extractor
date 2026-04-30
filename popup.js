document.addEventListener("DOMContentLoaded", () => {
  const extractButton = document.getElementById("extract");
  const statusLine = document.getElementById("statusLine");
  const statusMeta = document.getElementById("statusMeta");
  const spinner = document.getElementById("spinner");
  const bar = document.getElementById("bar");
  if (!extractButton) return;

  const setUi = ({ busy, line, meta, percent, indeterminate }) => {
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

  setUi({ busy: false, line: "Ready", meta: "No export running", percent: 0, indeterminate: false });

  let runId = null;
  let lastProgressAt = 0;
  const onMessage = (message) => {
    if (!message || message.type !== "wa_extractor_progress") return;
    if (runId && message.runId && message.runId !== runId) return;

    lastProgressAt = Date.now();
    const stage = message.stage || "Working...";
    const detail = message.detail || "";
    const percent = typeof message.percent === "number" ? message.percent : null;
    const indeterminate = Boolean(message.indeterminate);

    setUi({
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
      setUi({
        busy: false,
        line: "Done",
        meta:
          count != null && expected != null
            ? `${count}/${expected} exported${partial ? " (partial)" : ""}`
            : count != null
              ? `${count} contact(s) exported`
              : "Export done",
        percent: 100,
        indeterminate: false,
      });
    }

    if (message.state === "error") {
      setUi({
        busy: false,
        line: "Error",
        meta: message.error || "Export failed",
        percent: 0,
        indeterminate: false,
      });
    }
  };

  chrome.runtime.onMessage.addListener(onMessage);

  extractButton.addEventListener("click", () => {
    runId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    lastProgressAt = Date.now();
    setUi({ busy: true, line: "Starting...", meta: "Connecting to WhatsApp Web", percent: 0, indeterminate: true });

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs?.[0];
      if (!tab?.id) {
        setUi({ busy: false, line: "Ready", meta: "No active tab detected", percent: 0, indeterminate: false });
        return;
      }

      chrome.scripting.executeScript(
        {
          target: { tabId: tab.id },
          files: ["xlsx.full.min.js", "content.js"],
        },
        () => {
          if (chrome.runtime.lastError) {
            setUi({
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
      if (Date.now() - lastProgressAt > 15_000) {
        setUi({
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
});
