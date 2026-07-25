'use strict';

/*
 * Minimal zero-dependency XML parser.
 *
 * Parses the OFAC SLS /entities XML (and advanced-file entity blocks) into a
 * lightweight node tree: { tag, attrs, children[], text }. Handles elements,
 * attributes, self-closing tags, comments, CDATA, the XML declaration, and the
 * standard entity escapes. Not a general-purpose validator — scoped to the
 * well-formed XML OFAC publishes.
 */

function unescape(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

function parse(xml) {
  const root = { tag: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  let i = 0;
  const n = xml.length;

  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) break;

    // Text between tags → attach to current node.
    if (lt > i) {
      const txt = xml.slice(i, lt).trim();
      if (txt) stack[stack.length - 1].text += unescape(txt);
    }

    // Comments.
    if (xml.startsWith('<!--', lt)) { i = xml.indexOf('-->', lt) + 3; continue; }
    // CDATA.
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt);
      stack[stack.length - 1].text += xml.slice(lt + 9, end);
      i = end + 3; continue;
    }
    // XML declaration / doctype / processing instructions.
    if (xml.startsWith('<?', lt) || xml.startsWith('<!', lt)) { i = xml.indexOf('>', lt) + 1; continue; }

    const gt = xml.indexOf('>', lt);
    if (gt === -1) break;
    let raw = xml.slice(lt + 1, gt).trim();

    // Closing tag.
    if (raw[0] === '/') { if (stack.length > 1) stack.pop(); i = gt + 1; continue; }

    const selfClose = raw.endsWith('/');
    if (selfClose) raw = raw.slice(0, -1).trim();

    // Tag name + attributes.
    const sp = raw.search(/\s/);
    const tag = sp === -1 ? raw : raw.slice(0, sp);
    const attrs = {};
    if (sp !== -1) {
      const attrStr = raw.slice(sp + 1);
      const re = /([\w:.-]+)\s*=\s*"([^"]*)"|([\w:.-]+)\s*=\s*'([^']*)'/g;
      let m;
      while ((m = re.exec(attrStr))) {
        attrs[m[1] || m[3]] = unescape(m[2] != null ? m[2] : m[4]);
      }
    }

    const node = { tag, attrs, children: [], text: '' };
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
    i = gt + 1;
  }
  return root;
}

// Helpers.
const child = (node, tag) => node.children.find((c) => c.tag === tag) || null;
const children = (node, tag) => node.children.filter((c) => c.tag === tag);
const text = (node, tag) => { const c = child(node, tag); return c ? c.text.trim() : ''; };
// Depth-first collect all descendants with a tag.
function descendants(node, tag, out = []) {
  for (const c of node.children) {
    if (c.tag === tag) out.push(c);
    descendants(c, tag, out);
  }
  return out;
}

module.exports = { parse, child, children, text, descendants, unescape };
