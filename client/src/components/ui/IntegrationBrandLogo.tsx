import podiumBlackIcon from "../../assets/images/brands/Podium_Black_Icon.jpg";
import podiumWordmarkBlack from "../../assets/images/brands/Podium_Logo_Black.png";
import podiumWhiteIcon from "../../assets/images/brands/Podium_White_Icon.png";
import podiumWordmarkWhite from "../../assets/images/brands/Podium_Logo_White.jpg";
import qboIcon from "../../assets/images/brands/QBO_icon.png";
import qboWordmark from "../../assets/images/brands/QB_logo.png";
import stripeIcon from "../../assets/images/brands/Stripe_Icon.png";
import stripeWordmark from "../../assets/images/brands/stripe_logo.png";

export type IntegrationBrand = "podium" | "qbo" | "stripe";
type IntegrationBrandKind = "icon" | "wordmark";
type IntegrationBrandTheme = "light" | "dark";

const BRAND_LABELS: Record<IntegrationBrand, string> = {
  podium: "Podium",
  qbo: "QuickBooks Online",
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
  if (brand === "qbo") {
    return kind === "icon" ? qboIcon : qboWordmark;
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
