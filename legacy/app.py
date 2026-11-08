"""
ARSxedit — Automated Mobile Document Scanner
============================================

A production-ready Flask backend that:
  1. Accepts camera frames posted by the browser (base64 JPEG).
  2. Detects a white paper contour against a darker background.
  3. Perspective-warps the paper to a flat, standard A4 document.
  4. Buffers processed pages in memory and compiles them into a
     multi-page PDF on demand.

Run locally (desktop):
    pip install -r requirements.txt
    python app.py
    -> http://127.0.0.1:5000

Run on an Android phone under Termux (see README.md).
"""

import base64
import io
import json
import os
import threading

import cv2
import numpy as np
from flask import Flask, Response, jsonify, render_template, request

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
#: Fixed output page size (A4 @ 200 DPI). Brightness enhancement is NOT
#: applied here so text stays black-on-white (clean OCR-friendly output).
PAGE_W, PAGE_H = 1654, 2339          # A4 @ 200 DPI

#: OpenCV max dimension for edge detection. Large frames are downscaled for
#: speed; the final crop is always done on the *full-resolution* frame.
PROCESS_MAX_DIM = 1280

#: Sane, tunable constants for paper detection.
GAUSSIAN_KERNEL = (5, 5)
CANNY_LOW, CANNY_HIGH = 50, 150
MIN_CONTOUR_AREA_RATIO = 0.08       # paper must cover >= 8% of the frame
ADAPTIVE_STEP = 10                  # Canny threshold fallback step
MAX_ADAPTIVE_ITER = 12              # tries before giving up on a weak frame

# ---------------------------------------------------------------------------
# Application
# ---------------------------------------------------------------------------
app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024 * 1024  # 16 MB per frame

# In-memory page buffer (guarded by a lock).
# { "pages": [ {"image": <np.ndarray BGR>, "label": str, "ts": float} ], ... }
STATE = {"pages": []}
STATE_LOCK = threading.Lock()


# ---------------------------------------------------------------------------
# Image processing helpers
# ---------------------------------------------------------------------------
def order_points(pts: np.ndarray) -> np.ndarray:
    """Return the four corner points ordered: TL, TR, BR, BL."""
    rect = np.zeros((4, 2), dtype="float32")
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]           # top-left has smallest sum
    rect[2] = pts[np.argmax(s)]           # bottom-right has largest sum
    diff = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(diff)]        # top-right has smallest diff
    rect[3] = pts[np.argmax(diff)]        # bottom-left has largest diff
    return rect


def four_point_transform(image: np.ndarray, pts: np.ndarray) -> np.ndarray:
    """Apply a perspective warp so the 4 points map onto a rectangle."""
    rect = order_points(pts)
    (tl, tr, br, bl) = rect
    widthA = np.linalg.norm(br - bl)
    widthB = np.linalg.norm(tr - tl)
    maxWidth = max(int(widthA), int(widthB))
    heightA = np.linalg.norm(tr - br)
    heightB = np.linalg.norm(tl - bl)
    maxHeight = max(int(heightA), int(heightB))

    # Preserve the page's own aspect ratio unless it is wildly off the
    # A4 ratio, in which case we normalize toward A4 for a clean output.
    ratio = maxWidth / maxHeight if maxHeight else 1.0
    if 0.5 < ratio < 2.4:
        dst = np.array([[0, 0],
                        [maxWidth - 1, 0],
                        [maxWidth - 1, maxHeight - 1],
                        [0, maxHeight - 1]], dtype="float32")
    else:
        dst = np.array([[0, 0],
                        [PAGE_W - 1, 0],
                        [PAGE_W - 1, PAGE_H - 1],
                        [0, PAGE_H - 1]], dtype="float32")

    M = cv2.getPerspectiveTransform(rect, dst)
    warped = cv2.warpPerspective(image, M, (maxWidth, maxHeight))
    return warped


def find_paper_contour(image: np.ndarray, min_area: float):
    """
    Locate the document boundary in a BGR frame.

    Returns (warped, quad) where ``quad`` is the 4 corner points in the
    full-resolution frame, or (None, None) if no convincing paper is found.
    """
    orig = image.copy()
    h, w = image.shape[:2]
    scale = PROCESS_MAX_DIM / max(h, w)
    small = cv2.resize(image, (int(w * scale), int(h * scale))) if scale < 1.0 else image
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, GAUSSIAN_KERNEL, 0)

    low, high = CANNY_LOW, CANNY_HIGH
    quad = None

    # Increase sensitivity if the initial pass finds nothing (dim or busy bg).
    for _ in range(MAX_ADAPTIVE_ITER):
        edges = cv2.Canny(gray, low, high)
        contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)

        # Look at contours largest-first.
        contours = sorted(contours, key=cv2.contourArea, reverse=True)
        for c in contours[:10]:
            area = cv2.contourArea(c)
            if area < min_area * w * h:
                continue
            peri = cv2.arcLength(c, True)
            approx = cv2.approxPolyDP(c, 0.02 * peri, True)
            if len(approx) == 4 and cv2.isContourConvex(approx):
                quad = approx.reshape(4, 2)
                break
        if quad is not None:
            break
        low = max(low - ADAPTIVE_STEP, 10)
        high = max(high - ADAPTIVE_STEP, 20)

    if quad is None:
        return None, None

    # Map the downscaled quad back to the full-resolution frame.
    if scale < 1.0:
        quad = quad / scale

    warped = four_point_transform(orig, quad.astype("float32"))
    return warped, quad.astype(int)


def encode_jpeg(bgr: np.ndarray, quality: int = 92) -> bytes:
    ok, buf = cv2.imencode(".jpg", bgr, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise RuntimeError("Failed to JPEG-encode frame")
    return buf.tobytes()


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/process", methods=["POST"])
def api_process():
    """
    Process a single frame.

    Body: {"image": "<base64 JPEG>"}
    Returns: {"status": "ok", "found": true, "preview": "<base64 JPEG>",
              "quad": [[x,y]...], "pages": int}
    """
    try:
        data = request.get_json(force=True)
        raw = data.get("image", "")
        if not raw:
            return jsonify({"status": "error", "message": "No image supplied"}), 400

        nparr = np.frombuffer(base64.b64decode(raw), np.uint8)
        frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if frame is None:
            return jsonify({"status": "error", "message": "Invalid image"}), 400

        warped, quad = find_paper_contour(frame, MIN_CONTOUR_AREA_RATIO)

        payload = {"status": "ok", "found": quad is not None,
                   "pages": len(STATE["pages"])}
        if warped is not None:
            payload["preview"] = base64.b64encode(encode_jpeg(warped)).decode()
        if quad is not None:
            payload["quad"] = quad.tolist()
        return jsonify(payload)

    except Exception as exc:  # never leak internals to the client
        app.logger.exception("process failed")
        return jsonify({"status": "error", "message": str(exc)}), 500


@app.route("/api/capture", methods=["POST"])
def api_capture():
    """Persist the current processed frame as a scanned page."""
    try:
        data = request.get_json(force=True)
        raw = data.get("image", "")
        if not raw:
            return jsonify({"status": "error", "message": "No image"}), 400
        nparr = np.frombuffer(base64.b64decode(raw), np.uint8)
        frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if frame is None:
            return jsonify({"status": "error", "message": "Invalid image"}), 400

        warped, quad = find_paper_contour(frame, MIN_CONTOUR_AREA_RATIO)
        if warped is None:
            return jsonify({"status": "error", "found": False,
                            "message": "No document detected"}), 400

        with STATE_LOCK:
            STATE["pages"].append({
                "image": warped,
                "label": f"Page {len(STATE['pages']) + 1}",
                "ts": cv2.getTickCount(),
            })
        return jsonify({"status": "ok", "found": True,
                        "pages": len(STATE["pages"])})

    except Exception as exc:
        app.logger.exception("capture failed")
        return jsonify({"status": "error", "message": str(exc)}), 500


@app.route("/api/pages", methods=["GET"])
def api_pages():
    with STATE_LOCK:
        return jsonify({"pages": len(STATE["pages"])})


@app.route("/api/clear", methods=["POST"])
def api_clear():
    with STATE_LOCK:
        STATE["pages"] = []
    return jsonify({"status": "ok", "pages": 0})


@app.route("/api/pdf", methods=["GET"])
def api_pdf():
    """
    Build a multi-page PDF from the buffered pages and stream it back.

    Returns a PDF (``application/pdf``) or a JSON error if there are no pages.
    """
    with STATE_LOCK:
        pages = list(STATE["pages"])
    if not pages:
        return jsonify({"status": "error", "message": "No pages captured"}), 400

    try:
        buf = _build_pdf(pages)
        headers = {
            "Content-Disposition": "attachment; filename=scan.pdf",
            "Content-Type": "application/pdf",
        }
        return Response(buf, headers=headers)

    except Exception as exc:
        app.logger.exception("pdf build failed")
        return jsonify({"status": "error", "message": str(exc)}), 500


def _build_pdf(pages) -> bytes:
    """Render each page image into a single in-memory multi-page PDF."""
    from PIL import Image  # Pillow ships with the app (see requirements)

    imgs = []
    for p in pages:
        # Lossless PNG keeps handwritten / printed text crisp in the PDF.
        ok, buf = cv2.imencode(".png", p["image"])
        if not ok:
            raise RuntimeError("Could not encode a page to PNG")
        imgs.append(Image.open(io.BytesIO(buf)).convert("RGB"))

    out = io.BytesIO()
    imgs[0].save(out, "PDF", save_all=True, append_images=imgs[1:])
    return out.getvalue()


@app.errorhandler(413)
def too_large(_):
    return jsonify({"status": "error",
                    "message": "Frame too large (max 16 MB)"}), 413


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "5000"))
    # threaded=True is required so multiple simultaneous frame POSTs
    # (auto-capture) don't block one another.
    print(f"\n  ARSxedit Scanner running  ->  http://{host}:{port}\n")
    app.run(host=host, port=port, threaded=True, debug=False)
