'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import type { Components } from 'react-markdown'
import {
  HtmlPreviewModal,
  type HtmlPreviewTarget,
} from '@/components/workspace/html-preview-modal'
import type { PrivacyEntityMarker } from '@/domain/privacy/privacy-observability'
import { containsEmbeddedSurrogate } from '@/domain/privacy/surrogate-format'
import {
  isSafeMarkdownImageSrc,
  isSafeMarkdownLinkHref,
  unresolvedSurrogateHint,
} from '@/lib/markdown-url-policy'
import { injectPrivacyHighlights } from '@/lib/privacy-markdown-highlights'
import {
  linkWorkspaceFileReferences,
  workspaceFileLink,
  workspaceFileLinkForReference,
  workspaceHtmlPreviewFromLink,
} from '@/lib/workspace-file-visibility'

function privacyMarkClass(className?: string): string {
  switch (className) {
    case 'privacy-applied':
      return 'rounded-sm bg-sage/20 px-0.5 text-ink border-b border-sage/50'
    case 'privacy-blocked':
      return 'rounded-sm bg-coral/15 px-0.5 text-ink border-b border-coral/50'
    case 'privacy-skipped':
      return 'rounded-sm bg-night-3 px-0.5 text-ink-soft border-b border-line/60'
    case 'privacy-observed':
    default:
      return 'rounded-sm bg-honey/25 px-0.5 text-ink border-b border-honey/60'
  }
}

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
  const unresolved = containsEmbeddedSurrogate(href ?? '')
  const title = unresolved ? unresolvedSurrogateHint : undefined
  const markedClass = unresolved ? `${className ?? ''} decoration-wavy`.trim() : className

  if (!isSafeMarkdownLinkHref(href)) {
    return (
      <span className={markedClass} title={title} data-privacy-unresolved={unresolved || undefined}>
        {children}
      </span>
    )
  }

  const htmlPreview = href ? workspaceHtmlPreviewFromLink(href) : null

  if (htmlPreview && onOpenHtml) {
    return (
      <a
        href={href}
        className={markedClass}
        title={title}
        data-privacy-unresolved={unresolved || undefined}
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
      <Link
        href={href}
        className={markedClass}
        title={title}
        data-privacy-unresolved={unresolved || undefined}
      >
        {children}
      </Link>
    )
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={markedClass}
      title={title}
      data-privacy-unresolved={unresolved || undefined}
    >
      {children}
    </a>
  )
}

function markdownImageSrc(src: string | Blob | undefined): string | undefined {
  return typeof src === 'string' ? src : undefined
}

function MarkdownImage({ src, alt }: { src?: string | Blob; alt?: string }) {
  const href = markdownImageSrc(src)
  const unresolved = containsEmbeddedSurrogate(href ?? '')
  if (!isSafeMarkdownImageSrc(href)) {
    return (
      <span
        role="img"
        aria-label={unresolved ? unresolvedSurrogateHint : alt || 'Blokkolt külső kép'}
        title={unresolved ? unresolvedSurrogateHint : 'Külső kép nem tölthető be'}
        data-privacy-unresolved={unresolved || undefined}
        className="inline rounded bg-night-2 px-1.5 py-0.5 text-xs text-ink-faint"
      >
        {unresolved ? unresolvedSurrogateHint : alt || 'kép'}
      </span>
    )
  }
  return <img src={href} alt={alt ?? ''} />
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
    const unresolved = containsEmbeddedSurrogate(String(children))
    const unresolvedProps = {
      title: unresolved ? unresolvedSurrogateHint : undefined,
      'data-privacy-unresolved': unresolved || undefined,
    }
    if (isBlock) {
      return (
        <code
          className="my-2 block overflow-x-auto rounded-lg bg-night-2 px-3 py-2 font-mono text-xs"
          {...unresolvedProps}
        >
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
      <code
        className="rounded bg-night-2 px-1.5 py-0.5 font-mono text-[0.85em]"
        {...unresolvedProps}
      >
        {children}
      </code>
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
  img: ({ src, alt }) => <MarkdownImage src={src} alt={alt} />,
  hr: () => <hr className="my-3 border-line" />,
  mark: ({ className, children, title }) => (
    <mark className={privacyMarkClass(className ?? undefined)} title={title ?? undefined}>
      {children}
    </mark>
  ),
  }
}

const userComponents: Components = {
  p: ({ children }) => <p className="leading-relaxed">{children}</p>,
  a: ({ href, children }) => (
    <MarkdownLink href={href} className={linkClassName}>
      {children}
    </MarkdownLink>
  ),
  img: ({ src, alt }) => <MarkdownImage src={src} alt={alt} />,
  code: ({ className, children }) => {
    const unresolved = containsEmbeddedSurrogate(String(children))
    return (
      <code
        className={className}
        title={unresolved ? unresolvedSurrogateHint : undefined}
        data-privacy-unresolved={unresolved || undefined}
      >
        {children}
      </code>
    )
  },
}

export function ChatMarkdown({
  content,
  variant,
  workspaceBaseUrl,
  workspaceFilePaths = [],
  privacyMarkers = [],
}: {
  content: string
  variant: 'user' | 'agent'
  /** A beszélgetés/ticket saját, hitelesített workspace-fájl route-ja. */
  workspaceBaseUrl?: string
  workspaceFilePaths?: string[]
  privacyMarkers?: readonly PrivacyEntityMarker[]
}) {
  const [htmlPreview, setHtmlPreview] = useState<HtmlPreviewTarget | null>(null)
  const linkedContent = useMemo(
    () =>
      workspaceBaseUrl
        ? linkWorkspaceFileReferences(content, workspaceFilePaths, workspaceBaseUrl)
        : content,
    [content, workspaceBaseUrl, workspaceFilePaths],
  )
  const renderedContent = useMemo(
    () =>
      privacyMarkers.length > 0
        ? injectPrivacyHighlights(linkedContent, privacyMarkers)
        : linkedContent,
    [linkedContent, privacyMarkers],
  )
  const rehypePlugins = privacyMarkers.length > 0 ? [rehypeRaw] : []

  if (variant === 'user') {
    return (
      <div className="chat-markdown chat-markdown--user text-sm">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={rehypePlugins}
          components={{
            ...userComponents,
            mark: ({ className, children, title }) => (
              <mark className={privacyMarkClass(className ?? undefined)} title={title ?? undefined}>
                {children}
              </mark>
            ),
          }}
        >
          {renderedContent}
        </ReactMarkdown>
      </div>
    )
  }

  return (
    <>
      <div className="chat-markdown chat-markdown--agent text-sm text-ink-soft">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={rehypePlugins}
          components={agentComponentsFor(workspaceBaseUrl, workspaceFilePaths, setHtmlPreview)}
        >
          {renderedContent}
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
