export function ChatMarkdown({
  children,
  content,
  className,
}: {
  children?: string
  content?: string
  className?: string
  variant?: string
}) {
  return <div className={className}>{children ?? content ?? ''}</div>
}
