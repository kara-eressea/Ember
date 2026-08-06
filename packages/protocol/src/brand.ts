// The product name, once, for the whole workspace (#556).
//
// It used to be deployment config — `APP_NAME` in the container's `.env`, with
// runtime plumbing to carry it into the static web build — because "EmberChat"
// was a working title and a rename had to be a restart rather than a rebuild.
// That is settled as of 2026-08-06 (decisions.md §5): the name is final, so the
// knob has nothing left to do and the plumbing that served it is gone.
//
// It lives in `@emberchat/protocol` because that is the one package both the
// server and the web app already depend on, and a build-time literal has to be
// importable from both to be a single source of truth. Everything that shows
// the name — the wordmark, the document title, the install manifest, the prefs
// pane — imports this; a literal anywhere else is a bug (apps/web's
// `shipping-shape.test.ts` fails on one).
//
// Domains and origins are NOT frozen with it: `APP_BASE_URL` and the rest of
// the deployment config stay per-instance, because those genuinely differ per
// self-host while the product's name does not.

/**
 * The product name.
 *
 * Also the F-Chat IDN `cname` (`packages/session-engine`'s `clientName`), which
 * the F-List developer policy requires to be an honest, unique client
 * identifier. A constant satisfies that strictly better than a configurable
 * default did: there is no longer a value a deployment can set to claim it is
 * some other client. `CLIENT_VERSION` stays config — the release build feeds it
 * the tag, and the version half is the half that legitimately varies.
 */
export const APP_NAME = "EmberChat";
