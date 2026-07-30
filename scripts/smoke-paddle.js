"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { PaddleOcrClient } = require("../src/paddle-ocr-client");
const { reconstructPaddleText } = require("../src/core");

async function run() {
  const imagePath = process.argv[2];
  if (!imagePath || !fs.existsSync(imagePath)) {
    throw new Error("사용법: npm run smoke:paddle -- <PNG 경로>");
  }
  const client = new PaddleOcrClient({
    appPath: path.resolve(__dirname, ".."),
    cachePath: path.join(process.env.LOCALAPPDATA || process.cwd(), "LectureLens", "paddlex"),
    log: (message) => process.stderr.write(`${message}\n`)
  });
  try {
    const dataUrl = `data:image/png;base64,${fs.readFileSync(imagePath).toString("base64")}`;
    const blocks = await client.recognize(dataUrl);
    const result = reconstructPaddleText(blocks);
    console.log(`PADDLE_OCR_OK confidence=${result.confidence}`);
    console.log(result.text);
  } finally {
    client.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
