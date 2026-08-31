/*
 * ZiS - Offscreen Screenshot Processor
 * offscreen.js  (v1.0.2)
 *
 * Receives one screenshot at a time from the service worker,
 * draws it onto a single OffscreenCanvas, then returns the
 * final data URL when asked.
 */

let canvas = null;
let ctx = null;
let currentFormat = "png";
let currentOutputWidth = 0;
let currentOutputHeight = 0;

// ============================================================
// HELPERS
// ============================================================

async function dataUrlToBitmap(dataUrl) {
  const response = await fetch(dataUrl);
  if (!response.ok) {
    throw new Error("Could not read captured screenshot.");
  }
  const blob = await response.blob();
  return await createImageBitmap(blob);
}

async function canvasToDataUrl(canvas, format) {
  const mimeType = format === "jpg" ? "image/jpeg" : "image/png";
  const quality = format === "jpg" ? 0.92 : undefined;

  const blob = await canvas.convertToBlob({ type: mimeType, quality });
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  // Convert to base64 in chunks to avoid call-stack limits
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }

  return {
    dataUrl: `data:${mimeType};base64,${btoa(binary)}`,
    mimeType
  };
}

// ============================================================
// MESSAGE HANDLER
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // ---------- START A NEW CANVAS ----------
  if (message.action === "stitchStart") {
    (async () => {
      try {
        currentOutputWidth = message.outputWidth;
        currentOutputHeight = message.outputHeight;
        currentFormat = message.format || "png";

        canvas = new OffscreenCanvas(currentOutputWidth, currentOutputHeight);
        ctx = canvas.getContext("2d", { alpha: false });

        if (!ctx) {
          throw new Error("Could not create screenshot canvas.");
        }

        // White background
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, currentOutputWidth, currentOutputHeight);

        sendResponse({ success: true });
      } catch (error) {
        console.error("stitchStart error:", error);
        sendResponse({
          success: false,
          error: error?.message || "Failed to start canvas."
        });
      }
    })();
    return true;
  }

  // ---------- ADD ONE SCREENSHOT ----------
  if (message.action === "stitchAdd") {
    (async () => {
      try {
        if (!canvas || !ctx) {
          throw new Error("Canvas has not been initialised.");
        }

        const bitmap = await dataUrlToBitmap(message.dataUrl);

        const destinationY = Math.round(message.scrollY * message.scale);

        if (destinationY >= currentOutputHeight) {
          bitmap.close();
          sendResponse({ success: true });
          return;
        }

        const remainingHeight = currentOutputHeight - destinationY;
        const destinationWidth = currentOutputWidth;
        const destinationHeight = Math.min(bitmap.height, remainingHeight);

        if (destinationHeight > 0) {
          ctx.drawImage(
            bitmap,
            0, 0, bitmap.width, destinationHeight,
            0, destinationY, destinationWidth, destinationHeight
          );
        }

        bitmap.close();
        sendResponse({ success: true });
      } catch (error) {
        console.error("stitchAdd error:", error);
        sendResponse({
          success: false,
          error: error?.message || "Failed to draw screenshot."
        });
      }
    })();
    return true;
  }

  // ---------- FINISH & EXPORT ----------
  if (message.action === "stitchFinish") {
    (async () => {
      try {
        if (!canvas) {
          throw new Error("No canvas to finalise.");
        }

        const result = await canvasToDataUrl(canvas, currentFormat);

        // Clean up
        canvas = null;
        ctx = null;

        sendResponse({
          success: true,
          dataUrl: result.dataUrl,
          mimeType: result.mimeType
        });
      } catch (error) {
        console.error("stitchFinish error:", error);
        sendResponse({
          success: false,
          error: error?.message || "Failed to finalise screenshot."
        });
      }
    })();
    return true;
  }

  // Ignore unknown messages
  return false;
});