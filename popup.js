/*
 * ZiS - Full Page Screenshot
 * popup.js
 */


document.addEventListener(
  "DOMContentLoaded",
  () => {

    const captureBtn =
      document.getElementById(
        "captureBtn"
      );


    const status =
      document.getElementById(
        "status"
      );


    const percent =
      document.getElementById(
        "percent"
      );


    const progressFill =
      document.getElementById(
        "progressFill"
      );


    const speedSlider =
      document.getElementById(
        "speedSlider"
      );


    const speedValue =
      document.getElementById(
        "speedValue"
      );


    const notifyToggle =
      document.getElementById(
        "notifyToggle"
      );


    // --------------------------------------------------------
    // Speed slider
    // --------------------------------------------------------

    speedSlider.addEventListener(
      "input",
      event => {

        const speeds = [
          "Slow",
          "Medium",
          "Fast"
        ];


        const index =
          Number(
            event.target.value
          ) - 1;


        speedValue.textContent =
          speeds[index] ||
          "Medium";
      }
    );


    // --------------------------------------------------------
    // Progress updates
    // --------------------------------------------------------

    chrome.runtime.onMessage.addListener(
      message => {

        if (
          message.action !==
          "captureProgress"
        ) {

          return;
        }


        const progress =
          Math.max(
            0,
            Math.min(
              100,
              Number(
                message.progress
              ) || 0
            )
          );


        status.textContent =
          message.message ||
          "Capturing...";


        percent.textContent =
          `${progress}%`;


        progressFill.style.width =
          `${progress}%`;
      }
    );


    // --------------------------------------------------------
    // Capture
    // --------------------------------------------------------

    captureBtn.addEventListener(
      "click",
      () => {


        // Disable button.

        captureBtn.disabled =
          true;


        captureBtn.style.opacity =
          "0.7";


        captureBtn.style.cursor =
          "wait";


        // Reset status.

        status.textContent =
          "Preparing page...";


        percent.textContent =
          "0%";


        progressFill.style.width =
          "0%";


        // ----------------------------------------------------
        // Format
        // ----------------------------------------------------

        const formatElement =
          document.querySelector(
            'input[name="format"]:checked'
          );


        const format =
          formatElement
            ? formatElement.value
            : "png";


        // ----------------------------------------------------
        // Speed
        // ----------------------------------------------------

        const speed =
          Number(
            speedSlider.value
          ) || 2;


        // ----------------------------------------------------
        // Notifications
        // ----------------------------------------------------

        const notify =
          notifyToggle
            ? notifyToggle.checked
            : true;


        // ----------------------------------------------------
        // Send request
        // ----------------------------------------------------

        chrome.runtime.sendMessage(
          {
            action:
              "captureFullPage",

            format:
              format,

            speed:
              speed,

            notify:
              notify
          },

          response => {

            // ----------------------------------------------
            // Chrome runtime error
            // ----------------------------------------------

            if (
              chrome.runtime.lastError
            ) {

              status.textContent =
                "Error: " +
                chrome.runtime
                  .lastError
                  .message;


              percent.textContent =
                "Error";


              progressFill.style.width =
                "0%";


              enableCaptureButton();


              return;
            }


            // ----------------------------------------------
            // Successful capture
            // ----------------------------------------------

            if (
              response &&
              response.success
            ) {

              status.textContent =
                "Screenshot Saved!";


              percent.textContent =
                "100%";


              progressFill.style.width =
                "100%";


            } else {

              // --------------------------------------------
              // Capture failed
              // --------------------------------------------

              status.textContent =
                "Failed: " +
                (
                  response &&
                  response.error
                    ? response.error
                    : "Unknown error."
                );


              percent.textContent =
                "Error";


              progressFill.style.width =
                "0%";
            }


            enableCaptureButton();
          }
        );
      }
    );


    // --------------------------------------------------------
    // Re-enable capture button
    // --------------------------------------------------------

    function enableCaptureButton() {

      captureBtn.disabled =
        false;


      captureBtn.style.opacity =
        "1";


      captureBtn.style.cursor =
        "pointer";
    }

  }
);