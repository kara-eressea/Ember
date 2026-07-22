// End-to-end of the fix for #335 (follow-up): real wire specimens pulled from
// the live messages table — sent by the official F-Chat client, entity-escaped
// by the F-Chat server — traced through the whole client pipeline:
//   wire text → decodeWireEntities → parseBBCode → [url] href → resolvePreview.
// Before the decode step the href kept a literal "&amp;", so the CDN saw a
// param named "amp;is"/"amp;name" and every preview (and direct click) 404'd.

import { describe, expect, it } from "vitest";
import { parseBBCode, type BBNode } from "@emberchat/markdown-bbcode";
import { decodeWireEntities } from "../../lib/wire-text.js";
import { resolvePreview } from "../../lib/link-preview.js";

/** The href of the first [url] node in a parsed tree (the real specimens are a
 * single [url=…]label[/url]). */
function firstUrlHref(nodes: readonly BBNode[]): string | undefined {
  for (const node of nodes) {
    if (node.type === "url") {
      return node.href;
    }
  }
  return undefined;
}

/** The render path: decode wire entities, then parse. */
function hrefFromWire(wire: string): string | undefined {
  return firstUrlHref(parseBBCode(decodeWireEntities(wire)));
}

describe("live wire specimens through parse → href → resolvePreview (#335)", () => {
  it("twimg [url=] keeps format+name after decode and previews", () => {
    const wire =
      "[url=https://pbs.twimg.com/media/HNz2CfYaMAAcV8N?format=jpg&amp;name=4096x4096]Elf[/url]";
    const href = hrefFromWire(wire);
    expect(href).toBe(
      "https://pbs.twimg.com/media/HNz2CfYaMAAcV8N?format=jpg&name=4096x4096",
    );
    // The undecoded href would carry "amp;name" and never classify as an image.
    expect(href).not.toContain("&amp;");
    expect(resolvePreview(href!, ["pbs.twimg.com"])).toMatchObject({
      kind: "image",
      src: href,
      host: "pbs.twimg.com",
    });
  });

  it("Discord CDN [url=] keeps the signed ex/is/hm query after decode", () => {
    // hm= hash trimmed; every '&' arrives as '&amp;' on the wire.
    const wire =
      "[url=https://media.discordapp.net/attachments/1496961605118722138/1497877098847670332/image.png?ex=6a61d0c1&amp;is=6a607f41&amp;hm=599d&amp;=&amp;format=webp&amp;quality=lossless&amp;width=1356&amp;height=1781]Very sinister[/url]";
    const href = hrefFromWire(wire);
    expect(href).not.toContain("&amp;");
    expect(href).toContain("?ex=6a61d0c1&is=6a607f41&hm=599d");
    // Path ends in .png → classifies as an image; host is on the allowlist.
    expect(resolvePreview(href!, ["media.discordapp.net"])).toMatchObject({
      kind: "image",
      src: href,
      host: "media.discordapp.net",
    });
  });

  it("without decode the href is broken (regression guard)", () => {
    const wire =
      "[url=https://pbs.twimg.com/media/HNz2CfYaMAAcV8N?format=jpg&amp;name=4096x4096]Elf[/url]";
    // Parsing the raw wire (no decode) leaves the entity in the href — the bug.
    const broken = firstUrlHref(parseBBCode(wire));
    expect(broken).toContain("&amp;name=");
    // The CDN receives a param literally named "amp;name": a broken request.
    const params = new URL(broken!).searchParams;
    expect(params.has("name")).toBe(false);
    expect(params.has("amp;name")).toBe(true);
  });
});
