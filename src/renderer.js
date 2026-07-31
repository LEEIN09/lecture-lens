"use strict";

const api = window.lectureLens;
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const SETTINGS_KEY = "lecture-lens.settings.v1";
const LAYOUT_CHANGE_THRESHOLD = 8;

const state = {
  sourceId: null,
  sourceName: "",
  workspacePath: "",
  targetPath: "lecture/main.py",
  fileContent: "",
  roi: null,
  frameDataUrl: null,
  naturalSize: null,
  selecting: false,
  selectionStart: null,
  ocrBusy: false,
  autoTimer: null,
  lastFingerprint: null,
  pendingFingerprint: null,
  pendingStableCount: 0,
  badFrameCount: 0,
  layoutBlocked: false,
  savedSourceName: "",
  savedRoi: null,
  confidence: 0,
  rawOcr: "",
  gutterRatio: 0,
  savedGutterRatio: 0,
  gutterDragging: false
};

const previewStage = $("#previewStage");
const previewCanvas = $("#previewCanvas");
const previewContext = previewCanvas.getContext("2d", { willReadFrequently: true });
const selectionBox = $("#selectionBox");
const gutterMask = $("#gutterMask");
const gutterLine = $("#gutterLine");
const codeEditor = window.LectureCodeEditor.create($("#codeEditor"), {
  filename: state.targetPath,
  onChange: () => updateDiff()
});

function setStatus(text, kind = "") {
  $("#globalStatus").textContent = text;
  $("#statusDot").className = `status-dot ${kind}`.trim();
}

let toastTimer;
function toast(message, error = false) {
  const element = $("#toast");
  element.textContent = message;
  element.className = `toast${error ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.add("hidden"), 4200);
}

function friendlyError(error) {
  return error?.message || String(error) || "알 수 없는 오류가 발생했습니다.";
}

function setSafetyStatus(text, kind = "") {
  const element = $("#safetyStatus");
  element.textContent = text;
  element.className = `safety-status ${kind}`.trim();
}

function persistSettings() {
  const settings = {
    sourceName: state.sourceName || state.savedSourceName,
    roi: state.roi || state.savedRoi,
    gutterRatio: state.gutterRatio,
    workspacePath: state.workspacePath,
    targetPath: $("#targetPath").value.trim(),
    captureInterval: $("#captureInterval").value,
    safeAutoApply: $("#safeAutoApply").checked,
    minimumConfidence: $("#minimumConfidence").value
  };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function restoreSettings() {
  try {
    const settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    state.savedSourceName = String(settings.sourceName || "");
    state.savedRoi = settings.roi || null;
    state.savedGutterRatio = Math.max(0, Math.min(0.35, Number(settings.gutterRatio) || 0));
    state.gutterRatio = state.savedGutterRatio;
    state.workspacePath = String(settings.workspacePath || "");
    state.targetPath = String(settings.targetPath || "lecture/main.py");
    $("#workspacePath").value = state.workspacePath;
    $("#targetPath").value = state.targetPath;
    if (["3000", "5000", "8000"].includes(String(settings.captureInterval))) {
      $("#captureInterval").value = String(settings.captureInterval);
    }
    if (["85", "90", "95"].includes(String(settings.minimumConfidence))) {
      $("#minimumConfidence").value = String(settings.minimumConfidence);
    }
    $("#safeAutoApply").checked = Boolean(settings.safeAutoApply);
    updateApplyTarget();
  } catch {
    localStorage.removeItem(SETTINGS_KEY);
  }
}

async function loadSources() {
  const list = $("#sourceList");
  list.innerHTML = '<p class="diff-empty">창 목록을 불러오는 중...</p>';
  try {
    const sources = await api.listSources();
    list.innerHTML = "";
    const sourcePriority = (item) => {
      if (/zoom/i.test(item.name)) return 0;
      if (/youtube|chrome|edge|brave/i.test(item.name)) return 1;
      return 2;
    };
    const displaySources = [...sources].sort((left, right) =>
      sourcePriority(left) - sourcePriority(right) || left.name.localeCompare(right.name));
    if (!displaySources.length) {
      list.innerHTML = '<p class="diff-empty">캡처 가능한 창이 없습니다.</p>';
      return;
    }
    for (const source of displaySources) {
      const button = document.createElement("button");
      button.className = "source-card";
      const image = document.createElement("img");
      image.src = source.thumbnail;
      image.alt = "";
      const title = document.createElement("span");
      title.textContent = source.name;
      button.append(image, title);
      button.addEventListener("click", () => selectSource(source));
      list.append(button);
    }
  } catch (error) {
    list.innerHTML = "";
    toast(`창 목록 오류: ${friendlyError(error)}`, true);
  }
}

async function selectSource(source) {
  state.sourceId = source.id;
  state.sourceName = source.name;
  state.roi = source.name === state.savedSourceName ? state.savedRoi : null;
  state.gutterRatio = source.name === state.savedSourceName ? state.savedGutterRatio : 0;
  state.lastFingerprint = null;
  state.pendingFingerprint = null;
  state.layoutBlocked = false;
  state.badFrameCount = 0;
  $("#sourceName").textContent = source.name;
  $("#sourceModal").classList.add("hidden");
  setStatus("강의 창 연결됨", "active");
  await refreshFrame();
  if (!state.roi) await autoDetectCodeRegion({ quiet: true });
  persistSettings();
  updateControls();
}

async function refreshFrame() {
  if (!state.sourceId) return;
  try {
    setStatus("화면 캡처 중", "busy");
    const result = await api.captureFrame(state.sourceId);
    state.frameDataUrl = result.image;
    state.naturalSize = result.size;
    await drawPreview(result.image);
    setStatus(state.roi ? "캡처 준비 완료" : "코드 영역을 지정하세요", state.roi ? "active" : "busy");
  } catch (error) {
    setStatus("창 캡처 실패", "error");
    stopAutoCapture();
    toast(friendlyError(error), true);
  }
}

function drawPreview(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const bounds = previewStage.getBoundingClientRect();
      const width = Math.max(1, Math.floor(bounds.width));
      const height = Math.max(1, Math.floor(bounds.height));
      const ratio = Math.min(width / image.naturalWidth, height / image.naturalHeight);
      const drawWidth = Math.floor(image.naturalWidth * ratio);
      const drawHeight = Math.floor(image.naturalHeight * ratio);
      previewCanvas.width = width;
      previewCanvas.height = height;
      previewContext.clearRect(0, 0, width, height);
      previewContext.drawImage(
        image,
        Math.floor((width - drawWidth) / 2),
        Math.floor((height - drawHeight) / 2),
        drawWidth,
        drawHeight
      );
      previewStage.classList.remove("empty");
      renderSelectionBox();
      resolve();
    };
    image.onerror = reject;
    image.src = dataUrl;
  });
}

function longestRun(values, predicate) {
  let best = null;
  let start = null;
  for (let index = 0; index <= values.length; index += 1) {
    if (index < values.length && predicate(values[index], index)) {
      if (start === null) start = index;
      continue;
    }
    if (start !== null) {
      const run = { start, end: index, length: index - start };
      if (!best || run.length > best.length) best = run;
      start = null;
    }
  }
  return best;
}

function luminanceAt(data, width, x, y) {
  const offset = (y * width + x) * 4;
  return 0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2];
}

async function detectVsCodeRegion(dataUrl) {
  const image = await new Promise((resolve, reject) => {
    const item = new Image();
    item.onload = () => resolve(item);
    item.onerror = reject;
    item.src = dataUrl;
  });
  const width = Math.min(320, image.naturalWidth);
  const height = Math.max(1, Math.round(image.naturalHeight * width / image.naturalWidth));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;

  const columnDarkRatio = Array.from({ length: width }, (_, x) => {
    let dark = 0;
    for (let y = 0; y < height; y += 2) {
      if (luminanceAt(pixels, width, x, y) < 105) dark += 1;
    }
    return dark / Math.ceil(height / 2);
  });
  const appColumns = longestRun(columnDarkRatio, (ratio) => ratio >= 0.58);
  if (!appColumns || appColumns.length < width * 0.36) return null;

  const rowDarkRatio = Array.from({ length: height }, (_, y) => {
    let dark = 0;
    let samples = 0;
    for (let x = appColumns.start; x < appColumns.end; x += 2) {
      if (luminanceAt(pixels, width, x, y) < 105) dark += 1;
      samples += 1;
    }
    return samples ? dark / samples : 0;
  });
  const appRows = longestRun(rowDarkRatio, (ratio) => ratio >= 0.68);
  if (!appRows || appRows.length < height * 0.42) return null;

  const appWidth = appColumns.length;
  const appHeight = appRows.length;
  // Terminal dividers normally live near the bottom of the VS Code window.
  // Starting too high can mistake a long source line or the active-line
  // highlight for a panel divider and crop valid code below it.
  const searchStart = Math.round(appRows.start + appHeight * 0.7);
  const searchEnd = Math.round(appRows.start + appHeight * 0.91);
  let panelBoundary = null;
  let bestEdge = 0;
  for (let y = Math.max(1, searchStart); y < Math.min(height, searchEnd); y += 1) {
    let changed = 0;
    let samples = 0;
    for (let x = appColumns.start; x < appColumns.end; x += 2) {
      const difference = Math.abs(
        luminanceAt(pixels, width, x, y) -
        luminanceAt(pixels, width, x, y - 1)
      );
      if (difference >= 14) changed += 1;
      samples += 1;
    }
    const edge = samples ? changed / samples : 0;
    if (edge > bestEdge) {
      bestEdge = edge;
      panelBoundary = y;
    }
  }

  const editorTop = appRows.start + appHeight * 0.125;
  const boundaryRatio = panelBoundary === null
    ? 1
    : (panelBoundary - appRows.start) / appHeight;
  const hasTerminalBoundary =
    bestEdge >= 0.28 &&
    boundaryRatio >= 0.7 &&
    boundaryRatio <= 0.91;
  const editorBottom = hasTerminalBoundary
    ? panelBoundary - appHeight * 0.025
    : appRows.start + appHeight * 0.94;
  const editorLeft = appColumns.start + appWidth * 0.065;
  const editorRight = appColumns.end - appWidth * 0.012;
  if (editorBottom - editorTop < height * 0.2) return null;

  return {
    roi: {
      x: editorLeft / width,
      y: editorTop / height,
      width: (editorRight - editorLeft) / width,
      height: (editorBottom - editorTop) / height
    },
    gutterRatio: 0.065,
    confidence: Math.min(99, Math.round(
      65 + Math.min(20, appColumns.length / width * 20) + Math.min(14, bestEdge * 40)
    ))
  };
}

async function autoDetectCodeRegion({ quiet = false } = {}) {
  if (!state.frameDataUrl) {
    if (!quiet) toast("먼저 강의 창을 연결해 주세요.", true);
    return false;
  }
  setStatus("VS Code 영역 찾는 중", "busy");
  try {
    const detected = await detectVsCodeRegion(state.frameDataUrl);
    if (!detected) {
      setStatus(state.roi ? "캡처 준비 완료" : "코드 영역을 지정하세요", state.roi ? "active" : "busy");
      if (!quiet) toast("VS Code 편집기 영역을 찾지 못했습니다. 직접 드래그해 주세요.", true);
      return false;
    }
    state.roi = detected.roi;
    state.gutterRatio = detected.gutterRatio;
    state.savedRoi = state.roi;
    state.savedSourceName = state.sourceName;
    state.savedGutterRatio = state.gutterRatio;
    state.lastFingerprint = null;
    state.pendingFingerprint = null;
    state.layoutBlocked = false;
    state.badFrameCount = 0;
    persistSettings();
    renderSelectionBox();
    updateControls();
    setStatus("코드 영역 자동 감지 완료", "active");
    toast(`VS Code 편집기 영역을 자동으로 찾았습니다. 감지 신뢰도 ${detected.confidence}%`);
    return true;
  } catch (error) {
    setStatus(state.roi ? "캡처 준비 완료" : "코드 영역을 지정하세요", state.roi ? "active" : "busy");
    if (!quiet) toast(`자동 영역 감지 오류: ${friendlyError(error)}`, true);
    return false;
  }
}

function canvasImageBounds() {
  if (!state.naturalSize) return null;
  const width = previewCanvas.width;
  const height = previewCanvas.height;
  const ratio = Math.min(width / state.naturalSize.width, height / state.naturalSize.height);
  const drawWidth = state.naturalSize.width * ratio;
  const drawHeight = state.naturalSize.height * ratio;
  return {
    x: (width - drawWidth) / 2,
    y: (height - drawHeight) / 2,
    width: drawWidth,
    height: drawHeight
  };
}

function pointInCanvas(event) {
  const rect = previewCanvas.getBoundingClientRect();
  const scaleX = previewCanvas.width / rect.width;
  const scaleY = previewCanvas.height / rect.height;
  return {
    x: (event.clientX - rect.left) * scaleX,
    y: (event.clientY - rect.top) * scaleY
  };
}

function clampPoint(point, bounds) {
  return {
    x: Math.max(bounds.x, Math.min(bounds.x + bounds.width, point.x)),
    y: Math.max(bounds.y, Math.min(bounds.y + bounds.height, point.y))
  };
}

function beginSelection(event) {
  const bounds = canvasImageBounds();
  if (!bounds || !state.frameDataUrl) return;
  state.selecting = true;
  state.selectionStart = clampPoint(pointInCanvas(event), bounds);
  state.roi = null;
  state.gutterRatio = 0;
  previewCanvas.setPointerCapture(event.pointerId);
  updateSelectionFromPointer(event);
}

function updateSelectionFromPointer(event) {
  if (!state.selecting) return;
  const bounds = canvasImageBounds();
  const current = clampPoint(pointInCanvas(event), bounds);
  const x1 = Math.min(state.selectionStart.x, current.x);
  const y1 = Math.min(state.selectionStart.y, current.y);
  const x2 = Math.max(state.selectionStart.x, current.x);
  const y2 = Math.max(state.selectionStart.y, current.y);
  state.roi = {
    x: (x1 - bounds.x) / bounds.width,
    y: (y1 - bounds.y) / bounds.height,
    width: (x2 - x1) / bounds.width,
    height: (y2 - y1) / bounds.height
  };
  renderSelectionBox();
}

function endSelection(event) {
  if (!state.selecting) return;
  updateSelectionFromPointer(event);
  state.selecting = false;
  if (!state.roi || state.roi.width < .04 || state.roi.height < .04) {
    state.roi = null;
    toast("코드 영역을 조금 더 크게 지정해 주세요.", true);
  } else {
    state.lastFingerprint = null;
    state.pendingFingerprint = null;
    state.layoutBlocked = false;
    state.badFrameCount = 0;
    state.savedRoi = state.roi;
    state.savedSourceName = state.sourceName;
    state.savedGutterRatio = state.gutterRatio;
    persistSettings();
    toast("코드 영역이 지정됐습니다.");
    setStatus("캡처 준비 완료", "active");
  }
  renderSelectionBox();
  updateControls();
}

function beginGutterDrag(event) {
  if (!state.roi) return;
  event.preventDefault();
  event.stopPropagation();
  state.gutterDragging = true;
  gutterLine.setPointerCapture(event.pointerId);
  updateGutterFromPointer(event);
}

function updateGutterFromPointer(event) {
  if (!state.gutterDragging || !state.roi) return;
  const bounds = canvasImageBounds();
  if (!bounds) return;
  const point = pointInCanvas(event);
  const normalizedX = (point.x - bounds.x) / bounds.width;
  state.gutterRatio = Math.max(
    0,
    Math.min(0.35, (normalizedX - state.roi.x) / state.roi.width)
  );
  renderSelectionBox();
}

function endGutterDrag(event) {
  if (!state.gutterDragging) return;
  updateGutterFromPointer(event);
  state.gutterDragging = false;
  state.savedGutterRatio = state.gutterRatio;
  state.lastFingerprint = null;
  state.pendingFingerprint = null;
  persistSettings();
  toast(state.gutterRatio > 0.005
    ? `왼쪽 ${Math.round(state.gutterRatio * 100)}%를 OCR에서 제외합니다.`
    : "줄 번호 제외를 사용하지 않습니다.");
}

function renderSelectionBox() {
  const bounds = canvasImageBounds();
  if (!state.roi || !bounds) {
    selectionBox.classList.add("hidden");
    gutterMask.classList.add("hidden");
    gutterLine.classList.add("hidden");
    return;
  }
  const rect = previewCanvas.getBoundingClientRect();
  const scaleX = rect.width / previewCanvas.width;
  const scaleY = rect.height / previewCanvas.height;
  const left = (bounds.x + state.roi.x * bounds.width) * scaleX;
  const top = (bounds.y + state.roi.y * bounds.height) * scaleY;
  const width = state.roi.width * bounds.width * scaleX;
  const height = state.roi.height * bounds.height * scaleY;
  const excludedWidth = width * state.gutterRatio;
  selectionBox.style.left = `${left}px`;
  selectionBox.style.top = `${top}px`;
  selectionBox.style.width = `${width}px`;
  selectionBox.style.height = `${height}px`;
  gutterLine.style.left = `${left + excludedWidth}px`;
  gutterLine.style.top = `${top}px`;
  gutterLine.style.height = `${height}px`;
  gutterMask.style.left = `${left}px`;
  gutterMask.style.top = `${top}px`;
  gutterMask.style.width = `${excludedWidth}px`;
  gutterMask.style.height = `${height}px`;
  selectionBox.classList.remove("hidden");
  gutterLine.classList.remove("hidden");
  gutterMask.classList.toggle("hidden", excludedWidth < 2);
}

async function cropFrame(dataUrl) {
  if (!state.roi) throw new Error("먼저 코드 영역을 지정해 주세요.");
  const image = await new Promise((resolve, reject) => {
    const item = new Image();
    item.onload = () => resolve(item);
    item.onerror = reject;
    item.src = dataUrl;
  });
  const region = await api.calculateCropRegion({
    imageWidth: image.naturalWidth,
    imageHeight: image.naturalHeight,
    roi: state.roi,
    gutterRatio: state.gutterRatio
  });
  const sourceX = region.x;
  const sourceY = region.y;
  const sourceWidth = region.width;
  const sourceHeight = region.height;
  const upscale = sourceHeight < 800 ? Math.min(2, 800 / sourceHeight) : 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(sourceWidth * upscale);
  canvas.height = Math.round(sourceHeight * upscale);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(
    image,
    sourceX, sourceY, sourceWidth, sourceHeight,
    0, 0, canvas.width, canvas.height
  );
  return { dataUrl: canvas.toDataURL("image/png"), canvas };
}

function fingerprint(canvas) {
  const sample = document.createElement("canvas");
  sample.width = 32;
  sample.height = 18;
  const context = sample.getContext("2d", { willReadFrequently: true });
  context.drawImage(canvas, 0, 0, sample.width, sample.height);
  const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
  const values = [];
  for (let i = 0; i < pixels.length; i += 16) {
    values.push(Math.round((pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3 / 8));
  }
  return values;
}

function fingerprintDifference(left, right) {
  if (!left || !right || left.length !== right.length) return 100;
  let total = 0;
  for (let i = 0; i < left.length; i += 1) total += Math.abs(left[i] - right[i]);
  return total / left.length;
}

function frameStats(canvas) {
  const sample = document.createElement("canvas");
  sample.width = 64;
  sample.height = 36;
  const context = sample.getContext("2d", { willReadFrequently: true });
  context.drawImage(canvas, 0, 0, sample.width, sample.height);
  const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
  const luminance = [];
  let white = 0;
  let black = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    const value = 0.2126 * pixels[index] + 0.7152 * pixels[index + 1] + 0.0722 * pixels[index + 2];
    luminance.push(value);
    if (value >= 245) white += 1;
    if (value <= 10) black += 1;
  }
  const mean = luminance.reduce((sum, value) => sum + value, 0) / luminance.length;
  const variance = luminance.reduce((sum, value) => sum + (value - mean) ** 2, 0) / luminance.length;
  return {
    mean,
    stddev: Math.sqrt(variance),
    whiteRatio: white / luminance.length,
    blackRatio: black / luminance.length
  };
}

async function captureAndRecognize({ automatic = false } = {}) {
  if (state.ocrBusy || !state.sourceId || !state.roi) return;
  state.ocrBusy = true;
  updateControls();
  $("#ocrProgress").classList.remove("hidden");
  setStatus("코드 인식 중", "busy");
  try {
    const frame = await api.captureFrame(state.sourceId);
    state.frameDataUrl = frame.image;
    state.naturalSize = frame.size;
    await drawPreview(frame.image);
    const cropped = await cropFrame(frame.image);
    const currentFingerprint = fingerprint(cropped.canvas);
    const frameSafety = await api.evaluateFrameSafety(frameStats(cropped.canvas));

    if (!frameSafety.safe) {
      state.badFrameCount += 1;
      setSafetyStatus(frameSafety.reason, "blocked");
      setStatus("비정상 캡처 감지", "error");
      if (automatic && state.badFrameCount >= 2) {
        stopAutoCapture();
        toast(`${frameSafety.reason} 자동 감시를 중지했습니다. Chrome 창 상태를 확인해 주세요.`, true);
      } else if (!automatic) {
        toast(frameSafety.reason, true);
      }
      return;
    }
    state.badFrameCount = 0;

    if (automatic) {
      if (state.lastFingerprint &&
          fingerprintDifference(state.lastFingerprint, currentFingerprint) < 1.2) {
        state.pendingFingerprint = null;
        state.pendingStableCount = 0;
        setStatus("변경 없음 · 감시 중", "active");
        return;
      }
      if (state.lastFingerprint &&
          fingerprintDifference(state.lastFingerprint, currentFingerprint) > LAYOUT_CHANGE_THRESHOLD) {
        state.layoutBlocked = true;
        stopAutoCapture();
        setSafetyStatus("화면 배치 또는 확대·축소 변화 — 영역을 다시 확인하세요.", "blocked");
        setStatus("영역 재확인 필요", "error");
        toast("코드 영역이 크게 변해 자동 감시를 중지했습니다. 영역을 다시 지정해 주세요.", true);
        return;
      }
      if (!state.pendingFingerprint ||
          fingerprintDifference(state.pendingFingerprint, currentFingerprint) >= 1.2) {
        state.pendingFingerprint = currentFingerprint;
        state.pendingStableCount = 1;
        setStatus("화면 안정화 대기 중", "busy");
        return;
      }
      state.pendingStableCount += 1;
      if (state.pendingStableCount < 2) return;
    }

    const result = await api.recognize(cropped.dataUrl);
    if (!result.text.trim()) throw new Error("코드를 인식하지 못했습니다. 코드 영역과 영상 화질을 확인해 주세요.");
    state.rawOcr = result.text;
    $("#rawOcrView").textContent = result.text;
    const mergeBase = codeEditor.value.trim() ? codeEditor.value : state.fileContent;
    const merged = await api.mergeIncrementalCode({
      existing: mergeBase,
      recognized: result.text
    });
    codeEditor.value = merged.text;
    if (merged.mode === "incremental") {
      $("#mergeStatus").textContent =
        `기존 ${merged.preserved}줄 보존 · OCR 변경 후보 ${merged.inserted}줄`;
    } else {
      $("#mergeStatus").textContent = "일치하는 기존 구간이 적어 OCR 원문을 초안으로 열었습니다.";
    }
    state.confidence = result.confidence;
    state.lastFingerprint = currentFingerprint;
    state.pendingFingerprint = null;
    state.pendingStableCount = 0;
    updateConfidence(result.confidence, result.engine);
    updateDiff();
    updateControls();
    const extensionMatch = state.targetPath.match(/(\.[^.\\/]+)$/);
    const codeSafety = await api.evaluateCodeSafety({
      text: codeEditor.value,
      confidence: result.confidence,
      minimumConfidence: Number($("#minimumConfidence").value),
      extension: extensionMatch?.[1] || ""
    });
    if (codeSafety.safe) {
      setSafetyStatus("자동 반영 안전 조건 통과", "safe");
    } else {
      setSafetyStatus(codeSafety.reason, "warn");
    }

    if (automatic && $("#safeAutoApply").checked && codeSafety.safe) {
      const applied = await applyCode({ automatic: true });
      setStatus(applied ? "안전 자동 반영 완료" : "자동 반영 보류", applied ? "active" : "error");
    } else {
      setStatus(automatic ? "자동 감시 중" : "코드 인식 완료", "active");
      toast(`코드 인식 완료 · ${result.engine || "OCR"} 신뢰도 ${result.confidence}%`);
    }
  } catch (error) {
    setStatus("코드 인식 실패", "error");
    toast(friendlyError(error), true);
  } finally {
    state.ocrBusy = false;
    $("#ocrProgress").classList.add("hidden");
    updateControls();
  }
}

function updateConfidence(value, engine = "OCR") {
  const badge = $("#confidenceBadge");
  badge.textContent = `${engine} ${value}%`;
  badge.className = `confidence ${value >= 80 ? "good" : value >= 60 ? "warn" : "bad"}`;
}

function computeDiff(before, after) {
  const left = before.split("\n");
  const right = after.split("\n");
  const table = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i][j] = left[i] === right[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const output = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      output.push({ type: "same", text: left[i++] }); j += 1;
    } else if (j < right.length && (i === left.length || table[i][j + 1] >= table[i + 1][j])) {
      output.push({ type: "add", text: right[j++] });
    } else {
      output.push({ type: "remove", text: left[i++] });
    }
  }
  return output;
}

function updateDiff() {
  const diff = computeDiff(state.fileContent, codeEditor.value);
  const changed = diff.filter((line) => line.type !== "same");
  $("#diffCount").textContent = String(changed.length);
  const view = $("#diffView");
  view.innerHTML = "";
  if (!changed.length) {
    const empty = document.createElement("span");
    empty.className = "diff-empty";
    empty.textContent = "변경 내용이 없습니다.";
    view.append(empty);
  } else {
    for (const line of diff) {
      const element = document.createElement("span");
      element.className = `diff-line ${line.type}`;
      const marker = line.type === "add" ? "+ " : line.type === "remove" ? "− " : "  ";
      element.textContent = marker + line.text;
      view.append(element);
    }
  }
  updateControls();
}

async function chooseWorkspace() {
  const selected = await api.chooseWorkspace();
  if (!selected) return;
  state.workspacePath = selected;
  $("#workspacePath").value = selected;
  persistSettings();
  updateApplyTarget();
  await loadTarget();
}

async function loadTarget() {
  state.targetPath = $("#targetPath").value.trim();
  if (!state.workspacePath || !state.targetPath) {
    updateControls();
    return;
  }
  try {
    const result = await api.readTarget(state.workspacePath, state.targetPath);
    state.fileContent = result.content;
    codeEditor.setLanguage(state.targetPath);
    codeEditor.value = result.content;
    state.rawOcr = "";
    $("#rawOcrView").innerHTML =
      '<span class="diff-empty">아직 인식된 OCR 원문이 없습니다.</span>';
    $("#mergeStatus").textContent = result.exists
      ? "대상 파일 기준 준비 완료 · 다음 OCR에서 기존 줄을 보존합니다."
      : "새 파일 · 첫 OCR 결과를 검수 초안으로 사용합니다.";
    persistSettings();
    updateDiff();
    toast(result.exists ? "대상 파일을 불러왔습니다." : "새 파일로 적용할 준비가 됐습니다.");
  } catch (error) {
    toast(friendlyError(error), true);
  }
  updateApplyTarget();
}

function updateApplyTarget() {
  state.targetPath = $("#targetPath").value.trim();
  codeEditor.setLanguage(state.targetPath);
  $("#applyTarget").textContent = state.workspacePath
    ? `${state.targetPath || "파일을 입력하세요"}`
    : "작업 폴더를 선택하세요";
  persistSettings();
  updateControls();
}

async function applyCode({ automatic = false } = {}) {
  if (!codeEditor.value.trim()) return false;
  try {
    setStatus("파일 적용 중", "busy");
    const result = await api.writeTarget({
      workspacePath: state.workspacePath,
      relativePath: state.targetPath,
      content: codeEditor.value,
      expectedContent: state.fileContent
    });
    state.fileContent = codeEditor.value;
    updateDiff();
    setStatus("Antigravity 적용 완료", "active");
    toast(automatic
      ? `안전 조건을 통과해 ${state.targetPath}에 자동 반영했습니다.`
      : `${result.target}에 저장했습니다.${result.backupCreated ? " 이전 파일은 기록 폴더에 백업했습니다." : ""}`);
    return true;
  } catch (error) {
    setStatus("파일 적용 실패", "error");
    toast(friendlyError(error), true);
    return false;
  }
}

function updateControls() {
  const readyToCapture = Boolean(state.sourceId && state.roi && !state.ocrBusy);
  $("#captureButton").disabled = !readyToCapture;
  $("#autoCapture").disabled = !(state.sourceId && state.roi);
  $("#safeAutoApply").disabled = !(
    state.sourceId &&
    state.roi &&
    state.workspacePath &&
    state.targetPath
  );
  $("#refreshFrameButton").disabled = !state.sourceId;
  $("#detectRegionButton").disabled = !state.sourceId || !state.frameDataUrl;
  $("#resetRegionButton").disabled = !state.roi;
  $("#applyButton").disabled = !(
    state.workspacePath &&
    state.targetPath &&
    codeEditor.value.trim() &&
    codeEditor.value !== state.fileContent
  );
}

function startAutoCapture() {
  clearInterval(state.autoTimer);
  if (!$("#autoCapture").checked) return;
  state.layoutBlocked = false;
  state.badFrameCount = 0;
  persistSettings();
  setStatus("자동 감시 중", "active");
  state.autoTimer = setInterval(
    () => captureAndRecognize({ automatic: true }),
    Number($("#captureInterval").value)
  );
}

function stopAutoCapture() {
  clearInterval(state.autoTimer);
  state.autoTimer = null;
  $("#autoCapture").checked = false;
  persistSettings();
}

$("#sourceButton").addEventListener("click", () => {
  $("#sourceModal").classList.remove("hidden");
  loadSources();
});
$("#closeModal").addEventListener("click", () => $("#sourceModal").classList.add("hidden"));
$("#sourceModal").addEventListener("click", (event) => {
  if (event.target === $("#sourceModal")) $("#sourceModal").classList.add("hidden");
});
$("#reloadSources").addEventListener("click", loadSources);
$("#workspaceButton").addEventListener("click", chooseWorkspace);
$("#loadFileButton").addEventListener("click", loadTarget);
$("#targetPath").addEventListener("input", updateApplyTarget);
$("#refreshFrameButton").addEventListener("click", refreshFrame);
$("#detectRegionButton").addEventListener("click", () => autoDetectCodeRegion());
$("#resetRegionButton").addEventListener("click", () => {
  state.roi = null;
  state.savedRoi = null;
  state.gutterRatio = 0;
  state.savedGutterRatio = 0;
  state.lastFingerprint = null;
  state.pendingFingerprint = null;
  state.layoutBlocked = false;
  stopAutoCapture();
  renderSelectionBox();
  persistSettings();
  updateControls();
  setStatus("코드 영역을 지정하세요", "busy");
});
$("#captureButton").addEventListener("click", () => captureAndRecognize());
$("#applyButton").addEventListener("click", () => applyCode());
$("#autoCapture").addEventListener("change", startAutoCapture);
$("#captureInterval").addEventListener("change", () => {
  persistSettings();
  startAutoCapture();
});
$("#safeAutoApply").addEventListener("change", () => {
  persistSettings();
  setSafetyStatus(
    $("#safeAutoApply").checked ? "안전 조건 통과 시 자동 저장" : "검토 후 수동 적용",
    $("#safeAutoApply").checked ? "safe" : ""
  );
});
$("#minimumConfidence").addEventListener("change", persistSettings);
previewCanvas.addEventListener("pointerdown", beginSelection);
previewCanvas.addEventListener("pointermove", updateSelectionFromPointer);
previewCanvas.addEventListener("pointerup", endSelection);
previewCanvas.addEventListener("pointercancel", () => { state.selecting = false; });
gutterLine.addEventListener("pointerdown", beginGutterDrag);
gutterLine.addEventListener("pointermove", updateGutterFromPointer);
gutterLine.addEventListener("pointerup", endGutterDrag);
gutterLine.addEventListener("pointercancel", () => { state.gutterDragging = false; });
window.addEventListener("resize", () => state.frameDataUrl && drawPreview(state.frameDataUrl));
window.addEventListener("keydown", (event) => {
  if (event.altKey && event.key.toLowerCase() === "r") {
    event.preventDefault();
    $("#resetRegionButton").click();
  }
});

$$(".tab").forEach((tab) => tab.addEventListener("click", () => {
  $$(".tab").forEach((item) => item.classList.toggle("active", item === tab));
  $$(".tab-pane").forEach((pane) =>
    pane.classList.toggle("active", pane.id === `${tab.dataset.tab}Pane`));
  if (tab.dataset.tab === "code") codeEditor.focus();
}));

api.onOcrProgress(({ status, progress }) => {
  $("#progressBar").style.width = `${progress}%`;
  const labels = {
    "loading tesseract core": "OCR 엔진 로딩",
    "initializing tesseract": "OCR 초기화",
    "loading language traineddata": "언어 모델 로딩",
    "initializing api": "OCR 준비",
    "loading paddle ocr": "PP-OCRv5 모델 로딩",
    "recognizing text": "코드 인식"
  };
  $("#progressText").textContent = `${labels[status] || status} ${progress}%`;
});

restoreSettings();
if (state.workspacePath && state.targetPath) loadTarget();
updateControls();
