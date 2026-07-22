// Markdown → BBCode translation, BBCode AST parser + sanitizer (M4).

export {
  BB_COLORS,
  BB_NAME_TAGS,
  BB_WRAPPER_TAGS,
  bbcodeToText,
  parseBBCode,
  sanitizeBBCode,
  serializeBBCode,
  validHref,
  type BBColor,
  type BBNameTag,
  type BBNode,
  type BBWrapperTag,
} from "./bbcode.js";
export {
  markdownSpans,
  mdToBBCode,
  type MdSpan,
  type MdSpanType,
} from "./markdown.js";
export {
  analyzeMarkdown,
  type MdLossDiagnostic,
  type MdLossKind,
} from "./lossiness.js";
