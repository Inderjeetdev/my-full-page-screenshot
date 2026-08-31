/*
 * ZiS - Full Page Screenshot
 *
 * background.js
 *
 * Main responsibilities:
 *
 * 1. Receive capture request from popup.
 * 2. Find the active tab.
 * 3. Read webpage dimensions.
 * 4. Scroll through the webpage.
 * 5. Capture each viewport.
 * 6. Send screenshots to offscreen.html.
 * 7. Download final PNG/JPG.
 *
 * IMPORTANT:
 *
 * This version uses the "tabs" permission instead of relying
 * on the temporary "activeTab" permission.
 */


// ============================================================
// BASIC UTILITIES
// ============================================================

function sleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}


// ============================================================
// OFFSCREEN DOCUMENT
// ============================================================

let offscreenCreating = null;


async function ensureOffscreenDocument() {

  if (await chrome.offscreen.hasDocument()) {
    return;
  }


  /*
   * Prevent two simultaneous calls from trying to create
   * the same offscreen document.
   */

  if (offscreenCreating) {
    await offscreenCreating;
    return;
  }


  offscreenCreating =
    chrome.offscreen.createDocument({
      url: "offscreen.html",

      reasons: [
        "BLOBS"
      ],

      justification:
        "Stitch viewport screenshots into one full-page image."
    });


  try {

    await offscreenCreating;

  } finally {

    offscreenCreating = null;
  }
}


// ============================================================
// EXECUTE JAVASCRIPT INSIDE THE WEBPAGE
// ============================================================

async function executeInPage(
  tabId,
  func,
  args = []
) {

  const results =
    await chrome.scripting.executeScript({
      target: {
        tabId: tabId
      },

      func: func,

      args: args
    });


  if (
    !results ||
    !results.length
  ) {

    throw new Error(
      "Could not execute code inside the webpage."
    );
  }


  return results[0].result;
}


// ============================================================
// CHECK WHETHER PAGE IS ACCESSIBLE
// ============================================================

async function isAccessiblePage(tabId) {

  try {

    await executeInPage(
      tabId,
      () => true
    );

    return true;

  } catch (error) {

    console.error(
      "Page access check failed:",
      error
    );

    return false;
  }
}


// ============================================================
// GET PAGE INFORMATION
// ============================================================

async function getPageInfo(tabId) {

  return await executeInPage(
    tabId,

    () => {

      const doc =
        document.documentElement;

      const body =
        document.body;


      return {

        scrollWidth:
          Math.max(
            doc?.scrollWidth || 0,
            body?.scrollWidth || 0,
            doc?.clientWidth || 0
          ),


        scrollHeight:
          Math.max(
            doc?.scrollHeight || 0,
            body?.scrollHeight || 0,
            doc?.clientHeight || 0
          ),


        viewportWidth:
          window.innerWidth,


        viewportHeight:
          window.innerHeight,


        devicePixelRatio:
          window.devicePixelRatio || 1,


        scrollX:
          window.scrollX,


        scrollY:
          window.scrollY
      };
    }
  );
}


// ============================================================
// SCROLL PAGE
// ============================================================

async function scrollPage(
  tabId,
  y
) {

  return await executeInPage(

    tabId,

    scrollY => {

      window.scrollTo(
        0,
        scrollY
      );


      return {

        scrollY:
          window.scrollY,

        viewportHeight:
          window.innerHeight
      };
    },

    [y]
  );
}


// ============================================================
// RESTORE ORIGINAL SCROLL POSITION
// ============================================================

async function restoreScroll(
  tabId,
  x,
  y
) {

  try {

    await executeInPage(

      tabId,

      (scrollX, scrollY) => {

        window.scrollTo(
          scrollX,
          scrollY
        );
      },

      [x, y]
    );

  } catch (error) {

    console.warn(
      "Could not restore scroll position:",
      error
    );
  }
}


// ============================================================
// CAPTURE MODE
//
// Temporarily hides common floating widgets.
// ============================================================

async function setCaptureMode(
  tabId,
  enabled
) {

  try {

    await executeInPage(

      tabId,

      enable => {

        const STYLE_ID =
          "__zis_capture_style__";


        if (enable) {

          if (
            document.getElementById(
              STYLE_ID
            )
          ) {
            return;
          }


          const style =
            document.createElement(
              "style"
            );


          style.id =
            STYLE_ID;


          style.textContent = `

            [data-zis-hide-during-capture="true"] {
              display: none !important;
            }

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


          document.documentElement
            .appendChild(
              style
            );


        } else {

          const style =
            document.getElementById(
              STYLE_ID
            );


          if (style) {
            style.remove();
          }
        }
      },

      [enabled]
    );

  } catch (error) {

    console.warn(
      "Could not change capture mode:",
      error
    );
  }
}


// ============================================================
// SEND PROGRESS TO POPUP
// ============================================================

function sendProgress(
  progress,
  message
) {

  chrome.runtime.sendMessage({

    action:
      "captureProgress",

    progress:
      progress,

    message:
      message

  }).catch(() => {

    /*
     * Popup can close during/after capture.
     * This is harmless.
     */

  });
}


// ============================================================
// PRE-LOAD LAZY CONTENT
//
// Wikipedia and many modern websites load content/images
// while the user scrolls.
//
// We first scroll through the page so that more content is
// loaded before the real screenshot process starts.
// ============================================================

async function preloadPage(
  tabId,
  initialHeight,
  viewportHeight
) {

  let y = 0;

  let lastHeight =
    initialHeight;


  while (
    y < lastHeight
  ) {

    await scrollPage(
      tabId,
      y
    );


    await sleep(150);


    /*
     * Re-check the page height because lazy-loaded
     * content can make the page longer.
     */

    const info =
      await getPageInfo(
        tabId
      );


    lastHeight =
      Math.max(
        lastHeight,
        info.scrollHeight
      );


    y +=
      viewportHeight * 0.8;
  }


  /*
   * Return to top.
   */

  await scrollPage(
    tabId,
    0
  );


  await sleep(500);


  /*
   * Final dimensions after lazy loading.
   */

  return await getPageInfo(
    tabId
  );
}


// ============================================================
// STITCH SCREENSHOTS USING OFFSCREEN DOCUMENT
// ============================================================

async function stitchScreenshots(
  screenshots,
  outputWidth,
  outputHeight,
  scale,
  format
) {

  await ensureOffscreenDocument();


  return await new Promise(
    (resolve, reject) => {

      const requestId =
        crypto.randomUUID();


      let finished =
        false;


      const timeout =
        setTimeout(
          () => {

            if (finished) {
              return;
            }


            finished =
              true;


            chrome.runtime
              .onMessage
              .removeListener(
                listener
              );


            reject(
              new Error(
                "Screenshot processing timed out."
              )
            );

          },

          120000
        );


      function listener(
        message
      ) {

        if (
          message.action !==
          "stitchResult"
        ) {
          return;
        }


        if (
          message.requestId !==
          requestId
        ) {
          return;
        }


        if (finished) {
          return;
        }


        finished =
          true;


        clearTimeout(
          timeout
        );


        chrome.runtime
          .onMessage
          .removeListener(
            listener
          );


        if (
          message.success
        ) {

          resolve({

            dataUrl:
              message.dataUrl,

            mimeType:
              message.mimeType

          });

        } else {

          reject(
            new Error(
              message.error ||
              "Could not stitch screenshots."
            )
          );
        }
      }


      chrome.runtime
        .onMessage
        .addListener(
          listener
        );


      chrome.runtime
        .sendMessage({

          action:
            "stitchScreenshots",

          requestId:
            requestId,

          screenshots:
            screenshots,

          outputWidth:
            outputWidth,

          outputHeight:
            outputHeight,

          scale:
            scale,

          format:
            format

        })
        .catch(error => {

          if (finished) {
            return;
          }


          finished =
            true;


          clearTimeout(
            timeout
          );


          chrome.runtime
            .onMessage
            .removeListener(
              listener
            );


          reject(
            error
          );
        });
    }
  );
}


// ============================================================
// DOWNLOAD FINAL IMAGE
// ============================================================

async function downloadImage(
  dataUrl,
  format
) {

  const extension =
    format === "jpg"
      ? "jpg"
      : "png";


  const filename =
    `zis-screenshot-${Date.now()}.${extension}`;


  return await new Promise(
    (resolve, reject) => {

      chrome.downloads.download(

        {

          url:
            dataUrl,

          filename:
            filename,

          saveAs:
            false

        },

        downloadId => {

          if (
            chrome.runtime.lastError
          ) {

            reject(
              new Error(
                chrome.runtime
                  .lastError
                  .message
              )
            );


            return;
          }


          resolve(
            downloadId
          );
        }
      );
    }
  );
}


// ============================================================
// MAIN FULL-PAGE CAPTURE
// ============================================================

async function captureFullPage(
  tabId,
  windowId,
  format,
  speed,
  notify
) {

  let originalScrollX =
    0;

  let originalScrollY =
    0;


  try {

    // --------------------------------------------------------
    // Check page access
    // --------------------------------------------------------

    const accessible =
      await isAccessiblePage(
        tabId
      );


    if (!accessible) {

      throw new Error(
        "Cannot capture this page. Chrome blocks extensions from accessing some internal pages such as chrome:// pages, the Chrome Web Store, and the New Tab page."
      );
    }


    sendProgress(
      3,
      "Preparing page..."
    );


    // --------------------------------------------------------
    // Initial page information
    // --------------------------------------------------------

    let pageInfo =
      await getPageInfo(
        tabId
      );


    originalScrollX =
      pageInfo.scrollX;


    originalScrollY =
      pageInfo.scrollY;


    let viewportHeight =
      pageInfo.viewportHeight;


    if (
      !pageInfo.scrollHeight ||
      !viewportHeight
    ) {

      throw new Error(
        "Could not determine webpage dimensions."
      );
    }


    // --------------------------------------------------------
    // Capture mode
    // --------------------------------------------------------

    await setCaptureMode(
      tabId,
      true
    );


    // --------------------------------------------------------
    // Pre-load page
    // --------------------------------------------------------

    sendProgress(
      8,
      "Loading page content..."
    );


    pageInfo =
      await preloadPage(
        tabId,
        pageInfo.scrollHeight,
        viewportHeight
      );


    /*
     * IMPORTANT:
     *
     * Re-read all dimensions after lazy loading.
     *
     * This is particularly important for Wikipedia.
     */

    viewportHeight =
      pageInfo.viewportHeight;


    const scrollWidth =
      pageInfo.scrollWidth;


    const scrollHeight =
      pageInfo.scrollHeight;


    const devicePixelRatio =
      pageInfo.devicePixelRatio;


    const scale =
      Math.min(
        devicePixelRatio || 1,
        2
      );


    const outputWidth =
      Math.round(
        scrollWidth * scale
      );


    const outputHeight =
      Math.round(
        scrollHeight * scale
      );


    if (
      outputWidth > 32767 ||
      outputHeight > 32767
    ) {

      throw new Error(
        "This webpage is too large to create as one image. Try reducing browser zoom or capturing a shorter page."
      );
    }


    sendProgress(
      12,
      "Starting capture..."
    );


    // --------------------------------------------------------
    // Capture settings
    // --------------------------------------------------------

    const delays = {

      1: 450,

      2: 250,

      3: 150

    };


    const delay =
      delays[speed] ||
      delays[2];


    const screenshots = [];


    let y = 0;

    let lastCaptureTime =
      0;


    let captureNumber =
      0;


    /*
     * We use a small overlap between captures.
     *
     * This helps avoid missing a few pixels between
     * browser viewport positions.
     */

    const step =
      Math.max(
        100,
        viewportHeight - 2
      );


    // --------------------------------------------------------
    // CAPTURE LOOP
    // --------------------------------------------------------

    while (
      y < scrollHeight
    ) {

      /*
       * Chrome capture rate protection.
       */

      const now =
        Date.now();


      const elapsed =
        now -
        lastCaptureTime;


      if (
        lastCaptureTime &&
        elapsed < 500
      ) {

        await sleep(
          500 - elapsed
        );
      }


      // ------------------------------------------------------
      // Scroll
      // ------------------------------------------------------

      const result =
        await scrollPage(
          tabId,
          y
        );


      const actualY =
        result.scrollY;


      await sleep(
        delay + 150
      );


      // ------------------------------------------------------
      // Progress
      // ------------------------------------------------------

      captureNumber++;


      const progress =
        Math.min(

          78,

          12 +
          Math.round(

            (
              actualY /
              Math.max(
                1,
                scrollHeight
              )
            ) *

            66

          )
        );


      sendProgress(
        progress,
        `Capturing page...`
      );


      // ------------------------------------------------------
      // CAPTURE VISIBLE TAB
      //
      // IMPORTANT:
      // windowId is explicitly supplied.
      //
      // "tabs" permission in manifest makes this independent
      // of the temporary activeTab grant.
      // ------------------------------------------------------

      let imageDataUrl;


      try {

        imageDataUrl =
          await chrome.tabs
            .captureVisibleTab(

              windowId,

              {
                format:
                  "png"
              }
            );

      } catch (captureError) {

        console.error(
          "captureVisibleTab failed:",
          captureError
        );


        throw new Error(
          `Chrome could not capture the viewport: ${captureError.message}`
        );
      }


      screenshots.push({

        dataUrl:
          imageDataUrl,

        scrollY:
          actualY

      });


      lastCaptureTime =
        Date.now();


      // ------------------------------------------------------
      // Bottom check
      // ------------------------------------------------------

      const bottom =
        actualY +
        viewportHeight;


      if (
        bottom >=
        scrollHeight - 2
      ) {

        break;
      }


      /*
       * Move forward.
       */

      const nextY =
        actualY +
        step;


      if (
        nextY <= actualY
      ) {

        break;
      }


      y =
        nextY;
    }


    if (
      screenshots.length === 0
    ) {

      throw new Error(
        "No screenshots were captured."
      );
    }


    // --------------------------------------------------------
    // STITCH
    // --------------------------------------------------------

    sendProgress(
      82,
      "Combining screenshots..."
    );


    const stitched =
      await stitchScreenshots(

        screenshots,

        outputWidth,

        outputHeight,

        scale,

        format
      );


    // --------------------------------------------------------
    // DOWNLOAD
    // --------------------------------------------------------

    sendProgress(
      95,
      "Saving screenshot..."
    );


    const downloadId =
      await downloadImage(
        stitched.dataUrl,
        format
      );


    // --------------------------------------------------------
    // COMPLETE
    // --------------------------------------------------------

    sendProgress(
      100,
      "Screenshot Saved!"
    );


    if (notify) {

      chrome.notifications.create({

        type:
          "basic",

        iconUrl:
          "icon128.png",

        title:
          "ZiS",

        message:
          "Full Page Screenshot Complete!"

      });
    }


    return {

      success:
        true,

      downloadId:
        downloadId

    };


  } catch (error) {

    console.error(
      "Full-page capture error:",
      error
    );


    return {

      success:
        false,

      error:
        error?.message ||
        "Unknown capture error."

    };


  } finally {

    // --------------------------------------------------------
    // Restore page
    // --------------------------------------------------------

    try {

      await setCaptureMode(
        tabId,
        false
      );

    } catch (error) {}


    try {

      await restoreScroll(
        tabId,
        originalScrollX,
        originalScrollY
      );

    } catch (error) {}
  }
}


// ============================================================
// MESSAGE HANDLER
// ============================================================

chrome.runtime.onMessage.addListener(

  (
    request,
    sender,
    sendResponse
  ) => {


    if (
      request.action !==
      "captureFullPage"
    ) {

      return;
    }


    /*
     * Find the active tab.
     */

    chrome.tabs.query(

      {

        active:
          true,

        currentWindow:
          true

      },

      async tabs => {

        try {

          const tab =
            tabs?.[0];


          if (
            !tab ||
            !tab.id
          ) {

            sendResponse({

              success:
                false,

              error:
                "No active tab found."

            });


            return;
          }


          /*
           * Make sure we use the exact window containing
           * the active tab.
           */

          const windowId =
            tab.windowId;


          const result =
            await captureFullPage(

              tab.id,

              windowId,

              request.format ||
                "png",

              Number(
                request.speed
              ) || 2,

              request.notify !==
                false

            );


          sendResponse(
            result
          );


        } catch (error) {

          console.error(
            "Capture request failed:",
            error
          );


          sendResponse({

            success:
              false,

            error:
              error?.message ||
              "Unknown error."

          });
        }

      }
    );


    /*
     * Keep sendResponse alive.
     */

    return true;
  }
);