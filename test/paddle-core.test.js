"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { reconstructPaddleText } = require("../src/core");

test("PP-OCRv5 조각을 코드 줄과 들여쓰기로 복원한다", () => {
  const result = reconstructPaddleText([
    { text: "def mysu(x):", score: 0.96, box: [5, 10, 75, 21] },
    { text: "cal", score: 0.91, box: [30, 27, 49, 38] },
    { text: "=", score: 0.99, box: [53, 27, 58, 38] },
    { text: "3*x+2", score: 0.94, box: [62, 27, 94, 38] },
    { text: "return", score: 0.98, box: [30, 44, 67, 55] },
    { text: "cal", score: 0.93, box: [71, 44, 90, 55] },
    { text: "print('일반식', mysu(8))", score: 0.95, box: [5, 70, 145, 82] }
  ]);
  assert.equal(
    result.text,
    "def mysu(x):\n    cal = 3*x+2\n    return cal\nprint('일반식', mysu(8))"
  );
  assert.equal(result.confidence, 95);
});
