import { describe, expect, it } from "vitest";
import { decodeWireEntities, wireToPlainText } from "./wire-text.js";

describe("decodeWireEntities (#335 follow-up)", () => {
  it("decodes the three entities the F-Chat server injects", () => {
    expect(decodeWireEntities("Tom &amp; Jerry")).toBe("Tom & Jerry");
    expect(decodeWireEntities("a &lt;b&gt; c")).toBe("a <b> c");
  });

  it("restores a signed twimg URL's query so the CDN sees real params", () => {
    expect(
      decodeWireEntities(
        "https://pbs.twimg.com/media/HNz2CfYaMAAcV8N?format=jpg&amp;name=4096x4096",
      ),
    ).toBe(
      "https://pbs.twimg.com/media/HNz2CfYaMAAcV8N?format=jpg&name=4096x4096",
    );
  });

  it("decodes exactly once — &amp;amp; collapses to &amp;, not &", () => {
    // A user who literally typed "&amp;" is server-escaped to "&amp;amp;";
    // one decode must land on the literal they meant, never cascade to "&".
    expect(decodeWireEntities("&amp;amp;")).toBe("&amp;");
    // Likewise a literal "&lt;" the user typed round-trips to "&lt;".
    expect(decodeWireEntities("&amp;lt;")).toBe("&lt;");
  });

  it("leaves entities the server never emits untouched (ecosystem parity)", () => {
    // The reference client decodes only & < > — not quotes, apostrophes, or
    // numeric refs; decoding them would diverge from every other client.
    expect(decodeWireEntities("say &quot;hi&quot;")).toBe("say &quot;hi&quot;");
    expect(decodeWireEntities("it&#39;s &apos;fine&apos;")).toBe(
      "it&#39;s &apos;fine&apos;",
    );
    expect(decodeWireEntities("&#8212;")).toBe("&#8212;");
  });

  it("is a no-op on entity-free text", () => {
    expect(decodeWireEntities("plain https://static.f-list.net/a.png")).toBe(
      "plain https://static.f-list.net/a.png",
    );
  });
});

describe("wireToPlainText (#350)", () => {
  it("strips BBCode tags and decodes the server's entities together", () => {
    // The live specimen from the member-list status line (#350).
    expect(wireToPlainText("Other canons &amp; Summer Vibes!")).toBe(
      "Other canons & Summer Vibes!",
    );
    // Tags flatten to their text; the double-escaped form seen live also
    // collapses to a single ampersand.
    expect(wireToPlainText("[b]Other canons &amp; Summer[/b]")).toBe(
      "Other canons & Summer",
    );
  });

  it("keeps the same decode-exactly-once semantics as the raw decoder", () => {
    expect(wireToPlainText("[i]&amp;amp;[/i]")).toBe("&amp;");
    expect(wireToPlainText("a &lt;3 b")).toBe("a <3 b");
  });
});
