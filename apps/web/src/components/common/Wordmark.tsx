// The product name, in the one treatment it has (#537).
//
// There were two: the sidebar head rendered the config'd name at 14px/700
// (COMPONENTS.md §2 ServerHead), and the auth card rendered a purple initial
// chip beside the same name lowercased in mono — the placeholder mark from the
// prototype, which predates the "product name is config, never a literal"
// convention and never got swept. One product, two wordmarks, and a user who
// logged in saw the second one first.
//
// Both call sites render this now. The shell's treatment is the one that
// survived, because it is the one the app wears everywhere else; the running
// version stays a ServerHead detail rather than moving in here, since it comes
// from the authenticated /api/meta and the login screen has no session to ask
// with.

import { appConfig } from "../../lib/config.js";
import styles from "./wordmark.module.css";

export function Wordmark() {
  return (
    <span className={styles.wordmark} data-testid="wordmark">
      {appConfig().appName}
    </span>
  );
}
