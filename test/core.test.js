"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  calculateCropRegion,
  computeLineDiff,
  estimateCodeConfidence,
  evaluateCodeSafety,
  evaluateFrameSafety,
  normalizeOcrText,
  reconstructIndentedText,
  validateTargetPath
} = require("../src/core");

test("OCR 텍스트의 줄 번호와 스마트 따옴표를 정리한다", () => {
  const input = "1| const message = “hello”;  \r\n2| console.log(message);";
  assert.equal(
    normalizeOcrText(input),
    "const message = \"hello\";\nconsole.log(message);"
  );
});

test("왼쪽 제외선만큼 OCR 캡처 영역을 줄인다", () => {
  assert.deepEqual(calculateCropRegion(1000, 500, {
    x: 0.1, y: 0.2, width: 0.6, height: 0.5
  }, 0.1), {
    x: 160,
    y: 100,
    width: 540,
    height: 250
  });
});

test("줄 단위 추가와 삭제를 계산한다", () => {
  const diff = computeLineDiff("a\nb", "a\nc");
  assert.deepEqual(diff, [
    { type: "same", text: "a" },
    { type: "add", text: "c" },
    { type: "remove", text: "b" }
  ]);
});

test("작업 폴더 밖 경로를 거부한다", () => {
  const root = path.resolve("workspace");
  assert.throws(() => validateTargetPath(root, "../escape.py"));
  assert.equal(validateTargetPath(root, "src/main.py"), path.join(root, "src/main.py"));
});

test("의심 문자가 있으면 신뢰도를 낮춘다", () => {
  assert.ok(estimateCodeConfidence("const x = 1;", 80) >
    estimateCodeConfidence("const � = ¦;", 80));
});

test("OCR 줄 좌표로 코드 들여쓰기를 복원한다", () => {
  const data = {
    text: "def greet(name):\nreturn name\n",
    blocks: [{
      paragraphs: [{
        lines: [
          { text: "def greet(name):\n", bbox: { x0: 20, y0: 10, x1: 180, y1: 30 } },
          { text: "return name\n", bbox: { x0: 60, y0: 40, x1: 170, y1: 60 } }
        ]
      }]
    }]
  };
  assert.equal(reconstructIndentedText(data), "def greet(name):\n    return name");
});

test("흰 화면과 정상 코드 화면을 구분한다", () => {
  assert.equal(evaluateFrameSafety({
    mean: 250, stddev: 2, whiteRatio: 0.98, blackRatio: 0
  }).safe, false);
  assert.equal(evaluateFrameSafety({
    mean: 42, stddev: 31, whiteRatio: 0.01, blackRatio: 0.4
  }).safe, true);
});

test("안전 자동 저장에서 줄 번호 혼입과 Python OCR 오류를 차단한다", () => {
  assert.equal(evaluateCodeSafety({
    text: "1 import random\n2 lotto = []", confidence: 95, extension: ".py"
  }).safe, false);
  assert.equal(evaluateCodeSafety({
    text: "while len(lotto) I= 6:\n    pass", confidence: 95, extension: ".py"
  }).safe, false);
  assert.equal(evaluateCodeSafety({
    text: "while len(lotto) != 6:\n    pass", confidence: 95, extension: ".py"
  }).safe, true);
});
