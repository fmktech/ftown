"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

export interface PersistCodec<T> {
  serialize?: (value: T) => string;
  deserialize?: (raw: string) => T;
}

/**
 * useState persisted to localStorage under `key`.
 *
 * Hydration-safe for Next.js: the first render always uses `initial` (so
 * server and client markup match), then the stored value is loaded in a
 * mount effect. The setter writes through to localStorage (skipped when the
 * value is unchanged); both read and write are wrapped in try/catch so
 * private browsing, quota errors, and malformed payloads degrade to
 * in-memory state.
 *
 * Default codec is JSON; pass `serialize`/`deserialize` for raw-string or
 * non-JSON-representable values (see `stringSetCodec`).
 */
export function usePersistentState<T>(
  key: string,
  initial: T,
  opts?: PersistCodec<T>,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(initial);
  const codecRef = useRef(opts);
  codecRef.current = opts;

  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) {
        const deserialize =
          codecRef.current?.deserialize ?? ((r: string) => JSON.parse(r) as T);
        setValue(deserialize(raw));
      }
    } catch {
      /* ignore — keep the in-memory initial */
    }
  }, [key]);

  const set = useCallback<Dispatch<SetStateAction<T>>>(
    (action) => {
      setValue((prev) => {
        const next =
          typeof action === "function" ? (action as (p: T) => T)(prev) : action;
        if (!Object.is(next, prev)) {
          try {
            const serialize =
              codecRef.current?.serialize ?? ((v: T) => JSON.stringify(v));
            localStorage.setItem(key, serialize(next));
          } catch {
            /* ignore — state still updates in memory */
          }
        }
        return next;
      });
    },
    [key],
  );

  return [value, set];
}

/** Codec for `Set<string>` stored as a JSON array (the app's existing format). */
export const stringSetCodec: PersistCodec<Set<string>> = {
  serialize: (v) => JSON.stringify([...v]),
  deserialize: (raw) => new Set(JSON.parse(raw) as string[]),
};

/**
 * A persisted hidden-id set: the standard "hide this row" pattern.
 * Stored byte-compatibly with the app's historical format (JSON id array).
 */
export function useHiddenSet(key: string): {
  hidden: Set<string>;
  hide: (id: string) => void;
  unhide: (id: string) => void;
} {
  const [hidden, setHidden] = usePersistentState<Set<string>>(
    key,
    EMPTY_SET,
    stringSetCodec,
  );

  const hide = useCallback(
    (id: string) => {
      setHidden((prev) => {
        if (prev.has(id)) return prev;
        const next = new Set(prev);
        next.add(id);
        return next;
      });
    },
    [setHidden],
  );

  const unhide = useCallback(
    (id: string) => {
      setHidden((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    },
    [setHidden],
  );

  return useMemo(() => ({ hidden, hide, unhide }), [hidden, hide, unhide]);
}

const EMPTY_SET: Set<string> = new Set();
