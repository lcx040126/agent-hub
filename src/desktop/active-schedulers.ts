export interface ActiveSchedulerSlots<Scan, Heartbeat, ReleaseNotifier> {
  scanner: Scan | null;
  heartbeat: Heartbeat | null;
  releaseNotifier: ReleaseNotifier | null;
}

export function ensureActiveSchedulerSlots<Scan, Heartbeat, ReleaseNotifier>(options: {
  active: boolean;
  current: ActiveSchedulerSlots<Scan, Heartbeat, ReleaseNotifier>;
  startScanner(): Scan;
  startHeartbeat(): Heartbeat;
  startReleaseNotifier(): ReleaseNotifier;
}): ActiveSchedulerSlots<Scan, Heartbeat, ReleaseNotifier> {
  if (!options.active) return options.current;
  options.current.scanner ??= options.startScanner();
  options.current.heartbeat ??= options.startHeartbeat();
  options.current.releaseNotifier ??= options.startReleaseNotifier();
  return options.current;
}
