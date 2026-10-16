export const EMAIL_COLORS = {
  pageBackground: '#f3f7fc',
  cardBackground: '#ffffff',
  headerBackground: '#233e57',
  headerText: '#ffffff',
  text: '#17283a',
  mutedText: '#2a5983',
  border: '#cadded',
  accent: '#306999',
  accentText: '#ffffff',
  infoBackground: '#e7eff7',
  infoBorder: '#4184b6',
  warningBackground: '#fdf3e1',
  warningBorder: '#c98a1a',
} as const;

export const EMAIL_FONT_STACK = "Arial, 'Helvetica Neue', Helvetica, sans-serif";

export const EMAIL_CONTENT_WIDTH = 600;

export interface EmailBrand {
  readonly name: string;
  readonly logoUrl: string | null;
}

export const DEFAULT_EMAIL_BRAND: EmailBrand = { name: 'Control Interno UNAC', logoUrl: null };

export const EMAIL_FOOTER_TEXT = (brandName: string): string =>
  `Mensaje automático enviado por ${brandName}.`;
