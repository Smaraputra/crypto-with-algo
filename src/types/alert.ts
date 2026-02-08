export const ALERT_TYPES = [
  'price_above',
  'price_below',
  'price_change_pct',
  'portfolio_value_above',
  'portfolio_value_below',
  'holding_change_pct',
] as const;

export type AlertType = (typeof ALERT_TYPES)[number];

export const ALERT_STATUSES = ['active', 'triggered', 'paused'] as const;

export type AlertStatus = (typeof ALERT_STATUSES)[number];

export interface Alert {
  _id: string;
  userId: string;
  symbol: string;
  portfolioId: string | null;
  type: AlertType;
  targetPrice: number | null;
  percentChange: number | null;
  referencePrice: number | null;
  status: AlertStatus;
  recurring: boolean;
  cooldownMinutes: number;
  message: string;
  triggeredAt: Date | null;
  notifiedAt: Date | null;
  lastTriggeredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AlertListResponse {
  alerts: Alert[];
}

export interface AlertResponse {
  alert: Alert;
}

export interface CreateAlertInput {
  symbol?: string;
  portfolioId?: string;
  type: AlertType;
  targetPrice?: number;
  percentChange?: number;
  recurring?: boolean;
  cooldownMinutes?: number;
  message?: string;
}

export interface UpdateAlertInput {
  status?: AlertStatus;
  targetPrice?: number;
  percentChange?: number;
  recurring?: boolean;
  cooldownMinutes?: number;
  message?: string;
  notifiedAt?: Date | string;
}
