// The one rule for colouring a character's NAME, everywhere (#493).
//
// A name is coloured by the character's GENDER — never by a hash of the name.
// The hash palette (nickColor) draws from the same pastel violets, pinks and
// blues the gender palette does, so a hashed name regularly lands on the hue
// the chat uses for another gender: the reported bug was a woman's name in the
// mini profile card reading as a man's. Gender colouring is supplementary, so
// a gender we do not know takes NO colour and the name renders in the default
// text token — exactly what the member list and the message log already do.
//
// Chat surfaces that only ever have the roster keep using `useGenderColorVar`
// in the sessions store; this module is that same resolver plus the profile
// fallback, for the surfaces that hold a ProfileDto as well.
//
// The chat's source of truth is the session roster (`genderOf`, #338): the
// gender F-Chat serves for whoever is on screen. A profile surface may also
// hold the character's own profile, whose Gender infotag is that same value
// from F-List's other end. The roster wins where it speaks, so a name on a
// card can never disagree with the same name in the log; the profile fills in
// only for characters no open channel knows about.

import { INFOTAG_IDS } from "@emberchat/matcher";
import type { ProfileDto } from "@emberchat/protocol";
import { genderOf, useSessionsStore } from "../stores/sessions.js";
import { genderColorVar } from "../theme/tokens.js";

/** A profile's own Gender infotag, or undefined when it is not set. */
export function profileGender(
  profile: ProfileDto | undefined,
): string | undefined {
  if (!profile) {
    return undefined;
  }
  for (const group of profile.infotagGroups) {
    const tag = group.tags.find((entry) => entry.id === INFOTAG_IDS.gender);
    if (tag && tag.value !== "") {
      return tag.value;
    }
  }
  return undefined;
}

/**
 * A resolver for surfaces that colour many names in one render (a result list,
 * a guestbook page): one store read, any number of names. Returns the
 * `var(--eb-gender-…)` token for a name, or undefined when neither the roster
 * nor the passed profile knows a gender we have a colour for.
 */
export function useNameColors(
  identityId: string | undefined,
): (name: string, profile?: ProfileDto) => string | undefined {
  const session = useSessionsStore((s) =>
    identityId === undefined ? undefined : s.sessions[identityId],
  );
  return (name, profile) =>
    genderColorVar(genderOf(session, name)) ??
    genderColorVar(profileGender(profile));
}

/** One name's colour token — the single-name form of `useNameColors`. */
export function useNameColor(
  identityId: string | undefined,
  name: string,
  profile?: ProfileDto,
): string | undefined {
  return useNameColors(identityId)(name, profile);
}
