// The live-stream pane: one card per connected device, each group showing its
// measured rate and the latest decoded value of every stream, updating in
// place (~15 Hz) rather than as a scrolling log.
//
// STATUS_FLAGS streams whose definition carries a bit_mapping render as named
// flag chips instead of a raw integer; the calibration/init flags among them
// additionally surface as badges in the bottom status bar (see StatusBar.tsx).

import type {
  ConnectionStatus,
  DeviceView,
  GroupView,
  DecodedStream,
  StreamValue,
} from "../protocol/rgmp.ts";
import { decodeFlagBits } from "../protocol/status-flags.ts";

export function StreamPane({
  devices,
  status,
}: {
  devices: DeviceView[];
  status: ConnectionStatus;
}) {
  return (
    <section className="stream-pane">
      {devices.length === 0 ? (
        <div className="empty">
          {status === "connected"
            ? "Connected. Waiting for a device to stream…"
            : "Not connected. Enter the bridge URL and hit Connect."}
        </div>
      ) : (
        <div className="devices">
          {devices.map((device) => (
            <DeviceCard key={device.deviceId} device={device} />
          ))}
        </div>
      )}
    </section>
  );
}

function DeviceCard({ device }: { device: DeviceView }) {
  return (
    <section className="device">
      <header className="device-head">
        <span className="device-id">Device {device.deviceId}</span>
        {device.deviceType && <span className="device-type">{device.deviceType}</span>}
        {device.definition.timestamp_epoch && (
          <span className="epoch">epoch: {device.definition.timestamp_epoch}</span>
        )}
      </header>
      {device.groups.length === 0 ? (
        <p className="hint">No data yet for this device.</p>
      ) : (
        device.groups.map((group) => <GroupBlock key={group.groupId} group={group} />)
      )}
    </section>
  );
}

function GroupBlock({ group }: { group: GroupView }) {
  return (
    <div className="group">
      <div className="group-head">
        <span className="group-name">{group.name}</span>
        <span className="rate">
          {group.measuredHz.toFixed(1)} Hz
          {group.expectedRateHz > 0 && (
            <span className="rate-expected"> / {group.expectedRateHz}</span>
          )}
        </span>
        <span className="ts">ts {group.timestampUs.toString()}</span>
      </div>
      {group.streams.length === 0 ? (
        <div className="hint">empty group</div>
      ) : (
        <ul className="streams">
          {group.streams.map((stream, i) => (
            <StreamRow key={`${stream.label}-${stream.measureType}-${i}`} stream={stream} />
          ))}
        </ul>
      )}
    </div>
  );
}

function StreamRow({ stream }: { stream: DecodedStream }) {
  return (
    <li className="stream">
      <span className="stream-label">
        {stream.label}
        {/* A CUSTOM stream's label hides its frame (six identical
            "relative_emf_residual" rows say nothing) — show it alongside. */}
        {stream.label !== stream.targetFrame && (
          <span className="stream-frame"> · {stream.targetFrame}</span>
        )}
      </span>
      <span className="stream-measure">{stream.measureType}</span>
      {stream.bitMapping && stream.values.length === 1 ? (
        <FlagChips mapping={stream.bitMapping} value={stream.values[0]} />
      ) : (
        <span className="stream-values">{formatValues(stream.values)}</span>
      )}
    </li>
  );
}

/**
 * A flag word as named chips: lit = set, dimmed = clear. Chip colors stay
 * neutral because whether a set bit is good news depends on the flag
 * (`is_heading_reliable` set is good, `is_emf_saturated` set is not). The raw
 * word — including any bits the mapping doesn't name — is in the tooltip.
 */
function FlagChips({ mapping, value }: { mapping: Record<string, string>; value: StreamValue }) {
  return (
    <span className="stream-values flag-chips" title={`raw: ${value} (0x${value.toString(16)})`}>
      {decodeFlagBits(mapping, value).map((flag) => (
        <span key={flag.bit} className={`flag-chip ${flag.set ? "flag-set" : "flag-unset"}`}>
          {flag.name}
        </span>
      ))}
    </span>
  );
}

/** Render a stream's value array compactly: floats to 3 dp, ints/bigints raw. */
function formatValues(values: StreamValue[]): string {
  return `[${values.map(formatValue).join(", ")}]`;
}

function formatValue(v: StreamValue): string {
  if (typeof v === "bigint") return v.toString();
  if (Number.isInteger(v)) return v.toString();
  return v.toFixed(3);
}
