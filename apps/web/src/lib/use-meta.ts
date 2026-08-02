// Server meta (running version + the quiet update hint). It only changes when
// the server restarts, so one in-flight fetch is shared by every consumer —
// the sidebar head and the preferences About line don't each hit /api/meta.

import { useEffect, useState } from "react";
import { api, type MetaDto } from "./api.js";

let pending: Promise<MetaDto> | undefined;

/** Undefined until the fetch lands, and forever if it fails — every caller
 * renders without a version rather than showing an error. */
export function useServerMeta(): MetaDto | undefined {
  const [meta, setMeta] = useState<MetaDto>();
  useEffect(() => {
    let live = true;
    const request = (pending ??= api.getMeta());
    request.then(
      (value) => {
        if (live) {
          setMeta(value);
        }
      },
      () => {
        // A later mount (post-reconnect, say) may still succeed.
        if (pending === request) {
          pending = undefined;
        }
      },
    );
    return () => {
      live = false;
    };
  }, []);
  return meta;
}

/** Tags carry the leading "v", CLIENT_VERSION does not — display both alike. */
export function displayVersion(version: string): string {
  return version.startsWith("v") ? version : `v${version}`;
}
