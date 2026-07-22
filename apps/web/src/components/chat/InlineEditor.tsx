// SPIKE (#226): CodeMirror 6 inline-markdown composer input. The document
// model IS the plain markdown string — decorations from inline-md.ts style
// **bold** / *italic* / ~~strike~~ / ||spoiler|| / `code` / [eicon] in place,
// so nothing is ever serialized from HTML and mdToBBCode remains the only
// wire translation. The component exposes a textarea-shaped imperative
// handle (value / selectionStart / selectionEnd / setSelectionRange / focus)
// so every existing composer-edit.ts transform and the toolbar's caret
// reflection re-target it unchanged.

import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  defaultKeymap,
  history,
  historyKeymap,
  insertNewline,
} from "@codemirror/commands";
import { EditorState, Prec, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  keymap,
  placeholder as cmPlaceholder,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { inlineSpans, type SpanType } from "./inline-md.js";

/** The textarea-compatible surface the composer + toolbar program against. */
export interface ComposerInputHandle {
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  focus(): void;
  setSelectionRange(start: number, end: number): void;
  /** Replaces `document.activeElement === el` checks. */
  focused(): boolean;
}

const SPAN_CLASS: Record<SpanType, string> = {
  bold: "emb-b",
  italic: "emb-i",
  strike: "emb-s",
  spoiler: "emb-spoiler",
  code: "emb-code",
  eicon: "emb-eicon",
  delim: "emb-delim",
};

const marks = Object.fromEntries(
  (Object.entries(SPAN_CLASS) as [SpanType, string][]).map(([type, cls]) => [
    type,
    Decoration.mark({ class: cls }),
  ]),
) as Record<SpanType, Decoration>;

function decorate(doc: string): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const span of inlineSpans(doc)) {
    builder.add(span.from, span.to, marks[span.type]);
  }
  return builder.finish();
}

const inlineDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = decorate(view.state.doc.toString());
    }
    update(update: ViewUpdate) {
      if (update.docChanged) {
        this.decorations = decorate(update.state.doc.toString());
      }
    }
  },
  { decorations: (v) => v.decorations },
);

const theme = EditorView.theme({
  "&": { font: "inherit", color: "inherit", flex: "1", minWidth: "0" },
  ".cm-content": {
    padding: "0",
    fontFamily: "inherit",
    caretColor: "var(--text-1, currentColor)",
  },
  ".cm-line": { padding: "0" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    font: "inherit",
    lineHeight: "inherit",
    maxHeight: "160px",
    overflowY: "auto",
  },
  ".emb-b": { fontWeight: "700" },
  ".emb-i": { fontStyle: "italic" },
  ".emb-s": { textDecoration: "line-through" },
  ".emb-spoiler": {
    background: "var(--surface-3, rgba(128,128,128,.25))",
    borderRadius: "3px",
  },
  ".emb-code": {
    fontFamily: "var(--font-mono, monospace)",
    background: "var(--surface-3, rgba(128,128,128,.18))",
    borderRadius: "3px",
  },
  ".emb-eicon": {
    color: "var(--accent, #d98e04)",
    background: "var(--surface-3, rgba(128,128,128,.12))",
    borderRadius: "4px",
  },
  ".emb-delim": { opacity: "0.45" },
});

export interface InlineEditorProps {
  value: string;
  disabled: boolean;
  placeholder: string;
  onChange: (value: string) => void;
  /** Fires on every keydown with the live document text at event time —
   * the same stale-state contract the textarea path pins (#235 audit).
   * preventDefault() stops CodeMirror's own handling. */
  onKeyDown: (event: KeyboardEvent, liveText: string) => void;
  handleRef: { current: ComposerInputHandle | null };
  ariaLabel: string;
}

export function InlineEditor(props: InlineEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView>(null);
  // Latest callbacks without rebuilding the editor.
  const cbRef = useRef({ onChange: props.onChange, onKeyDown: props.onKeyDown });
  cbRef.current = { onChange: props.onChange, onKeyDown: props.onKeyDown };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    const view: EditorView = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: "",
        extensions: [
          history(),
          // Our keydown outranks everything: Enter-send must win over the
          // newline command; the callback reads the live doc.
          Prec.highest(
            EditorView.domEventHandlers({
              keydown: (event, v) => {
                cbRef.current.onKeyDown(event, v.state.doc.toString());
                return event.defaultPrevented;
              },
            }),
          ),
          keymap.of([
            { key: "Enter", run: insertNewline },
            { key: "Shift-Enter", run: insertNewline },
            ...historyKeymap,
            ...defaultKeymap,
          ]),
          cmPlaceholder(props.placeholder),
          EditorView.lineWrapping,
          inlineDecorations,
          theme,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              cbRef.current.onChange(update.state.doc.toString());
            }
          }),
          EditorView.editable.of(!props.disabled),
          EditorView.contentAttributes.of({ "aria-label": props.ariaLabel }),
        ],
      }),
    });
    viewRef.current = view;
    props.handleRef.current = {
      get value() {
        return view.state.doc.toString();
      },
      get selectionStart() {
        return view.state.selection.main.from;
      },
      get selectionEnd() {
        return view.state.selection.main.to;
      },
      focus() {
        view.focus();
      },
      setSelectionRange(start, end) {
        const max = view.state.doc.length;
        view.dispatch({
          selection: {
            anchor: Math.min(start, max),
            head: Math.min(end, max),
          },
        });
      },
      focused() {
        return view.hasFocus;
      },
    };
    return () => {
      props.handleRef.current = null;
      view.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- create once
  }, []);

  // Controlled-value reconciliation: external setText (send-clear, recall,
  // toolbar edits) reaches the editor here; user typing round-trips through
  // onChange so the docs already match and no dispatch happens.
  useEffect(() => {
    const view = viewRef.current;
    if (view && view.state.doc.toString() !== props.value) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: props.value },
      });
    }
  }, [props.value]);

  return <div ref={hostRef} data-testid="inline-composer" />;
}

/** Adapter: the legacy textarea satisfies the same handle. */
export function textareaHandle(
  el: HTMLTextAreaElement | null,
): ComposerInputHandle | null {
  if (!el) {
    return null;
  }
  return {
    get value() {
      return el.value;
    },
    get selectionStart() {
      return el.selectionStart;
    },
    get selectionEnd() {
      return el.selectionEnd;
    },
    focus: () => {
      el.focus();
    },
    setSelectionRange: (s, e) => {
      el.setSelectionRange(s, e);
    },
    focused: () => document.activeElement === el,
  };
}

/** React-keyboard-event shim so one Composer.onKeyDown serves both paths. */
export type AnyKeyEvent =
  | KeyboardEvent
  | ReactKeyboardEvent<HTMLTextAreaElement>;
