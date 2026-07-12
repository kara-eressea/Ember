// Placeholder for the app shell — replaced by the real AppShell in M1
// step 10 (sidebar, message log, member list, gateway socket).

import { Link, useParams } from "react-router";

export function AppPlaceholder() {
  const { identityId } = useParams();
  return (
    <div style={{ padding: 32 }}>
      <h1 style={{ fontSize: 18 }}>App shell arrives in the next step</h1>
      <p style={{ color: "var(--eb-dim)" }}>
        Identity <code>{identityId}</code> is selected; live chat lands with the
        app shell.
      </p>
      <Link to="/identities">← Back to identities</Link>
    </div>
  );
}
