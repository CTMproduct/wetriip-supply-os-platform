import { ReactNode } from 'react';

/**
 * A deliberately small markdown renderer.
 *
 * The assistant writes in a narrow subset — paragraphs, bold, inline code,
 * bullets and comparison tables — so a 120-line renderer covers it exactly.
 * Pulling in a full parser plus a sanitizer for that would be a large
 * dependency and a real XSS surface, and this never uses dangerouslySetInnerHTML.
 */
export function Markdown({ text }: { text: string }) {
  return <div className="md">{renderBlocks(text)}</div>;
}

function renderBlocks(text: string): ReactNode[] {
  const lines = text.split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i += 1;
      continue;
    }

    // Table: a header row followed by a separator row.
    if (line.trim().startsWith('|') && lines[i + 1]?.trim().match(/^\|[\s:|-]+\|$/)) {
      const header = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      out.push(
        <div className="table-wrap" key={key++}>
          <table>
            <thead>
              <tr>
                {header.map((h, hi) => (
                  <th key={hi}>{inline(h)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (
                    <td key={ci}>{inline(c)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Bullet list
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i += 1;
      }
      out.push(
        <ul key={key++}>
          {items.map((it, ii) => (
            <li key={ii}>{inline(it)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i += 1;
      }
      out.push(
        <ol key={key++}>
          {items.map((it, ii) => (
            <li key={ii}>{inline(it)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    // Heading
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const content = inline(heading[2]);
      out.push(
        level <= 2 ? (
          <h3 key={key++} className="md-h">
            {content}
          </h3>
        ) : (
          <h4 key={key++} className="md-h">
            {content}
          </h4>
        ),
      );
      i += 1;
      continue;
    }

    // Paragraph: consume until a blank line or the start of another block.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !lines[i].trim().startsWith('|') &&
      !/^#{1,4}\s/.test(lines[i])
    ) {
      para.push(lines[i]);
      i += 1;
    }
    out.push(<p key={key++}>{inline(para.join(' '))}</p>);
  }

  return out;
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

/** Inline formatting: **bold**, *italic*, _italic_, `code`. */
function inline(text: string): ReactNode[] {
  const tokens: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|_[^_]+_)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) tokens.push(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith('**')) {
      tokens.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('`')) {
      tokens.push(
        <code key={key++} className="md-code">
          {token.slice(1, -1)}
        </code>,
      );
    } else {
      tokens.push(<em key={key++}>{token.slice(1, -1)}</em>);
    }
    last = match.index + token.length;
  }
  if (last < text.length) tokens.push(text.slice(last));
  return tokens;
}
