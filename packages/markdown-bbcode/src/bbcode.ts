// BBCode AST for exactly the F-Chat chat subset (design/chat-bbcode-tags.md):
// b i u s sup sub color url user icon eicon noparse. The parser never
// interprets anything outside the subset — unknown or malformed tags come
// back as literal text, which is also how the official clients display them.
// Renderers consume the AST; `sanitizeBBCode` is the parse→serialize
// normalization for contexts that need a guaranteed-subset string.

/** The [color=…] names F-Chat accepts (fixed list, wiki-verified). */
export const BB_COLORS = [
  "red",
  "blue",
  "white",
  "yellow",
  "pink",
  "gray",
  "green",
  "orange",
  "purple",
  "black",
  "brown",
  "cyan",
] as const;
export type BBColor = (typeof BB_COLORS)[number];

/** Plain formatting wrappers: nestable, no parameters. */
export const BB_WRAPPER_TAGS = ["b", "i", "u", "s", "sup", "sub"] as const;
export type BBWrapperTag = (typeof BB_WRAPPER_TAGS)[number];

/** Tags whose body is a bare F-List name, never markup. */
export const BB_NAME_TAGS = ["user", "icon", "eicon"] as const;
export type BBNameTag = (typeof BB_NAME_TAGS)[number];

/** Profile-dialect block tags (M8): parsed only under dialect "profile" —
 * on the chat wire they stay literal text, exactly as before. */
export const BB_BLOCK_TAGS = [
  "heading",
  "big",
  "small",
  "quote",
  "left",
  "center",
  "right",
  "justify",
  "indent",
] as const;
export type BBBlockTag = (typeof BB_BLOCK_TAGS)[number];

export type BBDialect = "chat" | "profile";

export type BBNode =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "wrapper";
      readonly tag: BBWrapperTag;
      readonly children: readonly BBNode[];
    }
  | {
      readonly type: "color";
      readonly color: BBColor;
      readonly children: readonly BBNode[];
    }
  | {
      readonly type: "url";
      readonly href: string;
      readonly children: readonly BBNode[];
    }
  | { readonly type: "name"; readonly tag: BBNameTag; readonly name: string }
  | { readonly type: "noparse"; readonly text: string }
  // Profile-dialect nodes — never produced under dialect "chat".
  | {
      readonly type: "block";
      readonly tag: BBBlockTag;
      readonly children: readonly BBNode[];
    }
  | {
      readonly type: "collapse";
      readonly title: string;
      readonly children: readonly BBNode[];
    }
  | { readonly type: "hr" };

/** F-List character names; eicon names additionally allow dots. */
const NAME_RE = /^[a-zA-Z0-9 _.-]{1,64}$/;

/** The wiki is explicit: the scheme is required or the URL "fails as bad". */
export function validHref(href: string): boolean {
  return /^https?:\/\/\S+$/i.test(href);
}

export interface TagToken {
  readonly closing: boolean;
  readonly tag: string;
  readonly param: string | undefined;
  /** Raw source of the token, for literalizing. */
  readonly raw: string;
  readonly length: number;
}

/** Matches `[tag]`, `[/tag]`, `[tag=param]` at `input[at]`, or nothing.
 * Shared with the Markdown translator — one tag grammar, one place.
 * A closer carrying a parameter (`[/b=x]`) is not a token: officially
 * meaningless, so it must literalize rather than silently drop the param. */
export function readTagToken(input: string, at: number): TagToken | undefined {
  const match = /^\[(\/?)([a-zA-Z]+)(?:=([^\]\n]*))?\]/.exec(input.slice(at));
  if (!match || (match[1] === "/" && match[3] !== undefined)) {
    return undefined;
  }
  return {
    closing: match[1] === "/",
    tag: match[2]!.toLowerCase(),
    param: match[3],
    raw: match[0],
    length: match[0].length,
  };
}

function isWrapperTag(tag: string): tag is BBWrapperTag {
  return (BB_WRAPPER_TAGS as readonly string[]).includes(tag);
}

function isBlockTag(tag: string): tag is BBBlockTag {
  return (BB_BLOCK_TAGS as readonly string[]).includes(tag);
}

function isNameTag(tag: string): tag is BBNameTag {
  return (BB_NAME_TAGS as readonly string[]).includes(tag);
}

function isColor(param: string): param is BBColor {
  return (BB_COLORS as readonly string[]).includes(param);
}

interface Frame {
  /** The node under construction; text/children accumulate in `children`. */
  readonly open: TagToken;
  readonly children: BBNode[];
}

function pushText(children: BBNode[], text: string): void {
  if (text === "") {
    return;
  }
  const last = children.at(-1);
  if (last?.type === "text") {
    children[children.length - 1] = { type: "text", text: last.text + text };
    return;
  }
  children.push({ type: "text", text });
}

/**
 * Closer lookup over an already-lowercased input. Positions for each tag
 * are collected in one scan and consumed through a monotonic cursor, so a
 * hostile message (thousands of closer-less openers) costs O(n) total —
 * naive per-opener indexOf misses re-scan the tail every time, which is
 * quadratic and a denial of service on whoever renders the message.
 * Callers' `from` values must be non-decreasing per tag (both scanners
 * advance strictly left to right).
 */
export function makeCloserFinder(
  lower: string,
): (tag: string, from: number) => number {
  const positions = new Map<string, number[]>();
  const cursors = new Map<string, number>();
  return (tag, from) => {
    let list = positions.get(tag);
    if (!list) {
      list = [];
      const needle = `[/${tag}]`;
      for (
        let i = lower.indexOf(needle);
        i !== -1;
        i = lower.indexOf(needle, i + 1)
      ) {
        list.push(i);
      }
      positions.set(tag, list);
      cursors.set(tag, 0);
    }
    let cursor = cursors.get(tag)!;
    while (cursor < list.length && list[cursor]! < from) {
      cursor += 1;
    }
    cursors.set(tag, cursor);
    return cursor < list.length ? list[cursor]! : -1;
  };
}

/**
 * Parses BBCode into the subset AST. Lenient by design: unknown tags,
 * mismatched closers, bad parameters, and unclosed openers all become
 * literal text rather than errors — chat input is hostile and the wire
 * must never make us throw.
 *
 * Dialect "profile" (M8) additionally accepts the profile block tags
 * (heading/big/small/quote/alignment/indent), `[collapse=Title]`, and the
 * void `[hr]` — profile descriptions use a wider set than the chat wire.
 * Anything still unrecognized degrades to literal text either way.
 */
export function parseBBCode(
  input: string,
  dialect: BBDialect = "chat",
): BBNode[] {
  const root: Frame = {
    open: { closing: false, tag: "", param: undefined, raw: "", length: 0 },
    children: [],
  };
  const stack: Frame[] = [root];
  // One lowercase pass + indexed closer lookup (see makeCloserFinder).
  const findClose = makeCloserFinder(input.toLowerCase());
  let at = 0;

  const top = (): Frame => stack[stack.length - 1]!;

  while (at < input.length) {
    const bracket = input.indexOf("[", at);
    if (bracket === -1) {
      pushText(top().children, input.slice(at));
      break;
    }
    if (bracket > at) {
      pushText(top().children, input.slice(at, bracket));
      at = bracket;
    }
    const token = readTagToken(input, at);
    if (!token) {
      pushText(top().children, "[");
      at += 1;
      continue;
    }

    if (token.closing) {
      if (stack.length > 1 && top().open.tag === token.tag) {
        const frame = stack.pop()!;
        top().children.push(buildNode(frame));
      } else {
        // A closer with no matching opener on top: literal.
        pushText(top().children, token.raw);
      }
      at += token.length;
      continue;
    }

    // Raw-body tags: consume straight to their closer, no nesting.
    if (token.tag === "noparse" && token.param === undefined) {
      const bodyStart = at + token.length;
      const close = findClose("noparse", bodyStart);
      if (close === -1) {
        pushText(top().children, token.raw);
        at = bodyStart;
        continue;
      }
      top().children.push({
        type: "noparse",
        text: input.slice(bodyStart, close),
      });
      at = close + "[/noparse]".length;
      continue;
    }
    if (isNameTag(token.tag) && token.param === undefined) {
      const bodyStart = at + token.length;
      const close = findClose(token.tag, bodyStart);
      const name = close === -1 ? undefined : input.slice(bodyStart, close);
      if (name === undefined || !NAME_RE.test(name)) {
        pushText(top().children, token.raw);
        at = bodyStart;
        continue;
      }
      top().children.push({ type: "name", tag: token.tag, name });
      at = close + `[/${token.tag}]`.length;
      continue;
    }
    if (token.tag === "url" && token.param === undefined) {
      // [url]href[/url] — the body IS the link.
      const bodyStart = at + token.length;
      const close = findClose("url", bodyStart);
      const href = close === -1 ? undefined : input.slice(bodyStart, close);
      if (href === undefined || !validHref(href)) {
        pushText(top().children, token.raw);
        at = bodyStart;
        continue;
      }
      top().children.push({
        type: "url",
        href,
        children: [{ type: "text", text: href }],
      });
      at = close + "[/url]".length;
      continue;
    }

    // Nesting tags.
    if (isWrapperTag(token.tag) && token.param === undefined) {
      stack.push({ open: token, children: [] });
      at += token.length;
      continue;
    }
    if (token.tag === "color" && token.param !== undefined) {
      const color = token.param.trim().toLowerCase();
      if (isColor(color)) {
        stack.push({
          open: { ...token, param: color },
          children: [],
        });
        at += token.length;
        continue;
      }
      pushText(top().children, token.raw);
      at += token.length;
      continue;
    }
    if (token.tag === "url" && token.param !== undefined) {
      if (validHref(token.param.trim())) {
        stack.push({
          open: { ...token, param: token.param.trim() },
          children: [],
        });
        at += token.length;
        continue;
      }
      pushText(top().children, token.raw);
      at += token.length;
      continue;
    }

    // Profile-dialect blocks.
    if (dialect === "profile") {
      if (token.tag === "hr" && token.param === undefined) {
        top().children.push({ type: "hr" });
        at += token.length;
        continue;
      }
      if (token.tag === "collapse") {
        stack.push({ open: token, children: [] });
        at += token.length;
        continue;
      }
      if (isBlockTag(token.tag) && token.param === undefined) {
        stack.push({ open: token, children: [] });
        at += token.length;
        continue;
      }
    }

    // Anything else — unknown tag, or a subset tag with an illegal
    // parameter shape: literal.
    pushText(top().children, token.raw);
    at += token.length;
  }

  // Unclosed openers re-literalize; their parsed children become siblings.
  while (stack.length > 1) {
    const frame = stack.pop()!;
    pushText(top().children, frame.open.raw);
    for (const child of frame.children) {
      if (child.type === "text") {
        pushText(top().children, child.text);
      } else {
        top().children.push(child);
      }
    }
  }
  return root.children;
}

function buildNode(frame: Frame): BBNode {
  const { open, children } = frame;
  if (open.tag === "color") {
    return { type: "color", color: open.param as BBColor, children };
  }
  if (open.tag === "url") {
    return { type: "url", href: open.param!, children };
  }
  if (open.tag === "collapse") {
    return { type: "collapse", title: open.param?.trim() ?? "", children };
  }
  if (isBlockTag(open.tag)) {
    return { type: "block", tag: open.tag, children };
  }
  return { type: "wrapper", tag: open.tag as BBWrapperTag, children };
}

/** Serializes the AST back to BBCode. Only ever emits subset tags. */
export function serializeBBCode(nodes: readonly BBNode[]): string {
  let out = "";
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        out += node.text;
        break;
      case "wrapper":
        out += `[${node.tag}]${serializeBBCode(node.children)}[/${node.tag}]`;
        break;
      case "color":
        out += `[color=${node.color}]${serializeBBCode(node.children)}[/color]`;
        break;
      case "url":
        // A `]` in the href would terminate the tag in param position and
        // silently change the link target on re-parse — such hrefs only come
        // from the body form, so they serialize back to it.
        out += node.href.includes("]")
          ? `[url]${node.href}[/url]`
          : `[url=${node.href}]${serializeBBCode(node.children)}[/url]`;
        break;
      case "name":
        out += `[${node.tag}]${node.name}[/${node.tag}]`;
        break;
      case "noparse":
        out += `[noparse]${node.text}[/noparse]`;
        break;
      // Profile-dialect nodes serialize losslessly too (render-only in
      // practice — nothing ever sends the profile dialect to the wire).
      case "block":
        out += `[${node.tag}]${serializeBBCode(node.children)}[/${node.tag}]`;
        break;
      case "collapse":
        out +=
          node.title === ""
            ? `[collapse]${serializeBBCode(node.children)}[/collapse]`
            : `[collapse=${node.title}]${serializeBBCode(node.children)}[/collapse]`;
        break;
      case "hr":
        out += "[hr]";
        break;
    }
  }
  return out;
}

/**
 * Parse→serialize normalization: tag casing/parameters canonicalized,
 * everything outside the subset reduced to inert literal text. The result
 * always re-parses to the same AST (see the fixpoint property test).
 */
export function sanitizeBBCode(input: string): string {
  return serializeBBCode(parseBBCode(input));
}
