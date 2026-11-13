'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** The rows in view that are remembered: should the first leave the list, the next one holds. */
const ANCHORS = 8;

/**
 * Keeps the conversation the reader is looking at where it is on screen when rows arrive or
 * change places above it. A reader at the very top is left there, so that what is new shows,
 * and a list that no longer holds any of the rows that were in view starts from its top.
 * Returns the handler for the list's scroll event.
 */
export function useScrollAnchor(container: RefObject<HTMLElement | null>): () => void {
  const anchors = useRef<{ id: string; offset: number }[]>([]);
  const frame = useRef<number | undefined>(undefined);

  const remember = useCallback(() => {
    const root = container.current;
    anchors.current = [];
    if (!root || root.scrollTop <= 0) return;
    const top = root.getBoundingClientRect().top;
    for (const row of root.querySelectorAll<HTMLElement>('[data-conversation]')) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom <= top) continue;
      anchors.current.push({ id: row.dataset.conversation ?? '', offset: rect.top - top });
      if (anchors.current.length === ANCHORS) return;
    }
  }, [container]);

  // After every render: the rows may have moved even when the same ones are listed.
  useLayoutEffect(() => {
    const root = container.current;
    if (root && anchors.current.length > 0) {
      const top = root.getBoundingClientRect().top;
      let held = false;
      for (const saved of anchors.current) {
        const row = root.querySelector<HTMLElement>(
          `[data-conversation="${CSS.escape(saved.id)}"]`,
        );
        if (!row) continue;
        const moved = row.getBoundingClientRect().top - top - saved.offset;
        if (Math.abs(moved) >= 1) root.scrollTop += moved;
        held = true;
        break;
      }
      if (!held) root.scrollTop = 0;
    }
    remember();
  });

  useEffect(
    () => () => {
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    },
    [],
  );

  return useCallback(() => {
    if (frame.current !== undefined) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = undefined;
      remember();
    });
  }, [remember]);
}

/** How close to the end still counts as reading the newest messages. */
const NEAR_END = 48;

/**
 * Keeps a thread at its newest message for a reader who is already there, and leaves a reader
 * who has scrolled up where they are. `content` is the element that grows with the messages.
 */
export function useStickToEnd(
  container: RefObject<HTMLElement | null>,
  content: RefObject<HTMLElement | null>,
): { atEnd: boolean; onScroll: () => void; toEnd: () => void } {
  const stuck = useRef(true);
  const [atEnd, setAtEnd] = useState(true);

  const toEnd = useCallback(() => {
    const root = container.current;
    stuck.current = true;
    if (root) root.scrollTop = root.scrollHeight;
  }, [container]);

  const onScroll = useCallback(() => {
    const root = container.current;
    if (!root) return;
    const near = root.scrollHeight - root.scrollTop - root.clientHeight < NEAR_END;
    stuck.current = near;
    setAtEnd(near);
  }, [container]);

  // Both the messages and the room they have change height (a new message, a taller reply
  // box). The observer runs before the browser paints, so nothing is seen to jump.
  useLayoutEffect(() => {
    const root = container.current;
    const inner = content.current;
    if (!root || !inner) return;
    root.scrollTop = root.scrollHeight;
    const observer = new ResizeObserver(() => {
      if (stuck.current) root.scrollTop = root.scrollHeight;
    });
    observer.observe(root);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [container, content]);

  return { atEnd, onScroll, toEnd };
}
