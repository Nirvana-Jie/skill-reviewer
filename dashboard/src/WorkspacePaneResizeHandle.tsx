import { GripVertical } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import {
  nextPaneWidthFromKey,
  workspaceLayoutLimits,
  type WorkspacePane,
  type WorkspacePaneRange,
} from "./workspace-layout";

interface DragState {
  pointerId: number;
  startX: number;
  startValue: number;
}

export function WorkspacePaneResizeHandle({
  pane,
  value,
  range,
  label,
  hint,
  controls,
  onChange,
  onReset,
}: {
  pane: WorkspacePane;
  value: number;
  range: WorkspacePaneRange;
  label: string;
  hint: string;
  controls: string;
  onChange: (value: number) => void;
  onReset: () => void;
}) {
  const dragRef = useRef<DragState | null>(null);
  const teardownDragRef = useRef<((updateState?: boolean) => void) | null>(
    null,
  );
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    if (!isDragging) return;
    document.body.classList.add("is-resizing-pane");
    return () => document.body.classList.remove("is-resizing-pane");
  }, [isDragging]);

  useEffect(
    () => () => {
      teardownDragRef.current?.(false);
    },
    [],
  );

  return (
    <div
      className={`pane-resize-handle is-${pane} ${isDragging ? "is-dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controls}
      aria-valuemin={range.min}
      aria-valuemax={range.max}
      aria-valuenow={Math.round(value)}
      aria-valuetext={`${Math.round(value)} px`}
      tabIndex={0}
      title={hint}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        const next = nextPaneWidthFromKey({
          pane,
          key: event.key,
          value,
          range,
          defaultValue: workspaceLayoutLimits[pane].default,
          largeStep: event.shiftKey,
        });
        if (next === null) return;
        event.preventDefault();
        if (event.key === "Enter" || event.key === " ") onReset();
        else onChange(next);
      }}
      onPointerDown={(event) => {
        if (
          event.button !== 0 ||
          event.isPrimary === false ||
          dragRef.current
        ) {
          return;
        }
        event.preventDefault();
        const handle = event.currentTarget;
        const drag: DragState = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startValue: value,
        };
        handle.setPointerCapture?.(event.pointerId);
        dragRef.current = drag;
        setIsDragging(true);

        let finished = false;
        function handlePointerMove(pointerEvent: PointerEvent) {
          const activeDrag = dragRef.current;
          if (
            finished ||
            !activeDrag ||
            activeDrag.pointerId !== pointerEvent.pointerId
          ) {
            return;
          }
          const direction = pane === "rail" ? 1 : -1;
          const next = Math.min(
            Math.max(
              activeDrag.startValue +
                (pointerEvent.clientX - activeDrag.startX) * direction,
              range.min,
            ),
            range.max,
          );
          onChange(next);
        }

        function teardownDrag(updateState = true) {
          if (finished) return;
          finished = true;
          window.removeEventListener("pointermove", handlePointerMove);
          window.removeEventListener("pointerup", finishDrag);
          window.removeEventListener("pointercancel", finishDrag);
          window.removeEventListener("blur", handleWindowBlur);
          teardownDragRef.current = null;
          dragRef.current = null;
          if (handle.hasPointerCapture?.(drag.pointerId)) {
            handle.releasePointerCapture?.(drag.pointerId);
          }
          if (updateState) setIsDragging(false);
        }

        function finishDrag(pointerEvent: PointerEvent) {
          if (pointerEvent.pointerId !== drag.pointerId) return;
          teardownDrag();
        }

        function handleWindowBlur() {
          teardownDrag();
        }

        window.addEventListener("pointermove", handlePointerMove);
        window.addEventListener("pointerup", finishDrag);
        window.addEventListener("pointercancel", finishDrag);
        window.addEventListener("blur", handleWindowBlur);
        teardownDragRef.current = teardownDrag;
      }}
      onLostPointerCapture={() => teardownDragRef.current?.()}
    >
      <GripVertical size={12} strokeWidth={1.8} aria-hidden="true" />
    </div>
  );
}
