document.addEventListener('DOMContentLoaded', () => {
  const captureBtn = document.getElementById('captureBtn');
  const status = document.getElementById('status');
  const percent = document.getElementById('percent');
  const progressFill = document.getElementById('progressFill');
  const speedSlider = document.getElementById('speedSlider');
  const speedValue = document.getElementById('speedValue');

  // Handle slider labels
  speedSlider.addEventListener('input', (e) => {
    const speeds = ['Slow', 'Medium', 'Fast'];
    speedValue.textContent = speeds[e.target.value - 1];
  });

  captureBtn.addEventListener('click', () => {
    status.textContent = 'Capturing...';
    percent.textContent = '0%';
    progressFill.style.width = '0%';
    captureBtn.disabled = true;

    // Gather settings
    const format = document.querySelector('input[name="format"]:checked').value;
    const speed = parseInt(speedSlider.value);
    const notify = document.getElementById('notifyToggle').checked;

    // Send message to background
    chrome.runtime.sendMessage(
      { action: "captureFullPage", format: format, speed: speed, notify: notify },
      (response) => {
        if (chrome.runtime.lastError) {
          status.textContent = 'Error: ' + chrome.runtime.lastError.message;
          percent.textContent = 'Failed';
        } else if (response && response.success) {
          status.textContent = 'Screenshot Saved!';
          percent.textContent = '100%';
          progressFill.style.width = '100%';
        } else {
          status.textContent = 'Failed: ' + (response ? response.error : 'Unknown');
          percent.textContent = 'Error';
        }
        captureBtn.disabled = false;
      }
    );
  });
});