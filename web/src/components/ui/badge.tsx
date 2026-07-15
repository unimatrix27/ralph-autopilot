import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Badge with a `status` variant family wired to the semantic status palette
 * (src/lib/status.ts → `--status-*` tokens). Use the status tones to render
 * lifecycle state so colour meaning is consistent everywhere.
 */
const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline: "text-foreground",
        eligible: "border-transparent bg-status-eligible text-status-eligible-foreground",
        running: "border-transparent bg-status-running text-status-running-foreground",
        waiting: "border-transparent bg-status-waiting text-status-waiting-foreground",
        attention: "border-transparent bg-status-attention text-status-attention-foreground",
        danger: "border-transparent bg-status-danger text-status-danger-foreground",
        success: "border-transparent bg-status-success text-status-success-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
