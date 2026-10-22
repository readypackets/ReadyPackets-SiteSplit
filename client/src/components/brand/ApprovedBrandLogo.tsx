import type { ImgHTMLAttributes } from "react";
import { BRAND, BRAND_ASSETS } from "@shared/brand";
import { cn } from "@/lib/utils";

type BrandVariant = "light" | "dark";

interface ApprovedBrandIconProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> {
  variant: BrandVariant;
}

/** The approved compact mark, kept proportional for navigation and app-prompt use. */
export function ApprovedBrandIcon({ variant, alt = "", className, ...props }: ApprovedBrandIconProps) {
  return (
    <img
      src={BRAND_ASSETS[variant].icon}
      alt={alt}
      className={cn("object-contain", className)}
      {...props}
    />
  );
}

interface ApprovedBrandLogoProps {
  variant: BrandVariant;
  className?: string;
  /** Supply an empty value when the parent link already has an accessible label. */
  label?: string;
}

/**
 * The only full ReadyPackets web lockup. The supplied asset components retain
 * their native aspect ratios and are given one accessible name as a group.
 */
export function ApprovedBrandLogo({
  variant,
  className,
  label = `${BRAND.wordmark} — ${BRAND.tagline}`,
}: ApprovedBrandLogoProps) {
  const assets = BRAND_ASSETS[variant];
  return (
    <span
      className={cn("flex min-w-0 items-center gap-2", className)}
      role={label ? "img" : undefined}
      aria-label={label || undefined}
    >
      <ApprovedBrandIcon variant={variant} alt="" aria-hidden="true" className="h-auto w-[18%] shrink-0" />
      <span className="grid min-w-0 gap-0.5">
        <img src={assets.wordmark} alt="" aria-hidden="true" className="h-auto w-full" />
        <img src={assets.rule} alt="" aria-hidden="true" className="h-auto w-full" />
        <img src={assets.tagline} alt="" aria-hidden="true" className="h-auto w-[95%]" />
      </span>
    </span>
  );
}
