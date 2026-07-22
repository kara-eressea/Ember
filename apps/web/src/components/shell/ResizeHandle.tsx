// Drag-to-resize grab handle for a shell column (issue #292). A thin strip on
// the column edge: hover shows the col-resize cursor, a ~6px hit area makes it
// touch-friendly, and dragging updates the shell's width CSS variable directly
// (via rAF) so the grid reflows without a React render per pixel. The parent
// owns the committed width in state and persists it; this component only
// commits the final value on pointer-up (and the default on double-click).

import {
  useRef,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import {
  clampColumnWidth,
  WIDTH_VARS,
  type ResizableColumn,
} from "../../lib/sidebar-resize.js";
import styles from "./shell.module.css";

// The IdentityRail occupies a fixed leading column; the left sidebar width is
// measured from its trailing edge, so drags offset by exactly this much.
const RAIL_WIDTH = 60;

interface Props {
  column: ResizableColumn;
  shellRef: RefObject<HTMLDivElement | null>;
  /** Design-system default this column resets to on double-click. */
  defaultWidth: number;
  /** Commit the final width to parent state + localStorage. */
  onCommit: (width: number) => void;
}

export function ResizeHandle({
  column,
  shellRef,
  defaultWidth,
  onCommit,
}: Props) {
  const rafRef = useRef<number | null>(null);
  const latestRef = useRef<number>(defaultWidth);

  function widthFromPointer(clientX: number): number | undefined {
    const shell = shellRef.current;
    if (shell === null) {
      return undefined;
    }
    const rect = shell.getBoundingClientRect();
    const raw =
      column === "left"
        ? clientX - rect.left - RAIL_WIDTH
        : rect.right - clientX;
    return clampColumnWidth(raw, column);
  }

  function applyLive(width: number) {
    latestRef.current = width;
    if (rafRef.current !== null) {
      return;
    }
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      shellRef.current?.style.setProperty(
        WIDTH_VARS[column],
        `${latestRef.current}px`,
      );
    });
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    // Only the primary button / a single touch drags; ignore the rest.
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
      return;
    }
    const width = widthFromPointer(event.clientX);
    if (width !== undefined) {
      applyLive(width);
    }
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
      return;
    }
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    onCommit(latestRef.current);
  }

  function onDoubleClick() {
    shellRef.current?.style.setProperty(
      WIDTH_VARS[column],
      `${defaultWidth}px`,
    );
    latestRef.current = defaultWidth;
    onCommit(defaultWidth);
  }

  return (
    <div
      className={`${styles.resizeHandle} ${column === "left" ? styles.resizeLeft : styles.resizeRight}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={column === "left" ? "Resize sidebar" : "Resize side column"}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onDoubleClick}
    />
  );
}
