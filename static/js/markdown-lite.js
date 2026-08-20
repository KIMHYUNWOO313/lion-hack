/**
 * Lightweight markdown → HTML (tables, headers, lists, bold)
 */
(function (global) {
  "use strict";

  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  function inlineFormat(text) {
    return escapeHtml(text)
      .replace(/▲/g, '<span class="zm-risk high">▲</span>')
      .replace(/●/g, '<span class="zm-risk mid">●</span>')
      .replace(/○/g, '<span class="zm-risk low">○</span>')
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  }

  function parseTableRow(row) {
    return row
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
  }

  function isTableSep(line) {
    return /^\|[\s\-:|]+\|$/.test(line.trim());
  }

  function renderTable(lines) {
    if (!lines.length) return "";
    const header = parseTableRow(lines[0]);
    let bodyStart = 1;
    if (lines[1] && isTableSep(lines[1])) bodyStart = 2;

    let html =
      '<div class="zm-md-table-wrap"><table class="zm-md-table"><thead><tr>';
    header.forEach((h) => {
      html += `<th>${inlineFormat(h)}</th>`;
    });
    html += "</tr></thead><tbody>";

    for (let i = bodyStart; i < lines.length; i++) {
      const cells = parseTableRow(lines[i]);
      if (!cells.length || (cells.length === 1 && !cells[0])) continue;
      html += "<tr>";
      cells.forEach((c) => {
        html += `<td>${inlineFormat(c)}</td>`;
      });
      html += "</tr>";
    }
    html += "</tbody></table></div>";
    return html;
  }

  function renderMarkdown(text) {
    if (!text) return "";
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      if (!trimmed) {
        i++;
        continue;
      }

      if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
        const tableLines = [];
        while (i < lines.length) {
          const t = lines[i].trim();
          if (!t.startsWith("|")) break;
          tableLines.push(t);
          i++;
        }
        out.push(renderTable(tableLines));
        continue;
      }

      if (/^---+$/.test(trimmed)) {
        out.push("<hr class='zm-md-hr'>");
        i++;
        continue;
      }

      if (trimmed.startsWith("### ")) {
        out.push(`<h4 class="zm-md-h4">${inlineFormat(trimmed.slice(4))}</h4>`);
        i++;
        continue;
      }

      if (trimmed.startsWith("## ")) {
        out.push(`<h3 class="zm-md-h3">${inlineFormat(trimmed.slice(3))}</h3>`);
        i++;
        continue;
      }

      if (trimmed.startsWith("# ")) {
        out.push(`<h2 class="zm-md-h2">${inlineFormat(trimmed.slice(2))}</h2>`);
        i++;
        continue;
      }

      if (/^[-*] /.test(trimmed)) {
        out.push("<ul class='zm-md-ul'>");
        while (i < lines.length && /^[-*] /.test(lines[i].trim())) {
          out.push(`<li>${inlineFormat(lines[i].trim().replace(/^[-*] /, ""))}</li>`);
          i++;
        }
        out.push("</ul>");
        continue;
      }

      if (/^\d+\. /.test(trimmed)) {
        out.push("<ol class='zm-md-ol'>");
        while (i < lines.length && /^\d+\. /.test(lines[i].trim())) {
          out.push(
            `<li>${inlineFormat(lines[i].trim().replace(/^\d+\. /, ""))}</li>`
          );
          i++;
        }
        out.push("</ol>");
        continue;
      }

      const para = [];
      while (i < lines.length && lines[i].trim() && !lines[i].trim().startsWith("|")) {
        const t = lines[i].trim();
        if (/^#{1,3} /.test(t) || /^[-*] /.test(t) || /^\d+\. /.test(t)) break;
        if (/^---+$/.test(t)) break;
        para.push(lines[i].trim());
        i++;
      }
      if (para.length) {
        out.push(`<p class="zm-md-p">${inlineFormat(para.join(" "))}</p>`);
      }
    }

    return out.join("");
  }

  global.renderMarkdown = renderMarkdown;
})(window);
