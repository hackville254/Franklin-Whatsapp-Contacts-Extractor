chrome.action.onClicked.addListener((tab) => {
  chrome.scripting.executeScript({
    target: {tabId: tab.id},
    files: ['xlsx.full.min.js', 'content.js']
  });
});

let sendJob = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
      chrome.scripting.executeScript(
        {
          target: { tabId },
          args: [phoneDigits],
          func: async (digits) => {
            const sleepInner = (ms) => new Promise((r) => setTimeout(r, ms));

            const clickClosest = (node) => {
              if (!node) return false;
              const btn = node.closest?.('button, div[role="button"]') || node;
              btn?.click?.();
              return true;
            };

            const waitFor = async (fn, ms) => {
              const start = Date.now();
              while (Date.now() - start < ms) {
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
              await setLexicalInputValue(input, wanted);
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
                const got = normalize(input.innerText);
                if (got !== wanted) {
                  await setLexicalInputValue(input, wanted);
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
      chrome.scripting.executeScript(
        {
          target: { tabId },
          args: [messageText],
          func: async (text) => {
            const sleepInner = (ms) => new Promise((r) => setTimeout(r, ms));
            const isVisible = (el) => Boolean(el && el.offsetParent !== null);
            const start = Date.now();
            while (Date.now() - start < 8000) {
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

const attachImageWithCaption = (tabId, image, caption, timeoutMs) => {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const tick = () => {
      chrome.scripting.executeScript(
        {
          target: { tabId },
          args: [image, caption],
          func: async (img, cap) => {
            const sleepInner = (ms) => new Promise((r) => setTimeout(r, ms));
            const isVisible = (el) => Boolean(el && el.offsetParent !== null);

            const findAttachButton = () => {
              const candidates = [
                ...document.querySelectorAll('button[aria-label], button[title], div[role="button"][aria-label]'),
              ];
              const labels = ["attach", "joindre", "piece jointe", "attachment"];
              for (const el of candidates) {
                const label = String(el.getAttribute("aria-label") || el.getAttribute("title") || "").toLowerCase();
                if (!label) continue;
                if (labels.some((w) => label.includes(w))) return el;
              }
              const byIcon =
                document.querySelector('span[data-icon="attach-menu-plus"]') ||
                document.querySelector('span[data-icon="clip"]') ||
                document.querySelector('span[data-icon="attach"]');
              if (byIcon) return byIcon.closest("button, div[role='button']");
              return null;
            };

            const click = (el) => {
              if (!el) return false;
              el.click();
              return true;
            };

            const attachBtn = findAttachButton();
            click(attachBtn);
            await sleepInner(250);

            const inputs = [...document.querySelectorAll('input[type="file"]')].filter(isVisible);
            const pickInput = () => {
              for (const input of inputs) {
                const accept = String(input.getAttribute("accept") || "").toLowerCase();
                if (!accept || accept.includes("image")) return input;
              }
              return inputs[0] || null;
            };

            const input = pickInput();
            if (!input) return false;

            const arr = img?.data;
            if (!arr || !(arr instanceof ArrayBuffer)) return false;
            const type = String(img?.type || "image/jpeg");
            const name = String(img?.name || "image.jpg");
            const blob = new Blob([arr], { type });
            const file = new File([blob], name, { type });
            const dt = new DataTransfer();
            dt.items.add(file);
            input.files = dt.files;
            input.dispatchEvent(new Event("change", { bubbles: true }));

            const started = Date.now();
            while (Date.now() - started < 8000) {
              const boxes = [...document.querySelectorAll('div[contenteditable="true"][role="textbox"]')].filter(isVisible);
              const labelBox = boxes.find((b) => {
                const aria = String(b.getAttribute("aria-label") || "").toLowerCase();
                const title = String(b.getAttribute("title") || "").toLowerCase();
                const text = `${aria} ${title}`;
                return text.includes("caption") || text.includes("legende") || text.includes("caption");
              });
              const target = labelBox || boxes[boxes.length - 1];
              if (target) {
                const text = String(cap || "");
                target.focus();
                target.textContent = text;
                try {
                  target.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
                } catch {
                  target.dispatchEvent(new Event("input", { bubbles: true }));
                }
                return true;
              }
              await sleepInner(250);
            }
            return true;
          },
        },
        (results) => {
          const ok = Boolean(results?.[0]?.result);
          if (ok) return resolve(true);
          if (Date.now() - startedAt > timeoutMs) return resolve(false);
          setTimeout(tick, 400);
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
      image: message.image || null,
      index: 0,
    };

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
        if (!opened) {
          sendProgress({ state: "error_one", sent: i, total, detail: `Cannot open ${phone}` });
          await sleep(pickDelay());
          continue;
        }

        if (sendJob.image) {
          sendProgress({ state: "attaching", sent: i, total, detail: "Attaching image..." });
          await attachImageWithCaption(sendJob.tabId, sendJob.image, text, 20_000);
          await sleep(700);
        } else {
          await uiFillMessage(sendJob.tabId, text, 15_000);
        }

        sendProgress({ state: "sending", sent: i, total, detail: "Clicking send..." });
        await autoClickSend(sendJob.tabId, 12_000);

        sendProgress({ state: "done_one", sent: i + 1, total, detail: `${i + 1}/${total}` });
        await sleep(pickDelay());
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
    const image = message.image || null;
    (async () => {
      const opened = await uiOpenChatByPhone(tabId, phone, 25_000);
      if (!opened) {
        sendProgress({ state: "error_one", sent: 0, total: 1, detail: `Cannot open ${phone}` });
        return;
      }
      if (image) {
        await attachImageWithCaption(tabId, image, text, 20_000);
        await sleep(500);
      } else if (text) {
        await uiFillMessage(tabId, text, 15_000);
      }
      await autoClickSend(tabId, 12_000);
      sendProgress({ state: "opened_one", sent: 1, total: 1, detail: "Sent" });
    })();
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "wa_sender_stop") {
    if (sendJob) sendJob.cancelled = true;
    sendResponse({ ok: true });
    return true;
  }
});
