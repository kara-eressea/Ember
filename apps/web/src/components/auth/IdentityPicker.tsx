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

      {identities?.map((identity) => {
        const live =
          identity.sessionStatus !== "offline" &&
          identity.sessionStatus !== "stopped";
        return (
          <div key={identity.id} className={styles.identityRow}>
            <Avatar name={identity.characterName} size={38} />
            <span className={styles.identityInfo}>
              <span className={styles.identityName}>
                {identity.characterName}
              </span>
              <br />
              <span className={styles.identityMeta}>
                {accountName(identity.flistAccountId)} ·{" "}
                {identity.sessionStatus.replace("_", " ")}
              </span>
            </span>
            {live && (
              <button
                className={styles.signOut}
                onClick={() => {
                  void api
                    .disconnectIdentity(identity.id)
                    .then(reload)
                    .catch(() => reload());
                }}
              >
                Disconnect
              </button>
            )}
            <button
              className={styles.connectButton}
              onClick={() => {
                const open = () => navigate(`/app/${identity.id}`);
                if (live) {
                  void open();
                  return;
                }
                // Connect explicitly (the shell's connect-on-visit ignores
                // logged-off identities by design), then open — failures
                // surface as session status in the shell.
                void api.connectIdentity(identity.id).then(open, open);
              }}
            >
              {live ? "Open" : "Connect"}
            </button>
            <RemoveButton
              what={`identity ${identity.characterName} and its history`}
              onConfirm={async () => {
                await api.deleteIdentity(identity.id);
                await reload();
              }}
            />
          </div>
        );
      })}

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

/** Two-step destructive action: first click arms it, second confirms. */
function RemoveButton({
  what,
  onConfirm,
}: {
  what: string;
  onConfirm: () => Promise<void>;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={`${styles.removeButton} ${armed ? (styles.removeArmed ?? "") : ""}`}
      disabled={busy}
      title={armed ? `Click again to remove ${what}` : `Remove ${what}`}
      aria-label={armed ? `Confirm removing ${what}` : `Remove ${what}`}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setBusy(true);
        void onConfirm().finally(() => {
          setBusy(false);
          setArmed(false);
        });
      }}
      onBlur={() => {
        setArmed(false);
      }}
    >
      {armed ? "Remove?" : "✕"}
    </button>
  );
}

interface AddIdentityFlowProps {
  accounts: FlistAccountDto[];
  onDone: () => void;
  onAccountsChanged: () => void;
}

type FlowMode =
  | { kind: "choose" }
  | { kind: "add" }
  | { kind: "unlock"; account: FlistAccountDto }
  | { kind: "pick"; account: FlistAccountDto };

/**
 * Add flow: choose one of the known F-List accounts (unlock it if the vault
 * lost its password), add a different one, then pick a character. A proper
 * multi-account experience arrives with M3; this covers management basics —
 * without them a dead account row bricked the add flow (M1 UAT finding).
 */
function AddIdentityFlow({
  accounts,
  onDone,
  onAccountsChanged,
}: AddIdentityFlowProps) {
  const [mode, setMode] = useState<FlowMode>(() => {
    if (accounts.length === 0) {
      return { kind: "add" };
    }
    // Fast path: exactly one account and it's usable — straight to characters.
    if (accounts.length === 1 && accounts[0]!.unlocked) {
      return { kind: "pick", account: accounts[0]! };
    }
    return { kind: "choose" };
  });

  // Removing the last account from the chooser leaves nothing to choose —
  // fall through to the blank add form instead of an empty list.
  const effective: FlowMode =
    mode.kind === "choose" && accounts.length === 0 ? { kind: "add" } : mode;

  if (effective.kind === "pick") {
    return (
      <CharacterPicker
        account={effective.account}
        onDone={onDone}
        onManage={() => {
          setMode({ kind: "choose" });
        }}
      />
    );
  }
  if (effective.kind === "add" || effective.kind === "unlock") {
    return (
      <AccountForm
        unlock={mode.kind === "unlock" ? mode.account : undefined}
        onBack={
          accounts.length > 0
            ? () => {
                setMode({ kind: "choose" });
              }
            : undefined
        }
        onReady={(account) => {
          onAccountsChanged();
          setMode({ kind: "pick", account });
        }}
      />
    );
  }
  return (
    <div>
      <p className={styles.sectionLabel}>Pick an F-List account</p>
      {accounts.map((account) => (
        <div key={account.id} className={styles.identityRow}>
          <span className={styles.identityInfo}>
            <span className={styles.identityName}>{account.accountName}</span>
            <br />
            <span className={styles.identityMeta}>
              {account.unlocked ? "unlocked" : "locked — password needed"}
            </span>
          </span>
          <button
            className={styles.connectButton}
            onClick={() => {
              setMode(
                account.unlocked
                  ? { kind: "pick", account }
                  : { kind: "unlock", account },
              );
            }}
          >
            {account.unlocked ? "Pick character" : "Unlock…"}
          </button>
          <RemoveButton
            what={`account ${account.accountName}, its identities and their history`}
            onConfirm={async () => {
              await api.deleteFlistAccount(account.id);
              onAccountsChanged();
            }}
          />
        </div>
      ))}
      <button
        className={styles.addRow}
        onClick={() => {
          setMode({ kind: "add" });
        }}
      >
        <span className={styles.addChip}>+</span>
        Use a different F-List account
      </button>
    </div>
  );
}

function AccountForm({
  unlock,
  onBack,
  onReady,
}: {
  /** Set = re-enter the password for this known account (name fixed). */
  unlock: FlistAccountDto | undefined;
  onBack: (() => void) | undefined;
  onReady: (account: FlistAccountDto) => void;
}) {
  const [accountName, setAccountName] = useState(unlock?.accountName ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const { account } = unlock
        ? await api.unlockFlistAccount(unlock.id, password)
        : await api.addFlistAccount({ accountName, password });
      onReady(account);
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
        {unlock ? "Unlock your F-List account" : "Your F-List account"}
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
          disabled={unlock !== undefined}
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
        {unlock ? "Unlock" : "Verify account"}
      </button>
      {onBack && (
        <button
          type="button"
          className={styles.linkButton}
          onClick={onBack}
          disabled={busy}
        >
          Back to your accounts
        </button>
      )}
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
  onManage,
}: {
  account: FlistAccountDto;
  onDone: () => void;
  onManage: () => void;
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
      <button type="button" className={styles.linkButton} onClick={onManage}>
        Manage accounts
      </button>
    </div>
  );
}
