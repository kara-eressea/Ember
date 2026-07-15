// Highlights pane (COMPONENTS.md §12, M5 step 6): the rules CRUD over
// GET/PUT /api/highlight-rules (full-list replacement — the server compiles
// regex rules in RE2 and 422s ones it refuses), the own-nick toggle, and the
// when-highlighted actions. Rule changes affect new messages only: the
// mention flag is stamped at persist time and immutable (decisions.md §10).

import { useEffect, useState, type FormEvent } from "react";
import {
  HIGHLIGHT_RULE_KINDS,
  MAX_HIGHLIGHT_PATTERN_LENGTH,
  MAX_HIGHLIGHT_RULES,
  PREFS_DEFAULTS,
} from "@emberchat/protocol";
import type { HighlightRuleDto, HighlightRuleKind } from "@emberchat/protocol";
import { api, ApiError } from "../../lib/api.js";
import { playHighlightChime } from "../../lib/highlight-notify.js";
import { useSessionsStore } from "../../stores/sessions.js";
import { ACCENTS, type AccentId } from "../../theme/tokens.js";
import { FieldRow, GroupLabel, Segmented, Swatch, Toggle } from "./controls.js";
import { patchPrefs } from "./patch.js";
import styles from "./prefs.module.css";

const KIND_LABELS: Record<HighlightRuleKind, string> = {
  word: "Word",
  nick: "Nick",
  regex: "Regex",
};

const KIND_HINTS: Record<HighlightRuleKind, string> = {
  word: "Matched at word boundaries, case-insensitively",
  nick: "A character name, matched like a word",
  regex: "A regular expression, applied as written (case-insensitive)",
};

export function HighlightsPane({ identityId }: { identityId: string }) {
  const prefs = useSessionsStore(
    (s) => s.sessions[identityId]?.prefs ?? PREFS_DEFAULTS,
  );
  const set = (patch: Parameters<typeof patchPrefs>[1]) => {
    void patchPrefs(identityId, patch);
  };

  return (
    <>
      <GroupLabel>Rules</GroupLabel>
      <FieldRow
        label="Highlight my character's name"
        help="Messages naming the receiving character count as mentions"
      >
        <Toggle
          label="Highlight my character's name"
          checked={prefs.highlightOwnNick}
          onChange={(highlightOwnNick) => {
            set({ highlightOwnNick });
          }}
        />
      </FieldRow>
      <RulesEditor />

      <GroupLabel>When highlighted</GroupLabel>
      <FieldRow label="Play a sound">
        <Toggle
          label="Play a sound"
          checked={prefs.highlightSound}
          onChange={(highlightSound) => {
            if (highlightSound) {
              // Preview doubles as the browser's autoplay-unlock gesture.
              playHighlightChime();
            }
            set({ highlightSound });
          }}
        />
      </FieldRow>
      <FieldRow label="Flash the tab title">
        <Toggle
          label="Flash the tab title"
          checked={prefs.highlightFlashTitle}
          onChange={(highlightFlashTitle) => {
            set({ highlightFlashTitle });
          }}
        />
      </FieldRow>
      <FieldRow
        label="Bump conversation to top"
        help="A mentioned conversation floats up its sidebar section"
      >
        <Toggle
          label="Bump conversation to top"
          checked={prefs.highlightBump}
          onChange={(highlightBump) => {
            set({ highlightBump });
          }}
        />
      </FieldRow>
      <FieldRow
        label="Highlight color"
        help="The tint behind mentioned messages"
      >
        <div
          className={styles.swatchRow}
          role="radiogroup"
          aria-label="Highlight color"
        >
          <Swatch
            color={ACCENTS[prefs.accent].hex}
            label="Match accent"
            selected={prefs.highlightTint === "accent"}
            onClick={() => {
              set({ highlightTint: "accent" });
            }}
          />
          {(Object.keys(ACCENTS) as AccentId[]).map((id) => (
            <Swatch
              key={id}
              color={ACCENTS[id].hex}
              label={ACCENTS[id].label}
              selected={prefs.highlightTint === id}
              onClick={() => {
                set({ highlightTint: id });
              }}
            />
          ))}
        </div>
      </FieldRow>
    </>
  );
}

/**
 * The rules list + add form. Local state seeded from GET; every mutation is
 * an idempotent PUT of the whole list, and the response (with server ids)
 * replaces the local copy — no optimistic divergence to reconcile.
 */
function RulesEditor() {
  const [rules, setRules] = useState<HighlightRuleDto[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<HighlightRuleKind>("word");
  const [pattern, setPattern] = useState("");

  useEffect(() => {
    let cancelled = false;
    api
      .listHighlightRules()
      .then((result) => {
        if (!cancelled) {
          setRules(result.rules);
        }
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(
            loadError instanceof ApiError
              ? loadError.message
              : "Could not load highlight rules",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function save(
    next: { kind: HighlightRuleKind; pattern: string }[],
  ): Promise<boolean> {
    if (!rules) {
      return false;
    }
    setBusy(true);
    setError(undefined);
    try {
      // knownIds = the list this pane is editing; a 409 means another
      // device changed the rules since — reload instead of clobbering.
      const result = await api.putHighlightRules(
        next,
        rules.map((rule) => rule.id),
      );
      setRules(result.rules);
      return true;
    } catch (saveError) {
      if (saveError instanceof ApiError && saveError.status === 409) {
        const fresh = await api.listHighlightRules().catch(() => undefined);
        if (fresh) {
          setRules(fresh.rules);
        }
      }
      setError(
        saveError instanceof ApiError
          ? saveError.message
          : "Could not save highlight rules",
      );
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    const trimmed = pattern.trim();
    if (!trimmed || !rules || busy) {
      return;
    }
    if (await save([...rules, { kind, pattern: trimmed }])) {
      setPattern("");
    }
  }

  function remove(id: string) {
    if (!rules || busy) {
      return;
    }
    void save(rules.filter((rule) => rule.id !== id));
  }

  return (
    <div className={styles.rulesEditor}>
      {rules === undefined && !error && (
        <p className={styles.rulesEmpty}>Loading rules…</p>
      )}
      {rules !== undefined && rules.length === 0 && (
        <p className={styles.rulesEmpty}>
          No rules yet — add words, names, or regexes to be alerted on.
        </p>
      )}
      {rules !== undefined && rules.length > 0 && (
        <ul className={styles.ruleList} aria-label="Highlight rules">
          {rules.map((rule) => (
            <li key={rule.id} className={styles.ruleChip}>
              <span className={styles.ruleKind}>{KIND_LABELS[rule.kind]}</span>
              <span className={styles.rulePattern}>{rule.pattern}</span>
              <button
                type="button"
                className={styles.ruleRemove}
                aria-label={`Remove rule ${rule.pattern}`}
                disabled={busy}
                onClick={() => {
                  remove(rule.id);
                }}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className={styles.ruleForm}
        onSubmit={(event) => {
          void add(event);
        }}
      >
        <Segmented
          label="Rule kind"
          options={HIGHLIGHT_RULE_KINDS.map((value) => ({
            value,
            label: KIND_LABELS[value],
          }))}
          value={kind}
          onChange={setKind}
        />
        <input
          className={styles.textInput}
          value={pattern}
          onChange={(event) => {
            setPattern(event.target.value);
          }}
          maxLength={MAX_HIGHLIGHT_PATTERN_LENGTH}
          placeholder={kind === "regex" ? "pattern…" : "word or name…"}
          aria-label="Rule pattern"
        />
        <button
          type="submit"
          className={styles.ruleAdd}
          disabled={
            busy ||
            !pattern.trim() ||
            rules === undefined ||
            rules.length >= MAX_HIGHLIGHT_RULES
          }
        >
          Add
        </button>
      </form>
      <p className={styles.rulesHint}>
        {KIND_HINTS[kind]}. Rule changes apply to new messages only.
      </p>
      {error && (
        <p className={styles.paneError} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
