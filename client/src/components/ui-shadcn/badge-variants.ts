import { cva } from "class-variance-authority";

export const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-storefront-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-storefront-primary text-storefront-primary-foreground shadow",
        secondary:
          "border-transparent bg-storefront-secondary text-storefront-secondary-foreground",
        outline: "text-storefront-foreground border-storefront-border",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);
