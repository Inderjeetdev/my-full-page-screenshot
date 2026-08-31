/*
 * ZiS - Full Page Screenshot
 * background.js  (v1.0.2)
 *
 * Architecture change:
 * - Capture one viewport → send that single screenshot to offscreen → draw → release memory
 * - Never keep the full array of huge base64 strings in memory at once
 * - Messaging between service worker and offscreen is now correct (await the response)
 */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// OFFSCREEN DOCUMENT
// ============================================================

let offscreenCreating = null;

async function ensureOffscreenDocument() {
  if (await chrome.offscreen.hasDocument()) {
    return;
  }

  if (offscreenCreating) {
    await offscreenCreating;
    return;
  }

  offscreenCreating = chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["BLOBS"],
    justification: "Stitch viewport screenshots into one full-page image."
  });

  try {
    await offscreenCreating;
  } finally {
    offscreenCreating = null;
  }
}

// ============================================================
// PAGE HELPERS
// ============================================================

async function executeInPage(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args
  });

  if (!results || !results.length) {
    throw new Error("Could not execute code inside the webpage.");
  }
  return results[0].result;
}

async function isAccessiblePage(tabId) {
  try {
    await executeInPage(tabId, () => true);
    return true;
  } catch (error) {
    console.error("Page access check failed:", error);
    return false;
  }
}

async function getPageInfo(tabId) {
  return await executeInPage(tabId, () => {
    const doc = document.documentElement;
    const body = document.body;

    return {
      scrollWidth: Math.max(doc?.scrollWidth || 0, body?.scrollWidth || 0, doc?.clientWidth || 0),
      scrollHeight: Math.max(doc?.scrollHeight || 0, body?.scrollHeight || 0, doc?.clientHeight || 0),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
      scrollX: window.scrollX,
      scrollY: window.scrollY
    };
  });
}

async function scrollPage(tabId, y) {
  return await executeInPage(tabId, scrollY => {
    window.scrollTo(0, scrollY);
    return {
      scrollY: window.scrollY,
      viewportHeight: window.innerHeight
    };
  }, [y]);
}

async function restoreScroll(tabId, x, y) {
  try {
    await executeInPage(tabId, (scrollX, scrollY) => {
      window.scrollTo(scrollX, scrollY);
    }, [x, y]);
  } catch (error) {
    console.warn("Could not restore scroll position:", error);
  }
}

async function setCaptureMode(tabId, enabled) {
  try {
    await executeInPage(tabId, enable => {
      const STYLE_ID = "__zis_capture_style__";

      if (enable) {
        if (document.getElementById(STYLE_ID)) return;

        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = `
          [data-zis-hide-during-capture="true"] { display: none !important; }
          .intercom-lightweight-app,
          #intercom-container,
          .crisp-client,
          .drift-frame-controller,
          [id*="chat-widget"],
          [class*="chat-widget"],
          [class*="cookie-banner"],
          [class*="cookie-consent"] {
            display: none !important;
          }
        `;
        document.documentElement.appendChild(style);
      } else {
        const style = document.getElementById(STYLE_ID);
        if (style) style.remove();
      }
    }, [enabled]);
  } catch (error) {
    console.warn("Could not change capture mode:", error);
  }
}

function sendProgress(progress, message) {
  chrome.runtime.sendMessage({
    action: "captureProgress",
    progress,
    message
  }).catch(() => {});
}

// ============================================================
// PRE-LOAD LAZY CONTENT
// ============================================================

async function preloadPage(tabId, initialHeight, viewportHeight) {
  let y = 0;
  let lastHeight = initialHeight;

  while (y < lastHeight) {
    await scrollPage(tabId, y);
    await sleep(150);

    const info = await getPageInfo(tabId);
    lastHeight = Math.max(lastHeight, info.scrollHeight);
    y += viewportHeight * 0.8;
  }

  await scrollPage(tabId, 0);
  await sleep(500);

  return await getPageInfo(tabId);
}

// ============================================================
// OFFSCREEN COMMUNICATION (one screenshot at a time)
// ============================================================

/**
 * Tell the offscreen document to start a new canvas.
 */
async function offscreenStart(outputWidth, outputHeight, format) {
  await ensureOffscreenDocument();

  return await chrome.runtime.sendMessage({
    action: "stitchStart",
    outputWidth,
    outputHeight,
    format
  });
}

/**
 * Send a single viewport screenshot to be drawn onto the canvas.
 */
async function offscreenAddScreenshot(dataUrl, scrollY, scale) {
  return await chrome.runtime.sendMessage({
    action: "stitchAdd",
    dataUrl,
    scrollY,
    scale
  });
}

/**
 * Finalize the canvas and receive the finished data URL.
 */
async function offscreenFinish() {
  return await chrome.runtime.sendMessage({
    action: "stitchFinish"
  });
}

// ============================================================
// DOWNLOAD
// ============================================================

async function downloadImage(dataUrl, format) {
  const extension = format === "jpg" ? "jpg" : "png";
  const filename = `zis-screenshot-${Date.now()}.${extension}`;

  return await new Promise((resolve, reject) => {
    chrome.downloads.download({
      url: dataUrl,
      filename,
      saveAs: false
    }, downloadId => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(downloadId);
    });
  });
}

// ============================================================
// MAIN CAPTURE
// ============================================================

async function captureFullPage(tabId, windowId, format, speed, notify) {
  let originalScrollX = 0;
  let originalScrollY = 0;

  try {
    const accessible = await isAccessiblePage(tabId);
    if (!accessible) {
      throw new Error(
        "Cannot capture this page. Chrome blocks extensions from accessing some internal pages such as chrome:// pages, the Chrome Web Store, and the New Tab page."
      );
    }

    sendProgress(3, "Preparing page...");

    let pageInfo = await getPageInfo(tabId);
    originalScrollX = pageInfo.scrollX;
    originalScrollY = pageInfo.scrollY;

    let viewportHeight = pageInfo.viewportHeight;
    if (!pageInfo.scrollHeight || !viewportHeight) {
      throw new Error("Could not determine webpage dimensions.");
    }

    await setCaptureMode(tabId, true);

    sendProgress(8, "Loading page content...");
    pageInfo = await preloadPage(tabId, pageInfo.scrollHeight, viewportHeight);

    viewportHeight = pageInfo.viewportHeight;
    const scrollWidth = pageInfo.scrollWidth;
    const scrollHeight = pageInfo.scrollHeight;
    const devicePixelRatio = pageInfo.devicePixelRatio;

    const scale = Math.min(devicePixelRatio || 1, 2);
    const outputWidth = Math.round(scrollWidth * scale);
    const outputHeight = Math.round(scrollHeight * scale);

    if (outputWidth > 32767 || outputHeight > 32767) {
      throw new Error(
        "This webpage is too large to create as one image. Try reducing browser zoom or capturing a shorter page."
      );
    }

    sendProgress(12, "Starting capture...");

    // Start a fresh canvas in the offscreen document
    const startResult = await offscreenStart(outputWidth, outputHeight, format);
    if (!startResult || !startResult.success) {
      throw new Error(startResult?.error || "Could not initialise screenshot canvas.");
    }

    const delays = { 1: 450, 2: 250, 3: 150 };
    const delay = delays[speed] || delays[2];

    let y = 0;
    let lastCaptureTime = 0;
    let captureNumber = 0;
    const step = Math.max(100, viewportHeight - 2);

    // ---------- CAPTURE + DRAW LOOP (one at a time) ----------
    while (y < scrollHeight) {
      // Chrome capture rate limit protection
      const now = Date.now();
      const elapsed = now - lastCaptureTime;
      if (lastCaptureTime && elapsed < 500) {
        await sleep(500 - elapsed);
      }

      const result = await scrollPage(tabId, y);
      const actualY = result.scrollY;
      await sleep(delay + 150);

      captureNumber++;
      const progress = Math.min(
        78,
        12 + Math.round((actualY / Math.max(1, scrollHeight)) * 66)
      );
      sendProgress(progress, "Capturing page...");

      let imageDataUrl;
      try {
        imageDataUrl = await chrome.tabs.captureVisibleTab(windowId, {
          format: "png"
        });
      } catch (captureError) {
        console.error("captureVisibleTab failed:", captureError);
        throw new Error(`Chrome could not capture the viewport: ${captureError.message}`);
      }

      // Immediately hand the single screenshot to offscreen and free the base64 string
      const addResult = await offscreenAddScreenshot(imageDataUrl, actualY, scale);
      if (!addResult || !addResult.success) {
        throw new Error(addResult?.error || "Failed to draw screenshot.");
      }

      // Explicitly drop the large string so GC can reclaim it
      imageDataUrl = null;

      lastCaptureTime = Date.now();

      const bottom = actualY + viewportHeight;
      if (bottom >= scrollHeight - 2) break;

      const nextY = actualY + step;
      if (nextY <= actualY) break;
      y = nextY;
    }

    if (captureNumber === 0) {
      throw new Error("No screenshots were captured.");
    }

    // ---------- FINALIZE ----------
    sendProgress(85, "Combining screenshots...");

    const finishResult = await offscreenFinish();
    if (!finishResult || !finishResult.success) {
      throw new Error(finishResult?.error || "Could not finalise the screenshot.");
    }

    sendProgress(95, "Saving screenshot...");
    const downloadId = await downloadImage(finishResult.dataUrl, format);

    sendProgress(100, "Screenshot Saved!");

    if (notify) {
      chrome.notifications.create({
        type: "basic",
        iconUrl: "icon128.png",
        title: "ZiS",
        message: "Full Page Screenshot Complete!"
      });
    }

    return { success: true, downloadId };

  } catch (error) {
    console.error("Full-page capture error:", error);
    return {
      success: false,
      error: error?.message || "Unknown capture error."
    };
  } finally {
    try { await setCaptureMode(tabId, false); } catch (e) {}
    try { await restoreScroll(tabId, originalScrollX, originalScrollY); } catch (e) {}
  }
}

// ============================================================
// MESSAGE HANDLER (from popup)
// ============================================================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action !== "captureFullPage") {
    return;
  }

  chrome.tabs.query({ active: true, currentWindow: true }, async tabs => {
    try {
      const tab = tabs?.[0];
      if (!tab || !tab.id) {
        sendResponse({ success: false, error: "No active tab found." });
        return;
      }

      const result = await captureFullPage(
        tab.id,
        tab.windowId,
        request.format || "png",
        Number(request.speed) || 2,
        request.notify !== false
      );

      sendResponse(result);
    } catch (error) {
      console.error("Capture request failed:", error);
      sendResponse({
        success: false,
        error: error?.message || "Unknown error."
      });
    }
  });

  return true; // keep the message channel open for the async response
});