// Inline-rendering composer input (#226): CodeMirror 6 with a plain-string
// document. The document model IS the markdown the user typed — decorations
// from markdownSpans() (the translator's own walk) style **bold** /
// *italic* / ~~strike~~ / ||spoiler|| / `code` / [eicon] in place, so
// nothing is ever serialized from HTML and mdToBBCode remains the only wire
// translation. The component exposes the textarea-shaped ComposerInputHandle
// so every existing composer-edit.ts transform and the toolbar's caret
// reflection re-target it unchanged. This module is only ever loaded via
// dynamic import (React.lazy in Composer) — CodeMirror stays off the
// login/critical path.

import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import {
  defaultKeymap,
  history,
  historyKeymap,
  insertNewline,
} from "@codemirror/commands";
import {
  Compartment,
  EditorState,
  Prec,
  RangeSetBuilder,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  keymap,
  placeholder as cmPlaceholder,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { markdownSpans, type MdSpanType } from "@emberchat/markdown-bbcode";
import { eiconUrl } from "../../lib/avatar.js";
import type { ComposerInputHandle } from "./composer-input.js";

const SPAN_CLASS: Record<MdSpanType, string> = {
  bold: "emb-b",
  italic: "emb-i",
  strike: "emb-s",
  spoiler: "emb-spoiler",
  code: "emb-code",
  eicon: "emb-eicon",
  delim: "emb-delim",
};

const marks = Object.fromEntries(
  (Object.entries(SPAN_CLASS) as [MdSpanType, string][]).map(([type, cls]) => [
    type,
    Decoration.mark({ class: cls }),
  ]),
) as Record<MdSpanType, Decoration>;

/** A typed [eicon]name[/eicon] shown as the actual image while the caret is
 * elsewhere; touching it with the selection reveals the editable text. */
class EiconWidget extends WidgetType {
  constructor(readonly name: string) {
    super();
  }
  override eq(other: EiconWidget): boolean {
    return other.name === this.name;
  }
  override toDOM(): HTMLElement {
    const img = document.createElement("img");
    img.className = "emb-eicon-img";
    img.alt = `[eicon]${this.name}[/eicon]`;
    const url = eiconUrl(this.name);
    if (url !== undefined) {
      img.src = url;
    }
    return img;
  }
}

const EICON_TEXT = /^\[eicon]([\s\S]*)\[\/eicon]$/i;

function decorate(state: EditorState): DecorationSet {
  const doc = state.doc.toString();
  const { from: selFrom, to: selTo } = state.selection.main;
  const builder = new RangeSetBuilder<Decoration>();
  for (const span of markdownSpans(doc)) {
    // Eicons render as the real image once the caret leaves them; while the
    // selection touches the range the markdown text stays visible/editable.
    if (span.type === "eicon" && (selTo < span.from || selFrom > span.to)) {
      const name = EICON_TEXT.exec(doc.slice(span.from, span.to))?.[1];
      if (name !== undefined && eiconUrl(name) !== undefined) {
        builder.add(
          span.from,
          span.to,
          Decoration.replace({ widget: new EiconWidget(name) }),
        );
        continue;
      }
    }
    builder.add(span.from, span.to, marks[span.type]);
  }
  return builder.finish();
}

const inlineDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = decorate(view.state);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet) {
        this.decorations = decorate(update.state);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

// At rest the editor is the textarea (chat.module.css .composerInput): same
// font ramp, colors, caret and placeholder from the --eb-* tokens, and the
// same 160px autogrow cap with the scroller taking over past it.
const theme = EditorView.theme({
  "&": {
    flex: "1",
    minWidth: "0",
    color: "var(--eb-text)",
    fontSize: "13.5px",
    lineHeight: "1.5",
  },
  ".cm-content": {
    padding: "0",
    fontFamily: "inherit",
    caretColor: "var(--eb-text)",
  },
  ".cm-line": { padding: "0" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "inherit",
    lineHeight: "inherit",
    maxHeight: "160px",
    overflowY: "auto",
  },
  ".cm-placeholder": { color: "var(--eb-meta)" },
  ".emb-b": { fontWeight: "700" },
  ".emb-i": { fontStyle: "italic" },
  ".emb-s": { textDecoration: "line-through" },
  ".emb-spoiler": {
    background: "var(--eb-codebg)",
    borderRadius: "3px",
  },
  ".emb-code": {
    fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
    background: "var(--eb-codebg)",
    borderRadius: "3px",
  },
  ".emb-eicon": {
    color: "var(--eb-accent)",
    background: "var(--eb-codebg)",
    borderRadius: "4px",
  },
  ".emb-eicon-img": {
    height: "1.4em",
    width: "auto",
    verticalAlign: "-0.35em",
  },
  ".emb-delim": { color: "var(--eb-meta)" },
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
  handleRef: Ref<ComposerInputHandle | null>;
  ariaLabel: string;
}

export default function InlineEditor(props: InlineEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView>(null);
  // Latest callbacks without rebuilding the editor — synced in an effect
  // (react-compiler: refs are never touched during render).
  const cbRef = useRef({
    onChange: props.onChange,
    onKeyDown: props.onKeyDown,
  });
  useEffect(() => {
    cbRef.current = { onChange: props.onChange, onKeyDown: props.onKeyDown };
  });
  const dynamicRef = useRef(new Compartment());

  // The textarea-shaped handle dereferences the live view at call time, so
  // it can be created once and outlive editor setup/teardown.
  useImperativeHandle(
    props.handleRef,
    (): ComposerInputHandle => ({
      get value() {
        return viewRef.current?.state.doc.toString() ?? "";
      },
      get selectionStart() {
        return viewRef.current?.state.selection.main.from ?? 0;
      },
      get selectionEnd() {
        return viewRef.current?.state.selection.main.to ?? 0;
      },
      focus() {
        viewRef.current?.focus();
      },
      setSelectionRange(start, end) {
        const view = viewRef.current;
        if (!view) {
          return;
        }
        const max = view.state.doc.length;
        view.dispatch({
          selection: {
            anchor: Math.min(start, max),
            head: Math.min(end, max),
          },
        });
      },
      focused() {
        return viewRef.current?.hasFocus ?? false;
      },
      applyEdit(text, selStart, selEnd) {
        const view = viewRef.current;
        if (!view) {
          return;
        }
        view.focus();
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
          selection: {
            anchor: Math.min(selStart, text.length),
            head: Math.min(selEnd, text.length),
          },
        });
      },
    }),
    [],
  );

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
          EditorView.lineWrapping,
          inlineDecorations,
          theme,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              cbRef.current.onChange(update.state.doc.toString());
            }
          }),
          dynamicRef.current.of([
            cmPlaceholder(props.placeholder),
            EditorView.editable.of(!props.disabled),
          ]),
          EditorView.contentAttributes.of({ "aria-label": props.ariaLabel }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      viewRef.current = null;
      view.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- create once
  }, []);

  // Placeholder/disabled follow session state live (the textarea re-renders
  // its attributes; the editor reconfigures its compartment).
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: dynamicRef.current.reconfigure([
        cmPlaceholder(props.placeholder),
        EditorView.editable.of(!props.disabled),
      ]),
    });
  }, [props.placeholder, props.disabled]);

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
