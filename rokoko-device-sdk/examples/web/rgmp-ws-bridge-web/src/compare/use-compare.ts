// React binding for the solver comparison: a second RGMP connection (to the
// `rkk-hand-solver` sidecar) plus the timestamp-keyed rings that let the two
// streams be compared frame for frame. The matching lives in pose-ring.ts and
// the measuring in pose-delta.ts; this file is the plumbing.
//
// It talks to RgmpClient directly rather than reusing `useRgmp`: there is no
// stream pane for this connection, so none of the ~15 Hz snapshot publishing or
// per-group rate machinery applies. What it needs is the definition (to learn
// the joint order) and every data frame (to buffer it), which is exactly what
// the client hands out.
//
// The glove side of the comparison arrives through `captureGlove`, wired into
// `useRgmp`'s onFrame tap — the existing snapshot is latest-wins and cannot
// answer "what did the glove read at timestamp T".

import { useCallback, useEffect, useRef, useState } from "react";
import {
  RgmpClient,
  reconcileStatusError,
  type ConnectionStatus,
  type DataFrame,
} from "../protocol/rgmp-client.ts";
import type { GloveSample } from "../solver/smartglove.ts";
import { GloveCapture } from "./glove-capture.ts";
import { PoseRing, RING_CAPACITY, frameAtOrBefore, matchNewest } from "./pose-ring.ts";
import {
  canReadSolvedFrame,
  createSolvedFrame,
  readSolvedFrame,
  type SolvedFrame,
} from "./solved-frame.ts";
import { describeSolvedHand, type SolvedHandDescriptor } from "./solved-hand.ts";

/** A solved hand's descriptor and buffered poses. */
interface SolvedTrack {
  descriptor: SolvedHandDescriptor;
  ring: PoseRing<SolvedFrame>;
  /**
   * The `joints_openxr` frames, buffered like the world frames. Both groups
   * come out of the sidecar's one encode per glove frame with the same
   * timestamp, so the world match's timestamp indexes straight into this ring.
   */
  openxrRing: PoseRing<SolvedFrame> | null;
}

/** One frame both solvers saw, ready to compare. */
export interface ComparedFrame {
  timestampUs: bigint;
  /** The glove sample both solvers were given. */
  sample: GloveSample;
  /** The sidecar's pose for it. */
  solved: SolvedFrame;
  /**
   * The sidecar's OpenXR-formatted joints, or null when it doesn't emit them
   * (no `--emit-openxr`) or none have arrived yet. Normally the frame for
   * `timestampUs` exactly; briefly the one before it when the openxr message
   * — sent after its world sibling — hasn't landed yet (see frameAtOrBefore).
   * In `xr_base`, not the device frame — see scene/openxr-overlay.ts.
   */
  openxr: SolvedFrame | null;
  descriptor: SolvedHandDescriptor;
  /**
   * How far behind the newest glove frame this one is, in milliseconds — the
   * sidecar's round trip. Normally a frame or two; a number that climbs means
   * the sidecar is falling behind.
   */
  lagMs: number;
}

export interface UseCompare {
  status: ConnectionStatus;
  error: string | null;
  /** True once the sidecar stream is connected — what gates the overlay. */
  active: boolean;
  /**
   * Solved hands by (source) device id. Solved hands reuse the glove's device
   * id, which is exactly what makes the two streams correlatable — and why they
   * cannot share one snapshot.
   */
  solved: ReadonlyMap<number, SolvedHandDescriptor>;
  /** The newest frame both streams have for `deviceId`, or null. */
  frameFor: (deviceId: number) => ComparedFrame | null;
  /** Buffer one glove data frame. Wire to `useRgmp`'s onFrame. */
  captureGlove: (frame: DataFrame) => void;
  /** Drop the buffered glove samples. Wire to `useRgmp`'s onReset. */
  resetGlove: () => void;
  connect: (url: string) => void;
  disconnect: () => void;
}

export function useCompare(): UseCompare {
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [error, setError] = useState<string | null>(null);
  // Definitions are rare, so the descriptors can live in state and drive the
  // render (the overlay's geometry is built from them). The poses cannot.
  const [solved, setSolved] = useState<ReadonlyMap<number, SolvedHandDescriptor>>(new Map());

  const gloveCapture = useRef(new GloveCapture());
  const solvedTracks = useRef(new Map<number, SolvedTrack>());

  const clientRef = useRef<RgmpClient | null>(null);
  if (clientRef.current === null) {
    clientRef.current = new RgmpClient({
      onStatus: (nextStatus, nextError) => {
        setStatus(nextStatus);
        setError((prev) => reconcileStatusError(prev, nextStatus, nextError));
        if (nextStatus === "disconnected" || nextStatus === "error") {
          solvedTracks.current.clear();
          setSolved(new Map());
        }
      },
      onDefinition: ({ deviceId, definition }) => {
        const descriptor = describeSolvedHand(definition);
        if (descriptor === null) {
          // Every device on this endpoint should be a solved hand; one that
          // isn't means the second bridge is pointed at the driver by mistake,
          // which is worth saying out loud rather than showing no overlay.
          setError(
            `device ${deviceId} on the solver endpoint is not a solved hand ` +
              `(${definition.device_type ?? "no device_type"}) — is this the sidecar's port?`,
          );
          return;
        }
        // A re-announcement replaces the track: new session, new joint order.
        const { openxr } = descriptor;
        solvedTracks.current.set(deviceId, {
          descriptor,
          ring: new PoseRing(RING_CAPACITY, () => createSolvedFrame(descriptor.jointNames.length)),
          openxrRing: openxr
            ? new PoseRing(RING_CAPACITY, () => createSolvedFrame(openxr.jointNames.length))
            : null,
        });
        setSolved((prev) => new Map(prev).set(deviceId, descriptor));
      },
      onData: (frame) => {
        const track = solvedTracks.current.get(frame.deviceId);
        if (!track) return;
        const { descriptor } = track;
        if (frame.groupId === descriptor.worldGroupId) {
          // Vetted before the slot is claimed — see canReadSolvedFrame.
          if (!canReadSolvedFrame(descriptor, frame.streams)) return;
          readSolvedFrame(descriptor, frame.streams, track.ring.claim(frame.timestampUs));
        } else if (track.openxrRing && frame.groupId === descriptor.openxr?.groupId) {
          if (!canReadSolvedFrame(descriptor.openxr, frame.streams)) return;
          readSolvedFrame(
            descriptor.openxr,
            frame.streams,
            track.openxrRing.claim(frame.timestampUs),
          );
        }
      },
      onDisconnect: (deviceId) => {
        solvedTracks.current.delete(deviceId);
        setSolved((prev) => {
          if (!prev.has(deviceId)) return prev;
          const next = new Map(prev);
          next.delete(deviceId);
          return next;
        });
      },
      onBridgeError: (message) => setError(message),
    });
  }
  const client = clientRef.current;

  const captureGlove = useCallback((frame: DataFrame) => {
    // Only worth buffering while there is a solved stream to compare against.
    if (solvedTracks.current.size === 0) return;
    gloveCapture.current.capture(frame);
  }, []);

  const resetGlove = useCallback(() => {
    gloveCapture.current.clear();
  }, []);

  const frameFor = useCallback((deviceId: number): ComparedFrame | null => {
    const gloveRing = gloveCapture.current.ringFor(deviceId);
    const solvedTrack = solvedTracks.current.get(deviceId);
    if (!gloveRing || !solvedTrack) return null;

    const match = matchNewest(gloveRing, solvedTrack.ring);
    if (match === null) return null;

    const newest = gloveRing.newest() ?? match.timestampUs;
    return {
      timestampUs: match.timestampUs,
      sample: match.glove.sample,
      solved: match.solved,
      openxr: solvedTrack.openxrRing
        ? frameAtOrBefore(solvedTrack.openxrRing, match.timestampUs)
        : null,
      descriptor: solvedTrack.descriptor,
      lagMs: Number(newest - match.timestampUs) / 1000,
    };
  }, []);

  const connect = useCallback((url: string) => client.connect(url), [client]);
  const disconnect = useCallback(() => {
    client.disconnect();
    solvedTracks.current.clear();
    gloveCapture.current.clear();
    setSolved(new Map());
  }, [client]);

  useEffect(() => () => client.disconnect(), [client]);

  return {
    status,
    error,
    active: status === "connected",
    solved,
    frameFor,
    captureGlove,
    resetGlove,
    connect,
    disconnect,
  };
}
