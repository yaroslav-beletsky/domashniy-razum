"use client";

import { useSyncExternalStore } from "react";

/** matchMedia без гидратационных расхождений: на сервере — defaultValue. */
export function useMediaQuery(query: string, defaultValue = false): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(query);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(query).matches,
    () => defaultValue,
  );
}
