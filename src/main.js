"use strict";

const { app, BrowserWindow, desktopCapturer, dialog, ipcMain } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const fsSync = require("node:fs");
const { createWorker, OEM, PSM } = require("tesseract.js");
const { prepareTessdata } = require("./ocr-models");
const { PaddleOcrClient } = require("./paddle-ocr-client");
const {
  calculateCropRegion,
  evaluateCodeSafety,
  evaluateFrameSafety,
  mergeIncrementalCode,
  reconstructPaddleText,
  reconstructIndentedText,
  validateTargetPath
} = require("./core");

let mainWindow;
let ocrWorker;
let ocrWorkerPromise;
let paddleOcr;
const runtimeLogPath = path.join(app.getAppPath(), "runtime.log");

function runtimeLog(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fsSync.appendFileSync(runtimeLogPath, line, "utf8");
  } catch {
    // Logging must never prevent the app from starting.
  }
}

process.on("uncaughtException", (error) => runtimeLog(`uncaughtException: ${error.stack || error}`));
process.on("unhandledRejection", (error) => runtimeLog(`unhandledRejection: ${error?.stack || error}`));

function createWindow() {
  runtimeLog("Creating main window");
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1050,
    minHeight: 720,
    backgroundColor: "#0d1117",
    title: "Lecture Lens",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
  mainWindow.webContents.on("did-fail-load", (_event, code, description) =>
    runtimeLog(`did-fail-load ${code}: ${description}`));
  mainWindow.webContents.on("render-process-gone", (_event, details) =>
    runtimeLog(`render-process-gone: ${JSON.stringify(details)}`));
  mainWindow.on("ready-to-show", () => runtimeLog("Main window ready"));
  mainWindow.on("closed", () => runtimeLog("Main window closed"));
}

async function listCaptureSources() {
  const sources = await desktopCapturer.getSources({
    types: ["window"],
    fetchWindowIcons: true,
    thumbnailSize: { width: 480, height: 270 }
  });

  return sources
    .filter((source) => source.name !== "Lecture Lens")
    .map((source) => ({
      id: source.id,
      name: source.name,
      thumbnail: source.thumbnail.toDataURL(),
      appIcon: source.appIcon?.toDataURL() ?? null
    }));
}

async function captureSource(sourceId) {
  const sources = await desktopCapturer.getSources({
    types: ["window"],
    thumbnailSize: { width: 1920, height: 1080 }
  });
  const source = sources.find((item) => item.id === sourceId);
  if (!source || source.thumbnail.isEmpty()) {
    throw new Error("선택한 창을 캡처할 수 없습니다. 창이 최소화됐는지 확인해 주세요.");
  }
  return {
    image: source.thumbnail.toDataURL(),
    size: source.thumbnail.getSize(),
    name: source.name
  };
}

function emitOcrProgress(message) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("ocr:progress", {
    status: message.status,
    progress: Math.round((message.progress ?? 0) * 100)
  });
}

async function getOcrWorker() {
  if (ocrWorker) return ocrWorker;
  if (!ocrWorkerPromise) {
    const langPath = await prepareTessdata(path.join(app.getPath("userData"), "tessdata"));
    ocrWorkerPromise = createWorker(["kor", "eng"], OEM.LSTM_ONLY, {
      langPath,
      cacheMethod: "none",
      logger: emitOcrProgress
    }).then(async (worker) => {
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
        preserve_interword_spaces: "1",
        user_defined_dpi: "300"
      });
      ocrWorker = worker;
      return worker;
    }).catch((error) => {
      ocrWorkerPromise = null;
      throw error;
    });
  }
  return ocrWorkerPromise;
}

async function recognizeCode(dataUrl) {
  if (!/^data:image\/png;base64,/.test(dataUrl)) {
    throw new Error("지원하지 않는 캡처 이미지입니다.");
  }
  if (!paddleOcr) {
    paddleOcr = new PaddleOcrClient({
      appPath: app.getAppPath(),
      cachePath: path.join(process.env.LOCALAPPDATA || app.getPath("userData"), "LectureLens", "paddlex"),
      log: runtimeLog
    });
  }
  try {
    emitOcrProgress({ status: "loading paddle ocr", progress: 0.15 });
    const blocks = await paddleOcr.recognize(dataUrl);
    const result = reconstructPaddleText(blocks);
    if (!result.text.trim()) throw new Error("PP-OCRv5가 코드 문자를 찾지 못했습니다.");
    emitOcrProgress({ status: "recognizing text", progress: 1 });
    return { ...result, engine: "PP-OCRv5" };
  } catch (error) {
    runtimeLog(`PP-OCRv5 fallback: ${error.stack || error}`);
    const worker = await getOcrWorker();
    const result = await worker.recognize(dataUrl, {}, { text: true, blocks: true });
    return {
      text: reconstructIndentedText(result.data),
      confidence: Math.round(result.data.confidence ?? 0),
      engine: "Tesseract fallback"
    };
  }
}

async function readTarget(workspacePath, relativePath) {
  const target = validateTargetPath(workspacePath, relativePath);
  try {
    const content = await fs.readFile(target, "utf8");
    return { content, exists: true, target };
  } catch (error) {
    if (error.code === "ENOENT") return { content: "", exists: false, target };
    throw error;
  }
}

async function writeTarget({ workspacePath, relativePath, content, expectedContent }) {
  const target = validateTargetPath(workspacePath, relativePath);
  let current = "";
  let exists = true;
  try {
    current = await fs.readFile(target, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    exists = false;
  }

  if (current !== String(expectedContent ?? "")) {
    throw new Error("파일이 Antigravity 또는 다른 프로그램에서 변경됐습니다. 파일을 다시 불러온 뒤 적용해 주세요.");
  }

  await fs.mkdir(path.dirname(target), { recursive: true });
  if (exists) {
    const historyRoot = path.join(path.resolve(workspacePath), ".lecture-capture", "history");
    await fs.mkdir(historyRoot, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeName = relativePath.replace(/[\\/:*?"<>|]/g, "_");
    await fs.writeFile(path.join(historyRoot, `${stamp}_${safeName}`), current, "utf8");
  }
  await fs.writeFile(target, String(content), "utf8");
  return {
    target,
    backupCreated: exists,
    hash: crypto.createHash("sha256").update(String(content)).digest("hex")
  };
}

runtimeLog("Main process loaded");
app.whenReady().then(() => {
  runtimeLog("App ready");
  ipcMain.handle("capture:list", listCaptureSources);
  ipcMain.handle("capture:frame", (_event, sourceId) => captureSource(sourceId));
  ipcMain.handle("ocr:recognize", (_event, dataUrl) => recognizeCode(dataUrl));
  ipcMain.handle("workspace:choose", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Antigravity에서 연 작업 폴더 선택",
      properties: ["openDirectory", "createDirectory"]
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle("file:read", (_event, workspacePath, relativePath) =>
    readTarget(workspacePath, relativePath));
  ipcMain.handle("file:write", (_event, payload) => writeTarget(payload));
  ipcMain.handle("analysis:frame-safety", (_event, stats) => evaluateFrameSafety(stats));
  ipcMain.handle("analysis:code-safety", (_event, payload) => evaluateCodeSafety(payload));
  ipcMain.handle("analysis:crop-region", (_event, payload) =>
    calculateCropRegion(payload.imageWidth, payload.imageHeight, payload.roi, payload.gutterRatio));
  ipcMain.handle("analysis:incremental-merge", (_event, payload) =>
    mergeIncrementalCode(payload.existing, payload.recognized));
  createWindow();
}).catch((error) => runtimeLog(`App startup failed: ${error.stack || error}`));

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  runtimeLog("App before-quit");
  if (ocrWorker) ocrWorker.terminate().catch(() => {});
  if (paddleOcr) paddleOcr.close();
});
