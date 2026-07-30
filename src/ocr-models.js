"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const MODELS = [
  { language: "eng", packageName: "@tesseract.js-data/eng" },
  { language: "kor", packageName: "@tesseract.js-data/kor" }
];

async function ensureModel(source, destination) {
  let shouldCopy = true;
  try {
    const [sourceStat, destinationStat] = await Promise.all([
      fs.stat(source),
      fs.stat(destination)
    ]);
    shouldCopy = sourceStat.size !== destinationStat.size;
  } catch {
    shouldCopy = true;
  }
  if (shouldCopy) await fs.copyFile(source, destination);
}

async function prepareTessdata(destinationDirectory) {
  await fs.mkdir(destinationDirectory, { recursive: true });
  await Promise.all(MODELS.map(({ language, packageName }) => {
    const packageRoot = path.dirname(require.resolve(packageName));
    const source = path.join(packageRoot, "4.0.0", `${language}.traineddata.gz`);
    const destination = path.join(destinationDirectory, `${language}.traineddata.gz`);
    return ensureModel(source, destination);
  }));
  return destinationDirectory;
}

module.exports = { prepareTessdata };
