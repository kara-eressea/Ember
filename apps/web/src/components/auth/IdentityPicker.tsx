// The second login (COMPONENTS.md §14): pick which F-List character identity
// to connect as. Identities live server-side; adding one means vaulting the
// F-List account password (once per server run) and picking a character.

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import {
  api,
  ApiError,
  type FlistAccountDto,
  type IdentityDto,
} from "../../lib/api.js";
import { useAuthStore } from "../../stores/auth.js";
import { Avatar } from "../common/Avatar.js";
import { AuthCard } from "./AuthCard.js";
import styles from "./auth.module.css";

export function IdentityPicker() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const navigate = useNavigate();

  const [identities, setIdentities] = useState<IdentityDto[]>();
  const [accounts, setAccounts] = useState<FlistAccountDto[]>();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string>();

  const reload = useCallback(async () => {
    try {
      const [identityList, accountList] = await Promise.all([
        api.listIdentities(),
        api.listFlistAccounts(),
      ]);
      setIdentities(identityList.identities);
      setAccounts(accountList.accounts);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Failed to load");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount; state is set after the response, not synchronously
    void reload();
  }, [reload]);

  const accountName = (id: string) =>
    accounts?.find((a) => a.id === id)?.accountName ?? "";

  return (
    <AuthCard
      title="Choose an identity"
      sub="Identities are your F-List characters; each connects as its own session."
      wide
    >
      <div className={styles.accountBar}>
        <span className={styles.accountChip}>
          {(user?.username ?? "?").charAt(0).toUpperCase()}
        </span>
        <span className={styles.accountMeta}>
          <span className={styles.accountName}>{user?.username}</span>
          <span className={styles.accountSub}>{user?.email} · app account</span>
        </span>
        <button
          className={styles.signOut}
          onClick={() => {
            void logout().then(() => navigate("/login"));
          }}
        >
          Sign out
        </button>
      </div>

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      {identities?.map((identity) => (
        <div key={identity.id} className={styles.identityRow}>
          <Avatar name={identity.characterName} size={38} />
          <span className={styles.identityInfo}>
            <span className={styles.identityName}>
              {identity.characterName}
            </span>
            <br />
            <span className={styles.identityMeta}>
              {accountName(identity.flistAccountId)}
            </span>
          </span>
          <button
            className={styles.connectButton}
            onClick={() => {
              void navigate(`/app/${identity.id}`);
            }}
          >
            Connect
          </button>
        </div>
      ))}

      {adding ? (
        <AddIdentityFlow
          accounts={accounts ?? []}
          onDone={() => {
            setAdding(false);
            void reload();
          }}
          onAccountsChanged={() => {
            void reload();
          }}
        />
      ) : (
        <button
          className={styles.addRow}
          onClick={() => {
            setAdding(true);
          }}
        >
          <span className={styles.addChip}>+</span>
          Add a server identity
        </button>
      )}
    </AuthCard>
  );
}

interface AddIdentityFlowProps {
  accounts: FlistAccountDto[];
  onDone: () => void;
  onAccountsChanged: () => void;
}

/** Add flow: vault an account password if needed, then pick a character. */
function AddIdentityFlow({
  accounts,
  onDone,
  onAccountsChanged,
}: AddIdentityFlowProps) {
  const unlockedAccount = accounts.find((a) => a.unlocked);
  const lockedAccount = accounts.find((a) => !a.unlocked);

  if (unlockedAccount) {
    return <CharacterPicker account={unlockedAccount} onDone={onDone} />;
  }
  return (
    <AccountForm lockedAccount={lockedAccount} onAdded={onAccountsChanged} />
  );
}

function AccountForm({
  lockedAccount,
  onAdded,
}: {
  lockedAccount: FlistAccountDto | undefined;
  onAdded: () => void;
}) {
  const [accountName, setAccountName] = useState(
    lockedAccount?.accountName ?? "",
  );
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      if (lockedAccount) {
        await api.unlockFlistAccount(lockedAccount.id, password);
      } else {
        await api.addFlistAccount({ accountName, password });
      }
      onAdded();
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause.message : "Could not add account",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <p className={styles.sectionLabel}>
        {lockedAccount ? "Unlock your F-List account" : "Your F-List account"}
      </p>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <label className={styles.field}>
        <span className={styles.fieldLabel}>F-List account name</span>
        <input
          className={styles.input}
          value={accountName}
          onChange={(e) => {
            setAccountName(e.target.value);
          }}
          disabled={lockedAccount !== undefined}
          required
        />
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>F-List password</span>
        <input
          className={styles.input}
          type="password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
          }}
          autoComplete="off"
          required
        />
      </label>
      <button className={styles.primaryButton} type="submit" disabled={busy}>
        {lockedAccount ? "Unlock" : "Verify account"}
      </button>
      <p className={styles.footNote}>
        Your password is verified with F-List and kept only in server memory —
        never stored. A server restart will ask for it again.
      </p>
    </form>
  );
}

function CharacterPicker({
  account,
  onDone,
}: {
  account: FlistAccountDto;
  onDone: () => void;
}) {
  const [characters, setCharacters] = useState<string[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .listCharacters(account.id)
      .then(({ characters: list }) => {
        setCharacters(list);
      })
      .catch((cause: unknown) => {
        setError(
          cause instanceof ApiError
            ? cause.message
            : "Could not load characters",
        );
      });
  }, [account.id]);

  async function pick(characterName: string) {
    setBusy(true);
    setError(undefined);
    try {
      await api.createIdentity({
        flistAccountId: account.id,
        characterName,
      });
      onDone();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        onDone(); // already an identity — nothing to add
        return;
      }
      setError(
        cause instanceof ApiError ? cause.message : "Could not add identity",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className={styles.sectionLabel}>Characters on {account.accountName}</p>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {characters === undefined && !error && (
        <p className={styles.footNote}>Loading characters…</p>
      )}
      <div className={styles.characterGrid} role="list">
        {characters?.map((name) => (
          <button
            key={name}
            role="listitem"
            className={styles.characterButton}
            disabled={busy}
            onClick={() => {
              void pick(name);
            }}
          >
            <Avatar name={name} size={30} />
            {name}
          </button>
        ))}
      </div>
    </div>
  );
}
