// SPDX-License-Identifier: GPL-3.0-or-later
//
// The html normalisation UiPage() applies before writing `sys_ui_page.html`.
//
// The SDK runs the authored html through three libraries: htmlparser2 finds the
// raw text of <script>/<style> elements, whose `<` and `&` it masks; an ordered
// XML parse (fast-xml-parser) turns the markup into a node list, where the
// `<sdk:now-ux-globals>` shim tag is expanded; and an XML builder prints the list
// back with two-space indentation. The output is whatever those three produce, so
// this module re-implements the observable behaviour of each step — including
// the quirks (dropped root-level text, typed text values, unmatched closing tags
// that simply pop) — and refuses, via UnsupportedHtml, the inputs where the
// libraries reach states it does not model.

/** The html reaches a state of the SDK's parsers that the native compiler does not model. */
export class UnsupportedHtml extends Error {}

const LT_PLACEHOLDER = "\0__SDK_LT__\0";
const AMP_PLACEHOLDER = "\0__SDK_AMP__\0";
const MAX_NESTED_TAGS = 100;
const INDENT = "  ";

/** Normalises `html` exactly as the SDK's UiPage plugin does; throws Error with the SDK's message on invalid markup. */
export function compileUiPageHtml(html: string): string {
  const nodes = parseXml(escapeRawContent(html));
  transformNodes(nodes);
  return restoreRawContent(buildXml(nodes, "\n", 0));
}

// ---------------------------------------------------------------------------
// Raw-content masking (htmlparser2 tokenizer, HTML mode)

const CC_TAB = 0x09;
const CC_NL = 0x0a;
const CC_FF = 0x0c;
const CC_CR = 0x0d;
const CC_SPACE = 0x20;
const CC_BANG = 0x21;
const CC_DQUOTE = 0x22;
const CC_SQUOTE = 0x27;
const CC_DASH = 0x2d;
const CC_SLASH = 0x2f;
const CC_LT = 0x3c;
const CC_EQ = 0x3d;
const CC_GT = 0x3e;
const CC_QUESTION = 0x3f;
const CC_LBRACKET = 0x5b;

const codes = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const SEQ_CDATA = codes("CDATA[");
const SEQ_CDATA_END = codes("]]>");
const SEQ_COMMENT_END = codes("-->");
const SEQ_SCRIPT_END = codes("</script");
const SEQ_STYLE_END = codes("</style");
const SEQ_TITLE_END = codes("</title");

const isWhitespace = (c: number): boolean =>
  c === CC_SPACE || c === CC_NL || c === CC_TAB || c === CC_FF || c === CC_CR;
const isEndOfTagSection = (c: number): boolean => c === CC_SLASH || c === CC_GT || isWhitespace(c);
const isAsciiAlpha = (c: number): boolean => (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a);

const enum S {
  Text,
  BeforeTagName,
  InTagName,
  InSelfClosingTag,
  BeforeClosingTagName,
  InClosingTagName,
  AfterClosingTagName,
  BeforeAttributeName,
  InAttributeName,
  AfterAttributeName,
  BeforeAttributeValue,
  InAttributeValueDq,
  InAttributeValueSq,
  InAttributeValueNq,
  BeforeDeclaration,
  InDeclaration,
  InProcessingInstruction,
  BeforeComment,
  CdataSequence,
  InSpecialComment,
  InCommentLike,
  BeforeSpecialS,
  SpecialStartSequence,
  InSpecialTag,
}

interface Region {
  start: number;
  end: number;
}

/**
 * The text spans htmlparser2 reports as the children of <script> and <style>
 * elements. Entity decoding is left out: it never consumes a character that
 * moves the tokenizer between the states that decide where an element starts.
 */
function rawTextRegions(html: string): Region[] {
  const regions: Region[] = [];
  const length = html.length;
  let state = S.Text as S;
  let index = 0;
  let sectionStart = 0;
  let isSpecial = false;
  let sequence: number[] = SEQ_SCRIPT_END;
  let sequenceIndex = 0;
  let tagName = "";

  const at = (i: number): number => html.charCodeAt(i);
  const pushRegion = (start: number, end: number): void => {
    const data = html.slice(start, end);
    if (data.includes("<") || data.includes("&")) regions.push({ start, end });
  };
  const fastForwardTo = (c: number): boolean => {
    while (++index < length) {
      if (at(index) === c) return true;
    }
    index = length - 1;
    return false;
  };
  const startSpecial = (seq: number[], offset: number): void => {
    isSpecial = true;
    sequence = seq;
    sequenceIndex = offset;
    state = S.SpecialStartSequence;
  };
  // A <textarea> is not raw text to htmlparser2, so its children are decoded text and
  // markup, and the SDK masks each text child whose decoded text holds `<` or `&`. Only
  // plain text that runs straight to `</textarea` (or to the end of the input) and has
  // no character reference is modelled.
  const checkTextarea = (from: number): void => {
    const lt = html.indexOf("<", from);
    if (/&[A-Za-z0-9#]/.test(lt === -1 ? html.slice(from) : html.slice(from, lt))) {
      throw new UnsupportedHtml("a character reference in textarea content");
    }
    if (lt !== -1) {
      const close = html.slice(lt, lt + 10);
      const next = html.charCodeAt(lt + 10);
      if (close.toLowerCase() !== "</textarea" || !(next === CC_GT || isWhitespace(next))) {
        throw new UnsupportedHtml("textarea content with markup");
      }
    }
    pushRegion(from, lt === -1 ? length : lt);
  };

  const text = (c: number): void => {
    if (c === CC_LT) {
      state = S.BeforeTagName;
      sectionStart = index;
    }
  };
  const inTagName = (c: number): void => {
    if (isEndOfTagSection(c)) {
      tagName = html.slice(sectionStart, index).toLowerCase();
      state = S.BeforeAttributeName;
      beforeAttributeName(c);
    }
  };
  const beforeAttributeName = (c: number): void => {
    if (c === CC_GT) {
      if (isSpecial) {
        state = S.InSpecialTag;
        sequenceIndex = 0;
      } else {
        state = S.Text;
        if (tagName === "textarea") checkTextarea(index + 1);
      }
      sectionStart = index + 1;
    } else if (c === CC_SLASH) {
      state = S.InSelfClosingTag;
    } else if (!isWhitespace(c)) {
      state = S.InAttributeName;
    }
  };
  const inClosingTagName = (c: number): void => {
    if (c === CC_GT || isWhitespace(c)) {
      state = S.AfterClosingTagName;
      afterClosingTagName(c);
    }
  };
  const afterClosingTagName = (c: number): void => {
    if (c === CC_GT || fastForwardTo(CC_GT)) {
      state = S.Text;
      sectionStart = index + 1;
    }
  };
  const afterAttributeName = (c: number): void => {
    if (c === CC_EQ) {
      state = S.BeforeAttributeValue;
    } else if (c === CC_SLASH || c === CC_GT) {
      state = S.BeforeAttributeName;
      beforeAttributeName(c);
    } else if (!isWhitespace(c)) {
      state = S.InAttributeName;
    }
  };
  const inAttributeValueNq = (c: number): void => {
    if (isWhitespace(c) || c === CC_GT) {
      state = S.BeforeAttributeName;
      beforeAttributeName(c);
    }
  };
  const inDeclaration = (c: number): void => {
    if (c === CC_GT || fastForwardTo(CC_GT)) {
      state = S.Text;
      sectionStart = index + 1;
    }
  };

  for (; index < length; index++) {
    const c = at(index);
    switch (state) {
      case S.Text:
        text(c);
        break;
      case S.SpecialStartSequence: {
        const isEnd = sequenceIndex === sequence.length;
        const isMatch = isEnd ? isEndOfTagSection(c) : (c | 0x20) === sequence[sequenceIndex];
        if (!isMatch) {
          isSpecial = false;
        } else if (!isEnd) {
          sequenceIndex++;
          break;
        }
        sequenceIndex = 0;
        state = S.InTagName;
        inTagName(c);
        break;
      }
      case S.InSpecialTag: {
        if (sequenceIndex === sequence.length) {
          if (c === CC_GT || isWhitespace(c)) {
            const endOfText = index - sequence.length;
            if (sequence !== SEQ_TITLE_END) pushRegion(sectionStart, endOfText);
            isSpecial = false;
            sectionStart = endOfText + 2;
            state = S.InClosingTagName;
            inClosingTagName(c);
            break;
          }
          sequenceIndex = 0;
        }
        if ((c | 0x20) === sequence[sequenceIndex]) {
          sequenceIndex += 1;
        } else if (sequenceIndex === 0) {
          if (sequence !== SEQ_TITLE_END && fastForwardTo(CC_LT)) sequenceIndex = 1;
        } else {
          sequenceIndex = Number(c === CC_LT);
        }
        break;
      }
      case S.CdataSequence:
        if (c === SEQ_CDATA[sequenceIndex]) {
          if (++sequenceIndex === SEQ_CDATA.length) {
            state = S.InCommentLike;
            sequence = SEQ_CDATA_END;
            sequenceIndex = 0;
            sectionStart = index + 1;
          }
        } else {
          sequenceIndex = 0;
          state = S.InDeclaration;
          inDeclaration(c);
        }
        break;
      case S.InAttributeValueDq:
        if (c === CC_DQUOTE) state = S.BeforeAttributeName;
        break;
      case S.InAttributeName:
        if (c === CC_EQ || isEndOfTagSection(c)) {
          state = S.AfterAttributeName;
          afterAttributeName(c);
        }
        break;
      case S.InCommentLike:
        if (c === sequence[sequenceIndex]) {
          if (++sequenceIndex === sequence.length) {
            sequenceIndex = 0;
            sectionStart = index + 1;
            state = S.Text;
          }
        } else if (sequenceIndex === 0) {
          if (fastForwardTo(sequence[0]!)) sequenceIndex = 1;
        } else if (c !== sequence[sequenceIndex - 1]) {
          sequenceIndex = 0;
        }
        break;
      case S.InSpecialComment:
        inDeclaration(c);
        break;
      case S.BeforeAttributeName:
        beforeAttributeName(c);
        break;
      case S.InTagName:
        inTagName(c);
        break;
      case S.InClosingTagName:
        inClosingTagName(c);
        break;
      case S.BeforeTagName:
        if (c === CC_BANG) {
          state = S.BeforeDeclaration;
          sectionStart = index + 1;
        } else if (c === CC_QUESTION) {
          state = S.InProcessingInstruction;
          sectionStart = index + 1;
        } else if (isAsciiAlpha(c)) {
          const lower = c | 0x20;
          sectionStart = index;
          if (lower === SEQ_TITLE_END[2]) {
            startSpecial(SEQ_TITLE_END, 3);
          } else {
            state = lower === SEQ_SCRIPT_END[2] ? S.BeforeSpecialS : S.InTagName;
          }
        } else if (c === CC_SLASH) {
          state = S.BeforeClosingTagName;
        } else {
          state = S.Text;
          text(c);
        }
        break;
      case S.AfterAttributeName:
        afterAttributeName(c);
        break;
      case S.InAttributeValueSq:
        if (c === CC_SQUOTE) state = S.BeforeAttributeName;
        break;
      case S.BeforeAttributeValue:
        if (c === CC_DQUOTE) {
          state = S.InAttributeValueDq;
        } else if (c === CC_SQUOTE) {
          state = S.InAttributeValueSq;
        } else if (!isWhitespace(c)) {
          state = S.InAttributeValueNq;
          inAttributeValueNq(c);
        }
        break;
      case S.BeforeClosingTagName:
        if (isWhitespace(c)) {
          // ignored
        } else if (c === CC_GT) {
          state = S.Text;
        } else {
          state = isAsciiAlpha(c) ? S.InClosingTagName : S.InSpecialComment;
          sectionStart = index;
        }
        break;
      case S.BeforeSpecialS: {
        const lower = c | 0x20;
        if (lower === SEQ_SCRIPT_END[3]) {
          startSpecial(SEQ_SCRIPT_END, 4);
        } else if (lower === SEQ_STYLE_END[3]) {
          startSpecial(SEQ_STYLE_END, 4);
        } else {
          state = S.InTagName;
          inTagName(c);
        }
        break;
      }
      case S.InAttributeValueNq:
        inAttributeValueNq(c);
        break;
      case S.InSelfClosingTag:
        if (c === CC_GT) {
          // htmlparser2 ignores the slash in HTML mode, so the element stays open while
          // the tokenizer leaves raw-text mode — children the native compiler does not model.
          if (tagName === "script" || tagName === "style" || tagName === "textarea") {
            throw new UnsupportedHtml(`self-closing <${tagName}>`);
          }
          isSpecial = false;
          state = S.Text;
          sectionStart = index + 1;
        } else if (!isWhitespace(c)) {
          state = S.BeforeAttributeName;
          beforeAttributeName(c);
        }
        break;
      case S.InDeclaration:
        inDeclaration(c);
        break;
      case S.BeforeDeclaration:
        if (c === CC_LBRACKET) {
          state = S.CdataSequence;
          sequenceIndex = 0;
        } else {
          state = c === CC_DASH ? S.BeforeComment : S.InDeclaration;
        }
        break;
      case S.BeforeComment:
        if (c === CC_DASH) {
          state = S.InCommentLike;
          sequence = SEQ_COMMENT_END;
          sequenceIndex = 2;
          sectionStart = index + 1;
        } else {
          state = S.InDeclaration;
        }
        break;
      default:
        // S.InProcessingInstruction
        inDeclaration(c);
    }
  }
  // An unclosed raw-text element's content runs to the end of the input.
  if (state === S.InSpecialTag && sequence !== SEQ_TITLE_END) pushRegion(sectionStart, length);
  return regions;
}

function escapeRawContent(html: string): string {
  const regions = rawTextRegions(html);
  let result = html;
  for (let i = regions.length - 1; i >= 0; i--) {
    const { start, end } = regions[i]!;
    const escaped = result
      .slice(start, end)
      .replace(/&/g, AMP_PLACEHOLDER)
      .replace(/</g, LT_PLACEHOLDER);
    result = result.slice(0, start) + escaped + result.slice(end);
  }
  return result;
}

function restoreRawContent(html: string): string {
  return html.replaceAll(LT_PLACEHOLDER, "<").replaceAll(AMP_PLACEHOLDER, "&");
}

// ---------------------------------------------------------------------------
// Ordered XML parse (fast-xml-parser, preserveOrder, no entity processing)

type TextValue = string | number | boolean;

/** One entry of the ordered node list: a text value, a comment, a processing instruction or an element. */
type XNode =
  | { kind: "text"; value: TextValue }
  | { kind: "comment"; value: string }
  | { kind: "pi"; tag: string; attrs?: Map<string, string> }
  | { kind: "element"; tag: string; attrs?: Map<string, string>; children: XNode[] };

interface Container {
  tag: string;
  children: XNode[];
}

const RESERVED_NAMES = ["__proto__", "constructor", "prototype"];
const RENAMED_NAMES = [
  "hasOwnProperty",
  "toString",
  "valueOf",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
];

function sanitizeName(name: string): string {
  if (RESERVED_NAMES.includes(name)) {
    throw new Error(
      `[SECURITY] Invalid name: "${name}" is a reserved JavaScript keyword that could cause prototype pollution`,
    );
  }
  return RENAMED_NAMES.includes(name) ? `__${name}` : name;
}

const HEX = /^[-+]?0x[a-fA-F0-9]+$/;
const DECIMAL = /^([-+])?(0*)([0-9]*(\.[0-9]*)?)$/;
const E_NOTATION = /^([-+])?(0*)(\d*(\.\d*)?[eE][-+]?\d+)$/;

function parseENotation(raw: string, trimmed: string): TextValue {
  const match = trimmed.match(E_NOTATION);
  /* istanbul ignore next -- every finite decimal string with an exponent matches E_NOTATION */
  if (!match) return raw;
  const sign = match[1] ?? "";
  const eChar = match[3]!.indexOf("e") === -1 ? "E" : "e";
  const zeros = match[2]!;
  const eAfterZeros = sign ? raw[zeros.length + 1] === eChar : raw[zeros.length] === eChar;
  if (zeros.length > 1 && eAfterZeros) return raw;
  if (zeros.length === 1 && (match[3]!.startsWith(`.${eChar}`) || match[3]![0] === eChar)) {
    return Number(trimmed);
  }
  // An exponent right after the zeros has returned above, so only "0…0.5e3"-like values reach here.
  if (zeros.length > 0) return Number(sign + match[3]!);
  return Number(trimmed);
}

/** fast-xml-parser's `parseTagValue`: booleans, then strnum with its default options. */
function parseValue(raw: string): TextValue {
  const trimmed = raw.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed.length === 0) return raw;
  if (trimmed === "0") return 0;
  if (HEX.test(trimmed)) return parseInt(trimmed, 16);
  if (!isFinite(trimmed as unknown as number)) return raw;
  if (trimmed.includes("e") || trimmed.includes("E")) return parseENotation(raw, trimmed);
  const match = DECIMAL.exec(trimmed);
  if (!match) return raw;
  const sign = match[1] ?? "";
  const zeros = match[2]!;
  let digits = match[3]!;
  if (digits && digits.includes(".")) {
    digits = digits.replace(/0+$/, "");
    if (digits === ".") digits = "0";
    else if (digits[0] === ".") digits = "0" + digits;
    else if (digits[digits.length - 1] === ".") digits = digits.substring(0, digits.length - 1);
  }
  const num = Number(trimmed);
  const str = String(num);
  if (num === 0) return num;
  if (str.search(/[eE]/) !== -1) return num;
  if (trimmed.includes(".")) return str === "0" || str === digits || str === `${sign}${digits}` ? num : raw;
  const candidate = zeros ? digits : trimmed;
  if (zeros) return candidate === str || sign + candidate === str ? num : raw;
  return candidate === str || candidate === sign + str ? num : raw;
}

const ATTRIBUTE = /([^\s=]+)\s*(=\s*(['"])([\s\S]*?)\3)?/gm;

function attributesOf(expression: string): Map<string, string> | undefined {
  const attrs = new Map<string, string>();
  for (const match of expression.matchAll(ATTRIBUTE)) {
    if (match[4] !== undefined) attrs.set(sanitizeName(`@_${match[1]}`), match[4].trim());
  }
  return attrs.size > 0 ? attrs : undefined;
}

interface TagExpression {
  tagName: string;
  tagExp: string;
  closeIndex: number;
}

/** Reads `<name attrs` up to `close` (outside quotes), turning unquoted tabs into spaces. */
function readTagExpression(xml: string, start: number, close: string): TagExpression | undefined {
  const first = close.charCodeAt(0);
  const second = close.length > 1 ? close.charCodeAt(1) : -1;
  let quote = 0;
  let data = "";
  let from = start;
  for (let i = start; i < xml.length; i++) {
    const c = xml.charCodeAt(i);
    if (quote) {
      if (c === quote) quote = 0;
    } else if (c === CC_DQUOTE || c === CC_SQUOTE) {
      quote = c;
    } else if (c === first) {
      if (second === -1 || xml.charCodeAt(i + 1) === second) {
        data += xml.substring(from, i);
        const ws = data.search(/\s/);
        return ws === -1
          ? { tagName: data, tagExp: data, closeIndex: i }
          : { tagName: data.substring(0, ws), tagExp: data.substring(ws + 1).trimStart(), closeIndex: i };
      }
    } else if (c === CC_TAB) {
      data += xml.substring(from, i) + " ";
      from = i + 1;
    }
  }
  return undefined;
}

function closingIndex(xml: string, search: string, from: number, message: string): number {
  const found = xml.indexOf(search, from);
  if (found === -1) throw new Error(message);
  return found + search.length - 1;
}

function parseXml(source: string): XNode[] {
  const xml = source.replace(/\r\n?/g, "\n");
  const root: Container = { tag: "!xml", children: [] };
  const stack: (Container | undefined)[] = [];
  let current: Container | undefined = root;
  let text = "";

  // An unmatched closing tag pops past the root; fast-xml-parser then dereferences
  // an undefined parent, which the native compiler refuses rather than mimics.
  const parent = (): Container => {
    if (!current) throw new UnsupportedHtml("closing tag without an open element");
    return current;
  };
  const saveText = (): void => {
    if (!text) return;
    const trimmed = text.trim();
    if (trimmed.length > 0) {
      parent().children.push({ kind: "text", value: parseValue(trimmed) });
    }
    text = "";
  };

  for (let i = 0; i < xml.length; i++) {
    if (xml[i] !== "<") {
      text += xml[i];
      continue;
    }
    const next = xml.charCodeAt(i + 1);
    if (next === CC_SLASH) {
      const end = closingIndex(xml, ">", i, "Closing Tag is not closed.");
      sanitizeName(xml.substring(i + 2, end).trim());
      if (current) saveText();
      current = stack.pop();
      text = "";
      i = end;
    } else if (next === CC_QUESTION) {
      const exp = readTagExpression(xml, i + 1, "?>");
      if (!exp) throw new Error("Pi Tag is not closed.");
      saveText();
      const attrs = exp.tagName !== exp.tagExp ? attributesOf(exp.tagExp) : undefined;
      // `<?>` reads as a nameless tag, which the builder prints as an element holding empty text.
      const node: XNode = exp.tagName
        ? { kind: "pi", tag: exp.tagName }
        : { kind: "element", tag: "", children: [{ kind: "text", value: "" }] };
      if (attrs) node.attrs = attrs;
      parent().children.push(node);
      i = exp.closeIndex + 1;
    } else if (next === CC_BANG && xml.charCodeAt(i + 2) === CC_DASH && xml.charCodeAt(i + 3) === CC_DASH) {
      const end = closingIndex(xml, "-->", i + 4, "Comment is not closed.");
      saveText();
      parent().children.push({ kind: "comment", value: xml.substring(i + 4, end - 2) });
      i = end;
    } else if (next === CC_BANG && xml.charCodeAt(i + 2) === 0x44) {
      if (xml.substring(i + 3, i + 9) !== "OCTYPE") throw new Error("Invalid Tag instead of DOCTYPE");
      let j = i + 9;
      for (; j < xml.length && xml[j] !== ">"; j++) {
        if (xml[j] === "<") throw new UnsupportedHtml("DOCTYPE with markup declarations");
      }
      if (j === xml.length) throw new Error("Unclosed DOCTYPE");
      i = j;
    } else if (next === CC_BANG && xml.charCodeAt(i + 2) === CC_LBRACKET) {
      const end = closingIndex(xml, "]]>", i, "CDATA is not closed.") - 2;
      const content = xml.substring(i + 9, end);
      saveText();
      parent().children.push({ kind: "text", value: content.length > 0 ? parseValue(content) : "" });
      i = end + 2;
    } else {
      const exp = readTagExpression(xml, i + 1, ">");
      if (!exp) {
        const context = xml.substring(Math.max(0, i - 50), Math.min(xml.length, i + 50));
        throw new Error(`readTagExp returned undefined at position ${i}. Context: "${context}"`);
      }
      let tagName = sanitizeName(exp.tagName);
      let tagExp = exp.tagExp;
      if (tagName === "@_comment" || tagName === "#text") throw new Error(`Invalid tag name: ${tagName}`);
      if (current && text && current.tag !== "!xml") saveText();
      let selfClosing = false;
      if (tagExp.length > 0 && tagExp.lastIndexOf("/") === tagExp.length - 1) {
        selfClosing = true;
        if (tagName[tagName.length - 1] === "/") {
          tagName = tagName.substring(0, tagName.length - 1);
          tagExp = tagName;
        } else {
          tagExp = tagExp.substring(0, tagExp.length - 1);
        }
      }
      const attrs = tagName !== tagExp ? attributesOf(tagExp) : undefined;
      if (selfClosing) {
        // `<#text/>` and `<@_comment/>` slip past the name check above (the name still ends
        // in '/'): the SDK's builder prints the first as empty text and crashes on the second.
        const name = sanitizeName(tagName);
        if (name === "@_comment") throw new UnsupportedHtml("a self-closing <@_comment>");
        if (name === "#text") {
          parent().children.push({ kind: "text", value: "" });
          text = "";
          i = exp.closeIndex;
          continue;
        }
        const node: XNode = { kind: "element", tag: name, children: [] };
        if (attrs) node.attrs = attrs;
        parent().children.push(node);
      } else {
        if (stack.length > MAX_NESTED_TAGS) throw new Error("Maximum nested tags exceeded");
        const node: XNode & { kind: "element" } = { kind: "element", tag: tagName, children: [] };
        if (attrs) node.attrs = attrs;
        parent().children.push(node);
        stack.push(current);
        current = node;
      }
      text = "";
      i = exp.closeIndex;
    }
  }
  return root.children;
}

// ---------------------------------------------------------------------------
// <sdk:now-ux-globals> expansion

const POLARIS_APPSHELL_THEME_ID = "c86a62e2c7022010099a308dc7c26022";

const GLIDE_LEGACY_SCRIPTS = `<g:requires name="scripts/doctype/functions_bootstrap14.js" />
<g:requires name="scripts/lib/prototype.js" />
<g:requires name="scripts/classes/ajax/GlideURL.js" />
`;
const GLIDE_AJAX_SCRIPTS = `<g:requires name="scripts/classes/ajax/GlideAjax.js" />
<g:requires name="scripts/classes/GlideUser.js" />
<g2:client_script type="user" />
`;
const UX_FRAMEWORK_PRELOAD = `<link rel="preload" href="/uxasset/set-cache-buster/$[UxFrameworkScriptables.getFlushTimestamp()].js" as="script"></link>
`;
const UX_FRAMEWORK_RUNTIME = `<script type="module" src="/uxasset/externals/@devsnc/library-uxf/index.jsdbx"></script>
`;
const ARRAY_FROM_POLYFILL = `<script type="text/javascript">
<![CDATA[
    (function () {
    var testWorks = (function () {
        try {
        var result = Array.from(new Set([1, 2]));
        return (
            Array.isArray(result) && result.length === 2 && result[0] === 1
        );
        } catch (e) {
        return false;
        }
    })();
    if (testWorks) return;
    var originalArrayFrom = Array.from;
    function specArrayFrom(arrayLike, mapFn, thisArg) {
        if (arrayLike == null)
        throw new TypeError(
            "Array.from requires an array-like or iterable object"
        );
        var C = this;
        if (typeof C !== "function" || C === Window || C === Object) {
        C = Array;
        }
        var mapping = typeof mapFn === "function";
        var iterFn = arrayLike[Symbol.iterator];
        if (typeof iterFn === "function") {
        var result = [];
        var i = 0;
        var iterator = iterFn.call(arrayLike);
        var step;
        while (!(step = iterator.next()).done) {
            result[i] = mapping
            ? mapFn.call(thisArg, step.value, i)
            : step.value;
            i++;
        }
        result.length = i;
        return result;
        }
        var items = Object(arrayLike);
        var len = Math.min(
        Math.max(Number(items.length) || 0, 0),
        Number.MAX_SAFE_INTEGER
        );
        var result = new C(len);
        for (var k = 0; k < len; k++) {
        result[k] = mapping ? mapFn.call(thisArg, items[k], k) : items[k];
        }
        result.length = len;
        return result;
    }
    Array.from = function (arrayLike, mapFn, thisArg) {
        if (
        arrayLike != null &&
        typeof arrayLike[Symbol.iterator] === "function"
        ) {
        try {
            return specArrayFrom.call(this, arrayLike, mapFn, thisArg);
        } catch (e) {
            console.error("Array.from failed with error:", e);
            return originalArrayFrom.call(this, arrayLike, mapFn, thisArg);
        }
        }
        return originalArrayFrom.call(this, arrayLike, mapFn, thisArg);
    };
    })();
    if (window.Element && Element.Methods) {
    Element.Methods.remove = function (element) {
        element = $(element);
        if (element.parentNode) {
        element.parentNode.removeChild(element);
        }
        return element;
    };
    Element.addMethods();
    }]]>
</script>`;

function nowUxGlobals(themeId: string, legacy: boolean): XNode[] {
  return parseXml(`<!-- @sdk:now-ux-globals -->
<!-- Resolved from sdk:now-ux-globals tag at NowSDK build time to support earlier Glide releases -->
<script>
window.NOW = {};
window.NOW.user = {};
window.NOW.batch_glide_ajax_requests = false;
window.NOW.isUsingPolaris = true;
window.NOW.exclude_dark_theme = "false";
window.g_ck = "$[gs.getSession().getSessionToken() || gs.getSessionToken()]";
</script>
<!-- Include ServiceNow's required scripts -->
${legacy ? GLIDE_LEGACY_SCRIPTS : ""}<g:requires name="scripts/doctype/CustomEventManager.js" />
${legacy ? GLIDE_AJAX_SCRIPTS : ""}${legacy ? UX_FRAMEWORK_PRELOAD : ""}<g:requires name="scripts/polaris_theme_refresh_observer.js" />
<link data-source-id="glide-theme" id="polarisberg_theme_variables" rel="stylesheet" href="/$uxappimmutables.do?sysparm_request_type=ux_theme$[AMP]sysparm_app_sys_id=${themeId}$[AMP]uxpcb=$[sn_ui.PolarisUI.getThemeVariableCssCacheKey()]"></link>
${legacy ? UX_FRAMEWORK_RUNTIME : ""}
${legacy ? ARRAY_FROM_POLYFILL : ""}<!-- @sdk:now-ux-globals -->
`);
}

/** Replaces every `<sdk:now-ux-globals>` element in place, as the SDK's node transformer does. */
function transformNodes(nodes: XNode[]): void {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    // The SDK skips (and does not descend into) an element whose name is empty.
    if (node.kind !== "element" || node.tag === "") continue;
    if (node.tag === "sdk:now-ux-globals") {
      const themeId = node.attrs?.get("@_theme-id") ?? POLARIS_APPSHELL_THEME_ID;
      const mode = node.attrs?.get("@_mode") ?? "";
      nodes.splice(i, 1, ...nowUxGlobals(themeId, mode.toLowerCase() !== "minimal"));
      continue;
    }
    transformNodes(node.children);
  }
}

// ---------------------------------------------------------------------------
// Ordered XML build (format: true, two-space indent, `&` → `$[AMP]`)

const BARE_AMP = /&(?!(amp;|lt;|gt;|apos;|quot;))/g;

const escapeEntities = (value: string): string => (value.length > 0 ? value.replace(BARE_AMP, "$[AMP]") : value);

function attributeString(attrs: Map<string, string> | undefined): string {
  let out = "";
  if (attrs) {
    for (const [key, value] of attrs) out += ` ${key.substring(2)}="${escapeEntities(value)}"`;
  }
  return out;
}

function buildXml(nodes: XNode[], newline: string, depth: number): string {
  if (depth > MAX_NESTED_TAGS) throw new Error("Maximum nested tags exceeded");
  let out = "";
  let afterTag = false;
  for (const node of nodes) {
    if (node.kind === "text") {
      if (afterTag) out += newline;
      out += typeof node.value === "string" ? escapeEntities(node.value) : String(node.value);
      afterTag = false;
      continue;
    }
    if (node.kind === "comment") {
      out += `${newline}<!--${node.value.replace(/--/g, "- -").replace(/-$/, "- ")}-->`;
      afterTag = true;
      continue;
    }
    if (node.kind === "pi") {
      out += `${node.tag === "?xml" ? "" : newline}<${node.tag}${attributeString(node.attrs)}?>`;
      afterTag = true;
      continue;
    }
    const open = `${newline}<${node.tag}${attributeString(node.attrs)}`;
    const inner = buildXml(node.children, newline + INDENT, depth + 1);
    if (inner.endsWith(">")) {
      out += `${open}>${inner}${newline}</${node.tag}>`;
    } else {
      out += `${open}>`;
      out += inner && (inner.includes("/>") || inner.includes("</")) ? newline + INDENT + inner + newline : inner;
      out += `</${node.tag}>`;
    }
    afterTag = true;
  }
  return out;
}
