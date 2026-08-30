document.getElementById('captureBtn').addEventListener('click', () => {
  const status = document.getElementById('status');
  status.textContent = 'Capturing...';
  
  chrome.runtime.sendMessage({ action: "captureFullPage" }, (response) => {
    if (chrome.runtime.lastError) {
      status.textContent = 'Error: ' + chrome.runtime.lastError.message;
    } else if (response && response.success) {
      status.textContent = 'Screenshot Saved!';
    } else {
      status.textContent = 'Failed to capture.';
    }
  });
});