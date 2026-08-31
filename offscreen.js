/*
 * ZiS - Offscreen Screenshot Processor
 *
 * Receives viewport screenshots from background.js,
 * stitches them together and creates the final PNG/JPG.
 */


// ============================================================
// DATA URL → IMAGE BITMAP
// ============================================================

async function dataUrlToBitmap(
  dataUrl
) {

  const response =
    await fetch(
      dataUrl
    );


  if (!response.ok) {

    throw new Error(
      "Could not read captured screenshot."
    );
  }


  const blob =
    await response.blob();


  return await createImageBitmap(
    blob
  );
}


// ============================================================
// CANVAS → DATA URL
// ============================================================

async function canvasToDataUrl(
  canvas,
  format
) {

  const mimeType =
    format === "jpg"
      ? "image/jpeg"
      : "image/png";


  const quality =
    format === "jpg"
      ? 0.92
      : undefined;


  const blob =
    await canvas.convertToBlob({

      type:
        mimeType,

      quality:
        quality

    });


  const buffer =
    await blob.arrayBuffer();


  const bytes =
    new Uint8Array(
      buffer
    );


  let binary =
    "";


  const chunkSize =
    0x8000;


  for (
    let i = 0;
    i < bytes.length;
    i += chunkSize
  ) {

    const chunk =
      bytes.subarray(

        i,

        Math.min(
          i + chunkSize,
          bytes.length
        )

      );


    binary +=
      String.fromCharCode(
        ...chunk
      );
  }


  return {

    dataUrl:
      `data:${mimeType};base64,${btoa(binary)}`,

    mimeType:
      mimeType

  };
}


// ============================================================
// STITCH
// ============================================================

async function stitchScreenshots(
  screenshots,
  outputWidth,
  outputHeight,
  scale,
  format
) {

  if (
    !Array.isArray(
      screenshots
    ) ||
    screenshots.length === 0
  ) {

    throw new Error(
      "No screenshots were received."
    );
  }


  // ----------------------------------------------------------
  // Canvas
  // ----------------------------------------------------------

  const canvas =
    new OffscreenCanvas(

      outputWidth,

      outputHeight

    );


  const ctx =
    canvas.getContext(

      "2d",

      {
        alpha:
          false
      }

    );


  if (!ctx) {

    throw new Error(
      "Could not create screenshot canvas."
    );
  }


  // ----------------------------------------------------------
  // White background
  // ----------------------------------------------------------

  ctx.fillStyle =
    "#ffffff";


  ctx.fillRect(

    0,

    0,

    outputWidth,

    outputHeight

  );


  // ----------------------------------------------------------
  // Draw screenshots
  // ----------------------------------------------------------

  for (
    let i = 0;
    i < screenshots.length;
    i++
  ) {

    const screenshot =
      screenshots[i];


    if (
      !screenshot?.dataUrl
    ) {
      continue;
    }


    const bitmap =
      await dataUrlToBitmap(
        screenshot.dataUrl
      );


    /*
     * Convert CSS scroll position to device pixels.
     */

    const destinationY =
      Math.round(

        screenshot.scrollY *
        scale

      );


    if (
      destinationY >=
      outputHeight
    ) {

      bitmap.close();

      continue;
    }


    const remainingHeight =
      outputHeight -
      destinationY;


    /*
     * The screenshot is scaled to the complete
     * output width.
     */

    const destinationWidth =
      outputWidth;


    /*
     * Don't draw beyond bottom of canvas.
     */

    const destinationHeight =
      Math.min(

        bitmap.height,

        remainingHeight

      );


    if (
      destinationHeight > 0
    ) {

      ctx.drawImage(

        bitmap,

        0,

        0,

        bitmap.width,

        destinationHeight,

        0,

        destinationY,

        destinationWidth,

        destinationHeight

      );
    }


    bitmap.close();


    // --------------------------------------------------------
    // Progress
    // --------------------------------------------------------

    chrome.runtime.sendMessage({

      action:
        "stitchProgress",

      progress:
        82 +
        Math.round(

          (
            (i + 1) /
            screenshots.length
          ) *

          12

        )

    }).catch(() => {});
  }


  // ----------------------------------------------------------
  // Export
  // ----------------------------------------------------------

  return await canvasToDataUrl(

    canvas,

    format

  );
}


// ============================================================
// MESSAGE LISTENER
// ============================================================

chrome.runtime.onMessage.addListener(

  (
    message,
    sender,
    sendResponse
  ) => {


    if (
      message.action !==
      "stitchScreenshots"
    ) {

      return;
    }


    (
      async () => {

        try {

          const result =
            await stitchScreenshots(

              message.screenshots,

              message.outputWidth,

              message.outputHeight,

              message.scale,

              message.format

            );


          sendResponse({

            action:
              "stitchResult",

            requestId:
              message.requestId,

            success:
              true,

            dataUrl:
              result.dataUrl,

            mimeType:
              result.mimeType

          });


        } catch (error) {

          console.error(
            "Screenshot stitching error:",
            error
          );


          sendResponse({

            action:
              "stitchResult",

            requestId:
              message.requestId,

            success:
              false,

            error:
              error?.message ||
              "Screenshot stitching failed."

          });
        }

      }
    )();


    return true;
  }
);