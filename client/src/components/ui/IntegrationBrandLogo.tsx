import coreCreditIcon from "../../assets/images/brands/CoreCredit_Icon.png";
import coreCreditWordmark from "../../assets/images/brands/CoreCredit_Logo.png";
import meilisearchIcon from "../../assets/images/brands/Meilisearch_Icon.svg";
import meilisearchWordmark from "../../assets/images/brands/meilisearch-logo.png";
import metabaseIcon from "../../assets/images/brands/Metabase_Icon.svg";
import metabaseWordmark from "../../assets/images/brands/metabase_logo.png";
import nuorderIcon from "../../assets/images/brands/nuorder_icon.png";
import nuorderWordmark from "../../assets/images/brands/nuorder-logo.png";
import podiumBlackIcon from "../../assets/images/brands/Podium_Black_Icon.jpg";
import podiumWordmarkBlack from "../../assets/images/brands/Podium_Logo_Black.png";
import podiumWhiteIcon from "../../assets/images/brands/Podium_White_Icon.png";
import podiumWordmarkWhite from "../../assets/images/brands/Podium_Logo_White.jpg";
import qboIcon from "../../assets/images/brands/QBO_icon.png";
import qboWordmark from "../../assets/images/brands/QB_logo.png";
import shippoIcon from "../../assets/images/brands/Shippo_Icon.png";
import shippoWordmark from "../../assets/images/brands/Shippo_Logo.png";
import stripeIcon from "../../assets/images/brands/Stripe_Icon.png";
import stripeWordmark from "../../assets/images/brands/stripe_logo.png";

export type IntegrationBrand =
  | "corecredit"
  | "meilisearch"
  | "metabase"
  | "nuorder"
  | "podium"
  | "qbo"
  | "shippo"
  | "stripe";
type IntegrationBrandKind = "icon" | "wordmark";
type IntegrationBrandTheme = "light" | "dark";

const BRAND_LABELS: Record<IntegrationBrand, string> = {
  corecredit: "CoreCredit",
  meilisearch: "Meilisearch",
  metabase: "Metabase",
  nuorder: "NuORDER",
  podium: "Podium",
  qbo: "QuickBooks Online",
  shippo: "Shippo",
  stripe: "Stripe",
};

function resolveSrc(
  brand: IntegrationBrand,
  kind: IntegrationBrandKind,
  theme: IntegrationBrandTheme,
): string {
  if (brand === "stripe") {
    return kind === "icon" ? stripeIcon : stripeWordmark;
  }
  if (brand === "corecredit") {
    return kind === "icon" ? coreCreditIcon : coreCreditWordmark;
  }
  if (brand === "metabase") {
    return kind === "icon" ? metabaseIcon : metabaseWordmark;
  }
  if (brand === "meilisearch") {
    return kind === "icon" ? meilisearchIcon : meilisearchWordmark;
  }
  if (brand === "nuorder") {
    return kind === "icon" ? nuorderIcon : nuorderWordmark;
  }
  if (brand === "qbo") {
    return kind === "icon" ? qboIcon : qboWordmark;
  }
  if (brand === "shippo") {
    return kind === "icon" ? shippoIcon : shippoWordmark;
  }
  if (kind === "icon") {
    return theme === "dark" ? podiumWhiteIcon : podiumBlackIcon;
  }
  return theme === "dark" ? podiumWordmarkWhite : podiumWordmarkBlack;
}

interface IntegrationBrandLogoProps {
  brand: IntegrationBrand;
  kind?: IntegrationBrandKind;
  theme?: IntegrationBrandTheme;
  alt?: string;
  className?: string;
  imageClassName?: string;
}

export default function IntegrationBrandLogo({
  brand,
  kind = "wordmark",
  theme = "light",
  alt,
  className,
  imageClassName,
}: IntegrationBrandLogoProps) {
  return (
    <span className={className}>
      <img
        src={resolveSrc(brand, kind, theme)}
        alt={alt ?? BRAND_LABELS[brand]}
        className={imageClassName}
      />
    </span>
  );
}
