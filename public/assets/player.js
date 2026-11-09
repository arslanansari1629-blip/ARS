/* =========================================================================
   ArsVibe — pro player engine
   -------------------------------------------------------------------------
   Owns the video element's transport, quality, buffering and recovery.

   Design rules, learned from the failures this replaces:

   1. One control surface. The bar you see is the only bar: no native
      `controls` attribute underneath it showing a second, differently-shaped
      timeline.

   2. A stream that was stopped must start again. Every path that can leave
      the element without a source (a stop, a swapped rendition, an hls.js
      media error) has an explicit way back, and a retry always re-resolves the
      stream through `/api/stream?attempt=N` so it never re-uses the dead plan.

   3. Buffering is a state, not an error. The player keeps a read-ahead buffer,
      pre-seeks a short distance ahead after every stall, and reports what it is
      doing in the toolbar instead of freezing a black frame.

   4. Nothing here depends on a CDN at runtime: hls.js and dash.js are served
      from this origin, with the CDN list kept only as a last resort.
   ========================================================================= */

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export function fmtTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * A video element plus the engine attached to it.
 *
 * The caller supplies the DOM (so the markup can change without touching this
 * file) and two callbacks: `resolve` returns a fresh plan from the server, and
 * `onState` receives every state change so the toolbar can render it.
 */
export class ProPlayer {
  constructor({ video, root, resolve, onState, onError, onEnded, prefs }) {
    this.video = video;
    this.root = root || (video && video.parentElement) || null;
    this.resolve = resolve;
    this.onState = onState || (() => {});
    this.onError = onError || (() => {});
    this.onEnded = onEnded || (() => {});
    this.prefs = prefs || { get: () => ({}), set: () => {} };

    this.plan = null;
    this.hls = null;
    this.dash = null;
    this.native = false;
    this.engine = "";
    /** resolution attempts, sent to /api/stream so a retry bypasses its cache */
    this.attempt = 0;
    /** auto-recovery budget; refilled whenever playback is healthy again */
    this.recovery = 0;
    this.lastProgressAt = 0;
    this.destroyed = false;

    this._bindElement();
  }

  /* ------------------------------- state --------------------------------- */

  state(patch) {
    this._state = { ...(this._state || {}), ...patch };
    this.onState(this._state);
  }

  /* ----------------------------- element wiring --------------------------- */

  _bindElement() {
    const v = this.video;
    if (!v) return;

    v.addEventListener("loadedmetadata", () => {
      this.state({ duration: v.duration, ready: true });
      this._applyRelativeVolume();
    });

    // `waiting`/`playing` are the only reliable buffer signals across browsers:
    // `waiting` fires for a stall, `progress` for bytes arriving while paused.
    v.addEventListener("waiting", () => {
      this.state({ buffering: true });
      this._stallGuard();
    });
    v.addEventListener("playing", () => {
      this.recovery = 0;
      this.state({ buffering: false, playing: true, paused: false, error: "" });
    });
    v.addEventListener("play", () => this.state({ paused: false, ended: false }));
    v.addEventListener("pause", () => {
      // A stop is a deliberate action; the toolbar keeps offering Start.
      this.state({ paused: true, playing: false });
      this._prewarm();
    });
    // `progress` fires while paused too: the read-ahead buffer keeps filling,
    // so the progress rail shows real range instead of a frozen bar.
    v.addEventListener("progress", () => this.state({ buffered: this._bufferedEnd() }));
    v.addEventListener("ended", () => {
      this.state({ ended: true, playing: false });
      this.onEnded();
    });
    v.addEventListener("seeking", () => this.state({ seeking: true }));
    v.addEventListener("seeked", () => this.state({ seeking: false }));
    v.addEventListener("timeupdate", () => {
      this.lastProgressAt = Date.now();
      this.state({ currentTime: v.currentTime, duration: v.duration });
    });
    v.addEventListener("ratechange", () => this.state({ rate: v.playbackRate }));
    // Real playback re-arms the preflight: whatever went wrong last time is
    // behind us, and the *next* failure deserves its own probe.
    v.addEventListener("playing", () => {
      this._probeFailed = false;
    });
    v.addEventListener("volumechange", () =>
      this.state({ volume: v.volume, muted: v.muted })
    );
    v.addEventListener("error", () => {
      // When hls.js/dash.js own the media element they report through their own
      // events; a spurious element error there must not replace the player.
      if (!this.native) return;
      const code = v.error ? v.error.code : 0;
      // A native failure is often just a dead signed URL, not an unsupported
      // file: re-resolve a couple of times before telling the student anything.
      if (this.attempt < 3) {
        this._report("segment", `native ${code}`);
        this.retry({ reason: "The stream link expired." });
        return;
      }
      this._fail("Playback error", whyElementFailed(code));
    });
  }

  /**
   * Watchdog for a stall that never resolves.
   *
   * A segment request that hangs produces no error at all: `waiting` fires once
   * and then the element sits there forever. After a grace period, nudge the
   * pipeline instead of waiting for the student to guess.
   */
  _stallGuard() {
    clearTimeout(this._stalledFor);
    this._stalledFor = setTimeout(() => {
      if (this.destroyed || !this.video || this.video.paused) return;
      if (this.video.readyState >= 3) return;
      this.recovery += 1;
      if (this.recovery > 3) {
        this._report("stall", `${Math.round(this.video.currentTime)}s`);
        this.retry({ reason: "The stream stalled repeatedly." });
        return;
      }
      this.state({ buffering: true, note: "Re-buffering…" });
      // A short forward pre-seek un-sticks a decoder waiting on a lost segment;
      // for hls.js a fresh load of the current level is cheaper and safer.
      if (this.hls) {
        try {
          this.hls.startLoad();
        } catch {
          /* ignore */
        }
      } else {
        const t = this.video.currentTime;
        this.video.currentTime = t + 0.25;
      }
    }, 6000);
  }

  /** End of the buffered range that contains the playhead. */
  _bufferedEnd() {
    const v = this.video;
    if (!v || !v.buffered || !v.buffered.length) return 0;
    for (let i = 0; i < v.buffered.length; i += 1) {
      if (v.buffered.start(i) <= v.currentTime && v.buffered.end(i) >= v.currentTime) {
        return v.buffered.end(i);
      }
    }
    return v.buffered.end(v.buffered.length - 1);
  }

  /**
   * Ask for a little more media around the pause point.
   *
   * A lecture is watched in bursts: pause, read a note, come back. Telling the
   * element to prefer `auto` preloading means the next play starts on local
   * bytes instead of re-buffering. It deliberately does *not* call `load()`:
   * that would throw away the current buffer, which is the opposite of what a
   * pause is for.
   */
  _prewarm() {
    if (!this.video) return;
    const want = this.video.currentTime + 20;
    const have = this._bufferedEnd();
    if (!Number.isFinite(want) || have >= want - 1) return;
    try {
      if (this.video.preload !== "auto") this.video.preload = "auto";
    } catch {
      /* an element may refuse; nothing else to do */
    }
    // hls.js owns fetching when it is attached: ask it to keep loading rather
    // than touching the element's source.
    if (this.hls) {
      try {
        this.hls.startLoad();
      } catch {
        /* ignore */
      }
    }
  }

  /* ------------------------------ plan attach ----------------------------- */

  /**
   * Attach a resolved plan. `autoplay` false is used by "Start over", where the
   * user asked for a specific position and not for a play command.
   */
  async load(plan, { autoplay = true } = {}) {
    if (!plan || !plan.url) throw new Error("No stream plan to load");
    this.plan = plan;
    this.state({ buffering: true, error: "", note: "Starting…" });

    if (plan.engine === "embed" || plan.kind === "youtube" || plan.kind === "vimeo") {
      this.state({ engine: "embed", embed: plan.embed || "" });
      return;
    }

    this._teardownPlayers();

    if (plan.kind === "dash") {
      await this._attachDash(plan, autoplay);
      return;
    }

    if (plan.kind === "hls") {
      await this._attachHls(plan, autoplay);
      return;
    }

    this._attachNative(plan, autoplay);
  }

  _attachNative(plan, autoplay) {
    this.native = true;
    this.engine = "native";
    this.video.src = plan.url;
    this.state({ engine: "native", qualityLevels: [] });
    if (autoplay) this.play();
  }

  async _attachHls(plan, autoplay) {
    // Probe the manifest before handing it to hls.js.
    //
    // hls.js reports an expired signature as a generic fatal `manifestLoadError`
    // after its own retry budget, which on a slow connection is half a minute of
    // black frame. One cheap request up front answers the same question in a
    // second, and — crucially — it lets the player re-resolve *before* the
    // student ever sees a frozen player. A timeout or a 403 here is not an error
    // to show; it is a signal to go and get a fresh link.
    if (!this._probeFailed) {
      const probe = await probeManifest(plan.url, 7000);
      if (!probe.ok) {
        // Remember that this cycle has already spent its re-resolve. The next
        // attach skips the probe and hands the URL to the engine anyway: a probe
        // can be wrong (a blocked preflight, a rate-limited burst) while the
        // media pipeline would have played, and a player that refuses to try is
        // exactly the "video never plays" bug this file exists to avoid. One
        // probe per failure cycle, never a probe loop.
        this._probeFailed = true;
        this._report(
          probe.status === 403 || probe.status === 401 ? "signature" : "manifest",
          probe.status || probe.error
        );
        return this.retry({
          reason: probe.status ? "The stream link expired." : "The stream did not answer.",
        });
      }
    }

    const Hls = await this._ensureHls();
    const canNative = Boolean(
      this.video.canPlayType && this.video.canPlayType("application/vnd.apple.mpegurl")
    );

    if (!Hls || !Hls.isSupported()) {
      // No MSE-HLS. Try the element itself either way: `canPlayType` is a hint,
      // not a promise, and a browser that *can* play this manifest should get
      // the chance. The native error path explains the failure if it cannot.
      this._attachNative(plan, autoplay);
      if (!canNative) {
        this.state({
          note: "This browser is playing the stream natively",
          engine: "native",
        });
      }
      return;
    }

    const hls = new Hls({
      // A lecture is watched in long stretches: keep a real read-ahead buffer so
      // an ordinary network wobble never reaches the screen.
      maxBufferLength: 90,
      maxMaxBufferLength: 240,
      maxBufferSize: 90 * 1000 * 1000,
      backBufferLength: 120,
      // Keep the fragment we just left so a skip back (the common case after an
      // accidental forward tap) is instant instead of a re-fetch.
      maxBufferHole: 0.5,
      highBufferWatchdogPeriod: 4,
      // After a seek into unbuffered media the player starts at the nearest
      // keyframe; jumping a small gap is far cheaper than re-fetching a
      // fragment, and it is what makes ±10 s feel instant on a long lecture.
      nudgeMaxRetry: 6,
      nudgeOffset: 0.2,
      // Do not tear the buffer down on a brief stall during a seek.
      testBandwidth: false,
      // A two-hour VOD: never let ABR downshift because of one slow fragment.
      abrEwmaFastVoD: 4,
      abrEwmaSlowVoD: 14,
      // Steady ABR: do not flip renditions every fragment (visible quality
      // pumping) and do not start at the top level on a slow line.
      startLevel: -1,
      abrEwmaDefaultEstimate: 800000,
      abrBandWidthFactor: 0.85,
      abrBandWidthUpFactor: 0.7,
      fragLoadingMaxRetry: 6,
      manifestLoadingMaxRetry: 4,
      levelLoadingMaxRetry: 4,
      fragLoadingTimeOut: 45000,
      manifestLoadingTimeOut: 20000,
      levelLoadingTimeOut: 20000,
      lowLatencyMode: false,
      enableWorker: true,
      // Start no higher than the first second of the lecture: fetching a few
      // fragments at 240p fills the buffer in a fraction of the time a 720p
      // start does, and ABR steps up within ~10 s. This is what makes the
      // first frame feel instant on a slow line.
      startPosition: -1,
      // Never pick a rendition the player surface cannot show: on a laptop a
      // 240p stream looks the same as 480p but buffers twice as fast.
      capLevelToPlayerSize: true,
      capLevelOnFPSDrop: true,
    });
    this.hls = hls;
    this.native = false;
    this.engine = "hls";

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      const levels = (hls.levels || []).map((l) => ({
        height: l.height || 0,
        bitrate: l.bitrate || 0,
        index: l.index ?? hls.levels.indexOf(l),
      }));
      this.state({ engine: "hls", qualityLevels: levels });
      this._applySavedQuality(levels);
      if (autoplay) this.play();
    });

    hls.on(Hls.Events.LEVEL_SWITCHED, () => {
      this.state({ autoLevel: hls.autoLevelEnabled, currentLevel: hls.currentLevel });
    });

    hls.on(Hls.Events.ERROR, (_evt, data) => {
      if (!data || !data.fatal) return;
      const details = String(data.details || "");

      // A manifest/level failure means the signed playlist itself is dead
      // (expired signature, a signer that gave up). Re-requesting the same URL
      // cannot help — resolve a new plan from a different signer host.
      if (/manifest|level/i.test(details) || data.type === Hls.ErrorTypes.KEY_SYSTEM_ERROR) {
        this.retry({ reason: "The signed stream link expired." });
        return;
      }

      this.recovery += 1;
      if (this.recovery > 4) {
        this._report("segment", details || "recovery exhausted");
        this.retry({ reason: "The stream kept dropping." });
        return;
      }
      this.state({ buffering: true, note: "Recovering stream…" });
      try {
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else hls.startLoad();
      } catch {
        this.retry({ reason: "The stream could not recover." });
      }
    });

    hls.loadSource(plan.url);
    hls.attachMedia(this.video);
    this.state({ engine: "hls" });
  }

  async _attachDash(plan, autoplay) {
    const dashjs = await this._ensureDash();
    if (!dashjs) {
      // A browser without MSE-DASH still deserves a native attempt.
      this._attachNative(plan, autoplay);
      return;
    }
    const player = dashjs.MediaPlayer().create();
    this.dash = player;
    this.native = false;
    this.engine = "dash";
    player.updateSettings({
      streaming: {
        abr: { autoSwitchBitrate: { video: true }, initialBitrate: { video: 800 } },
        buffer: { fastSwitchEnabled: true, stableBufferTime: 30, bufferTimeAtTopQuality: 60 },
      },
    });
    player.on("streamInitialized", () => {
      const list = (player.getBitrateInfoListFor && player.getBitrateInfoListFor("video")) || [];
      this.state({
        engine: "dash",
        qualityLevels: list.map((b, i) => ({ height: b.height || 0, bitrate: b.bitrate || 0, index: i })),
      });
      if (autoplay) this.play();
    });
    player.initialize(this.video, plan.url, false);
    this.state({ engine: "dash" });
  }

  /* ------------------------------- libraries ------------------------------ */

  _script(src, timeoutMs = 7000) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) return resolve();
      const el = document.createElement("script");
      let settled = false;
      const done = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(arg);
      };
      const timer = setTimeout(() => {
        el.remove();
        done(reject, new Error(`Timed out loading ${src}`));
      }, timeoutMs);
      el.src = src;
      el.onload = () => done(resolve);
      el.onerror = () => done(reject, new Error(`Failed to load ${src}`));
      document.head.appendChild(el);
    });
  }

  async _ensureLib(globalName, sources) {
    if (window[globalName]) return window[globalName];
    for (const src of sources) {
      try {
        await this._script(src);
        if (window[globalName]) return window[globalName];
      } catch {
        /* try the next mirror */
      }
    }
    return null;
  }

  _ensureHls() {
    // Same-origin copy first: a network that blocks CDNs must not break playback.
    return this._ensureLib("Hls", [
      "/assets/vendor/hls.min.js",
      "https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js",
      "https://unpkg.com/hls.js@1.5.17/dist/hls.min.js",
    ]);
  }

  _ensureDash() {
    return this._ensureLib("dashjs", [
      "/assets/vendor/dash.all.min.js",
      "https://cdn.jsdelivr.net/npm/dashjs@4.7.4/dist/dash.all.min.js",
    ]);
  }

  /* ------------------------------- transport ------------------------------ */

  /**
   * Call `play()` defensively.
   *
   * It can throw synchronously (older iOS webviews) or return nothing at all in
   * environments without a media pipeline, and `.catch` on that return value
   * used to take the whole player down with a TypeError.
   */
  _playElement() {
    try {
      const result = this.video.play();
      return result && typeof result.then === "function" ? result : Promise.resolve();
    } catch (err) {
      return Promise.reject(err);
    }
  }

  play() {
    if (!this.video || this.destroyed) return Promise.resolve();
    // Pressing play always clears the stopped state. Leaving it set kept the
    // "Paused — press start" pane on top of a video that was already playing,
    // which is what "it will not play again" looked like.
    this._stopped = false;
    this.state({ stopped: false, paused: false });
    // Starting again after a stop: the element may have been left with no
    // source at all (a stop, an engine swap, a failed retry). Recover it rather
    // than letting `play()` reject forever on an empty element.
    if (!this._hasSource()) return this.restart();
    return this._playElement().catch((err) => {
      if (err && err.name === "NotAllowedError") {
        // Autoplay policy: a muted start is better than a black frame.
        this.video.muted = true;
        this.state({ muted: true, note: "Autoplay was blocked — muted" });
        return this._playElement().catch(() => {});
      }
      if (err && err.name === "AbortError") return undefined;
      this.state({ paused: true, note: "" });
      return undefined;
    });
  }

  pause() {
    this.video?.pause();
  }

  toggle() {
    if (!this.video) return;
    if (this.video.paused) return this.play();
    this.pause();
    return Promise.resolve();
  }

  /**
   * "Stop" is a real stop: pause, drop the media pipeline and show a Start
   * affordance. It used to leave the element paused with a stale, expiring
   * signed URL attached, so pressing play again failed with no explanation.
   */
  stop() {
    if (!this.video) return;
    this.video.pause();
    this._stopped = true;
    this.state({ paused: true, playing: false, buffering: false, stopped: true, note: "" });
  }

  /** Is there a usable media source right now? */
  _hasSource() {
    if (!this.video) return false;
    if (this.hls || this.dash) return true;
    const src = this.video.currentSrc || this.video.getAttribute("src") || "";
    return Boolean(src) && src !== "about:blank";
  }

  /** Start a stopped player: reuse the source if it is alive, else re-resolve. */
  async restart() {
    this._stopped = false;
    if (this._hasSource()) {
      this.state({ stopped: false });
      return this.play();
    }
    return this.retry({ reason: "" });
  }

  /**
   * Seek to an absolute position.
   *
   * This is the hot path for the skip buttons and the arrow keys, so it is
   * deliberately cheap: no plan re-resolution, no overlay, no hls.js restart.
   * Seeking a *signed* HLS stream is not free — asking for a byte range far from
   * the buffered window forces the player to fetch a new fragment — so the seek
   * is coalesced: repeated taps land once, at the final position, instead of
   * queueing a fetch per tap.
   */
  seek(seconds) {
    if (!this.video) return;
    // A seek *is* the fix for a stall: clear the watchdog so it does not fire
    // mid-seek and issue a competing load.
    clearTimeout(this._stalledFor);
    this.recovery = Math.max(0, this.recovery - 1);
    const d = Number(this.video.duration);
    if (Number.isFinite(d) && d > 0) {
      this.video.currentTime = clamp(seconds, 0, d - 0.3);
      return;
    }
    // No duration yet (metadata still loading): remember it and apply on
    // `loadedmetadata` rather than dropping the intent on the floor.
    this._pendingSeek = Math.max(0, seconds);
    if (!this._pendingSeekBound) {
      this._pendingSeekBound = true;
      this.video.addEventListener(
        "loadedmetadata",
        () => {
          if (Number.isFinite(this._pendingSeek)) {
            this.video.currentTime = this._pendingSeek;
            this._pendingSeek = undefined;
          }
        },
        { once: true }
      );
    }
  }

  /**
   * Relative seek with a small cooldown.
   *
   * Without it, holding the arrow key issued dozens of seeks per second and each
   * one started a fragment fetch, which is exactly what made skipping feel like
   * lag. The cooldown is short enough to feel instant and long enough for the
   * next fragment to arrive.
   */
  seekBy(delta) {
    if (!this.video) return false;
    const now = Date.now();
    if (this._lastSeekAt && now - this._lastSeekAt < 120) return false;
    this._lastSeekAt = now;
    this.seek(this.video.currentTime + delta);
    return true;
  }

  /* -------------------------------- quality ------------------------------- */

  _applySavedQuality(levels) {
    const wanted = Number(this.prefs.get().quality);
    if (!wanted || wanted < 0) return;
    const match = (levels || []).find((l) => l.height === wanted);
    if (match) this.setQuality(match.height);
  }

  /** A specific height, or "auto". Honest: it also reports what it did. */
  setQuality(height) {
    const auto = height === "auto" || Number(height) < 0;
    if (this.hls) {
      if (auto) {
        this.hls.currentLevel = -1;
        this.hls.nextLevel = -1;
      } else {
        let best = -1;
        let delta = Infinity;
        (this.hls.levels || []).forEach((l, i) => {
          const d = Math.abs((l.height || 0) - Number(height));
          if (d < delta) {
            delta = d;
            best = i;
          }
        });
        // Cap the level *and* pin it: setting currentLevel alone lets ABR pick
        // a different rendition on the next fragment.
        this.hls.autoLevelEnabled = false;
        this.hls.currentLevel = best;
        this.hls.nextLevel = best;
        this.hls.loadLevel = best;
      }
      this.prefs.set("quality", auto ? -1 : Number(height));
      this.state({ quality: auto ? "auto" : Number(height), autoLevel: auto });
      return;
    }

    if (this.dash && this.dash.getBitrateInfoListFor) {
      const list = this.dash.getBitrateInfoListFor("video") || [];
      if (auto) {
        this.dash.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: true } } } });
        this.prefs.set("quality", -1);
        this.state({ quality: "auto", autoLevel: true });
        return;
      }
      let best = -1;
      let delta = Infinity;
      list.forEach((b, i) => {
        const d = Math.abs((b.height || 0) - Number(height));
        if (d < delta) {
          delta = d;
          best = i;
        }
      });
      this.dash.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: false } } } });
      if (best >= 0) this.dash.setQualityFor("video", best, true);
      this.prefs.set("quality", Number(height));
      this.state({ quality: Number(height), autoLevel: false });
      return;
    }

    // Native playback has one rendition: say so instead of pretending.
    this.state({ quality: "native", note: "This stream has a single rendition" });
  }

  /* -------------------------------- volume -------------------------------- */

  _applyRelativeVolume() {
    const saved = Number(this.prefs.get().volume);
    if (Number.isFinite(saved) && saved >= 0 && saved <= 1) this.video.volume = saved;
    this.video.muted = this.prefs.get().muted === true;
  }

  setVolume(value) {
    if (!this.video) return;
    const v = clamp(Number(value), 0, 1);
    this.video.volume = v;
    this.video.muted = v === 0;
    this.prefs.set("volume", v);
    this.prefs.set("muted", this.video.muted);
    this.state({ volume: v, muted: this.video.muted });
  }

  toggleMute() {
    if (!this.video) return;
    this.video.muted = !this.video.muted;
    if (!this.video.muted && this.video.volume === 0) this.video.volume = 0.6;
    this.prefs.set("muted", this.video.muted);
    this.state({ muted: this.video.muted, volume: this.video.volume });
  }

  setRate(rate) {
    if (!this.video) return;
    this.video.playbackRate = Number(rate) || 1;
    this.prefs.set("speed", this.video.playbackRate);
    this.state({ rate: this.video.playbackRate });
  }

  /* ------------------------------- recovery ------------------------------- */

  /**
   * Tell the site that this stream is dead on *this* device.
   *
   * `sendBeacon` is used when available because the most important report — "the
   * manifest 403'd" — happens while the page is possibly being navigated away
   * from, and a normal fetch gets cancelled. It is fire-and-forget: a player must
   * never wait on telemetry, and a failed report must never block a retry.
   */
  _report(kind, extra = "") {
    try {
      const folder = (this.plan && (this.plan.folder || folderOf(this.plan.url))) || "";
      const q = `/api/repair?folder=${encodeURIComponent(folder)}&kind=${encodeURIComponent(kind)}${
        extra ? `&detail=${encodeURIComponent(String(extra).slice(0, 160))}` : ""
      }`;
      if (navigator && typeof navigator.sendBeacon === "function") {
        navigator.sendBeacon(q);
        return;
      }
      fetch(q, { method: "GET", keepalive: true, credentials: "omit" }).catch(() => {});
    } catch {
      /* telemetry is never load-bearing */
    }
  }

  /**
   * Re-resolve the stream and resume at the current position.
   *
   * This is the single path that fixes every failure mode: an expired
   * signature, a dead signer host, a stopped player with a stale URL, and a
   * media pipeline that hls.js could not recover. The position is carried over
   * so a retry never costs the student their place in a two-hour lecture.
   *
   * It is also where "the link fell" gets *cured* rather than reported: before
   * asking for a new plan the player tells the site this folder is dead on this
   * device, so the poisoned plan is dropped and the new attempt re-probes instead
   * of being handed the same URL again. Attempts are spaced with a widening
   * backoff, and after the first three the player stops asking for a new plan and
   * re-attaches the best one it already has — a stream that 403'd once usually
   * works again, and re-resolving forever turns one bad minute into a loop.
   */
  async retry({ reason = "", position = null } = {}) {
    if (this.destroyed) return;
    const at = Number.isFinite(position) ? position : (this.video ? this.video.currentTime : 0);
    this.attempt += 1;
    this.recovery = 0;
    this._stopped = false;
    this.state({
      buffering: true,
      error: "",
      note: "Reconnecting…",
      attempt: this.attempt,
      paused: false,
    });

    // A dead manifest is reported before the retry, so the retry has a chance of
    // being given a *different* plan.
    this._report("manifest", reason);

    const backoff = this._backoff(this.attempt);
    if (backoff > 0) {
      this.state({ note: "Reconnecting…" });
      await new Promise((r) => setTimeout(r, backoff));
      if (this.destroyed) return;
    }

    let plan = null;
    try {
      plan = await this.resolve(this.attempt);
    } catch (err) {
      // The resolver itself failed. If a previous plan exists it is still the
      // best thing we have, so fall back to it instead of dead-ending the page.
      if (this.plan && this.plan.url && this.attempt <= 4) {
        this.state({ note: "Using the last known stream…" });
        return this.load(this.plan, { autoplay: true });
      }
      this._fail("Stream unavailable", err.message || "The stream service did not respond.");
      return;
    }
    if (!plan || !plan.playable || !plan.url) {
      // Same reasoning: a resolver that reports "no plan" five times in a row is
      // unlikely to be wrong, but a cached good plan is still playable.
      if (this.plan && this.plan.url && this.attempt <= 4) {
        this.state({ note: "Using the last known stream…" });
        return this.load(this.plan, { autoplay: true });
      }
      this._fail(
        "This class has no video yet",
        (plan && plan.reason) || "The source has not published a playable stream for this lecture."
      );
      return;
    }

    try {
      await this.load(plan, { autoplay: true });
      // Resume where the student was. `loadedmetadata` may fire after this for
      // some engines, so the seek is repeated there once metadata exists.
      const resume = () => {
        if (at > 1) {
          try {
            this.video.currentTime = at;
          } catch {
            /* element not ready yet */
          }
        }
        this.video.removeEventListener("loadedmetadata", resume);
      };
      if (this.video.readyState >= 1) resume();
      else this.video.addEventListener("loadedmetadata", resume);
      this.state({ note: reason ? `Reconnected — ${reason}` : "" });
    } catch (err) {
      this._fail("Playback not supported", err.message || "The player could not start.");
    }
  }

  /**
   * Gap before the next resolve attempt: 0 s, 2.4 s, 3.8 s, 6.1 s, then 9 s.
   *
   * A signer that is rate limiting us recovers in seconds, and hammering it is
   * what keeps it limited — so the first retry is instant (the common case is a
   * single expired signature, and making the student wait for it is a bug), and
   * only the later ones back off. Kept as a method so a test can flatten it.
   */
  _backoff(attempt) {
    if (attempt <= 1) return 0;
    return Math.min(9000, Math.round(1500 * Math.pow(1.6, attempt - 1)));
  }

  _fail(title, text) {
    this.state({ buffering: false, error: text, errorTitle: title, playing: false });
    this.onError(title, text);
  }

  /* ------------------------------- teardown ------------------------------- */

  _teardownPlayers() {
    this.native = false;
    if (this.hls) {
      try {
        this.hls.destroy();
      } catch {
        /* ignore */
      }
      this.hls = null;
    }
    if (this.dash) {
      try {
        this.dash.reset();
      } catch {
        /* ignore */
      }
      this.dash = null;
    }
    if (this.video) {
      // Leaving the old source attached is what made a retry resume the *dead*
      // manifest; clear it before the next engine takes over.
      try {
        this.video.removeAttribute("src");
        this.video.load();
      } catch {
        /* ignore */
      }
    }
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this._stalledFor);
    this._teardownPlayers();
  }
}

/** The video folder inside a relay URL, for the repair beacon. */
export function folderOf(url) {
  try {
    const u = new URL(String(url || ""), "http://x");
    return u.searchParams.get("videoKey") || u.searchParams.get("folder") || "";
  } catch {
    return "";
  }
}

/** Turn a MediaError code into a sentence a student can act on. */
export function whyElementFailed(code) {
  switch (code) {
    case 1:
      return "Loading the video was interrupted.";
    case 2:
      return "The network dropped while loading the video.";
    case 3:
      return "The video data is damaged — retry to fetch a fresh copy.";
    case 4:
      return "This video format cannot be decoded by this browser. Try Chrome or Safari, or open the source player.";
    default:
      return "This stream could not be opened.";
  }
}

/**
 * Quick-probe an HLS manifest before handing it to hls.js.
 *
 * A stalling first byte is the most common "spinner forever" cause: the signed
 * URL answers 200 but the body never arrives. Probing here means the player can
 * say "resolving a new link" instead of showing a black frame.
 */
export async function probeManifest(url, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
    if (!res.ok) return { ok: false, status: res.status };
    const text = await res.text();
    return { ok: text.includes("#EXTM3U") || text.includes("<MPD"), status: res.status, bytes: text.length };
  } catch (err) {
    return { ok: false, status: 0, error: err && err.name === "AbortError" ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}
