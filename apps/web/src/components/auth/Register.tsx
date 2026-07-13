import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { ApiError } from "../../lib/api.js";
import { useAuthStore } from "../../stores/auth.js";
import { AuthCard } from "./AuthCard.js";
import styles from "./auth.module.css";

/** 0–4: length, lowercase+uppercase, digit, symbol. */
export function passwordStrength(password: string): number {
  let score = 0;
  if (password.length >= 8) score += 1;
  if (password.length >= 12) score += 1;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
  if (/\d/.test(password) || /[^a-zA-Z0-9]/.test(password)) score += 1;
  return score;
}

export function Register() {
  const register = useAuthStore((s) => s.register);
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [terms, setTerms] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const strength = passwordStrength(password);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await register({ email, username, password });
      await navigate("/identities");
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause.message : "Registration failed",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard
      title="Create your account"
      sub="One account for every identity you connect."
    >
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
          <span className={styles.fieldLabel}>Username</span>
          <input
            className={styles.input}
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
            }}
            autoComplete="username"
            required
            minLength={3}
            maxLength={32}
          />
        </label>
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
          <span className={styles.fieldLabel}>Password</span>
          <span className={styles.fieldRow}>
            <input
              className={styles.input}
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
              }}
              autoComplete="new-password"
              required
              minLength={8}
              maxLength={128}
            />
            <button
              type="button"
              className={styles.inputSuffix}
              onClick={() => {
                setShowPassword((v) => !v);
              }}
            >
              {showPassword ? "hide" : "show"}
            </button>
          </span>
          <span className={styles.strength} aria-hidden="true">
            {[0, 1, 2, 3].map((i) => (
              <span
                key={i}
                className={
                  i < strength ? styles.strengthOn : styles.strengthSegment
                }
              />
            ))}
          </span>
        </label>
        <label className={styles.checkboxRow}>
          <input
            className={styles.checkbox}
            type="checkbox"
            checked={terms}
            onChange={(e) => {
              setTerms(e.target.checked);
            }}
            required
          />
          I agree to the terms of service
        </label>
        <button className={styles.primaryButton} type="submit" disabled={busy}>
          Create account
        </button>
      </form>
      <p className={styles.footNote}>
        Already have an account? <Link to="/login">Log in</Link>
      </p>
    </AuthCard>
  );
}
