async function captureFullPage(tabId, format, speed, notify) {
  try {
    // 1. Inject html2canvas library into the page (CDN version)
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: () => {
        return new Promise((resolve) => {
          const script = document.createElement('script');
          script.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
          script.onload = () => resolve(true);
          script.onerror = () => resolve(false);
          document.head.appendChild(script);
        });
      }
    });

    // 2. Get page dimensions and scroll to top
    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: () => {
        window.scrollTo(0, 0);
        return {
          fullHeight: document.documentElement.scrollHeight,
          fullWidth: document.documentElement.scrollWidth,
          viewportHeight: window.innerHeight
        };
      }
    });

    const { fullHeight, fullWidth } = injectionResults[0].result;
    const viewportHeight = window.innerHeight;

    // 3. Capture using html2canvas (which handles fixed elements by hiding them temporarily)
    const captureResult = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: async () => {
        // Wait for the page to settle
        await new Promise(resolve => setTimeout(resolve, 200));

        // Use html2canvas to capture the full element
        const canvas = await html2canvas(document.body, {
          width: document.documentElement.scrollWidth,
          height: document.documentElement.scrollHeight,
          scrollX: 0,
          scrollY: 0,
          windowWidth: document.documentElement.scrollWidth,
          windowHeight: document.documentElement.scrollHeight,
          scale: 1, // Set to 2 for higher resolution (but takes longer)
          useCORS: true,
          logging: false
        });

        return canvas.toDataURL('image/png');
      }
    });

    const dataUrl = captureResult[0].result;

    // 4. Convert to Blob and download
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    
    const fileExtension = format === 'jpg' ? 'jpg' : 'png';
    const mimeType = format === 'jpg' ? 'image/jpeg' : 'image/png';

    // Download the file
    chrome.downloads.download({
      url: url,
      filename: `zis-screenshot-${Date.now()}.${fileExtension}`,
      saveAs: false
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error("Download error:", chrome.runtime.lastError);
        return;
      }
      
      // Show notification if enabled
      if (notify) {
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icon128.png',
          title: 'ZiS',
          message: 'Full Page Screenshot Complete!'
        });
      }
      
      setTimeout(() => URL.revokeObjectURL(url), 5000);
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
      
      // Pass settings from popup
      captureFullPage(tabs[0].id, request.format, request.speed, request.notify)
        .then(sendResponse);
    });
    return true; // Indicates async response
  }
});

console.log("ZiS background service worker loaded.");