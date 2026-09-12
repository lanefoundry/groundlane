import { cva, type VariantProps } from 'class-variance-authority'
import type { HTMLAttributes } from 'react'
import { cn } from '#/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold transition-colors',
  {
    variants: {
      variant: {
        default:
          'border border-[var(--border)] bg-[var(--secondary)] text-[var(--secondary-foreground)]',
        outline:
          'border border-[var(--border)] bg-transparent text-[var(--foreground)]',
        success:
          'border border-[var(--positive)]/25 bg-[var(--positive)]/8 text-[var(--positive)]',
        destructive:
          'border border-[var(--destructive)]/25 bg-[var(--destructive)]/8 text-[var(--destructive)]',
        warning:
          'border border-[var(--warning)]/25 bg-[var(--warning)]/8 text-[var(--warning)]',
        accent:
          'border-0 bg-[var(--accent-soft)] text-[var(--accent)]',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
)

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
