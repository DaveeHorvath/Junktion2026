#pragma once

#include "rgmp_v2_basic_types.hpp"

#include <cstddef>
#include <cstdint>
#include <span>
#include <vector>

namespace rkk::rgmp::v2 {

struct device_disconnect_frame {
    uint32_t device_id{0};
};

// Guards against accidental field additions; not a wire-layout guarantee.
static_assert(sizeof(device_disconnect_frame) == 4);

void write_device_disconnect_frame(
    device_disconnect_frame const& f,
    std::span<std::byte, 4>        out
);
[[nodiscard]] device_disconnect_frame
read_device_disconnect_frame(std::span<std::byte const, 4> in);

// Sugar overload for the consumer dispatcher: takes a dynamically-sized
// body span (the bytes after the 8-byte outer msg_header), validates that
// it is at least 4 bytes long, and decodes the device_id. Throws
// rkk::rgmp::v2::error on undersized body.
//
// Mirrors parse_stream_definition_frame(std::span<std::byte const>) — the
// consumer side gets one parse_* helper per message kind, so dispatch
// arms never reach for read_u32_le or hand-construct sized spans.
[[nodiscard]] device_disconnect_frame
parse_device_disconnect_frame(std::span<std::byte const> body);

// One-call producer-side helper, mirroring frame_stream_definition. Encodes
// `f` and wraps it in the 8-byte outer header (msg_prefix::device_disconnect
// + msg_len = 4). Returns wire-ready bytes.
[[nodiscard]] std::vector<std::byte>
frame_device_disconnect(device_disconnect_frame const& f);

} // namespace rkk::rgmp::v2
