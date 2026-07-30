import { basicSetup } from "codemirror";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, highlightWhitespace } from "@codemirror/view";
import { indentUnit } from "@codemirror/language";
import { python } from "@codemirror/lang-python";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { java } from "@codemirror/lang-java";
import { cpp } from "@codemirror/lang-cpp";

function languageFor(filename = "") {
  const extension = filename.toLowerCase().match(/(\.[^.\\/]+)$/)?.[1] || "";
  if (extension === ".py") return python();
  if ([".js", ".jsx"].includes(extension)) return javascript({ jsx: extension === ".jsx" });
  if ([".ts", ".tsx"].includes(extension)) {
    return javascript({ typescript: true, jsx: extension === ".tsx" });
  }
  if (extension === ".json") return json();
  if ([".html", ".htm"].includes(extension)) return html();
  if ([".css", ".scss"].includes(extension)) return css();
  if (extension === ".java") return java();
  if ([".c", ".h", ".cpp", ".hpp", ".cc"].includes(extension)) return cpp();
  return [];
}

const lectureTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "#d9e4ef",
    backgroundColor: "#080d14",
    fontSize: "12px"
  },
  ".cm-content": {
    padding: "12px 0",
    caretColor: "#51a7ff",
    fontFamily: '"Cascadia Code", Consolas, monospace',
    lineHeight: "1.58",
    tabSize: "4"
  },
  ".cm-line": { padding: "0 12px 0 6px" },
  ".cm-scroller": { overflow: "auto" },
  ".cm-gutters": {
    color: "#607086",
    backgroundColor: "#0b1119",
    borderRight: "1px solid #1f2b3a"
  },
  ".cm-activeLine, .cm-activeLineGutter": {
    backgroundColor: "rgba(81, 167, 255, .08)"
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "rgba(81, 167, 255, .22)"
  },
  ".cm-cursor": { borderLeftColor: "#51a7ff" },
  ".cm-specialChar": { color: "#64748b" }
}, { dark: true });

function createLectureEditor(host, { value = "", filename = "", onChange = () => {} } = {}) {
  let suppressChange = false;
  const languageSlot = new Compartment();
  const baseExtensions = [
    basicSetup,
    indentUnit.of("    "),
    highlightWhitespace(),
    lectureTheme,
    EditorView.updateListener.of((update) => {
      if (update.docChanged && !suppressChange) onChange(update.state.doc.toString());
    })
  ];
  const state = EditorState.create({
    doc: value,
    extensions: [...baseExtensions, languageSlot.of(languageFor(filename))]
  });
  const view = new EditorView({ state, parent: host });

  return {
    get value() {
      return view.state.doc.toString();
    },
    set value(nextValue) {
      const text = String(nextValue ?? "");
      if (text === view.state.doc.toString()) return;
      suppressChange = true;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text }
      });
      suppressChange = false;
    },
    setLanguage(nextFilename) {
      view.dispatch({ effects: languageSlot.reconfigure(languageFor(nextFilename)) });
    },
    focus() {
      view.focus();
    },
    destroy() {
      view.destroy();
    }
  };
}

window.LectureCodeEditor = { create: createLectureEditor };
