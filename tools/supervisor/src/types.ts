export interface Signal {
  triggerId: string;
  key: string;
  summary: string;
  urgent?: boolean;
}

export interface Trigger {
  id: string;
  cooldownMin: number;
  check(): Promise<Signal | null>;
}

export interface QuietHours {
  start: string;
  end: string;
}

export interface SupervisorConfig {
  quietHours: QuietHours;
  enabled: Record<string, boolean>;
  minIntervalMin: number;
  deadlineHorizonDays: number;
  modelDispatcherEnabled: boolean;
  modelDispatcherDailyCap: number;
  localModel: string;
  nvidiaApiKey: string;
  nvidiaModel: string;
}

export interface TriggerState {
  lastFiredISO: string | null;
  lastKey: string | null;
}

export interface SupervisorState {
  config: SupervisorConfig;
  triggers: Record<string, TriggerState>;
  lastTickISO: string | null;
  dispatch: { dateISO: string | null; count: number };
}
