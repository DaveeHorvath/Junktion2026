// The status bar along the bottom of the app: the single home for glanceable
// per-device state that would otherwise scatter across the panes. Today that
// is the calibration/init flag badges (heading, emf flip — see
// protocol/status-flags.ts); more indicators are meant to land here over time.
//
// Always rendered, even when empty, so the panes don't resize when a device
// appears or a flag becomes available.

import type { DeviceView } from "../protocol/rgmp.ts";
import { collectDiagnostics } from "../protocol/status-flags.ts";
import { detectIsRight, isSmartglove } from "../solver/smartglove.ts";

/**
 * What a device is, not which slot it's in: the reported device type (falling
 * back to the numeric id), with an R/L designator for gloves — two connected
 * gloves share a device type, and laterality is what you actually glance for.
 */
function deviceLabel(device: DeviceView): string {
  const type = device.deviceType ?? `Device ${device.deviceId}`;
  if (!isSmartglove(device.definition)) return type;
  return `${type} ${detectIsRight(device.definition) ? "R" : "L"}`;
}

export function StatusBar({ devices }: { devices: DeviceView[] }) {
  return (
    <footer className="status-bar">
      {devices.map((device) => {
        const diagnostics = collectDiagnostics(device.groups.flatMap((group) => group.streams));
        if (diagnostics.length === 0) return null;
        return (
          <span key={device.deviceId} className="status-device">
            <span className="status-device-id" title={`Device ${device.deviceId}`}>
              {deviceLabel(device)}
            </span>
            {diagnostics.map((d) => (
              <span
                key={d.name}
                className={`diag-badge ${d.set ? "diag-on" : "diag-off"}`}
                title={d.title}
              >
                {d.label}
              </span>
            ))}
          </span>
        );
      })}
    </footer>
  );
}
