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
import helcimIcon from "../../assets/images/brands/Helcim_Icon.png";
import helcimWordmark from "../../assets/images/brands/Helcim_Logo.png";
import weatherIcon from "../../assets/images/brands/weather_icon.jpeg";

export type IntegrationBrand =
  | "meilisearch"
  | "metabase"
  | "nuorder"
  | "podium"
  | "qbo"
  | "shippo"
  | "helcim"
  | "weather"
  | "constant_contact";
type IntegrationBrandKind = "icon" | "wordmark";
type IntegrationBrandTheme = "light" | "dark";

const constantContactIcon = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="%232563eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>`;
const constantContactWordmark = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 40" fill="none"><text x="5" y="26" fill="%232563eb" font-family="system-ui, -apple-system, sans-serif" font-weight="800" font-size="16" letter-spacing="-0.5px">Constant Contact</text></svg>`;

const BRAND_LABELS: Record<IntegrationBrand, string> = {
  meilisearch: "Meilisearch",
  metabase: "Metabase",
  nuorder: "NuORDER",
  podium: "Podium",
  qbo: "QuickBooks Online",
  shippo: "Shippo",
  helcim: "Helcim",
  weather: "Weather",
  constant_contact: "Constant Contact",
};

function resolveSrc(
  brand: IntegrationBrand,
  kind: IntegrationBrandKind,
  theme: IntegrationBrandTheme,
): string {
  if (brand === "constant_contact") {
    return kind === "icon" ? constantContactIcon : constantContactWordmark;
  }
  if (brand === "helcim") {
    return kind === "icon" ? helcimIcon : helcimWordmark;
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
  if (brand === "weather") {
    return weatherIcon;
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
