import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  Building2,
  CalendarClock,
  ClipboardList,
  Clock3,
  CreditCard,
  Gift,
  Heart,
  History,
  Landmark,
  LayoutDashboard,
  LayoutGrid,
  ListChecks,
  MessageSquare,
  Package,
  Receipt,
  Scissors,
  Settings,
  Shield,
  ShoppingCart,
  Star,
  Truck,
  Users,
  Wallet,
} from "lucide-react";

export type AppIconName =
  | "operations"
  | "dashboard"
  | "insights"
  | "register"
  | "checkout"
  | "customers"
  | "orders"
  | "orderHistory"
  | "inventory"
  | "product"
  | "weddings"
  | "giftCards"
  | "loyalty"
  | "staff"
  | "qbo"
  | "reports"
  | "appointments"
  | "settings"
  | "tasks"
  | "inbox"
  | "rmsCharge"
  | "layaways"
  | "shipping"
  | "receipt"
  | "vendor"
  | "alterations";

export const APP_ICONS: Record<AppIconName, LucideIcon> = {
  operations: LayoutGrid,
  dashboard: LayoutDashboard,
  insights: LayoutDashboard,
  register: ShoppingCart,
  checkout: CreditCard,
  customers: Users,
  orders: ClipboardList,
  orderHistory: History,
  inventory: Package,
  product: Package,
  weddings: Heart,
  giftCards: Gift,
  loyalty: Star,
  staff: Shield,
  qbo: Landmark,
  reports: BarChart3,
  appointments: CalendarClock,
  settings: Settings,
  tasks: ListChecks,
  inbox: MessageSquare,
  rmsCharge: Wallet,
  layaways: Clock3,
  shipping: Truck,
  receipt: Receipt,
  vendor: Building2,
  alterations: Scissors,
};

export const APP_NAV_ICON_NAMES = {
  home: "operations",
  register: "register",
  customers: "customers",
  "rms-charge": "rmsCharge",
  "podium-inbox": "inbox",
  alterations: "alterations",
  orders: "orders",
  inventory: "inventory",
  weddings: "weddings",
  "gift-cards": "giftCards",
  loyalty: "loyalty",
  staff: "staff",
  qbo: "qbo",
  appointments: "appointments",
  reports: "reports",
  dashboard: "insights",
  "pos-dashboard": "dashboard",
  settings: "settings",
  shipping: "shipping",
  tasks: "tasks",
  layaways: "layaways",
} as const;

export const APP_ICON_SIZES = {
  rail: 18,
  section: 16,
  stat: 18,
  button: 16,
  badge: 14,
  empty: 48,
} as const;

export function getAppIcon(name: AppIconName): LucideIcon {
  return APP_ICONS[name];
}

export function getNavIconProps(active = false) {
  return {
    size: APP_ICON_SIZES.rail,
    strokeWidth: active ? 2.5 : 2,
  } as const;
}
