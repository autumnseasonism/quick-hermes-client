// Zero-dependency, intentionally minimal Markdown renderer for assistant
// messages. Everything is HTML-escaped first, so the output is safe to inject
// via innerHTML. Covers: fenced code blocks, inline code, bold, italic,
// headings, ordered/unordered lists, blockquotes, horizontal rules, links.
(function () {
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function safeUrl(url) {
    const u = String(url).trim();
    return /^https?:\/\//i.test(u) ? u : "";
  }

  // Operates on already-escaped text. Splits on backticks so inline-code spans
  // (odd segments) are never touched by the emphasis/link passes.
  function renderInline(text) {
    const parts = String(text).split("`");
    let out = "";
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        out += `<code>${parts[i]}</code>`;
        continue;
      }
      let seg = parts[i];
      seg = seg.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, url) => {
        const safe = safeUrl(url);
        return safe ? `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
      });
      seg = seg.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      seg = seg.replace(/__([^_]+)__/g, "<strong>$1</strong>");
      seg = seg.replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, "$1<em>$2</em>");
      seg = seg.replace(/(^|[^_])_([^_\s][^_]*?)_/g, "$1<em>$2</em>");
      out += seg;
    }
    return out;
  }

  function isBlockStart(line) {
    return (
      /^```/.test(line) ||
      /^(#{1,6})\s/.test(line) ||
      /^\s*([-*])\s+/.test(line) ||
      /^\s*\d+\.\s+/.test(line) ||
      /^\s*>/.test(line) ||
      /^\s*([-*_])\1{2,}\s*$/.test(line)
    );
  }

  function render(src) {
    const lines = escapeHtml(src == null ? "" : src).split("\n");
    let html = "";
    let inCode = false;
    let codeLang = "";
    let codeBuf = [];
    let listType = null;
    let listBuf = [];

    function flushList() {
      if (listType) {
        html += `<${listType}>${listBuf.join("")}</${listType}>`;
        listType = null;
        listBuf = [];
      }
    }

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const fence = line.match(/^```(\w*)\s*$/);
      if (fence) {
        if (!inCode) {
          flushList();
          inCode = true;
          codeLang = fence[1] || "";
          codeBuf = [];
        } else {
          html += `<pre data-lang="${codeLang}"><code>${codeBuf.join("\n")}</code></pre>`;
          inCode = false;
        }
        i++;
        continue;
      }
      if (inCode) {
        codeBuf.push(line);
        i++;
        continue;
      }
      if (/^\s*$/.test(line)) {
        flushList();
        i++;
        continue;
      }
      let m;
      if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
        flushList();
        const lvl = m[1].length;
        html += `<h${lvl}>${renderInline(m[2])}</h${lvl}>`;
        i++;
        continue;
      }
      if (/^\s*([-*])\s+/.test(line)) {
        if (listType !== "ul") {
          flushList();
          listType = "ul";
        }
        listBuf.push(`<li>${renderInline(line.replace(/^\s*[-*]\s+/, ""))}</li>`);
        i++;
        continue;
      }
      if (/^\s*\d+\.\s+/.test(line)) {
        if (listType !== "ol") {
          flushList();
          listType = "ol";
        }
        listBuf.push(`<li>${renderInline(line.replace(/^\s*\d+\.\s+/, ""))}</li>`);
        i++;
        continue;
      }
      if ((m = line.match(/^\s*>\s?(.*)$/))) {
        flushList();
        html += `<blockquote>${renderInline(m[1])}</blockquote>`;
        i++;
        continue;
      }
      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
        flushList();
        html += "<hr/>";
        i++;
        continue;
      }
      flushList();
      const para = [line];
      i++;
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlockStart(lines[i])) {
        para.push(lines[i]);
        i++;
      }
      html += `<p>${para.map(renderInline).join("<br/>")}</p>`;
    }
    if (inCode) {
      html += `<pre data-lang="${codeLang}"><code>${codeBuf.join("\n")}</code></pre>`;
    }
    flushList();
    return html;
  }

  window.renderMarkdown = render;
})();
