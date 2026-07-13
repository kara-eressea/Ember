import { useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { ApiError } from "../../lib/api.js";
import { useAuthStore } from "../../stores/auth.js";
import { AuthCard } from "./AuthCard.js";
import styles from "./auth.module.css";

export function Login() {
  const login = useAuthStore((s) => s.login);
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await login({ email, password, remember });
      // A deep link bounced through RequireAuth resumes where it pointed.
      const from = (location.state as { from?: string } | null)?.from;
      await navigate(from ?? "/identities");
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard title="Log in" sub="Welcome back.">
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <form
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Email</span>
          <input
            className={styles.input}
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
            }}
            autoComplete="email"
            required
          />
        </label>
        <label className={styles.field}>
          <span className={styles.metaRow}>
            <span className={styles.fieldLabel}>Password</span>
            <span
              className={styles.forgot}
              title="Password reset arrives with email verification (v1.0)"
            >
              Forgot?
            </span>
          </span>
          <input
            className={styles.input}
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
            }}
            autoComplete="current-password"
            required
          />
        </label>
        <label className={styles.checkboxRow}>
          <input
            className={styles.checkbox}
            type="checkbox"
            checked={remember}
            onChange={(e) => {
              setRemember(e.target.checked);
            }}
          />
          Keep me signed in
        </label>
        <button className={styles.primaryButton} type="submit" disabled={busy}>
          Log in
        </button>
      </form>
      <p className={styles.footNote}>
        Next: choose which identity to connect with.
      </p>
      <p className={styles.footNote}>
        New here? <Link to="/register">Create an account</Link>
      </p>
    </AuthCard>
  );
}
