/* =========================================================================
   ARSxedit — Document Scanner (frontend logic)
   - getUserMedia rear-camera streaming
   - throttled frame posting to /api/process for paper detection
   - neon tracker overlay following the detected quad
   - auto-capture (steady-document detection) + manual capture
   - multi-page PDF export via /api/pdf
   ========================================================================= */
(() => {
  "use strict";

  const video = document.getElementById("video");
  const tracker = document.getElementById("tracker");
  const trackerPoly = document.getElementById("trackerPoly");
  const captureBtn = document.getElementById("captureBtn");
  const makePdfBtn = document.getElementById("makePdfBtn");
  const clearBtn = document.getElementById("clearBtn");
  const autoToggle = document.getElementById("autoToggle");
  const toast = document.getElementById("statusToast");
  const pageCounter = document.getElementById("pageCounter");
  const scanlines = document.getElementById("scanlines");
  const pdfLink = document.getElementById("pdfLink");
  const snapCanvas = document.getElementById("snapCanvas");

  // ---- state -------------------------------------------------------------
  let stream = null;
  let detected = false;          // last frame had a confirmed page
  let pendingCapture = false;    // capture is armed
  let processing = false;        // a POST is in flight
  let toastTimer = null;
  let steadyFrames = 0;
  const STEADY_REQUIRED = 5;     // consecutive steady frames to auto-capture

  // ---- helpers -----------------------------------------------------------
  function el(id) { return document.getElementById(id); }

  function showToast(msg, kind = "") {
    toast.textContent = msg;
    toast.className = "toast show " + kind;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.className = "toast"; }, 2400);
  }

  function setCounter(n) {
    pageCounter.textContent = `${n} page${n === 1 ? "" : "s"}`;
    makePdfBtn.disabled = n === 0;
  }

  // ---- camera bootstrap --------------------------------------------------
  async function startCamera() {
    const preferred = {
      audio: false,
      video: {
        facingMode: { ideal: "environment" },   // prefer rear camera
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    };

    try {
      stream = await navigator.mediaDevices.getUserMedia(preferred);
    } catch (e) {
      // Some Android browsers ignore facingMode; try a plain request.
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
      } catch (err2) {
        showToast("Camera unavailable. Check permissions.", "err");
        throw err2;
      }
    }

    video.srcObject = stream;
    await video.play();
    captureBtn.disabled = false;
    showToast("Ready. Point at a document.", "ok");
    requestAnimationFrame(detectLoop);
  }

  // ---- detection loop ----------------------------------------------------
  // Grab a frame, post it to the backend, draw the tracker, decide capture.
  function detectLoop() {
    if (video.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA && !processing) {
      const frame = grabFrame(video);
      postProcess(frame);
    }
    requestAnimationFrame(detectLoop);
  }

  // Draw the current video frame onto a canvas and return a JPEG data URL.
  function grabFrame(v) {
    const w = v.videoWidth;
    const h = v.videoHeight;
    snapCanvas.width = w;
    snapCanvas.height = h;
    const ctx = snapCanvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(v, 0, 0, w, h);
    // strip the data-URL prefix
    return snapCanvas.toDataURL("image/jpeg", 0.8).split(",")[1];
  }

  function postProcess(base64) {
    processing = true;
    fetch("/api/process", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: base64 }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.status === "ok") {
          handleDetectResult(data);
        } else {
          setTrackerVisible(false);
          detected = false;
          steadyFrames = 0;
          scanlines.classList.remove("on");
        }
      })
      .catch(() => {
        setTrackerVisible(false);
        detected = false;
        steadyFrames = 0;
        scanlines.classList.remove("on");
      })
      .finally(() => { processing = false; });
  }

  function handleDetectResult(data) {
    detected = data.found;
    if (data.quad) {
      drawTracker(data.quad);
      scanlines.classList.add("on");
    } else {
      setTrackerVisible(false);
      scanlines.classList.remove("on");
    }

    // ---- auto-capture: fire when the document is steady ------------------
    if (autoToggle.checked && detected) {
      steadyFrames++;
      if (steadyFrames >= STEADY_REQUIRED && !pendingCapture) {
        doCapture();
      }
    } else {
      steadyFrames = 0;
    }
  }

  function drawTracker(quad) {
    // quad comes in full-res video coordinates; map to the fitted stage.
    const videoW = video.videoWidth || 1;
    const videoH = video.videoHeight || 1;
    // Because we mirror the video with scaleX(-1), flip the X coordinate.
    const pts = quad.map(([x, y]) => {
      const ux = 100 - (x / videoW) * 100;      // mirror
      const uy = (y / videoH) * 100;
      return `${ux},${uy}`;
    });
    trackerPoly.setAttribute("points", pts.join(" "));
    tracker.classList.remove("hidden");
  }
  function setTrackerVisible(v) { tracker.classList.toggle("hidden", !v); }

  // ---- capture -----------------------------------------------------------
  function doCapture() {
    if (pendingCapture || !detected) {
      showToast("No page in frame", "err");
      return;
    }
    pendingCapture = true;
    captureBtn.disabled = true;

    const frame = grabFrame(video);
    fetch("/api/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: frame }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.status === "ok") {
          setCounter(data.pages);
          showToast(`Page captured · ${data.pages} total`, "ok");
          // flash the tracker for feedback
          trackerPoly.style.opacity = "1";
          setTimeout(() => { trackerPoly.style.opacity = ""; }, 180);
        } else {
          showToast(data.message || "Capture failed", "err");
        }
      })
      .catch(() => showToast("Capture failed", "err"))
      .finally(() => {
        pendingCapture = false;
        captureBtn.disabled = false;
        steadyFrames = 0; // require a fresh steady run for the next auto shot
      });
  }

  // ---- PDF export --------------------------------------------------------
  async function makePdf() {
    makePdfBtn.disabled = true;
    showToast("Building PDF…");
    try {
      const res = await fetch("/api/pdf");
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.message || "PDF build failed");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      pdfLink.href = url;
      pdfLink.download = "arsxedit-scan.pdf";
      pdfLink.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      showToast("PDF ready", "ok");
    } catch (e) {
      showToast(e.message, "err");
    } finally {
      makePdfBtn.disabled = false;
    }
  }

  function clearPages() {
    fetch("/api/clear", { method: "POST" })
      .then((r) => r.json())
      .then((d) => { if (d.status === "ok") { setCounter(0); showToast("Cleared", "ok"); } })
      .catch(() => showToast("Clear failed", "err"));
  }

  // ---- event wiring ------------------------------------------------------
  captureBtn.addEventListener("click", doCapture);
  makePdfBtn.addEventListener("click", makePdf);
  clearBtn.addEventListener("click", clearPages);

  // refresh the live page count on load
  fetch("/api/pages").then((r) => r.json()).then((d) => setCounter(d.pages || 0));

  // kick everything off
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showToast("This browser does not support camera access.", "err");
  } else {
    startCamera();
  }
})();

