chrome.action.onClicked.addListener((tab) => {
  chrome.scripting.executeScript({
    target: {tabId: tab.id},
    files: ['xlsx.full.min.js', 'content.js']
  });
});

let sendJob = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const sleepCancelable = async (ms) => {
  const slice = 120;
  let remaining = Math.max(0, Number(ms || 0));
  while (remaining > 0) {
    if (sendJob?.cancelled) return false;
    const step = Math.min(slice, remaining);
    await sleep(step);
    remaining -= step;
  }
  return !sendJob?.cancelled;
};

const sendProgress = (payload) => {
  try {
    chrome.runtime.sendMessage({ type: "wa_sender_progress", ...payload });
  } catch {}
};

const waitForTabComplete = (tabId, timeoutMs) => {
  return new Promise((resolve) => {
    const startedAt = Date.now();

    const onUpdated = (id, info) => {
      if (id !== tabId) return;
      if (info.status === "complete") {
        cleanup();
        resolve(true);
      }
    };

    const timer = setInterval(() => {
      if (Date.now() - startedAt > timeoutMs) {
        cleanup();
        resolve(false);
      }
    }, 250);

    const cleanup = () => {
      clearInterval(timer);
      try {
        chrome.tabs.onUpdated.removeListener(onUpdated);
      } catch {}
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
  });
};

const uiOpenChatByPhone = (tabId, phoneDigits, timeoutMs) => {
  return new Promise((resolve) => {
    const startedAt = Date.now();

    const tick = () => {
      if (sendJob?.cancelled) return resolve(false);
      chrome.scripting.executeScript(
        {
          target: { tabId },
          args: [phoneDigits],
          func: async (digits) => {
            const sleepInner = (ms) => new Promise((r) => setTimeout(r, ms));

            const cancelled = () => Boolean(window.__BRANDDEO_SENDER_CANCEL);

            const clickClosest = (node) => {
              if (!node) return false;
              const btn = node.closest?.('button, div[role="button"]') || node;
              btn?.click?.();
              return true;
            };

            const waitFor = async (fn, ms) => {
              const start = Date.now();
              while (Date.now() - start < ms) {
                if (cancelled()) return null;
                const v = fn();
                if (v) return v;
                await sleepInner(120);
              }
              return null;
            };

            const isVisible = (el) => Boolean(el && el.offsetParent !== null);

            const normalize = (s) => String(s || "").replace(/[^\d]/g, "");

            const setLexicalInputValue = async (el, value) => {
              const text = String(value || "");
              el.focus();

              try {
                const range = document.createRange();
                range.selectNodeContents(el);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
              } catch {}

              try {
                const dt = new DataTransfer();
                dt.setData("text/plain", text);
                el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
              } catch {}

              await sleepInner(40);

              const current = normalize(el.innerText);
              if (!current || current !== normalize(text)) {
                try {
                  document.execCommand("insertText", false, text);
                } catch {
                  el.textContent = text;
                }
              }

              try {
                el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
              } catch {
                el.dispatchEvent(new Event("input", { bubbles: true }));
              }
            };

            const typeLexicalSlow = async (el, value) => {
              const text = String(value || "");
              el.focus();

              try {
                const range = document.createRange();
                range.selectNodeContents(el);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
              } catch {}

              try {
                document.execCommand("delete", false, null);
              } catch {
                el.textContent = "";
              }

              try {
                el.dispatchEvent(new InputEvent("input", { bubbles: true, data: "", inputType: "deleteContentBackward" }));
              } catch {
                el.dispatchEvent(new Event("input", { bubbles: true }));
              }

              for (const ch of text) {
                if (cancelled()) return;
                try {
                  document.execCommand("insertText", false, ch);
                } catch {
                  el.textContent = `${el.textContent || ""}${ch}`;
                }
                try {
                  el.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" }));
                } catch {
                  el.dispatchEvent(new Event("input", { bubbles: true }));
                }
                await sleepInner(35 + Math.floor(Math.random() * 45));
              }
            };

            const newChatIcon = document.querySelector('span[data-testid="new-chat-outline"]');
            if (newChatIcon) clickClosest(newChatIcon);

            await sleepInner(250);

            const dialpadBtn = await waitFor(
              () => {
                const byLabel = document.querySelector(
                  'button[aria-label="Numero de telephone"], button[aria-label="Numéro de téléphone"], button[aria-label="Phone number"]'
                );
                if (byLabel && isVisible(byLabel)) return byLabel;
                const titleNode = [...document.querySelectorAll("svg title")].find((t) => t.textContent === "ic-dialpad");
                const byIcon = titleNode?.closest?.("button, div[role='button']") || null;
                return isVisible(byIcon) ? byIcon : null;
              },
              6000
            );
            if (dialpadBtn) dialpadBtn.click();

            const phoneBtn = await waitFor(
              () => {
                const el = document.querySelector(
                  'button[aria-label="Numero de telephone"], button[aria-label="Numéro de téléphone"], button[aria-label="Phone number"]'
                );
                return isVisible(el) ? el : null;
              },
              6000
            );
            if (phoneBtn) phoneBtn.click();

            const input = await waitFor(
              () => {
                const el = document.querySelector('[data-testid="phone-number-input"][contenteditable="true"][role="textbox"]');
                return isVisible(el) ? el : null;
              },
              8000
            );
            if (!input) return { ok: false, step: "no_input" };

            const wanted = normalize(digits);
            let stable = 0;
            for (let attempt = 0; attempt < 6; attempt += 1) {
              if (cancelled()) return { ok: false, step: "cancelled" };
              if (attempt < 2) await setLexicalInputValue(input, wanted);
              else await typeLexicalSlow(input, wanted);
              await sleepInner(220);
              const got = normalize(input.innerText);
              if (got === wanted) stable += 1;
              else stable = 0;
              if (stable >= 2) break;
              await sleepInner(250);
            }
            if (normalize(input.innerText) !== wanted) return { ok: false, step: "input_not_set" };

            const cell = await (async () => {
              const start = Date.now();
              while (Date.now() - start < 12_000) {
                if (cancelled()) return null;
                const got = normalize(input.innerText);
                if (got !== wanted) {
                  await typeLexicalSlow(input, wanted);
                  await sleepInner(180);
                }

                const el = document.querySelector('[data-testid="cell-frame-container"][role="button"]');
                if (isVisible(el)) return el;

                await sleepInner(180);
              }
              return null;
            })();
            if (!cell) return { ok: false, step: "no_result" };
            cell.click();

            const composer = await waitFor(
              () => {
                if (cancelled()) return null;
                const foot = document.querySelector("footer");
                const candidates = (foot || document).querySelectorAll('div[contenteditable="true"][role="textbox"]');
                for (const el of candidates) {
                  if (!isVisible(el)) continue;
                  if (el.getAttribute("data-testid") === "phone-number-input") continue;
                  const dt = String(el.getAttribute("data-testid") || "");
                  const aria = String(el.getAttribute("aria-label") || "").toLowerCase();
                  if (dt.includes("compose") || aria.includes("message") || aria.includes("saisir") || aria.includes("tapez")) return el;
                }
                return null;
              },
              12_000
            );
            if (!composer) return { ok: false, step: "no_composer" };
            return { ok: true };
          },
        },
        (results) => {
          if (sendJob?.cancelled) return resolve(false);
          const res = results?.[0]?.result;
          if (res?.ok) return resolve(true);
          if (Date.now() - startedAt > timeoutMs) return resolve(false);
          setTimeout(tick, 350);
        }
      );
    };

    tick();
  });
};

const uiFillMessage = (tabId, messageText, timeoutMs) => {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const tick = () => {
      if (sendJob?.cancelled) return resolve(false);
      chrome.scripting.executeScript(
        {
          target: { tabId },
          args: [messageText],
          func: async (text) => {
            const sleepInner = (ms) => new Promise((r) => setTimeout(r, ms));
            const isVisible = (el) => Boolean(el && el.offsetParent !== null);
            const cancelled = () => Boolean(window.__BRANDDEO_SENDER_CANCEL);
            const start = Date.now();
            while (Date.now() - start < 8000) {
              if (cancelled()) return false;
              const foot = document.querySelector("footer");
              const candidates = (foot || document).querySelectorAll('div[contenteditable="true"][role="textbox"]');
              for (const el of candidates) {
                if (!isVisible(el)) continue;
                if (el.getAttribute("data-testid") === "phone-number-input") continue;
                const dt = String(el.getAttribute("data-testid") || "");
                const aria = String(el.getAttribute("aria-label") || "").toLowerCase();
                if (dt.includes("compose") || aria.includes("message") || aria.includes("saisir") || aria.includes("tapez")) {
                  el.focus();
                  el.textContent = String(text || "");
                  try {
                    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: String(text || ""), inputType: "insertText" }));
                  } catch {
                    el.dispatchEvent(new Event("input", { bubbles: true }));
                  }
                  await sleepInner(100);
                  return true;
                }
              }
              await sleepInner(200);
            }
            return false;
          },
        },
        (results) => {
          if (sendJob?.cancelled) return resolve(false);
          const ok = Boolean(results?.[0]?.result);
          if (ok) return resolve(true);
          if (Date.now() - startedAt > timeoutMs) return resolve(false);
          setTimeout(tick, 300);
        }
      );
    };
    tick();
  });
};

const autoClickSend = (tabId, timeoutMs) => {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const tick = () => {
      if (sendJob?.cancelled) return resolve(false);
      chrome.scripting.executeScript(
        {
          target: { tabId },
          func: () => {
            const isVisible = (el) => Boolean(el && el.offsetParent !== null);

            const matchLabel = (s) => {
              const t = String(s || "").toLowerCase().trim();
              return t === "send" || t === "envoyer";
            };

            const byIcon =
              document.querySelector('span[data-icon="send"]') ||
              document.querySelector('span[data-icon="send-filled"]') ||
              document.querySelector('span[data-icon="wds-ic-send-filled"]') ||
              document.querySelector('span[data-testid="wds-ic-send-filled"]') ||
              document.querySelector('span[data-testid="send"]') ||
              (() => {
                const titleNode = [...document.querySelectorAll("svg title")].find((t) => t.textContent === "send");
                return titleNode?.closest?.("button, div[role='button']") || null;
              })();

            if (byIcon) {
              const btn = byIcon.closest?.("button, div[role='button']") || byIcon;
              if (isVisible(btn)) {
                btn.click();
                return true;
              }
            }

            const byAria = document.querySelector('[role="button"][aria-label="Envoyer"], button[aria-label="Envoyer"]');
            if (isVisible(byAria)) {
              byAria.click();
              return true;
            }

            const buttons = document.querySelectorAll('button[aria-label], button[title], div[role="button"][aria-label]');
            for (const el of buttons) {
              if (!isVisible(el)) continue;
              const label = el.getAttribute("aria-label") || el.getAttribute("title") || "";
              if (matchLabel(label)) {
                el.click();
                return true;
              }
            }
            return false;
          },
        },
        (results) => {
          if (sendJob?.cancelled) return resolve(false);
          const ok = Boolean(results?.[0]?.result);
          if (ok) return resolve(true);
          if (Date.now() - startedAt > timeoutMs) return resolve(false);
          setTimeout(tick, 300);
        }
      );
    };
    tick();
  });
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return;

  if (message.type === "wa_extractor_done") {
    chrome.storage.local.set({ branddeo_lastExtract: message.payload || null });
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "wa_sender_start") {
    sendJob = {
      cancelled: false,
      tabId: message.tabId,
      recipients: Array.isArray(message.recipients) ? message.recipients : [],
      text: String(message.text || ""),
      randomDelay: Boolean(message.randomDelay),
      delayMinMs: Math.max(800, Number(message.delayMinMs || 1500)),
      delayMaxMs: Math.max(800, Number(message.delayMaxMs || message.delayMinMs || 1500)),
      index: 0,
    };

    chrome.scripting.executeScript({
      target: { tabId: sendJob.tabId },
      func: () => {
        window.__BRANDDEO_SENDER_CANCEL = false;
      },
    });

    const renderTemplate = (template, recipient, index) => {
      const phone = String(recipient?.phone ?? recipient?.number ?? recipient ?? "").replace(/[^\d]/g, "");
      const name = String(recipient?.name ?? "").trim();
      const id = `${Date.now().toString(36)}${(index + 1).toString(36)}`;
      return String(template || "")
        .replaceAll("{phone}", phone)
        .replaceAll("{name}", name)
        .replaceAll("{index}", String(index + 1))
        .replaceAll("{id}", id);
    };

    const pickDelay = () => {
      const min = Math.max(800, Number(sendJob.delayMinMs || 1500));
      const max = Math.max(min, Number(sendJob.delayMaxMs || min));
      if (!sendJob.randomDelay) return min;
      return Math.floor(min + Math.random() * (max - min + 1));
    };

    (async () => {
      const total = sendJob.recipients.length;
      sendProgress({ state: "start", sent: 0, total, detail: "Starting..." });

      for (let i = 0; i < total; i += 1) {
        if (!sendJob || sendJob.cancelled) break;
        sendJob.index = i;

        const recipient = sendJob.recipients[i];
        const phone = String(recipient?.phone ?? recipient?.number ?? recipient ?? "").replace(/[^\d]/g, "");
        if (!phone) continue;

        const text = renderTemplate(sendJob.text, recipient, i);
        sendProgress({ state: "opening", sent: i, total, detail: `Open chat ${i + 1}/${total}` });
        const opened = await uiOpenChatByPhone(sendJob.tabId, phone, 25_000);
        if (!sendJob || sendJob.cancelled) break;
        if (!opened) {
          sendProgress({ state: "error_one", sent: i, total, detail: `Cannot open ${phone}` });
          await sleepCancelable(pickDelay());
          continue;
        }

        await uiFillMessage(sendJob.tabId, text, 15_000);
        if (!sendJob || sendJob.cancelled) break;

        sendProgress({ state: "sending", sent: i, total, detail: "Clicking send..." });
        await autoClickSend(sendJob.tabId, 12_000);
        if (!sendJob || sendJob.cancelled) break;

        sendProgress({ state: "done_one", sent: i + 1, total, detail: `${i + 1}/${total}` });
        await sleepCancelable(pickDelay());
      }

      const finished = Boolean(sendJob && !sendJob.cancelled);
      sendProgress({ state: finished ? "done" : "stopped", sent: (sendJob?.index ?? -1) + 1, total });
      sendJob = null;
    })();

    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "wa_sender_open_one") {
    const tabId = message.tabId;
    const recipient = message.recipient || {};
    const phone = String(recipient?.phone ?? recipient?.number ?? recipient ?? "").replace(/[^\d]/g, "");
    const text = String(message.text || "");
    (async () => {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            window.__BRANDDEO_SENDER_CANCEL = false;
          },
        });
      } catch {}
      const opened = await uiOpenChatByPhone(tabId, phone, 25_000);
      if (!opened) {
        sendProgress({ state: "error_one", sent: 0, total: 1, detail: `Cannot open ${phone}` });
        return;
      }
      if (text) await uiFillMessage(tabId, text, 15_000);
      await autoClickSend(tabId, 12_000);
      sendProgress({ state: "opened_one", sent: 1, total: 1, detail: "Sent" });
    })();
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "wa_sender_stop") {
    if (sendJob) {
      sendJob.cancelled = true;
      const total = sendJob.recipients.length;
      const sent = (sendJob.index ?? -1) + 1;
      sendProgress({ state: "stopped", sent, total, detail: "Stopped" });
      chrome.scripting.executeScript({
        target: { tabId: sendJob.tabId },
        func: () => {
          window.__BRANDDEO_SENDER_CANCEL = true;
        },
      });
    }
    sendResponse({ ok: true });
    return true;
  }
});
