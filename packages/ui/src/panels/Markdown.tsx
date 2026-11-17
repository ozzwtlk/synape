import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

/** Agent output is untrusted: always sanitized before rendering. */
export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true }) as string, { FORBID_TAGS: ['style', 'form', 'input', 'img'] }), [text]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function Diff({ text }: { text: string }) {
  return (
    <div className="diff">
      {text.split('\n').map((l, i) => (
        <div key={i} className={l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ') ? 'meta' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'hunk' : ''}>
          {l || ' '}
        </div>
      ))}
    </div>
  );
}
