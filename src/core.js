"use strict";

const path = require("node:path");

const SUPPORTED_EXTENSIONS = new Set([
  ".py", ".js", ".jsx", ".ts", ".tsx", ".java", ".c", ".h", ".cpp", ".hpp",
  ".cs", ".go", ".rs", ".php", ".rb", ".html", ".css", ".scss", ".json",
  ".yaml", ".yml", ".xml", ".sql", ".sh", ".md", ".txt"
]);

function normalizeOcrText(input) {
  return String(input ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/^\s*\d+[|¦]\s?/gm, "")
    .replace(/^\s*\d+\s{2,}(?=\S)/gm, "")
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/\u00a0/g, " ")
    .replace(/\n{4,}/g, "\n\n\n")
    .trimEnd();
}

function computeLineDiff(before, after) {
  const left = String(before ?? "").split("\n");
  const right = String(after ?? "").split("\n");
  const table = Array.from({ length: left.length + 1 }, () =>
    new Uint32Array(right.length + 1)
  );

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
      output.push({ type: "same", text: left[i] });
      i += 1;
      j += 1;
    } else if (j < right.length && (i === left.length || table[i][j + 1] >= table[i + 1][j])) {
      output.push({ type: "add", text: right[j] });
      j += 1;
    } else {
      output.push({ type: "remove", text: left[i] });
      i += 1;
    }
  }
  return output;
}

function canonicalCodeLine(line) {
  return String(line ?? "")
    .normalize("NFKC")
    .replace(/^\s*\d{1,4}\s+/, "")
    .toLocaleLowerCase("en")
    .match(/[\p{L}\p{N}_]+/gu)?.join("|") ?? "";
}

function normalizedLineSimilarity(left, right) {
  const a = canonicalCodeLine(left);
  const b = canonicalCodeLine(right);
  if (!a || !b) return a === b ? 1 : 0;
  if (a === b) return 1;
  const previous = new Uint16Array(b.length + 1);
  const current = new Uint16Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    previous.set(current);
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}

function looksLikeCodeLine(line) {
  const value = String(line ?? "");
  if (!value.trim()) return true;
  return /^\s*(async\s+def|def|class|if|elif|else|for|while|try|except|finally|with|return|import|from|function|const|let|var|print)\b/u.test(value) ||
    /[=()[\]{}:;#]|=>|->/u.test(value) ||
    /^\s{2,}[A-Za-z_\p{L}]/u.test(value);
}

function mergeIncrementalCode(existingText, recognizedText) {
  const existing = String(existingText ?? "").replace(/\r\n?/g, "\n").split("\n");
  const recognized = String(recognizedText ?? "").replace(/\r\n?/g, "\n").split("\n");
  if (!String(existingText ?? "").trim()) {
    return { text: recognized.join("\n"), mode: "replace", preserved: 0, inserted: recognized.length };
  }
  if (!String(recognizedText ?? "").trim()) {
    return { text: existing.join("\n"), mode: "unchanged", preserved: existing.length, inserted: 0 };
  }

  // Weighted LCS: find monotonic line anchors even when punctuation or spacing
  // was lost by OCR.
  const rows = recognized.length + 1;
  const columns = existing.length + 1;
  const scores = Array.from({ length: rows }, () => new Float32Array(columns));
  const directions = Array.from({ length: rows }, () => new Uint8Array(columns));
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < columns; j += 1) {
      const similarity = normalizedLineSimilarity(recognized[i - 1], existing[j - 1]);
      const weight = similarity >= 0.9 ? 3 : similarity >= 0.72 ? 1 : 0;
      const diagonal = scores[i - 1][j - 1] + weight;
      const skipRecognized = scores[i - 1][j];
      const skipExisting = scores[i][j - 1];
      if (weight > 0 && diagonal >= skipRecognized && diagonal >= skipExisting) {
        scores[i][j] = diagonal;
        directions[i][j] = 1;
      } else if (skipRecognized >= skipExisting) {
        scores[i][j] = skipRecognized;
        directions[i][j] = 2;
      } else {
        scores[i][j] = skipExisting;
        directions[i][j] = 3;
      }
    }
  }

  const pairs = [];
  let row = recognized.length;
  let column = existing.length;
  while (row > 0 && column > 0) {
    if (directions[row][column] === 1) {
      pairs.push({
        recognized: row - 1,
        existing: column - 1,
        similarity: normalizedLineSimilarity(recognized[row - 1], existing[column - 1])
      });
      row -= 1;
      column -= 1;
    } else if (directions[row][column] === 2) {
      row -= 1;
    } else {
      column -= 1;
    }
  }
  pairs.reverse();

  const strongPairs = pairs.filter((pair) => pair.similarity >= 0.72);
  if (strongPairs.length < 2) {
    return {
      text: recognized.join("\n"),
      mode: "replace",
      preserved: 0,
      inserted: recognized.length
    };
  }

  const first = strongPairs[0];
  const last = strongPairs.at(-1);
  let recognizedStart = first.recognized;
  while (recognizedStart > 0 && looksLikeCodeLine(recognized[recognizedStart - 1])) {
    recognizedStart -= 1;
  }
  let recognizedEnd = last.recognized;
  while (recognizedEnd + 1 < recognized.length && looksLikeCodeLine(recognized[recognizedEnd + 1])) {
    recognizedEnd += 1;
  }

  const pairByRecognized = new Map(strongPairs.map((pair) => [pair.recognized, pair]));
  const output = existing.slice(0, first.existing);
  let existingCursor = first.existing;
  let preserved = output.length;
  let inserted = 0;

  for (let index = recognizedStart; index <= recognizedEnd; index += 1) {
    const pair = pairByRecognized.get(index);
    if (pair) {
      while (existingCursor < pair.existing) {
        output.push(existing[existingCursor]);
        existingCursor += 1;
        preserved += 1;
      }
      if (canonicalCodeLine(recognized[index]) === canonicalCodeLine(existing[pair.existing])) {
        output.push(existing[pair.existing]);
        preserved += 1;
      } else {
        output.push(recognized[index]);
        inserted += 1;
      }
      existingCursor = pair.existing + 1;
    } else {
      output.push(recognized[index]);
      inserted += 1;
    }
  }

  while (existingCursor <= last.existing) {
    output.push(existing[existingCursor]);
    existingCursor += 1;
    preserved += 1;
  }
  const tail = existing.slice(last.existing + 1);
  output.push(...tail);
  preserved += tail.length;

  return {
    text: output.join("\n"),
    mode: "incremental",
    preserved,
    inserted,
    matched: strongPairs.length
  };
}

function calculateCropRegion(imageWidth, imageHeight, roi, gutterRatio = 0) {
  if (!(imageWidth > 0) || !(imageHeight > 0) || !roi) {
    throw new Error("캡처 영역 정보가 올바르지 않습니다.");
  }
  const gutter = Math.max(0, Math.min(0.35, Number(gutterRatio) || 0));
  const excludedWidth = roi.width * gutter;
  return {
    x: Math.max(0, Math.round((roi.x + excludedWidth) * imageWidth)),
    y: Math.max(0, Math.round(roi.y * imageHeight)),
    width: Math.max(1, Math.round((roi.width - excludedWidth) * imageWidth)),
    height: Math.max(1, Math.round(roi.height * imageHeight))
  };
}

function validateTargetPath(workspacePath, relativePath) {
  if (!workspacePath || !relativePath) {
    throw new Error("작업 폴더와 대상 파일을 모두 선택해 주세요.");
  }

  const root = path.resolve(workspacePath);
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("대상 파일은 선택한 작업 폴더 안에 있어야 합니다.");
  }
  if (!SUPPORTED_EXTENSIONS.has(path.extname(target).toLowerCase())) {
    throw new Error("지원하지 않는 파일 형식입니다.");
  }
  return target;
}

function estimateCodeConfidence(text, ocrConfidence) {
  const value = String(text ?? "");
  if (!value.trim()) return 0;
  let score = Number.isFinite(ocrConfidence) ? ocrConfidence : 50;
  const replacementChars = (value.match(/[�]/g) || []).length;
  const suspicious = (value.match(/[¦©®¬]/g) || []).length;
  score -= Math.min(30, replacementChars * 10 + suspicious * 3);
  if (/[{}()[\]=;:]|^\s*(def|class|function|const|let|var|import|from)\b/m.test(value)) {
    score += 4;
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

function evaluateFrameSafety(stats) {
  const value = stats ?? {};
  if (!Number.isFinite(value.mean) || !Number.isFinite(value.stddev)) {
    return { safe: false, reason: "프레임 분석 정보가 올바르지 않습니다." };
  }
  if (value.whiteRatio >= 0.985 || (value.mean >= 248 && value.stddev < 7)) {
    return { safe: false, reason: "영상이 흰 화면으로 감지됐습니다." };
  }
  if (value.blackRatio >= 0.985 || (value.mean <= 4 && value.stddev < 5)) {
    return { safe: false, reason: "영상이 검은 화면으로 감지됐습니다." };
  }
  if (value.stddev < 3.5) {
    return { safe: false, reason: "화면 대비가 너무 낮아 코드를 구분할 수 없습니다." };
  }
  return { safe: true, reason: "" };
}

function hasBalancedDelimiters(text) {
  const pairs = { ")": "(", "]": "[", "}": "{" };
  const stack = [];
  let quote = null;
  let escaped = false;
  for (const character of text) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
    } else if ("([{".includes(character)) {
      stack.push(character);
    } else if (pairs[character]) {
      if (stack.pop() !== pairs[character]) return false;
    }
  }
  return stack.length === 0 && quote === null;
}

function evaluateCodeSafety({ text, confidence, minimumConfidence = 90, extension = "" }) {
  const value = String(text ?? "");
  if (!value.trim()) return { safe: false, reason: "인식된 코드가 없습니다." };
  if (!Number.isFinite(confidence) || confidence < minimumConfidence) {
    return { safe: false, reason: `OCR 신뢰도가 자동 저장 기준 ${minimumConfidence}%보다 낮습니다.` };
  }
  if (!hasBalancedDelimiters(value)) {
    return { safe: false, reason: "괄호 또는 따옴표의 짝이 맞지 않습니다." };
  }
  if (/[�¦©®¬]/.test(value)) {
    return { safe: false, reason: "OCR 의심 문자가 포함되어 있습니다." };
  }
  if (/\b(PROBLEMS|OUTPUT|DEBUG CONSOLE|TERMINAL|PORTS)\b/i.test(value)) {
    return { safe: false, reason: "에디터 패널 문구가 코드에 섞인 것으로 보입니다." };
  }

  const lines = value.split("\n");
  const numbered = lines.filter((line) => /^\s*\d{1,4}\s{1,3}(?=[A-Za-z_@])/u.test(line));
  if (numbered.length >= 2) {
    return { safe: false, reason: "여러 줄에서 줄 번호가 코드에 섞인 것으로 보입니다." };
  }

  if (String(extension).toLowerCase() === ".py") {
    const missingColon = lines.some((line) =>
      /^\s*(async\s+def|def|class|if|elif|else|for|while|try|except|finally|with)\b.*[^:\\]$/u.test(line.trimEnd()));
    if (missingColon) {
      return { safe: false, reason: "Python 블록 문장에서 콜론이 누락된 것으로 보입니다." };
    }
    if (/(^|\s)I=(?!=)/m.test(value)) {
      return { safe: false, reason: "비교 연산자 '!='가 'I='로 인식된 가능성이 있습니다." };
    }
  }
  return { safe: true, reason: "" };
}

function reconstructIndentedText(ocrData) {
  const lines = [];
  for (const block of ocrData?.blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        const raw = String(line.text ?? "").replace(/\r?\n$/, "").trimEnd();
        if (raw.trim()) lines.push({ text: raw.trimStart(), bbox: line.bbox });
      }
    }
  }
  if (!lines.length) return normalizeOcrText(ocrData?.text ?? "");

  lines.sort((left, right) => {
    const vertical = (left.bbox?.y0 ?? 0) - (right.bbox?.y0 ?? 0);
    return Math.abs(vertical) > 3 ? vertical : (left.bbox?.x0 ?? 0) - (right.bbox?.x0 ?? 0);
  });

  const minX = Math.min(...lines.map((line) => line.bbox?.x0 ?? 0));
  const widths = lines
    .map((line) => {
      const width = (line.bbox?.x1 ?? 0) - (line.bbox?.x0 ?? 0);
      return width > 0 ? width / Math.max(1, line.text.length) : 0;
    })
    .filter((width) => width > 2 && Number.isFinite(width))
    .sort((left, right) => left - right);
  const charWidth = widths.length ? widths[Math.floor(widths.length / 2)] : 10;

  const clusters = [];
  for (const x of lines.map((line) => line.bbox?.x0 ?? minX).sort((a, b) => a - b)) {
    const cluster = clusters.find((item) => Math.abs(item.mean - x) <= charWidth * 1.2);
    if (cluster) {
      cluster.values.push(x);
      cluster.mean = cluster.values.reduce((sum, value) => sum + value, 0) / cluster.values.length;
    } else {
      clusters.push({ mean: x, values: [x] });
    }
  }
  clusters.sort((left, right) => left.mean - right.mean);
  const firstOffset = clusters.length > 1 ? clusters[1].mean - clusters[0].mean : 0;
  const rawStep = firstOffset / charWidth;
  const indentStep = rawStep >= 2.5 && rawStep <= 7
    ? 4
    : rawStep >= 1.2 && rawStep < 2.5
      ? 2
      : Math.max(1, Math.round(rawStep));

  return normalizeOcrText(lines.map((line) => {
    const x = line.bbox?.x0 ?? minX;
    let clusterIndex = 0;
    let distance = Number.POSITIVE_INFINITY;
    clusters.forEach((cluster, index) => {
      const current = Math.abs(cluster.mean - x);
      if (current < distance) {
        distance = current;
        clusterIndex = index;
      }
    });
    const levels = firstOffset > 0
      ? Math.max(0, Math.round((clusters[clusterIndex].mean - clusters[0].mean) / firstOffset))
      : 0;
    const indent = Math.min(32, levels * indentStep);
    return `${" ".repeat(indent)}${line.text}`;
  }).join("\n"));
}

function reconstructPaddleText(blocks) {
  const spacingKeywords = new Set([
    "async", "await", "break", "case", "catch", "class", "const", "continue",
    "def", "delete", "do", "elif", "else", "except", "export", "extends",
    "finally", "for", "from", "function", "if", "import", "in", "interface",
    "let", "new", "raise", "return", "switch", "throw", "try", "var", "while",
    "with", "yield"
  ]);
  const items = (blocks ?? [])
    .map((block) => ({
      text: String(block?.text ?? "").trim(),
      score: Number(block?.score),
      box: Array.isArray(block?.box) ? block.box.map(Number) : []
    }))
    .filter((block) =>
      block.text && block.box.length === 4 && block.box.every(Number.isFinite));
  if (!items.length) return { text: "", confidence: 0 };

  items.sort((left, right) => {
    const leftY = (left.box[1] + left.box[3]) / 2;
    const rightY = (right.box[1] + right.box[3]) / 2;
    const tolerance = Math.max(3, Math.min(left.box[3] - left.box[1], right.box[3] - right.box[1]) * 0.55);
    return Math.abs(leftY - rightY) <= tolerance
      ? left.box[0] - right.box[0]
      : leftY - rightY;
  });

  const lines = [];
  for (const item of items) {
    const centerY = (item.box[1] + item.box[3]) / 2;
    const height = Math.max(1, item.box[3] - item.box[1]);
    let line = lines.find((candidate) =>
      Math.abs(candidate.centerY - centerY) <= Math.max(3, Math.min(candidate.height, height) * 0.6));
    if (!line) {
      line = { centerY, height, items: [] };
      lines.push(line);
    }
    line.items.push(item);
    line.centerY = line.items.reduce((sum, value) =>
      sum + (value.box[1] + value.box[3]) / 2, 0) / line.items.length;
    line.height = Math.max(line.height, height);
  }
  lines.sort((left, right) => left.centerY - right.centerY);

  const characterWidths = items
    .map((item) => (item.box[2] - item.box[0]) / Math.max(1, item.text.length))
    .filter((width) => Number.isFinite(width) && width > 1)
    .sort((left, right) => left - right);
  const charWidth = characterWidths[Math.floor(characterWidths.length / 2)] || 8;

  const merged = lines.map((line) => {
    line.items.sort((left, right) => left.box[0] - right.box[0]);
    let text = line.items[0].text;
    let rightEdge = line.items[0].box[2];
    for (const item of line.items.slice(1)) {
      const gap = item.box[0] - rightEdge;
      let spaces = gap <= charWidth * 0.35
        ? 0
        : Math.max(1, Math.min(8, Math.round(gap / charWidth)));
      const previousToken = text.match(/[A-Za-z_]+$/)?.[0];
      if (spaces === 0 && (spacingKeywords.has(previousToken) || /[,;]/u.test(text.at(-1)))) {
        spaces = 1;
      }
      text += `${" ".repeat(spaces)}${item.text}`;
      rightEdge = Math.max(rightEdge, item.box[2]);
    }
    return { text, x: line.items[0].box[0] };
  });

  const xValues = [...new Set(merged.map((line) => Math.round(line.x)))]
    .sort((left, right) => left - right);
  const baseX = xValues[0] ?? 0;
  const secondX = xValues.find((value) => value - baseX >= charWidth * 1.2);
  const indentPixels = secondX ? secondX - baseX : 0;
  const rawIndent = indentPixels / charWidth;
  const indentStep = rawIndent >= 2.5 && rawIndent <= 7 ? 4 : Math.max(1, Math.round(rawIndent));

  const text = normalizeOcrText(merged.map((line) => {
    const level = indentPixels > 0
      ? Math.max(0, Math.round((line.x - baseX) / indentPixels))
      : 0;
    return `${" ".repeat(Math.min(32, level * indentStep))}${line.text}`;
  }).join("\n"));
  const validScores = items.map((item) => item.score).filter(Number.isFinite);
  const confidence = validScores.length
    ? Math.round(validScores.reduce((sum, score) => sum + score, 0) / validScores.length * 100)
    : 0;
  return { text, confidence };
}

module.exports = {
  SUPPORTED_EXTENSIONS,
  calculateCropRegion,
  canonicalCodeLine,
  computeLineDiff,
  estimateCodeConfidence,
  evaluateCodeSafety,
  evaluateFrameSafety,
  normalizeOcrText,
  mergeIncrementalCode,
  normalizedLineSimilarity,
  reconstructPaddleText,
  reconstructIndentedText,
  validateTargetPath
};
