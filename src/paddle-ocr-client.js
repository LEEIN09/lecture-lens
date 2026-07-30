"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const PROTOCOL_PREFIX = "LECTURE_LENS_JSON:";

class PaddleOcrClient {
  constructor({ appPath, cachePath, log = () => {} }) {
    this.appPath = appPath;
    this.cachePath = cachePath;
    this.log = log;
    this.child = null;
    this.readyPromise = null;
    this.pending = new Map();
    this.sequence = 0;
  }

  get pythonPath() {
    return path.join(this.appPath, ".venv", "Scripts", "python.exe");
  }

  get available() {
    return fs.existsSync(this.pythonPath) &&
      fs.existsSync(path.join(this.appPath, "src", "paddle_ocr.py"));
  }

  async start() {
    if (this.child && this.readyPromise) return this.readyPromise;
    if (!this.available) {
      throw new Error("PP-OCRv5 로컬 실행 환경이 설치되지 않았습니다.");
    }

    let resolveReady;
    let rejectReady;
    this.readyPromise = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const child = spawn(this.pythonPath, ["-u", path.join(this.appPath, "src", "paddle_ocr.py")], {
      cwd: this.appPath,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PADDLE_PDX_CACHE_HOME: this.cachePath,
        PADDLE_PDX_MODEL_SOURCE: "BOS",
        PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: "True"
      }
    });
    this.child = child;

    const output = readline.createInterface({ input: child.stdout });
    output.on("line", (line) => {
      if (!line.startsWith(PROTOCOL_PREFIX)) {
        if (line.trim()) this.log(`PP-OCR stdout: ${line}`);
        return;
      }
      let message;
      try {
        message = JSON.parse(line.slice(PROTOCOL_PREFIX.length));
      } catch (error) {
        this.log(`PP-OCR protocol parse failed: ${error.message}`);
        return;
      }
      if (message.type === "ready") {
        resolveReady();
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.type === "error") pending.reject(new Error(message.message));
      else pending.resolve(message.blocks ?? []);
    });

    child.stderr.on("data", (chunk) => {
      const message = String(chunk).trim();
      if (message) this.log(`PP-OCR: ${message}`);
    });
    child.on("error", (error) => {
      rejectReady(error);
      this.failAll(error);
    });
    child.on("exit", (code) => {
      const error = new Error(`PP-OCRv5 엔진이 종료되었습니다. (code ${code ?? "unknown"})`);
      rejectReady(error);
      this.failAll(error);
      this.child = null;
      this.readyPromise = null;
    });

    return this.readyPromise;
  }

  async recognize(dataUrl) {
    await this.start();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("PP-OCRv5 인식 시간이 초과되었습니다."));
      }, 120000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, dataUrl })}\n`, "utf8");
    });
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    if (!this.child) return;
    this.child.stdin.end();
    this.child.kill();
    this.child = null;
    this.readyPromise = null;
  }
}

module.exports = { PaddleOcrClient };
