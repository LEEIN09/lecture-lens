"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  canonicalCodeLine,
  mergeIncrementalCode,
  normalizedLineSimilarity
} = require("../src/core");

test("공백과 연산자를 제외한 코드 내용이 같으면 같은 줄로 판단한다", () => {
  assert.equal(canonicalCodeLine("    num = int(input('선택: '))"), "num|int|input|선택");
  assert.equal(canonicalCodeLine("num int(input('선택: '))"), "num|int|input|선택");
  assert.equal(normalizedLineSimilarity("while True+", "while True:"), 1);
});

test("화면에 보이는 OCR 구간만 병합하고 기존 파일 앞뒤를 보존한다", () => {
  const existing = [
    "menu = {}",
    "",
    "while True:",
    "    print()",
    "    num = int(input('1.등록 9.종료>>'))",
    "    if num == 1:",
    "        name = input('메뉴이름>>')",
    "print('파일 끝')"
  ].join("\n");
  const recognized = [
    "WINDOW TITLE",
    "while True+",
    "print()",
    "num int(input('1.등록 9.종료>>'))",
    "if num == 1:",
    "name = input('메뉴이름>>')",
    "price = int(input('가격>>'))"
  ].join("\n");

  const result = mergeIncrementalCode(existing, recognized);
  assert.equal(result.mode, "incremental");
  assert.equal(result.text, [
    "menu = {}",
    "",
    "while True:",
    "    print()",
    "    num = int(input('1.등록 9.종료>>'))",
    "    if num == 1:",
    "        name = input('메뉴이름>>')",
    "price = int(input('가격>>'))",
    "print('파일 끝')"
  ].join("\n"));
  assert.ok(result.preserved >= 7);
  assert.equal(result.inserted, 1);
});

test("기존 파일과 일치하는 구간이 부족하면 OCR 초안을 그대로 사용한다", () => {
  const result = mergeIncrementalCode("const oldValue = 1;", "def completely_new():\n    pass");
  assert.equal(result.mode, "replace");
  assert.equal(result.text, "def completely_new():\n    pass");
});
