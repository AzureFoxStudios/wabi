export interface BrandPalette {
  backgroundTop: string;
  backgroundBottom: string;
  cardBackground: string;
  accent: string;
  text: string;
}

export interface BootSequence {
  brandDisplay: string;
  pulseAccent: string;
  backgroundGradient: string;
  statusText?: string;
  durationMs?: number;
}

export interface BrandProfile {
  id: string;
  brandName: string;
  logoUrl?: string;
  bannerUrl?: string;
  palette: BrandPalette;
  headline?: string;
  subheadline?: string;
  footerNote?: string;
  customCss?: string;
  bootSequence?: BootSequence;
}
