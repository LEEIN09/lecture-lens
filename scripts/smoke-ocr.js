"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createWorker, OEM, PSM } = require("tesseract.js");
const { reconstructIndentedText } = require("../src/core");
const { prepareTessdata } = require("../src/ocr-models");

async function run() {
  let worker;
  const fixturePath = path.join(os.tmpdir(), `lecture-lens-ocr-${process.pid}.png`);
  try {
    const safePath = fixturePath.replace(/'/g, "''");
    const powershell = [
      "Add-Type -AssemblyName System.Drawing",
      "$bmp=New-Object System.Drawing.Bitmap 1000,620",
      "$gfx=[System.Drawing.Graphics]::FromImage($bmp)",
      "$gfx.Clear([System.Drawing.Color]::White)",
      "$font=New-Object System.Drawing.Font('Consolas',32)",
      "$brush=[System.Drawing.Brushes]::Black",
      "$indentX=30+(4*$gfx.MeasureString('M',$font).Width)",
      "$gfx.DrawString('def greet(name):',$font,$brush,30,30)",
      "$gfx.DrawString('message = \"Hello, {name}!\"',$font,$brush,$indentX,85)",
      "$gfx.DrawString('return message',$font,$brush,$indentX,140)",
      "$gfx.DrawString('print(greet(\"mentor\"))',$font,$brush,30,220)",
      "$fontKor=New-Object System.Drawing.Font('Malgun Gothic',40)",
      "$gfx.DrawString('print(\"전체 총점 =\", data)',$fontKor,$brush,30,310)",
      `$bmp.Save('${safePath}',[System.Drawing.Imaging.ImageFormat]::Png)`,
      "$font.Dispose()",
      "$fontKor.Dispose()",
      "$gfx.Dispose()",
      "$bmp.Dispose()"
    ].join("; ");
    const generated = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-Command", powershell],
      { encoding: "utf8" }
    );
    if (generated.status !== 0 || !fs.existsSync(fixturePath)) {
      throw new Error(generated.stderr || "Could not create OCR fixture image");
    }
    const langPath = await prepareTessdata(path.join(os.tmpdir(), "lecture-lens-tessdata-smoke"));
    worker = await createWorker(["kor", "eng"], OEM.LSTM_ONLY, { langPath, cacheMethod: "none" });
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
      preserve_interword_spaces: "1"
    });
    const result = await worker.recognize(fixturePath, {}, { text: true, blocks: true });
    const text = reconstructIndentedText(result.data);
    const passed = text.includes("def greet(name)") &&
      text.includes("    return message") &&
      text.includes("전체") &&
      text.includes("총점");
    console.log(`OCR_${passed ? "OK" : "FAILED"} confidence=${Math.round(result.data.confidence)}`);
    console.log(text.trim());
    return passed ? 0 : 1;
  } catch (error) {
    console.error(error);
    return 1;
  } finally {
    if (worker) await worker.terminate();
    try { fs.unlinkSync(fixturePath); } catch {}
  }
}

run().then((code) => {
  process.exitCode = code;
});
