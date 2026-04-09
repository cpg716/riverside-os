import { cva } from "class-variance-authority";

export const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-storefront-ring disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "bg-storefront-primary text-storefront-primary-foreground shadow hover:bg-storefront-primary/90",
        destructive:
          "bg-storefront-destructive text-storefront-destructive-foreground shadow-sm hover:bg-storefront-destructive/90",
        outline:
          "border border-storefront-input bg-storefront-background shadow-sm hover:bg-storefront-accent hover:text-storefront-accent-foreground",
        secondary:
          "bg-storefront-secondary text-storefront-secondary-foreground shadow-sm hover:bg-storefront-secondary/80",
        ghost: "hover:bg-storefront-accent hover:text-storefront-accent-foreground",
        link: "text-storefront-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);
