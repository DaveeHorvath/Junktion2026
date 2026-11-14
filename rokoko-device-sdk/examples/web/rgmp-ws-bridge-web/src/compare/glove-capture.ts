// The glove half of the comparison's buffering: deciding which of a device's
// groups is the sensor group, and ring-buffering the samples read from it.
// Pure and framework-free, like pose-ring.ts; use-compare.ts owns one per
// connection and feeds it from `useRgmp`'s onFrame tap.

import type { DataFrame } from "../protocol/rgmp-client.ts";
import type { DecodedStream } from "../protocol/rgmp-layout.ts";
import {
  HUB_SENSOR_ID,
  createGloveSampleScratch,
  resolveSensorId,
  sampleGloveInto,
  type GloveSampleScratch,
} from "../solver/smartglove.ts";
import { PoseRing, RING_CAPACITY } from "./pose-ring.ts";

/**
 * True when this group carries the glove's hub orientation.
 *
 * The hub is the right thing to key on: the solver no-ops without it, so a group
 * that has it is the group both solvers are reading, and a group that doesn't is
 * of no use to the comparison whatever else it carries.
 */
function isSensorGroup(streams: readonly DecodedStream[]): boolean {
  for (const stream of streams) {
    if (stream.measureType !== "ORIENTATION" && stream.measureType !== "TRANSFORM") continue;
    if (resolveSensorId(stream.targetFrame, stream.referenceFrame) === HUB_SENSOR_ID) return true;
  }
  return false;
}

/** A glove device's settled sensor group and its buffered samples. */
interface GloveTrack {
  groupId: number;
  ring: PoseRing<GloveSampleScratch>;
}

/**
 * Buffers glove sensor samples per device, keyed by timestamp.
 *
 * Which group is the sensor group is settled per (device, group), never per
 * device: real gloves publish several groups (motion plus `emf_only`, see
 * solver/smartglove.ts), and which one's frame arrives first is a race.
 * Rejecting the whole device on an `emf_only` first frame used to silence the
 * comparison — stuck on "waiting for a frame both solvers have" — until the
 * next reconnect happened to win the race.
 */
export class GloveCapture {
  private readonly tracks = new Map<number, GloveTrack>();
  /** `deviceId:groupId` pairs we have looked at and rejected. */
  private readonly notSensorGroups = new Set<string>();

  /** Buffer one data frame, or drop it if its group isn't the sensor group. */
  capture(frame: DataFrame): void {
    let track = this.tracks.get(frame.deviceId);
    if (track === undefined) {
      const key = `${frame.deviceId}:${frame.groupId}`;
      if (this.notSensorGroups.has(key)) return;
      if (!isSensorGroup(frame.streams)) {
        // Not the sensor group — but only this group is ruled out. Another of
        // the device's groups may still be the one both solvers read.
        this.notSensorGroups.add(key);
        return;
      }
      track = {
        groupId: frame.groupId,
        ring: new PoseRing(RING_CAPACITY, createGloveSampleScratch),
      };
      this.tracks.set(frame.deviceId, track);
    }
    if (frame.groupId !== track.groupId) return;

    // The decoded streams are the layout's reusable target, so this copies the
    // numbers out into the slot's own arrays rather than retaining them.
    sampleGloveInto(frame.streams, track.ring.claim(frame.timestampUs));
  }

  /** The device's sample ring, or null while its sensor group hasn't shown up. */
  ringFor(deviceId: number): PoseRing<GloveSampleScratch> | null {
    return this.tracks.get(deviceId)?.ring ?? null;
  }

  /** Drop everything buffered and every group verdict. */
  clear(): void {
    this.tracks.clear();
    this.notSensorGroups.clear();
  }
}
