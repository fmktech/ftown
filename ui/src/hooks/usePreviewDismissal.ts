"use client";

import { useCallback, useEffect, useState } from 'react';
import type { SessionPreviewDescriptor } from '../../../bridge/src/preview-protocol';
import { isPreviewDismissed, readDismissedPreviews, withPreviewDismissed, writeDismissedPreviews, type DismissedPreviews } from '@/lib/preview-dismissal';

/** Remembers which session previews the owner closed, per session and per preview revision. */
export function usePreviewDismissal() {
  const [dismissed, setDismissed] = useState<DismissedPreviews>(readDismissedPreviews);
  useEffect(() => { writeDismissedPreviews(dismissed); }, [dismissed]);
  const isDismissed = useCallback((sessionKey: string, descriptor: SessionPreviewDescriptor) => isPreviewDismissed(dismissed, sessionKey, descriptor), [dismissed]);
  const setPreviewDismissed = useCallback((sessionKey: string, descriptor: SessionPreviewDescriptor, value: boolean) => {
    setDismissed(previous => withPreviewDismissed(previous, sessionKey, descriptor, value));
  }, []);
  return { isDismissed, setPreviewDismissed };
}
