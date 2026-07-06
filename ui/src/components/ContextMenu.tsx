"use client";

import { useState, useRef, useEffect, useLayoutEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Shared right-click / kebab context-menu primitives, extracted from the
 * pattern originated in SessionList.tsx so other lists (e.g. LoopList) can
 * reuse the same positioning, dismissal, and styling behavior.
 */

export const menuButtonStyle = {
  display: "block" as const,
  width: "100%",
  textAlign: "left" as const,
  padding: "6px 12px",
  background: "transparent",
  border: "none",
  cursor: "pointer",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
};

export const contextMenuPanelStyle = {
  position: "fixed" as const,
  zIndex: 9999,
  background: "var(--bg-elevated)",
  border: "1px solid var(--border-muted)",
  borderRadius: 6,
  padding: "4px 0",
  minWidth: 120,
  boxShadow: "0 4px 12px rgba(0, 0, 0, 0.4)",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
};

export function useDismissContextMenu(onClose: () => void, menuRef: React.RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    function handleClickOutside(e: MouseEvent | TouchEvent): void {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose();
    }
    function handleScroll(): void {
      onClose();
    }

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("touchstart", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", handleScroll, true);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("touchstart", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [onClose, menuRef]);
}

// Keep a context menu fully on screen: measure it after mount and clamp the
// desired (x, y) into the viewport with a small margin. Without this, menus
// opened on rows near the bottom of the list render partly off-screen.
export function useClampedMenuPosition(
  x: number,
  y: number,
  menuRef: React.RefObject<HTMLDivElement | null>,
): { top: number; left: number } {
  const [pos, setPos] = useState({ top: y, left: x });
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    const maxLeft = window.innerWidth - rect.width - margin;
    const maxTop = window.innerHeight - rect.height - margin;
    setPos({
      top: Math.max(margin, Math.min(y, maxTop)),
      left: Math.max(margin, Math.min(x, maxLeft)),
    });
  }, [x, y, menuRef]);
  return pos;
}

export function ContextMenuButton({
  label,
  onClick,
  color = "var(--text-secondary)",
  disabled = false,
}: {
  label: string;
  onClick: () => void;
  color?: string;
  disabled?: boolean;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      style={{
        ...menuButtonStyle,
        color: disabled ? "var(--text-faint)" : color,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.background = "var(--bg-hover)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      {label}
    </button>
  );
}

/**
 * Generic positioned, portal-rendered context menu panel. Handles outside
 * click / touch, Escape, and scroll dismissal, plus viewport clamping.
 * Callers supply the menu items as children (typically `ContextMenuButton`).
 */
export function ContextMenu({
  x,
  y,
  ariaLabel,
  onClose,
  children,
}: {
  x: number;
  y: number;
  ariaLabel: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  useDismissContextMenu(onClose, menuRef);
  const pos = useClampedMenuPosition(x, y, menuRef);
  useEffect(() => {
    menuRef.current?.focus();
  }, []);

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={ariaLabel}
      tabIndex={-1}
      style={{ ...contextMenuPanelStyle, top: pos.top, left: pos.left, outline: "none" }}
    >
      {children}
    </div>,
    document.body
  );
}
