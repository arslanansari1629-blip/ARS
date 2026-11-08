# ðŸ“„ ARSxedit â€” Automated Mobile Document Scanner

A production-ready **Flask + OpenCV** web app that turns your phone's rear
camera into a smart document scanner:

- **Frontend** â€” HTML5 `getUserMedia` rear-camera streaming, a neon tracker
  that outlines the detected paper, an **Auto**-capture toggle, and a
  **Make PDF** button.
- **Backend** â€” OpenCV contour detection + perspective warp to flatten the
  paper to a clean A4 page; pages are buffered in memory and compiled into a
  **multi-page PDF** on demand.
- **Fully responsive** dark-mode UI, built for mobile browsers.

---

## âœ¨ Features

| Feature | Details |
|---------|---------|
| Camera | `facingMode: "environment"` (rear camera), mirrored preview |
| Detection | White-paper-on-dark contour detection with adaptive Canny fallback |
| Warp | Perspective transform to a flat A4-sized page (clean text) |
| Capture | Manual tap **or** steady-frame Auto-capture |
| PDF | Multi-page PDF from all buffered pages, streamed to the browser |
| Live preview | Detection preview + page counter + toasts |

---

## ðŸ§± Project structure

```
docscanner/
â”œâ”€â”€ app.py                 # Flask backend + OpenCV image processing
â”œâ”€â”€ requirements.txt
â”œâ”€â”€ README.md
â”œâ”€â”€ templates/
â”‚   â””â”€â”€ index.html         # frontend markup
â””â”€â”€ static/
    â”œâ”€â”€ css/style.css      # dark, responsive UI
    â””â”€â”€ js/scanner.js      # camera + detection + capture + PDF logic
```

---

## ðŸ’» Run on a desktop / laptop

```bash
cd docscanner
python3 -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

Then open **http://127.0.0.1:5000** in a browser and allow camera access.
> Chrome / Edge only serve `getUserMedia` over HTTPS *or* on
> `http://localhost` / `127.0.0.1`. On desktop localhost this works out of
> the box.

---

## ðŸ“± Run on an Android phone with Termux

> Goal: run the server **on the phone itself** so the *same phone's browser*
> can access the rear camera over `http://localhost:5000`.
> **You do NOT need a computer at all.**

### Step 1 â€” Install Termux
Install **Termux** from F-Droid (the Play Store version is often outdated):
https://f-droid.org/packages/com.termux/

### Step 2 â€” Update packages & allow storage
```bash
pkg update && pkg upgrade -y
termux-setup-storage
```
The `termux-setup-storage` prompt grants storage access (only needed to copy
files around, optional).

### Step 3 â€” Install the toolchain (Python, build deps, git)
```bash
pkg install -y python git clang binutils
pip install --upgrade pip wheel
```

### Step 4 â€” Install native OpenCV system libraries
OpenCV on Termux needs several native libraries. Install them first so the
Python wheel links cleanly:
```bash
pkg install -y opencv libopencv \
  libjpeg-turbo libpng libwebp libtiff \
  zlib freetype libglvnd
```
> If `opencv` is not found, just install the Python package in the next step
> â€” the pip wheel ships prebuilt binaries that usually work on recent Termux.

### Step 5 â€” Get the code & install Python dependencies
```bash
cd ~
git clone https://github.com/<YOUR_USER>/docscanner.git
# or copy the `docscanner` folder onto the phone and cd into it
cd docscanner

pip install -r requirements.txt
```
If the pinned `opencv-python-headless` wheel fails to build, install a build:
```bash
pip install --upgrade opencv-python-headless
```

### Step 6 â€” Run the server
```bash
python app.py
```
You'll see:
```
ARSxedit Scanner running  ->  http://0.0.0.0:5000
```

### Step 7 â€” Open it in the phone browser
Open **http://localhost:5000** (or **http://127.0.0.1:5000**) in Chrome/Firefox
on the same phone and **Allow** the camera prompt.

> ðŸ’¡ **Why this works:** Termux binds the server to `0.0.0.0`, so it's reachable
> from the phone's own browser at `localhost`. No internet connection or
> computer is required. Only *this* phone's browser can reach it â€” nothing is
> exposed to the internet.

### Optional â€” serve over the local network
To reach it from a *laptop* on the same Wi-Fi (useful if the laptop has the
camera-free backend but you want a bigger view):
1. Find the phone's LAN IP: `ip -f inet addr show` (look under `wlan0`).
2. On the laptop, open `http://<phone-ip>:5000`.
   - The browser on the laptop must allow `getUserMedia`. For non-localhost
     origins, Chrome requires HTTPS â€” use `adb forward` or a local tunnel in
     that case. Simpler: just use the phone's own browser as described above.

---

## ðŸ› Troubleshooting

| Problem | Fix |
|---------|-----|
| `getUserMedia` error / black camera | Use the **phone's** browser on `localhost`. Ensure camera permission is **Allowed**, not "Ask every time". Close other apps using the camera. |
| "Camera unavailable" | Some browsers ignore `facingMode`. The app auto-falls back to any camera. |
| OpenCV install fails in Termux | Run `pkg install -y opencv libopencv` first, then `pip install --upgrade opencv-python-headless`. |
| No document detected | Put the paper on a **darker, high-contrast** surface, hold the camera level and steady, and make sure the whole sheet is in frame. |
| PDF downloads but won't open | Re-try; ensure at least one page is captured. |
| Slow / laggy | Detection runs at full res; on weak phones reduce `PROCESS_MAX_DIM` in `app.py` to `800`. |

---

## ðŸ”§ Tuning the detector (in `app.py`)

- `MIN_CONTOUR_AREA_RATIO` â€” raise if it over-detects small objects; lower if
  it misses far-away documents.
- `CANNY_LOW / CANNY_HIGH` â€” edge sensitivity.
- `ADAPTIVE_STEP / MAX_ADAPTIVE_ITER` â€” how aggressively it re-scans dim frames.
- `PAGE_W / PAGE_H` â€” output page resolution (A4 @ 200 DPI).

---

## ðŸ“ Notes

- Pages are held **in memory** only; restarting the server clears them.
- Output PDF uses lossless PNG tiles for crisp text.
- Built with â¤ï¸ â€” ARSxedit.
