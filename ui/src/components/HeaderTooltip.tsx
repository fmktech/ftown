"use client";

import { cloneElement, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type ReactElement } from "react";
import { createPortal } from "react-dom";

/** A non-obstructive description for a header control or status. */
export function HeaderTooltip({ label, children, className, focusable = false }: {
  label: string; children: ReactNode; className?: string; focusable?: boolean;
}) {
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const tooltip = useRef<HTMLSpanElement>(null);
  const suppressed = useRef(false);
  const touch = useRef(false);
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState({ left: 8, top: 0 });
  const hide = () => setVisible(false);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => { if (event.key !== "Escape") touch.current = false; };
    document.addEventListener("keydown", keyboard, true);
    return () => document.removeEventListener("keydown", keyboard, true);
  }, []);
  useLayoutEffect(() => {
    if (!visible) return;
    const place = () => {
      if (!anchor.current || !tooltip.current) return;
      const rect = anchor.current.getBoundingClientRect();
      const width = tooltip.current.getBoundingClientRect().width;
      setPosition({ left: Math.max(8, Math.min(window.innerWidth - width - 8, rect.left + (rect.width - width) / 2)), top: rect.bottom + 6 });
    };
    place();
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { suppressed.current = true; hide(); } };
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { document.removeEventListener("keydown", escape); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [visible, label]);
  const child = !focusable && isValidElement<{ "aria-describedby"?: string }>(children)
    ? cloneElement(children as ReactElement<{ "aria-describedby"?: string }>, { "aria-describedby": [children.props["aria-describedby"], visible ? id : undefined].filter(Boolean).join(" ") || undefined })
    : children;
  return <>
    <span ref={anchor} className={className} style={{ display: className ? undefined : "inline-flex" }}
      role={focusable ? "group" : undefined} tabIndex={focusable ? 0 : undefined} aria-label={focusable ? label : undefined} aria-describedby={focusable && visible ? id : undefined}
      onPointerDown={event => { touch.current = event.pointerType === "touch"; }}
      onKeyDown={event => { if (event.key !== "Escape") touch.current = false; }}
      onMouseEnter={() => { if (!touch.current && !suppressed.current) setVisible(true); }}
      onMouseLeave={() => { suppressed.current = false; touch.current = false; hide(); }}
      onFocus={() => { if (!touch.current && !suppressed.current) setVisible(true); }}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) { suppressed.current = false; hide(); } }}
      onClick={() => { suppressed.current = true; hide(); }}>
      {child}
    </span>
    {visible && createPortal(<span ref={tooltip} id={id} role="tooltip" style={{ position: "fixed", left: position.left, top: position.top, zIndex: 10000, maxWidth: "min(280px, calc(100vw - 16px))", padding: "6px 8px", borderRadius: 6, border: "1px solid var(--border-muted)", background: "var(--bg-elevated)", color: "var(--text-primary)", boxShadow: "0 4px 12px rgba(0,0,0,.4)", fontSize: 11, lineHeight: 1.4, whiteSpace: "normal", pointerEvents: "none" }}>{label}</span>, document.body)}
  </>;
}
