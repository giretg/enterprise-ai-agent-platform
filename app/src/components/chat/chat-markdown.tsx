'use client'

import Link from 'next/link'
import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'
import {
  HtmlPreviewModal,
  type HtmlPreviewTarget,
} from '@/components/workspace/html-preview-modal'
import {
  linkWorkspaceFileReferences,
  workspaceFileLink,
  workspaceFileLinkForReference,
  workspaceHtmlPreviewFromLink,
} from '@/lib/workspace-file-visibility'

function MarkdownLink({
  href,
  children,
  className,
  forceExternal = false,
  onOpenHtml,
}: {
  href?: string
  children?: React.ReactNode
  className?: string
  forceExternal?: boolean
  onOpenHtml?: (target: HtmlPreviewTarget) => void
}) {
  const htmlPreview = href ? workspaceHtmlPreviewFromLink(href) : null

  if (htmlPreview && onOpenHtml) {
    return (
      <a
        href={href}
        className={className}
        onClick={(event) => {
          event.preventDefault()
          onOpenHtml(htmlPreview)
        }}
      >
        {children}
      </a>
    )
  }

  if (href?.startsWith('/') && !forceExternal) {
    return (
      <Link href={href} className={className}>
        {children}
      </Link>
    )
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
    </a>
  )
}

const linkClassName =
  'font-medium text-coral underline decoration-coral/40 underline-offset-2 hover:text-coral-deep'

function agentComponentsFor(
  workspaceBaseUrl: string | undefined,
  workspaceFilePaths: string[],
  onOpenHtml: (target: HtmlPreviewTarget) => void,
): Components {
  return {
  p: ({ children }) => <p className="mb-3 last:mb-0 leading-relaxed">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  ul: ({ children }) => <ul className="mb-3 list-disc space-y-1.5 pl-5 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-3 list-decimal space-y-1.5 pl-5 last:mb-0">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  h1: ({ children }) => (
    <h3 className="mb-2 mt-1 font-display text-base font-semibold text-ink">{children}</h3>
  ),
  h2: ({ children }) => (
    <h4 className="mb-2 mt-1 font-display text-sm font-semibold text-ink">{children}</h4>
  ),
  h3: ({ children }) => (
    <h5 className="mb-1.5 mt-1 text-sm font-semibold text-ink">{children}</h5>
  ),
  code: ({ className, children }) => {
    const isBlock = className?.includes('language-')
    if (isBlock) {
      return (
        <code className="my-2 block overflow-x-auto rounded-lg bg-night-2 px-3 py-2 font-mono text-xs">
          {children}
        </code>
      )
    }
    const content = String(children).replace(/\n$/, '')
    if (workspaceBaseUrl && workspaceFilePaths.includes(content)) {
      return (
        <MarkdownLink
          href={workspaceFileLink(workspaceBaseUrl, content)}
          className={`${linkClassName} rounded bg-night-2 px-1.5 py-0.5 font-mono text-[0.85em]`}
          forceExternal
          onOpenHtml={onOpenHtml}
        >
          {children}
        </MarkdownLink>
      )
    }
    return (
      <code className="rounded bg-night-2 px-1.5 py-0.5 font-mono text-[0.85em]">{children}</code>
    )
  },
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-lg bg-night-2 p-3 font-mono text-xs">{children}</pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-sage/50 pl-3 text-ink-soft italic">{children}</blockquote>
  ),
  a: ({ href, children }) => {
    const workspaceHref = workspaceBaseUrl
      ? workspaceFileLinkForReference(href, workspaceFilePaths, workspaceBaseUrl)
      : null
    return (
      <MarkdownLink
        href={workspaceHref ?? href}
        className={linkClassName}
        forceExternal={Boolean(workspaceHref)}
        onOpenHtml={onOpenHtml}
      >
        {children}
      </MarkdownLink>
    )
  },
  hr: () => <hr className="my-3 border-line" />,
  }
}

const userComponents: Components = {
  p: ({ children }) => <p className="leading-relaxed">{children}</p>,
}

export function ChatMarkdown({
  content,
  variant,
  workspaceBaseUrl,
  workspaceFilePaths = [],
}: {
  content: string
  variant: 'user' | 'agent'
  /** A beszélgetés/ticket saját, hitelesített workspace-fájl route-ja. */
  workspaceBaseUrl?: string
  workspaceFilePaths?: string[]
}) {
  const [htmlPreview, setHtmlPreview] = useState<HtmlPreviewTarget | null>(null)

  if (variant === 'user') {
    return (
      <div className="chat-markdown chat-markdown--user text-sm">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={userComponents}>
          {content}
        </ReactMarkdown>
      </div>
    )
  }

  return (
    <>
      <div className="chat-markdown chat-markdown--agent text-sm text-ink-soft">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={agentComponentsFor(workspaceBaseUrl, workspaceFilePaths, setHtmlPreview)}
        >
          {workspaceBaseUrl
            ? linkWorkspaceFileReferences(content, workspaceFilePaths, workspaceBaseUrl)
            : content}
        </ReactMarkdown>
      </div>
      {htmlPreview && (
        <HtmlPreviewModal target={htmlPreview} onClose={() => setHtmlPreview(null)} />
      )}
    </>
  )
}

export function TypingIndicator({ agentName }: { agentName: string }) {
  return (
    <div className="flex justify-start" aria-live="polite" aria-busy="true">
      <div className="rounded-2xl rounded-bl-md border border-line bg-card px-4 py-3 shadow-sm">
        <span className="sr-only">{agentName} gépel…</span>
        <span className="flex items-center gap-1.5" aria-hidden>
          <span className="chat-typing-dot" />
          <span className="chat-typing-dot chat-typing-dot--2" />
          <span className="chat-typing-dot chat-typing-dot--3" />
        </span>
      </div>
    </div>
  )
}
