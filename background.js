async function captureFullPage(tabId) {
  try {
    // 1. Inject a script to get page dimensions and scroll
    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: () => {
        // Calculate full page height
        const fullHeight = Math.max(
          document.body.scrollHeight, document.documentElement.scrollHeight,
          document.body.offsetHeight, document.documentElement.offsetHeight,
          document.body.clientHeight, document.documentElement.clientHeight
        );
        const fullWidth = Math.max(
          document.body.scrollWidth, document.documentElement.scrollWidth,
          document.body.offsetWidth, document.documentElement.offsetWidth,
          document.body.clientWidth, document.documentElement.clientWidth
        );
        const viewportHeight = window.innerHeight;
        const viewportWidth = window.innerWidth;
        
        // Scroll to top
        window.scrollTo(0, 0);
        
        return { fullHeight, fullWidth, viewportHeight, viewportWidth };
      }
    });

    const { fullHeight, fullWidth, viewportHeight, viewportWidth } = injectionResults[0].result;
    
    // 2. Calculate how many captures we need
    const captureHeight = Math.min(viewportHeight, fullHeight);
    const totalCaptures = Math.ceil(fullHeight / viewportHeight);
    
    // 3. Create a canvas to stitch the images together
    const canvas = new OffscreenCanvas(fullWidth, fullHeight);
    const ctx = canvas.getContext('2d');
    
    let currentY = 0;
    const capturePromises = [];

    // 4. Loop to capture each part of the page
    for (let i = 0; i < totalCaptures; i++) {
      // Scroll to the correct position
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: (scrollY) => { window.scrollTo(0, scrollY); },
        args: [currentY]
      });

      // Give the page a moment to render
      await new Promise(resolve => setTimeout(resolve, 100));

      // Capture the visible tab
      const dataUrl = await chrome.tabs.captureVisibleTab(tabId, { format: 'png' });
      const image = await createImageBitmap(await fetch(dataUrl).then(r => r.blob()));

      // Draw the captured part onto the canvas at the correct Y position
      ctx.drawImage(image, 0, currentY, fullWidth, captureHeight);

      currentY += viewportHeight;
    }

    // 5. Generate final image and download
    const finalBlob = await canvas.convertToBlob({ type: 'image/png' });
    const url = URL.createObjectURL(finalBlob);
    
    // Use chrome.downloads API to save the file
    chrome.downloads.download({
      url: url,
      filename: `screenshot-${Date.now()}.png`,
      saveAs: false
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error("Download error:", chrome.runtime.lastError);
      }
      // Revoke the object URL after download starts
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });

    return { success: true };
    
  } catch (error) {
    console.error("Capture error:", error);
    return { success: false, error: error.message };
  }
}

// Listen for messages from the popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "captureFullPage") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs.length === 0) {
        sendResponse({ success: false, error: "No active tab found." });
        return;
      }
      captureFullPage(tabs[0].id).then(sendResponse);
    });
    return true; // Indicates async response
  }
});

// Optional: Listen for keyboard shortcut or other triggers
console.log("Full Page Screenshot background service worker loaded.");