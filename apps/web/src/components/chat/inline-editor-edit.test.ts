import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import {
  externalEdit,
  fullDocReplace,
  isProgrammatic,
} from "./inline-editor-edit.js";

// These exercise the transaction/annotation logic headlessly via EditorState
// (no DOM / EditorView needed), matching how the composer's other pure-logic
// modules are tested.

describe("isProgrammatic (#269 item 1)", () => {
  it("is false for a user keystroke transaction (onChange fires → TPN/slash)", () => {
    const state = EditorState.create({ doc: "" });
    const tr = state.update({
      changes: { from: 0, insert: "hi" },
      userEvent: "input.type",
    });
    expect(isProgrammatic([tr])).toBe(false);
    expect(tr.newDoc.toString()).toBe("hi");
  });

  it("is true for a programmatic (externalEdit-annotated) transaction", () => {
    const state = EditorState.create({ doc: "" });
    const tr = state.update({
      changes: { from: 0, insert: "[eicon]cat[/eicon]" },
      annotations: externalEdit.of(true),
    });
    // Toolbar/eicon/slash inserts must NOT re-fire onChange, so no spurious
    // typing TPN reaches the wire and the slash popover is not reset.
    expect(isProgrammatic([tr])).toBe(true);
  });
});

describe("fullDocReplace (#269 item 2)", () => {
  it("replaces the whole document and carries the caret to the end", () => {
    const state = EditorState.create({ doc: "old draft" });
    const next = "recalled message";
    const after = state.update(fullDocReplace(state.doc.length, next)).state;
    expect(after.doc.toString()).toBe(next);
    // A bare {from,to,insert} collapses the selection to 0 on a full replace;
    // fullDocReplace anchors the caret at the end of the restored text.
    expect(after.selection.main.head).toBe(next.length);
    expect(after.selection.main.anchor).toBe(next.length);
  });

  it("marks the replace as programmatic so onChange stays silent", () => {
    const state = EditorState.create({ doc: "x" });
    const tr = state.update(fullDocReplace(state.doc.length, "y"));
    expect(isProgrammatic([tr])).toBe(true);
  });

  it("clears the caret to 0 when the new text is empty (send-clear)", () => {
    const state = EditorState.create({ doc: "sent" });
    const after = state.update(fullDocReplace(state.doc.length, "")).state;
    expect(after.doc.toString()).toBe("");
    expect(after.selection.main.head).toBe(0);
  });
});
