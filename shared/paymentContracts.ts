export type PaymentIntentStatus =
  | 'draft'
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'expired'
  | 'refunded'
  | 'disputed'
  | 'canceled';

export type PaymentCheckoutMode = 'qr' | 'payment_link' | 'app_switch' | 'redirect' | 'tap_to_pay';

export interface PaymentMethodCapability {
  id: string;
  label: string;
  checkoutModes: PaymentCheckoutMode[];
  countries?: string[];
  currencies?: string[];
  minAmountMinor?: number;
  maxAmountMinor?: number;
  requiresMobile?: boolean;
  requiresDesktop?: boolean;
  estimatedSharePercent?: number;
  enabledByDefault?: boolean;
  notes?: string;
}

export interface PaymentProviderCapability {
  pluginId: string;
  providerName: string;
  countries: string[];
  currencies: string[];
  methods: PaymentMethodCapability[];
  nonCustodialOnly: boolean;
  webhookSignatureRequired: boolean;
  supportsRefunds: boolean;
  supportsDisputes: boolean;
  notes?: string;
}

export interface PaymentUserBlock {
  userId: number;
  workspaceId: string;
  reason: string | null;
  blockedByUserId: number | null;
  blockedByUsername: string | null;
  blockedUsername: string | null;
  blockedAt: number;
  expiresAt: number | null;
}
