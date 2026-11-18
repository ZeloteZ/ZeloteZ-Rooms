"use strict";

window.roomsShare = function roomsShare(state) {
  const bridge = window.roomsLocal;
  const get = id => document.getElementById(id);
  const t = (en, de, zh) => state.language === "zh-CN" ? zh : state.language === "de" ? de : en;
  const sourceSelect = get("share-source"), audioSelect = get("share-audio-source");
  const modeSelect = get("share-audio-mode"), cropToggle = get("share-crop");
  const image = get("share-preview-image"), stage = get("share-preview-stage");
  const cropArea = get("share-crop-area"), cropBox = get("share-crop-rect");
  const start = get("share-dialog-start"), error = get("share-dialog-error");
  let sources = [], audioSources = [], kind = "screen", selected = null;
  let loading = false, audioLoading = false, submitting = false, closed = false;
  let previewLocked = false, previewWaiting = false, imageReady = false, actualPreview = false;
  let actualImagePending = false;
  let audioGeneration = 0, pointer = null;
  let region = { x: .1, y: .1, width: .8, height: .8 };
  const clamp = (n, low, high) => Math.min(high, Math.max(low, n));
  const hasThumbnail = () => imageReady && !image.hidden && image.naturalWidth > 0 && image.naturalHeight > 0;
  const hasActualPreview = () => actualPreview && hasThumbnail();
  const canCrop = () => hasActualPreview() && cropToggle.checked && !previewWaiting;

  document.documentElement.lang = state.language;
  document.body.dataset.shareView = "true";
  get("heading").textContent = t("Share your screen", "Bildschirm teilen", "共享屏幕");
  get("description").textContent = t("Choose what to share, then adjust picture and sound.", "Wähle eine Quelle und passe Bild und Ton an.", "选择共享来源，然后调整画面和声音。");
  const labels = {
    "share-source-label": t("Video source", "Bildquelle", "画面来源"),
    "share-screen": t("Screen", "Bildschirm", "屏幕"),
    "share-window": t("Window", "Fenster", "窗口"),
    "share-options-heading": t("Stream settings", "Stream-Einstellungen", "直播设置"),
    "share-quality-label": t("Resolution", "Auflösung", "分辨率"),
    "share-fps-label": t("Frame rate", "Bildrate", "帧率"),
    "share-crop-label": t("Share a selected area", "Ausgewählten Bereich teilen", "共享选定区域"),
    "share-audio-label": t("Audio", "Ton", "音频"),
    "share-audio-source-label": t("Audio source", "Tonquelle", "音频来源"),
    "share-audio-refresh": t("Refresh audio sources", "Tonquellen aktualisieren", "刷新音频来源"),
    "share-dialog-cancel": t("Cancel", "Abbrechen", "取消"),
    "share-privacy-note": t("Your screen is shared only after you select Start sharing.", "Dein Bildschirm wird erst nach „Teilen starten“ übertragen.", "点击“开始共享”后才会传输画面。"),
  };
  for (const [id, label] of Object.entries(labels)) get(id).textContent = label;
  get("share-source-kinds").setAttribute("aria-label", t("Source type", "Quellentyp", "来源类型"));
  cropArea.setAttribute("aria-label", t("Selected sharing area", "Ausgewählter Freigabebereich", "选定的共享区域"));
  const audioLabels = [t("No audio", "Kein Ton", "无音频"), t("Application audio", "Anwendungston", "应用音频"), t("System audio", "Systemton", "系统音频")];
  [...modeSelect.options].forEach((option, i) => {
    option.textContent = audioLabels[i];
    if (option.value !== "none" && !state.audioModes?.includes(option.value)) option.remove();
  });
  get("share-source-kinds").hidden = Boolean(state.portal);

  function showError(message = "") { error.textContent = message; error.hidden = !message; }
  function resetRegion() { region = { x: .1, y: .1, width: .8, height: .8 }; }
  function renderRegion() {
    cropArea.hidden = !canCrop();
    if (!canCrop()) {
      get("share-crop-status").textContent = "";
      return;
    }
    // CSS sizes the overlay to the contained image, excluding any letterboxing.
    cropBox.style.left = `${region.x * 100}%`;
    cropBox.style.top = `${region.y * 100}%`;
    cropBox.style.width = `${region.width * 100}%`;
    cropBox.style.height = `${region.height * 100}%`;
    get("share-crop-status").textContent = t("Area: {width}% × {height}%", "Bereich: {width}% × {height}%", "区域：{width}% × {height}%")
      .replace("{width}", Math.round(region.width * 100)).replace("{height}", Math.round(region.height * 100));
  }
  function render() {
    const sourceMissing = selected === null;
    sourceSelect.disabled = loading || submitting || previewLocked || sourceSelect.options.length === 0;
    get("share-source-refresh").disabled = loading || submitting || previewLocked;
    get("share-source-refresh").textContent = loading ? t("Loading…", "Wird geladen …", "正在加载…")
      : state.portal ? t("Choose source…", "Quelle wählen …", "选择来源…") : t("Refresh", "Aktualisieren", "刷新");
    for (const value of ["screen", "window"]) {
      const button = get(`share-${value}`);
      button.setAttribute("aria-pressed", String(kind === value));
      button.disabled = loading || submitting || previewLocked;
    }
    cropToggle.disabled = sourceMissing || submitting || previewWaiting;
    modeSelect.disabled = submitting || audioLoading;
    get("share-height").disabled = submitting;
    get("share-fps").disabled = submitting;
    get("share-audio-controls").hidden = modeSelect.value === "none";
    audioSelect.disabled = audioLoading || submitting || audioSources.length === 0;
    get("share-audio-refresh").disabled = audioLoading || submitting;
    start.disabled = sourceMissing || loading || audioLoading || submitting || previewWaiting || (modeSelect.value !== "none" && audioSelect.value === "");
    start.textContent = previewWaiting ? t("Loading preview…", "Vorschau wird geladen …", "正在加载预览…")
      : cropToggle.checked && !hasActualPreview() ? t("Load preview", "Vorschau laden", "加载预览")
        : t("Start sharing", "Teilen starten", "开始共享");
    get("share-preview-placeholder").hidden = hasThumbnail();
    get("share-preview-placeholder").textContent = sourceMissing
      ? t("Choose a screen or window to see its preview.", "Wähle einen Bildschirm oder ein Fenster für die Vorschau.", "选择屏幕或窗口以查看预览。")
      : previewWaiting ? t("Preparing the selected source…", "Die ausgewählte Quelle wird vorbereitet …", "正在准备所选来源…")
        : t("No preview available for this source.", "Für diese Quelle ist keine Vorschau verfügbar.", "此来源没有可用预览。");
    get("share-crop-help").textContent = !cropToggle.checked ? t("Enable to share only part of the selected source.", "Aktivieren, um nur einen Teil der Quelle zu teilen.", "启用后仅共享所选来源的一部分。")
      : hasActualPreview() ? t("Drag to select. Arrow keys move; Shift + arrows resize.", "Zum Auswählen ziehen. Pfeiltasten verschieben, Umschalt + Pfeile ändern die Größe.", "拖动以选择区域。方向键移动，Shift + 方向键调整大小。")
        : t("Load a preview to select the area before sharing.", "Lade eine Vorschau, um den Bereich vor der Freigabe auszuwählen.", "加载预览后可在共享前选择区域。");
    renderRegion();
  }
  function updateImage() {
    imageReady = false;
    image.hidden = true;
    image.removeAttribute("src");
    const thumbnail = sources[selected]?.thumbnail;
    if (typeof thumbnail === "string" && /^data:image\/(?:png|jpeg|webp);base64,/.test(thumbnail)) image.src = thumbnail;
    render();
  }
  image.addEventListener("load", () => {
    imageReady = true;
    image.hidden = false;
    stage.style.setProperty("--share-preview-ratio", String(image.naturalWidth / image.naturalHeight));
    if (actualImagePending) { actualPreview = true; actualImagePending = false; previewWaiting = false; }
    render();
  });
  image.addEventListener("error", () => {
    imageReady = false;
    image.hidden = true;
    if (previewWaiting) showError(t("The preview could not be loaded. Cancel and choose the source again.", "Die Vorschau konnte nicht geladen werden. Brich ab und wähle die Quelle erneut.", "无法加载预览，请取消后重新选择来源。"));
    render();
  });
  function renderSources() {
    actualPreview = false;
    actualImagePending = false;
    sourceSelect.replaceChildren();
    sources.forEach((source, index) => {
      if (!state.portal && source.kind !== kind) return;
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = source.name;
      sourceSelect.append(option);
    });
    selected = sourceSelect.options.length ? Number(sourceSelect.options[0].value) : null;
    resetRegion();
    updateImage();
  }
  async function loadSources() {
    if (loading || previewLocked || closed) return;
    loading = true;
    selected = null;
    showError();
    render();
    try {
      const result = await bridge.captureSources();
      if (closed) return;
      sources = result?.status === "ok" && Array.isArray(result.sources) ? result.sources : [];
      get("share-source-status").textContent = sources.length ? (state.portal
        ? t("Source approved by your system.", "Quelle vom System freigegeben.", "来源已获系统授权。") : "")
        : result?.status === "empty" ? t("No capture sources found. Refresh to try again.", "Keine Bildquellen gefunden. Versuche es mit Aktualisieren erneut.", "未找到画面来源，请刷新重试。")
          : t("Source selection is unavailable or was canceled. Try again.", "Die Quellenauswahl ist nicht verfügbar oder wurde abgebrochen. Versuche es erneut.", "来源选择不可用或已取消，请重试。");
      if (!state.portal && !sources.some(source => source.kind === kind) && sources.length) kind = sources[0].kind === "window" ? "window" : "screen";
      renderSources();
    } catch {
      sources = [];
      renderSources();
      get("share-source-status").textContent = t("Sources could not be loaded. Try again.", "Die Quellen konnten nicht geladen werden. Versuche es erneut.", "无法加载来源，请重试。");
    } finally { loading = false; render(); }
  }
  async function loadAudio() {
    const generation = ++audioGeneration, mode = modeSelect.value;
    audioSources = [];
    audioSelect.replaceChildren();
    get("share-audio-status").textContent = "";
    if (mode === "none") { audioLoading = false; render(); return; }
    audioLoading = true;
    get("share-audio-status").textContent = t("Loading audio sources…", "Tonquellen werden geladen …", "正在加载音频来源…");
    render();
    try {
      const result = await bridge.captureAudio(mode);
      if (closed || generation !== audioGeneration) return;
      audioSources = result?.status === "ok" && Array.isArray(result.sources) ? result.sources : [];
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = t("Choose an audio source…", "Tonquelle auswählen …", "选择音频来源…");
      placeholder.disabled = true;
      placeholder.selected = true;
      audioSelect.append(placeholder);
      audioSources.forEach((source, index) => {
        const option = document.createElement("option");
        option.value = String(index);
        option.textContent = source.name;
        audioSelect.append(option);
      });
      get("share-audio-status").textContent = audioSources.length
        ? mode === "system" ? t("Includes all audio played by this device.", "Enthält alle über dieses Gerät abgespielten Töne.", "包含此设备播放的所有声音。")
          : t("Only the selected application output is shared.", "Nur die ausgewählte Anwendungsausgabe wird geteilt.", "仅共享所选应用的音频输出。")
        : result?.status === "empty" ? t("No active audio sources. Play audio and refresh, or choose No audio.", "Keine aktiven Tonquellen. Starte die Wiedergabe und aktualisiere oder wähle „Kein Ton“.", "没有活动音频来源。请播放音频后刷新，或选择“无音频”。")
          : t("Audio sources unavailable. Refresh or choose No audio.", "Tonquellen nicht verfügbar. Aktualisiere oder wähle „Kein Ton“.", "音频来源不可用，请刷新或选择“无音频”。");
    } catch {
      if (generation === audioGeneration) get("share-audio-status").textContent = t("Audio sources could not be loaded.", "Die Tonquellen konnten nicht geladen werden.", "无法加载音频来源。");
    } finally { if (generation === audioGeneration) { audioLoading = false; render(); } }
  }
  function point(event) {
    const bounds = cropArea.getBoundingClientRect();
    return { x: clamp((event.clientX - bounds.left) / bounds.width, 0, 1), y: clamp((event.clientY - bounds.top) / bounds.height, 0, 1) };
  }
  cropArea.addEventListener("pointerdown", event => {
    if (event.button !== 0 || !canCrop() || submitting) return;
    const p = point(event), corner = event.target.dataset.corner;
    pointer = { id: event.pointerId, start: p, region: { ...region }, action: corner || (cropBox.contains(event.target) ? "move" : "select") };
    cropArea.setPointerCapture(event.pointerId);
    cropArea.focus();
    event.preventDefault();
  });
  cropArea.addEventListener("pointermove", event => {
    if (!pointer || pointer.id !== event.pointerId) return;
    const p = point(event), old = pointer.region;
    if (pointer.action === "move") {
      region.x = clamp(old.x + p.x - pointer.start.x, 0, 1 - old.width);
      region.y = clamp(old.y + p.y - pointer.start.y, 0, 1 - old.height);
    } else {
      const corner = pointer.action;
      const anchor = corner === "select" ? pointer.start : { x: corner.includes("w") ? old.x + old.width : old.x, y: corner.includes("n") ? old.y + old.height : old.y };
      region.width = clamp(Math.abs(p.x - anchor.x), .02, 1);
      region.height = clamp(Math.abs(p.y - anchor.y), .02, 1);
      region.x = clamp(Math.min(anchor.x, p.x), 0, 1 - region.width);
      region.y = clamp(Math.min(anchor.y, p.y), 0, 1 - region.height);
    }
    renderRegion();
  });
  function releasePointer(event) { if (pointer?.id === event.pointerId) pointer = null; }
  cropArea.addEventListener("pointerup", releasePointer);
  cropArea.addEventListener("pointercancel", releasePointer);
  cropArea.addEventListener("lostpointercapture", releasePointer);
  cropArea.addEventListener("keydown", event => {
    if (!canCrop() || submitting || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const dx = event.key === "ArrowLeft" ? -.01 : event.key === "ArrowRight" ? .01 : 0;
    const dy = event.key === "ArrowUp" ? -.01 : event.key === "ArrowDown" ? .01 : 0;
    if (event.shiftKey) {
      region.width = clamp(region.width + dx, .02, 1 - region.x);
      region.height = clamp(region.height + dy, .02, 1 - region.y);
    } else {
      region.x = clamp(region.x + dx, 0, 1 - region.width);
      region.y = clamp(region.y + dy, 0, 1 - region.height);
    }
    renderRegion();
  });
  get("share-source-refresh").addEventListener("click", loadSources);
  for (const value of ["screen", "window"]) get(`share-${value}`).addEventListener("click", () => { kind = value; renderSources(); });
  sourceSelect.addEventListener("change", () => { selected = Number(sourceSelect.value); actualPreview = false; actualImagePending = false; resetRegion(); showError(); updateImage(); });
  cropToggle.addEventListener("change", render);
  modeSelect.addEventListener("change", loadAudio);
  get("share-audio-refresh").addEventListener("click", loadAudio);
  audioSelect.addEventListener("change", render);
  function cancel() { if (!closed) { closed = true; void bridge.cancel(); } }
  get("share-dialog-cancel").addEventListener("click", cancel);
  document.addEventListener("keydown", event => { if (event.key === "Escape") cancel(); });
  bridge.onCapturePreview?.(payload => {
    if (closed || !previewLocked || selected === null || typeof payload?.thumbnail !== "string") return;
    sources[selected] = { ...sources[selected], thumbnail: payload.thumbnail };
    actualImagePending = true;
    updateImage();
  });
  start.addEventListener("click", async () => {
    if (start.disabled || selected === null) return;
    const needsPreview = cropToggle.checked && !hasActualPreview();
    submitting = true;
    showError();
    if (needsPreview) { previewLocked = true; previewWaiting = true; }
    render();
    try {
      const result = await bridge.submit({ source: selected, height: Number(get("share-height").value), fps: Number(get("share-fps").value),
        region: cropToggle.checked ? hasActualPreview() ? { ...region } : true : null,
        audioMode: modeSelect.value, audioSource: modeSelect.value === "none" ? null : Number(audioSelect.value) });
      if (result === true) { closed = true; return; }
      if (result === "preview") return;
      if (needsPreview) { previewLocked = false; previewWaiting = false; }
      showError(t("The selected sources could not be started. Check your selection and try again.", "Die ausgewählten Quellen konnten nicht gestartet werden. Prüfe deine Auswahl und versuche es erneut.", "无法启动所选来源，请检查选择后重试。"));
    } catch {
      if (needsPreview) { previewLocked = false; previewWaiting = false; }
      showError(t("Sharing could not be started. Try again or cancel.", "Die Freigabe konnte nicht gestartet werden. Versuche es erneut oder brich ab.", "无法开始共享，请重试或取消。"));
    } finally { submitting = false; render(); }
  });
  get("share-dialog").hidden = false;
  if (state.portal) {
    get("share-source-status").textContent = t("Your system will ask which screen or window to allow.", "Dein System fragt, welchen Bildschirm oder welches Fenster du freigeben möchtest.", "系统将询问你允许共享的屏幕或窗口。");
    render();
    get("share-source-refresh").focus();
  } else { void loadSources(); }
};
