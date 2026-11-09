import { useEffect, useRef, useState } from "react";

import { HEADER_H, OVERSCAN, ROW_H } from "./geometry";

// The matrix's own scrollport and what follows from scrolling it: which
// rows are mounted (`range` — the virtualisation) and the scrollport's
// width. The custom scrollbar thumbs follow the same scrolling but keep
// their geometry to themselves (MatrixScrollbars): it changes on every
// frame, and held here it would re-render the whole grid on every frame.
export function useMatrixScroll(rowCount: number) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [range, setRange] = useState({ start: 0, end: 40 });
  // The scrollport's own width, which is what the products column is sized
  // from. Zero until first measured — see productColumnWidth for why that
  // starts the column at its narrowest.
  const [gridWidth, setGridWidth] = useState(0);

  // ---- virtualisation --------------------------------------------------
  // Measured off the scroll container rather than the window: the grid owns
  // its own scrollport (that is what makes `position: sticky` work without
  // guessing the page's offset), so the page's scroll position is irrelevant
  // here. Row `i` sits at HEADER_H + i * ROW_H in flow, and the sticky header
  // always covers the top HEADER_H of the viewport, so the first row visible
  // *below* the header is simply scrollTop / ROW_H.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    let frame = 0;
    const measure = () => {
      frame = 0;
      // Guarded like the range below: this runs on every scroll frame, and
      // the width only changes when the window does.
      setGridWidth((current) => (current === element.clientWidth ? current : element.clientWidth));

      const first = Math.floor(element.scrollTop / ROW_H);
      const visible = Math.ceil(Math.max(0, element.clientHeight - HEADER_H) / ROW_H);
      const start = Math.max(0, first - OVERSCAN);
      const end = Math.min(rowCount, first + visible + OVERSCAN);
      // Same-range guard: a scroll event fires per frame, and re-rendering
      // the grid for a range it already has is the one thing that would make
      // scrolling this cheap grid expensive again.
      setRange((current) =>
        current.start === start && current.end === end ? current : { start, end },
      );
    };
    // Coalesced into a frame: scroll fires far more often than the browser
    // paints, and each un-throttled handler would queue its own React render.
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };

    measure();
    element.addEventListener("scroll", onScroll, { passive: true });
    // The visible row count changes with the window, not only with scrolling.
    const observer = new ResizeObserver(onScroll);
    observer.observe(element);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      element.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, [rowCount]);

  return { scrollRef, range, gridWidth };
}
