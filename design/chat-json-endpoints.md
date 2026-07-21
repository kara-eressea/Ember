Work in progress replacement documentation is available [https://toys.in.newtsin.space/api-docs/ at this page.]

==API Version 1==
To use most of the API endpoints, you need a ticket. The endpoints that do not require a ticket are: kink-list.php, info-list.php. 

All endpoints are POST requests.

The API(and site) is not intended for bulk data collection or export, and should not be used for such. Those found using the API in this manner will have their accounts suspended. Limit requests to one per second and character data requests to less than 200 per hour.

===Acquiring a ticket.===
POST to https://www.f-list.net/json/getApiTicket.php
Do NOT use GET for acquiring API tickets, this is being phased out.

Send two form fields, account and password.

If you do not require information about characters, friends or bookmarks, please pass one or more of the following fields with "true" as the value(without quotes):
no_characters, no_friends, no_bookmarks.

Tickets are valid for 30 minutes from issue, and invalidate all previous tickets for the account when issued.

===Sending a ticket.===
Any endpoint that requires a ticket must have the additional POST parameters of "account" which is the username of the account issued the ticket, and "ticket" which is the ticket acquired during the previous step.

===Bookmarks===
https://www.f-list.net/json/api/bookmark-add.php, Bookmark a profile. Takes one argument, "name".

https://www.f-list.net/json/api/bookmark-list.php, List all bookmarked profiles.

https://www.f-list.net/json/api/bookmark-remove.php, Remove a profile bookmark. Takes one argument, "name".

===Character data===
Note: If you try to use these on an account which is banned, timed out, blocked or deleted, you will receive an error.

https://www.f-list.net/json/api/character-data.php, Get a character's information. Requires one parameter, "name". Must be POST. Includes id, name, description, view count, infotags, kinks, custom kinks, subkinks, images, and inlines. You will need to assemble the data based on information from the mapping endpoint to obtain human readable names for infotags, kinks and list items.

https://www.f-list.net/json/api/character-list.php, Get a list of all the account's characters.

===Getting misc data===
https://www.f-list.net/json/api/group-list.php, Get the global list of all f-list groups.

https://www.f-list.net/json/api/ignore-list.php, Get a list of all profiles your account has on chat-ignore.

https://www.f-list.net/json/api/info-list.php, Get the global list of profile info fields, grouped. Dropdown options include a list of the options. Does not require the account and ticket form fields.

https://www.f-list.net/json/api/kink-list.php, Get the global list of kinks, grouped. Does not require the account and ticket form fields.

https://www.f-list.net/json/api/mapping-list.php Get the global list of kinks, infotags, infotag groups, and list items. Does not require the account and ticket form fields.

===Handling friend requests, friend list data===
https://www.f-list.net/json/api/friend-list.php, List all friends, account-wide, in a "your-character (source) => the character's friend (dest)" format. (Verified against live behaviour 2026-07-21: source is your own character, dest the friend — same orientation as friend-remove's source_name/dest_name.)

https://www.f-list.net/json/api/friend-remove.php, Remove a profile from your friends. Takes two argument, "source_name" (your char) and "dest_name" (the character's friend you're removing).

https://www.f-list.net/json/api/request-accept.php, Accept an incoming friend request. Takes one argument, "request_id", which you can get with the request-list endpoint.

https://www.f-list.net/json/api/request-cancel.php, Cancel an outgoing friend request. Takes one argument, "request_id", which you can get with the request-pending endpoint.

https://www.f-list.net/json/api/request-deny.php, Deny a friend request. Takes one argument, "request_id", which you can get with the request-list endpoint.

https://www.f-list.net/json/api/request-list.php, Get all incoming friend requests.

https://www.f-list.net/json/api/request-pending.php, Get all outgoing friend requests.

https://www.f-list.net/json/api/request-send.php, Send a friend request. source_name, dest_name.


[[Category:F-Chat]]
[[Category:Developer Resources]]

---

# Verified shapes (EmberChat endpoint spike, 2026-07-17)

Everything below this line is EmberChat documentation, not wiki copy. Source:
the M8 step-1 supervised live pass (11 requests, user-run, responses inspected
offline) plus source reading of the official client (`f-list/chat3client`) and
Horizon (`Fchat-Horizon/Horizon`) for the cases the live pass couldn't exercise.
General observations:

- Every F-List JSON response carries an `error` field — empty string on
  success, a human-readable message on failure (still HTTP 200). Check
  `error !== ''`, not the status code.
- Numeric values arrive inconsistently typed across endpoints (see
  images below) — schemas must coerce (`z.coerce.number()`), never assume.

## `getApiTicket.php` — verified

`no_friends=true` / `no_bookmarks=true` are honored and keep the payload
small. (We still need `characters` for identity setup elsewhere; the spike
passed both flags since it only needed the ticket.)

## `character-data.php` — verified

POST `account`, `ticket`, `name` (the official client can also query by
`id`). Response top-level keys:

| Key | Type | Notes |
|---|---|---|
| `id` | int | character id — needed for `character-images.php` / guestbook |
| `name` | string | canonical casing |
| `description` | string | raw BBCode (profile dialect), unicode-escaped |
| `views` | int | |
| `customs_first` | bool | display pref: custom kinks above standard |
| `custom_title` | string | |
| `is_self` | bool | true when the queried character belongs to the ticket's account |
| `settings` | object | `{customs_first, show_friends, guestbook, prevent_bookmarks, public}` — all bool. **`settings.guestbook` gates the Guestbook tab for free** |
| `badges` | string[] | empty for normal users |
| `created_at`, `updated_at` | int | unix seconds |
| `kinks` | object | `{ "<kinkId>": "fave"\|"yes"\|"maybe"\|"no" }` — ids are **string keys**, resolve names via mapping-list |
| `custom_kinks` | object | `{ "<customId>": { name, description, choice, children: number[] } }` — `children` lists standard kink ids grouped under the custom |
| `infotags` | object | `{ "<infotagId>": "<value>" }` — for `type:"list"` infotags the value is a **listitem id as a string**; for `type:"text"` it's free text. Resolve via mapping-list |
| `inlines` | object | inline-image definitions referenced from the description (empty in spike sample) |
| `images` | array | `{ image_id, extension, height, width, description, sort_order }` — **all values strings**, **no `url`**: assemble `https://static.f-list.net/images/charimage/{image_id}.{extension}` |
| `character_list` | array | account's other characters — empty unless requested/permitted |
| `timezone` | int | UTC offset hours |
| `current_user` | object | `{ inline_mode, animated_icons }` — the *viewer's* prefs |
| `error` | string | `""` on success |

## `character-images.php` — verified (undocumented on the wiki)

POST `account`, `ticket`, `id` (numeric character id). Response
`{ images: [...], error }` — same fields as `character-data.php`'s `images`
but **numerically typed** (`height`/`width`/`sort_order`/`id` are ints, key is
`id` not `image_id`) **and including a ready-made `url`**. Redundant with the
`images` array already in `character-data.php` — M8 uses the embedded array
and skips this endpoint (one less budget class).

## `character-guestbook.php` — verified live (both cases)

POST `account`, `ticket`, `id` (numeric character id), `page` — **0-based**
(confirmed live: a guestbook with posts only on its first page returns them
at `page=0` and `[]` at `page=1`), pages of 10 (official client passes
`offset/10`). Disabled guestbook →
`{ "error": "This character does not have a guestbook." }`. Success (observed):

```json
{ "posts": [ { "id": 305179, "character": { "id": 2167793, "name": "…" },
    "postedAt": 1520787424, "message": "…", "reply": null,
    "private": false, "approved": true, "canEdit": true } ],
  "page": 0, "canEdit": true, "nextPage": false, "error": "" }
```

`postedAt` is unix seconds. The top-level `page` echo and `canEdit` aren't in
the client sources' type; the sources also list `repliedAt`/`deleted` fields
not present in the observed posts (likely only when `reply` is set) — lenient
schema either way. Gate the tab on `settings.guestbook` from character-data
before ever calling this.

## `character-memo-get2.php` — verified live

POST `account`, `ticket`, `target` — **`target` is the character *name*,
not the id** (an id probe returns `{"error":"Character not found."}`;
`f-list/chat3client` and Horizon both pass the name). Response (observed):
`{ note: string|null, id: number, error }` — `note` is `null` when no memo
exists; `id` is the save target for `character-memo-save.php`
(POST `target` = that id, `note` = text). In the no-memo case the observed
`id` equaled the character id — treat it as opaque and always echo it back
to save, per the official client.

## Global mapping lists — verified (all ticketless POST)

- **`mapping-list.php`** — the one M8 actually uses; supersedes the other two
  (their content is a re-grouping of the same data). Shape:
  `{ kinks: [{id, name, description, group_id}], kink_groups: [{id, name}],
  infotags: [{id, name, type: "text"|"list", list, group_id}],
  infotag_groups: [{id, name}], listitems: [{id, name, value}], error }` —
  **every value is a string**, including ids. ~559 kinks / 26 groups /
  74 infotags / 5 groups / 166 listitems, ~130 KB. For `type:"list"` infotags,
  `list` names the listitem family (`"orientation"`, `"build"`, …) and
  `listitems.name` matches it; the profile's infotag value is the listitem `id`.
- `kink-list.php` — `{ kinks: { "<groupId>": { group, items: [{kink_id, name,
  description}] } } }` (ints here). HTML entities in group names
  (`&amp;`) — decode before display.
- `info-list.php` — `{ info: { "<groupId>": { group, items: [{id, name, type,
  list?}] } } }`; dropdown items carry their option list.

## xariah.net eicon index — model corrected

**There is no search endpoint.** The spike's `/eicons/Home/Search/<q>` and
`/BaseSearch/<q>` probes both 404'd; Horizon and XarChat instead download the
**full index** and search locally:

- `GET https://xariah.net/eicons/Home/EiconsDataBase/base.doc` — full dump,
  one eicon per line, `name\thash` tab-separated; comment lines start with
  `#`, including `# As Of: <unix-seconds>`.
- `GET https://xariah.net/eicons/Home/EiconsDataDeltaSince/<unix-seconds>` —
  incremental: `+\t<name>` / `-\t<name>` lines plus the same `# As Of:`
  footer.

Consequence for M8: the server keeps a local index (bulk fetch + periodic
delta), and `GET /api/eicons/search` greps it in-process — the user's query
never reaches xariah at all; xariah only ever sees periodic bulk fetches from
the server.
