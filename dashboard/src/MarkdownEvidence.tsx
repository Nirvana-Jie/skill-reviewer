import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { useUiPreferences } from "./ui-preferences";

export default function MarkdownEvidence({ content }: { content: string }) {
  const { t } = useUiPreferences();
  return (
    <div className="evidence-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ node: _node, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer" />
          ),
          img: ({ node: _node, alt }) => (
            <span className="markdown-image-placeholder">
              {t("markdownImageNotLoaded", { alt: alt || t("unnamedImage") })}
            </span>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
